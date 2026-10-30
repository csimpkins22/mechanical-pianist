// Interpreted performance -> continuous, physically plausible hand motion.
//
// The hands are planned once, before playback, as sampled channels (wrist
// position, yaw, pitch, roll) built from what the fingers must do and when:
//
//   1. every note pulls the wrist toward the position that puts its finger on
//      its key, starting as early as the music allows (a rest is a chance to
//      travel; a fast run is not);
//   2. the pull is blurred with a zero-phase filter, so the hand starts moving
//      before it has to: anticipation falls out of non-causal smoothing;
//   3. the result is projected back into what is physically reachable while
//      fingers hold keys, and re-smoothed, a few times;
//   4. height, arcs over leaps, attack dips, relaxation, roll toward the
//      playing side of the hand and turning for thumb passages are layered on;
//   5. a final pass evaluates the IK at every note and nudges the wrist where
//      a finger would fall short of its key.
//
// Fingers are not sampled: their targets are evaluated exactly from each
// finger's note list at any t (see PerformanceTimeline).
import { KEYS, contactX, keyOf, type KeyInfo } from '../core/keyboard';
import { REST_TIPS, TIP_RADIUS, type V3 } from '../core/handGeometry';
import { Signal, clamp, gaussianBlur, smoothstep } from '../core/math';
import { drift, hash01 } from '../core/random';
import type { Finger, Hand, Performance, PerformanceNote } from '../core/types';
import { strokeOf, type KeyStroke } from './KeyMechanics';

export const RATE = 120; // samples per second
export const SHOULDER_X = 0.19; // shoulders either side of the keyboard centre
export const ELBOW_Z = 0.36;

/** Preferred contact depth (z) per finger 1..5 on white and black keys. */
const PREF_Z_WHITE = [0, -0.017, -0.036, -0.04, -0.036, -0.024];
const PREF_Z_BLACK = [0, -0.068, -0.08, -0.086, -0.08, -0.072];
/** how far the wrist may drift laterally from a finger's ideal while it holds a key */
const LATERAL_TOL = [0, 0.046, 0.022, 0.016, 0.018, 0.034];
const THUMB_UNDER_TOL = 0.065;
/** roll bias when a finger plays: thumb side down (+) or little-finger side down (-) */
const ROLL_BIAS = [0, 0.07, 0.025, 0, -0.03, -0.075];

export interface PlannedNote {
  note: PerformanceNote;
  finger: Finger;
  key: KeyInfo;
  stroke: KeyStroke;
  /** contact point on the resting key (world x, z) */
  cx: number;
  cz: number;
  /** passing over (finger) or under (thumb) another finger on the way in */
  transit: 'over' | 'under' | null;
  /** previous note of the same finger (for transitions), and next */
  prev: PlannedNote | null;
  next: PlannedNote | null;
}

export interface HandTrack {
  hand: Hand;
  sx: 1 | -1;
  x: Signal;
  y: Signal;
  z: Signal;
  yaw: Signal;
  pitch: Signal;
  roll: Signal;
  /** finger number -> notes sorted by contact time */
  fingers: PlannedNote[][];
  notes: PlannedNote[];
  /** where the hand waits when it has nothing to play */
  home: number;
}

export interface MotionPlan {
  hands: Record<Hand, HandTrack>;
  t0: number;
  t1: number;
}

/** Canonical rest tip (right-hand frame) rotated by yaw, mirrored for the left hand: world offset from the wrist. */
export function tipOffsetWorld(f: number, sx: number, yaw: number): [number, number, number] {
  const p = REST_TIPS[f];
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [sx * (p[0] * c + p[2] * s), p[1], -p[0] * s + p[2] * c];
}

function sampled(t0: number, n: number, fn: (t: number, i: number) => number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(t0 + i / RATE, i);
  return a;
}

/** weighted average with forward/backward fill where nothing pulls */
function fillWeighted(num: Float32Array, den: Float32Array, fallback: number): Float32Array {
  const n = num.length;
  const out = new Float32Array(n);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (den[i] > 1e-4) last = num[i] / den[i];
    out[i] = last;
  }
  let first = NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (!Number.isNaN(out[i])) first = out[i];
    else out[i] = Number.isNaN(first) ? fallback : first;
  }
  // blend partial weights toward the carried value, so weak pulls move the hand gently
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = Math.min(1, den[i]);
    res[i] = den[i] > 1e-4 ? (num[i] / den[i]) * w + out[i] * (1 - w) : out[i];
  }
  return res;
}

function engagement(pn: PlannedNote, t: number, lead: number): number {
  const s = pn.note.start;
  const e = Math.max(pn.note.keyEnd, s + 0.05);
  if (t < s) return smoothstep(s - lead, s - 0.02, t);
  if (t <= e) return 1;
  return 1 - smoothstep(e, e + 0.16, t);
}

function planHand(perf: Performance, hand: Hand, t0: number, n: number): HandTrack {
  const sx: 1 | -1 = hand === 'R' ? 1 : -1;
  const list = perf.byHand[hand].filter((x) => !x.flags.includes('chord-overflow'));
  const planned: PlannedNote[] = list.map((note) => {
    const key = keyOf(note.midi);
    const j = (hash01(note.id, 7) - 0.5) * 0.0024;
    return { note, finger: note.finger, key, stroke: strokeOf(note), cx: key.x + j, cz: 0, transit: null, prev: null, next: null };
  });
  // anticipation window per note: how long since this hand's previous onset
  const lead = new Float32Array(planned.length);
  {
    let prevOnset = -10;
    let groupStart = -10;
    for (let i = 0; i < planned.length; i++) {
      const s = planned[i].note.start;
      if (s - groupStart > 0.04) {
        prevOnset = groupStart;
        groupStart = s;
      }
      lead[i] = clamp(s - prevOnset, 0.08, 0.65);
    }
  }
  const home = planned.length ? planned[0].key.x - sx * REST_TIPS[3][0] : sx * 0.25;

  // --- 1. depth (z) ---------------------------------------------------------
  const zNum = new Float32Array(n);
  const zDen = new Float32Array(n);
  const accumulate = (num: Float32Array, den: Float32Array, value: (pn: PlannedNote) => number, weight = (_pn: PlannedNote) => 1) => {
    planned.forEach((pn, i) => {
      const v = value(pn);
      const w0 = weight(pn);
      const a = Math.max(0, Math.floor((pn.note.start - lead[i] - t0) * RATE));
      const b = Math.min(n - 1, Math.ceil((Math.max(pn.note.keyEnd, pn.note.start + 0.05) + 0.16 - t0) * RATE));
      for (let k = a; k <= b; k++) {
        const w = engagement(pn, t0 + k / RATE, lead[i]) * w0;
        num[k] += v * w;
        den[k] += w;
      }
    });
  };
  const prefZ = (pn: PlannedNote) => (pn.key.black ? PREF_Z_BLACK : PREF_Z_WHITE)[pn.finger];
  // a chord sits as deep as its most demanding note needs: a thumb on a black
  // key brings the whole hand in, and the long fingers play the white keys
  // further back, between the black ones
  const depthOf = new Map<PlannedNote, number>();
  for (let i = 0; i < planned.length; ) {
    let j = i;
    while (j < planned.length && planned[j].note.start - planned[i].note.start < 0.04) j++;
    const group = planned.slice(i, j);
    const need = Math.min(...group.map((pn) => prefZ(pn) - REST_TIPS[pn.finger][2]));
    for (const pn of group) depthOf.set(pn, need);
    i = j;
  }
  accumulate(zNum, zDen, (pn) => depthOf.get(pn)!);
  let z = gaussianBlur(fillWeighted(zNum, zDen, 0.115), 0.09 * RATE);

  // --- 2. lateral (x), first without yaw ---------------------------------
  const lateral = (yawAt: (t: number) => number) => {
    const num = new Float32Array(n);
    const den = new Float32Array(n);
    accumulate(num, den, (pn) => pn.cx - tipOffsetWorld(pn.finger, sx, yawAt(pn.note.start))[0]);
    let x = gaussianBlur(fillWeighted(num, den, home), 0.05 * RATE);
    // reachability while keys are held: project, re-smooth, repeat
    const lo = new Float32Array(n).fill(-Infinity);
    const hi = new Float32Array(n).fill(Infinity);
    for (const pn of planned) {
      const u = pn.cx - tipOffsetWorld(pn.finger, sx, yawAt(pn.note.start))[0];
      let tl = LATERAL_TOL[pn.finger];
      let th = LATERAL_TOL[pn.finger];
      if (pn.finger === 1) {
        // the thumb reaches much further under the palm than away from it
        if (sx > 0) tl = THUMB_UNDER_TOL;
        else th = THUMB_UNDER_TOL;
      }
      const a = Math.max(0, Math.floor((pn.stroke.contact - t0) * RATE));
      const b = Math.min(n - 1, Math.ceil((pn.stroke.release + 0.04 - t0) * RATE));
      for (let k = a; k <= b; k++) {
        lo[k] = Math.max(lo[k], u - tl);
        hi[k] = Math.min(hi[k], u + th);
      }
    }
    for (let it = 0; it < 4; it++) {
      for (let k = 0; k < n; k++) {
        if (lo[k] > hi[k]) x[k] = (lo[k] + hi[k]) / 2;
        else x[k] = Math.min(hi[k], Math.max(lo[k], x[k]));
      }
      if (it < 3) x = gaussianBlur(x, 0.02 * RATE);
    }
    return x;
  };
  let xArr = lateral(() => 0);

  // --- 3. yaw from the forearm (the elbow trails the wrist) ---------------
  const forearmYaw = (i: number) => {
    const wx = xArr[i];
    const ex = sx * SHOULDER_X + 0.5 * (wx - sx * SHOULDER_X);
    const fx = ex - wx;
    const fz = ELBOW_Z - z[i];
    return Math.atan2(sx * fx, fz); // canonical: + toward the thumb
  };
  let yawArr = gaussianBlur(sampled(t0, n, (_t, i) => 0.5 * forearmYaw(i)), 0.25 * RATE);

  // --- 4. thumb passages turn and roll the hand; fingers roll it their way --
  const xSig0 = new Signal(t0, RATE, xArr);
  const under = new Float32Array(n);
  const rollNum = new Float32Array(n);
  const rollDen = new Float32Array(n);
  planned.forEach((pn, i) => {
    const a = Math.max(0, Math.floor((pn.note.start - lead[i] - t0) * RATE));
    const b = Math.min(n - 1, Math.ceil((pn.note.keyEnd + 0.16 - t0) * RATE));
    for (let k = a; k <= b; k++) {
      const t = t0 + k / RATE;
      const w = engagement(pn, t, lead[i]);
      rollNum[k] += ROLL_BIAS[pn.finger] * w;
      rollDen[k] += w;
      if (pn.finger === 1) {
        const natural = xSig0.at(t) + tipOffsetWorld(1, sx, 0)[0];
        const disp = sx * (pn.cx - natural); // + = further under the palm than at rest
        under[k] = Math.max(under[k], clamp(disp / 0.04, 0, 1) * w);
      }
    }
  });
  const underS = gaussianBlur(under, 0.07 * RATE);
  yawArr = gaussianBlur(
    sampled(t0, n, (t, i) => yawArr[i] - 0.2 * underS[i] + 0.025 * drift(t * 0.21, hand === 'R' ? 3 : 4)),
    0.06 * RATE,
  );
  const yawSig = new Signal(t0, RATE, yawArr);
  const rollArr = gaussianBlur(
    sampled(t0, n, (t, i) => 0.03 + (rollDen[i] > 1e-3 ? rollNum[i] / Math.max(1, rollDen[i]) : 0) - 0.12 * underS[i] + 0.02 * drift(t * 0.17, hand === 'R' ? 5 : 6)),
    0.09 * RATE,
  );

  // lateral again, now with the hand's final turn known
  xArr = lateral((t) => yawSig.at(t));

  // contact depth per note, from the planned hand depth at its onset
  const zSig = new Signal(t0, RATE, z);
  for (const pn of planned) {
    const off = tipOffsetWorld(pn.finger, sx, yawSig.at(pn.note.start));
    const jz = (hash01(pn.note.id, 11) - 0.5) * 0.004;
    pn.cz = clamp(zSig.at(pn.note.start) + off[2] + jz, pn.key.playZMin, pn.key.playZMax);
    pn.cx = contactX(pn.key, pn.cz) + (hash01(pn.note.id, 7) - 0.5) * (pn.cz < -0.05 ? 0.001 : 0.0024);
  }

  // --- 5. height: hover, black-key lift, idle lift, travel arcs, attack dips --
  const busy = new Float32Array(n);
  const blackW = new Float32Array(n);
  const dips = new Float32Array(n);
  planned.forEach((pn, i) => {
    const a = Math.max(0, Math.floor((pn.note.start - lead[i] - t0) * RATE));
    const b = Math.min(n - 1, Math.ceil((pn.note.keyEnd + 0.16 - t0) * RATE));
    for (let k = a; k <= b; k++) {
      const w = engagement(pn, t0 + k / RATE, lead[i]);
      busy[k] = Math.max(busy[k], w);
      if (pn.key.black) blackW[k] = Math.max(blackW[k], w);
    }
    // attack: the wrist gives a little under the strike, then recovers
    const group = planned.filter((q) => Math.abs(q.note.start - pn.note.start) < 0.04).length;
    const depth = (0.0012 + 0.0042 * pn.note.velocity) * (group >= 3 ? 1.4 : 1) / Math.sqrt(group);
    const s = pn.note.start;
    const ka = Math.max(0, Math.floor((s - 0.05 - t0) * RATE));
    const kb = Math.min(n - 1, Math.ceil((s + 0.45 - t0) * RATE));
    for (let k = ka; k <= kb; k++) {
      const t = t0 + k / RATE;
      const u = t < s ? smoothstep(s - 0.05, s + 0.01, t) : 1 - smoothstep(s + 0.02, s + 0.45, t);
      dips[k] -= depth * u;
    }
  });
  // while any key is held the hand cannot fly off in an arc
  const holding = new Float32Array(n);
  for (const pn of planned) {
    const a = Math.max(0, Math.floor((pn.stroke.contact - 0.03 - t0) * RATE));
    const b = Math.min(n - 1, Math.ceil((pn.stroke.release + 0.03 - t0) * RATE));
    for (let k = a; k <= b; k++) holding[k] = 1;
  }
  const holdingS = gaussianBlur(holding, 0.02 * RATE);
  const busyS = gaussianBlur(busy, 0.35 * RATE);
  const blackS = gaussianBlur(blackW, 0.12 * RATE);
  const xSig = new Signal(t0, RATE, xArr);
  const speed = sampled(t0, n, (t) => Math.abs(xSig.slope(t)));
  const speedS = gaussianBlur(speed, 0.06 * RATE);
  const yRaw = sampled(t0, n, (t, i) => {
    const idle = 1 - busyS[i];
    const arc = 0.04 * Math.tanh(speedS[i] / 1.1) * (1 - holdingS[i]);
    return 0.061 + 0.008 * blackS[i] + 0.016 * idle + arc + Math.max(-0.009, dips[i]) + 0.0012 * drift(t * 0.35, hand === 'R' ? 7 : 8);
  });
  const yArr = gaussianBlur(yRaw, 0.03 * RATE);
  const pitchArr = sampled(t0, n, (t, i) => 0.07 - 0.9 * (yArr[i] - 0.061) + 0.015 * drift(t * 0.23, hand === 'R' ? 9 : 10) - 0.08 * underS[i]);

  // --- finger note lists and transitions -----------------------------------
  const fingers: PlannedNote[][] = [[], [], [], [], [], []];
  for (const pn of planned) fingers[pn.finger].push(pn);
  for (const lst of fingers) {
    lst.sort((a, b) => a.stroke.contact - b.stroke.contact);
    for (let i = 0; i < lst.length; i++) {
      lst[i].prev = lst[i - 1] ?? null;
      lst[i].next = lst[i + 1] ?? null;
    }
  }
  // crossing: on the way to its key, does a finger pass another finger that is holding a key?
  for (const pn of planned) {
    const p = pn.prev;
    if (!p) continue;
    const from = p.cx;
    const to = pn.cx;
    if (Math.abs(to - from) < 0.012) continue;
    const ta = p.stroke.release;
    const tb = pn.stroke.contact;
    const crossed = planned.some(
      (q) =>
        q.finger !== pn.finger &&
        q.stroke.contact < tb &&
        q.stroke.release > ta &&
        (q.cx - from) * (q.cx - to) < 0 &&
        // only fingers on the other side of the hand count as crossings
        (pn.finger === 1 || q.finger === 1 || Math.sign(sx * (to - from)) !== Math.sign(pn.finger - q.finger)),
    );
    if (crossed) pn.transit = pn.finger === 1 ? 'under' : 'over';
  }

  return {
    hand,
    sx,
    x: new Signal(t0, RATE, xArr),
    y: new Signal(t0, RATE, yArr),
    z: new Signal(t0, RATE, z),
    yaw: yawSig,
    pitch: new Signal(t0, RATE, pitchArr),
    roll: new Signal(t0, RATE, rollArr),
    fingers,
    notes: planned,
    home,
  };
}

/** Keep the hands from colliding: when they crowd each other the right hand rises over the left. */
function separateHands(L: HandTrack, R: HandTrack) {
  const n = L.x.data.length;
  const lift = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const sep = R.x.data[k] - L.x.data[k];
    lift[k] = clamp((0.17 - sep) * 0.7, 0, 0.06);
  }
  const s = gaussianBlur(lift, 0.15 * RATE);
  for (let k = 0; k < n; k++) {
    (R.y.data as Float32Array)[k] += s[k];
    (L.y.data as Float32Array)[k] -= s[k] * 0.15;
  }
}

export function planMotion(perf: Performance): MotionPlan {
  const t0 = -1;
  const t1 = perf.score.duration + 1;
  const n = Math.ceil((t1 - t0) * RATE) + 1;
  const L = planHand(perf, 'L', t0, n);
  const R = planHand(perf, 'R', t0, n);
  separateHands(L, R);
  return { hands: { L, R }, t0, t1 };
}

export { KEYS, TIP_RADIUS };
export type { V3 };
