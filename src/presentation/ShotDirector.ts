// The director: a library of designed camera moves ("shots") and an edit of
// the piece that cuts between them at musical moments, the way a concert
// film is cut.
//
// Editing. Every onset is a candidate cut, scored by what makes a cut feel
// right: a strong attack, a breath before it, a bar line, a new bass note;
// a cut in the middle of a fast run is penalised. Dynamic programming picks
// the cuts, preferring shots of 6-9 s when the music is calm and 3-5 s as it
// builds. Each segment then gets a shot by film grammar: open wide, close on
// a pull-back, alternate wide/medium/close, never repeat a recent shot, put
// close-ups on the hand that leads. The edit is computed once, so a camera
// state is still a pure function of t.
//
// Shots. Each is a move over its segment (dolly, truck, crane, orbit, push,
// a static locked-off frame) whose subject is pre-tracked: the camera knows
// where the hands will be, so it follows them smoothly instead of chasing.
// Close shots stop down (depth of field goes with distance squared over focal
// length squared), so the fingers stay sharp even this near.
import * as THREE from 'three';
import { keyOf } from '../core/keyboard';
import { clamp } from '../core/math';
import { drift } from '../core/random';
import type { Hand } from '../core/types';
import type { CameraState } from './CinematicCamera';

export interface DirectorContext {
  duration: number;
  center(t: number): number;
  span(t: number): number;
  /** fingertip centre of a hand (smoothed) */
  tip(h: Hand, t: number): THREE.Vector3;
  wrist(h: Hand, t: number): THREE.Vector3;
  peak(t: number): number;
  lead(t: number): number; // 0 = left leads, 1 = right
}

export interface NoteRef {
  hand: Hand;
  midi: number;
  start: number;
  end: number;
  velocity: number;
}

interface Segment {
  a: number;
  b: number;
  shot: Shot;
  hand: Hand; // the hand the shot is about
  side: number; // +1 right hand / treble side, -1 left / bass side
  key: NoteRef | null; // the note a key close-up waits for
  seed: number;
}

type Scale = 'wide' | 'medium' | 'close' | 'detail';

interface Features {
  intensity: number; // 0..1
  density: number; // onsets per second
  span: number; // m between the hands
  travel: number; // m the lead hand moves
  lead: Hand;
  first: boolean;
  last: boolean;
  length: number;
}

interface Shot {
  id: string;
  name: string;
  scale: Scale;
  /** how well the shot suits a segment (higher is better; -Infinity never) */
  fit(f: Features): number;
  frame(ctx: DirectorContext, t: number, s: Segment): CameraState;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** eased progress through the shot: steady in the middle, soft at the ends */
const ease = (u: number) => {
  const c = clamp(u, 0, 1);
  return 0.5 * c + 0.5 * c * c * (3 - 2 * c);
};
/** a point at azimuth `az` (from +z toward +x), distance `d`, height `h` around `p` */
const around = (p: THREE.Vector3, az: number, d: number, h: number) => V(p.x + Math.sin(az) * d, h, p.z + Math.cos(az) * d);

function state(pos: THREE.Vector3, target: THREE.Vector3, focalLength: number, fstop: number, focusAt: THREE.Vector3 = target, roll = 0): CameraState {
  return { position: pos, target, focalLength, fstop, focus: pos.distanceTo(focusAt), roll };
}

/** the shot's subject, pre-tracked: mostly where it will be mid-shot, following it gently */
function subject(ctx: DirectorContext, h: Hand | 'both', t: number, s: Segment, follow = 0.45): THREE.Vector3 {
  const at = (u: number) =>
    h === 'both' ? V(ctx.center(u), 0.02, -0.07) : ctx.tip(h, u);
  const mid = at((s.a + s.b) / 2);
  return mid.lerp(at(t), follow);
}

const SHOTS: Shot[] = [
  {
    id: 'opening',
    name: 'Along the keys, into the light',
    scale: 'medium',
    fit: (f) => (f.first ? 10 : -1),
    frame(ctx, t, s) {
      // the opening: low from the treble end, looking down the keyboard
      // toward the window, so the hands are lit from behind; a slow push in on
      // a fairly long lens with the keys falling away into soft focus
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.4);
      const target = V(c.x - 0.03, 0.03, -0.04);
      // focus stays on the nearer (right) hand: the far one softens with the keys
      return state(around(target, 1.22, lerp(1.05, 0.84, u), lerp(0.2, 0.155, u)), target, lerp(50, 60, u), 4, ctx.tip('R', t), -0.008);
    },
  },
  {
    id: 'establishing',
    name: 'Establishing',
    scale: 'wide',
    fit: (f) => (f.first ? 0 : 0.2 - f.intensity),
    frame(ctx, t, s) {
      // a crane down from high over the player's place: from the score on the
      // desk and the piano's face, tilting down to the hands; the forearms run
      // in under the camera, their ends behind it
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.3);
      const pos = V(c.x + lerp(0.16, 0.06, u), lerp(1.12, 0.78, u), 0.33);
      const target = V(c.x - 0.04, lerp(0.24, 0.05, u), lerp(-0.2, -0.07, u));
      return state(pos, target, 28, 6.3, c);
    },
  },
  {
    id: 'pullback',
    name: 'Pull-back reveal',
    scale: 'wide',
    fit: (f) => (f.last ? 10 : -Infinity),
    frame(ctx, t, s) {
      // the end: rising straight up over the hands and widening, the whole
      // keyboard, the score and the light coming into the frame
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.3);
      const pos = V(c.x + lerp(0.1, 0.02, u), lerp(0.42, 1.2, u), lerp(0.24, 0.3, u));
      const target = V(c.x, lerp(0.0, 0.1, u), lerp(-0.05, -0.16, u));
      return state(pos, target, lerp(42, 26, u), 6.3, c);
    },
  },
  {
    id: 'rise',
    name: 'Crane up',
    scale: 'wide',
    fit: (f) => 0.4 + 0.6 * f.intensity - (f.length < 4 ? 1 : 0),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.4);
      const target = V(c.x, 0.02, -0.06);
      return state(around(target, 1.38, 0.78, lerp(0.05, 0.36, u)), target, 46, 5.6, ctx.tip(s.hand, t));
    },
  },
  {
    id: 'silhouette',
    name: 'Into the light',
    scale: 'wide',
    fit: (f) => 0.7 - f.density * 0.08,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.35);
      const target = V(c.x - 0.25, 0.08, -0.08);
      return state(around(target, lerp(1.46, 1.4, u), 1.25, 0.11), target, 85, 4, ctx.tip(s.hand, t));
    },
  },
  {
    id: 'overhead-crane',
    name: 'Overhead, turning',
    scale: 'wide',
    fit: (f) => 0.5 + Math.min(1, f.span / 0.5) * 0.6,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.4);
      const target = V(c.x, 0.0, -0.04);
      const pos = V(c.x + 0.03, lerp(0.8, 0.68, u), 0.2);
      return state(pos, target, 30, 7, target, lerp(-0.1, 0.1, u));
    },
  },
  {
    id: 'bass-profile',
    name: 'Down the keys from the bass',
    scale: 'medium',
    fit: (f) => 0.6 + (f.lead === 'L' ? 0.4 : 0),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.5);
      const target = V(c.x + 0.05, 0.02, -0.05);
      const focus = ctx.lead(t) > 0.5 ? ctx.tip('R', t) : ctx.tip('L', t);
      return state(around(target, -1.33, lerp(0.95, 0.8, u), 0.17), target, 62, 5, focus, 0.01);
    },
  },
  {
    id: 'treble-profile',
    name: 'Down the keys from the treble',
    scale: 'medium',
    fit: (f) => 0.6 + (f.lead === 'R' ? 0.3 : 0),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, 'both', t, s, 0.5);
      const target = V(c.x - 0.05, 0.02, -0.05);
      const focus = ctx.lead(t) > 0.5 ? ctx.tip('R', t) : ctx.tip('L', t);
      return state(around(target, 1.36, lerp(0.85, 0.72, u), 0.19), target, 66, 5, focus, -0.012);
    },
  },
  {
    id: 'dutch',
    name: 'Dutch angle',
    scale: 'medium',
    fit: (f) => 0.2 + f.intensity * 1.1,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.6);
      return state(around(c, s.side * 1.18, lerp(0.62, 0.5, u), 0.2), c, 45, 5.6, c, -s.side * 0.13);
    },
  },
  {
    id: 'handheld',
    name: 'Handheld',
    scale: 'medium',
    fit: (f) => 0.3 + f.intensity * 0.8 + Math.min(0.5, f.density * 0.06),
    frame(ctx, t, s) {
      const c = subject(ctx, s.hand, t, s, 0.75);
      const j = (k: number, a: number) => (drift(t * 0.9 + k, s.seed + k) + 0.4 * drift(t * 2.6 + k, s.seed + 7 * k)) * a;
      const pos = around(c, s.side * 1.08, 0.55, 0.15).add(V(j(1, 0.006), j(2, 0.005), j(3, 0.006)));
      return state(pos, c.clone().add(V(j(4, 0.004), j(5, 0.003), 0)), 50, 5.6, c, j(6, 0.012));
    },
  },
  {
    id: 'orbit',
    name: 'Orbit',
    scale: 'medium',
    fit: (f) => 0.6 + (f.length > 5 ? 0.3 : -0.3),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.5);
      return state(around(c, s.side * lerp(1.25, 0.6, u), 0.45, 0.13), c, 50, 6.3, c);
    },
  },
  {
    id: 'over-shoulder',
    name: 'Over the shoulder',
    scale: 'medium',
    fit: (f) => 0.7,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.5);
      const w = ctx.wrist(s.hand, (s.a + s.b) / 2);
      const pos = V(w.x + s.side * lerp(0.13, 0.1, u), lerp(0.4, 0.34, u), w.z + lerp(0.27, 0.22, u));
      return state(pos, c, 34, 6.3, c);
    },
  },
  {
    id: 'low-front',
    name: 'Low, from the key slip',
    scale: 'close',
    fit: (f) => 0.5 + (f.density > 3 ? 0.3 : 0),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.55);
      const pos = V(c.x + s.side * lerp(0.17, 0.12, u), 0.028, 0.24);
      return state(pos, c.clone().add(V(0, 0.015, 0)), 45, 11, c);
    },
  },
  {
    id: 'key-slider',
    name: 'Slider along the keys',
    scale: 'close',
    fit: (f) => 0.5 + Math.min(0.6, f.travel * 2),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.7);
      const pos = V(c.x + s.side * lerp(0.36, 0.22, u), 0.045, 0.17);
      return state(pos, c.clone().add(V(-s.side * 0.03, 0.01, 0)), 55, 14, c);
    },
  },
  {
    id: 'macro',
    name: 'Macro on the fingers',
    scale: 'detail',
    fit: (f) => 0.6 + Math.min(0.5, f.density * 0.07),
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.6);
      return state(around(c, s.side * lerp(0.98, 0.78, u), 0.4, 0.07), c.clone().add(V(0, 0.008, 0)), 75, 16, c);
    },
  },
  {
    id: 'dorsal',
    name: 'The back of the hand',
    scale: 'detail',
    fit: (f) => 0.55 - f.intensity * 0.3,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const w = ctx.wrist(s.hand, lerp((s.a + s.b) / 2, t, 0.5));
      const target = w.clone().add(V(0, 0.01, -0.07));
      const pos = w.clone().add(V(s.side * lerp(0.16, 0.12, u), 0.2, lerp(0.12, 0.09, u)));
      return state(pos, target, 62, 16, target);
    },
  },
  {
    id: 'key-xcu',
    name: 'Waiting on a key',
    scale: 'detail',
    fit: (f) => 0.45 + (f.length < 6 ? 0.3 : -0.4),
    frame(ctx, t, s) {
      // locked off on the key of the strongest note in the shot; the finger comes to it
      const k = s.key;
      const x = k ? keyOf(k.midi).x : ctx.tip(s.hand, t).x;
      const black = k ? [1, 3, 6, 8, 10].includes(k.midi % 12) : false;
      const target = V(x, black ? 0.02 : 0.008, black ? -0.08 : -0.035);
      const pos = V(x + s.side * 0.2, 0.05, 0.22);
      return state(pos, target, 85, 16, target);
    },
  },
  {
    id: 'desk',
    name: 'From the music desk',
    scale: 'close',
    fit: (f) => 0.45,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.5);
      const pos = V(c.x - s.side * 0.12, lerp(0.25, 0.22, u), -0.13);
      return state(pos, c.clone().add(V(0, 0, 0.05)), 50, 14, c);
    },
  },
  {
    id: 'push-in',
    name: 'Slow push-in',
    scale: 'medium',
    fit: (f) => 0.3 + f.intensity * 1.2,
    frame(ctx, t, s) {
      const u = ease((t - s.a) / (s.b - s.a));
      const c = subject(ctx, s.hand, t, s, 0.5);
      return state(around(c, s.side * 1.3, lerp(0.85, 0.42, u), lerp(0.18, 0.12, u)), c, lerp(55, 70, u), 9, c);
    },
  },
];

const SCALE_ORDER: Scale[] = ['wide', 'medium', 'close', 'detail'];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** seconds of each beat from a tempo map (assumes the file's beats start at 0) */
function beatTimes(tempos: { time: number; bpm: number }[], duration: number): number[] {
  const out: number[] = [];
  const ts = tempos.length ? tempos.slice().sort((a, b) => a.time - b.time) : [{ time: 0, bpm: 120 }];
  let t = 0;
  let i = 0;
  while (t <= duration + 1 && out.length < 20000) {
    while (i + 1 < ts.length && ts[i + 1].time <= t + 1e-6) i++;
    out.push(t);
    t += 60 / Math.max(20, ts[i].bpm);
  }
  return out;
}

export interface DirectorOptions {
  /** with nothing to cut to (no notes: live playing), a new shot every this many seconds */
  cadence?: number;
  /** the hand a shot is about, decided as it begins (live playing: whichever hand is playing then) */
  handAt?: (t: number) => Hand;
}

export class ShotDirector {
  readonly segments: Segment[] = [];
  private handAt?: (t: number) => Hand;

  constructor(
    private ctx: DirectorContext,
    notes: NoteRef[],
    tempos: { time: number; bpm: number }[],
    opts: DirectorOptions = {},
  ) {
    this.handAt = opts.handAt;
    const D = ctx.duration;
    const sorted = notes.slice().sort((a, b) => a.start - b.start);
    // onsets, chords merged
    const onsets: { t: number; vel: number; bass: boolean; gap: number; dense: number }[] = [];
    let lastEnd = -1;
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const prev = onsets[onsets.length - 1];
      if (prev && n.start - prev.t < 0.04) {
        prev.vel = Math.max(prev.vel, n.velocity);
        prev.bass ||= n.hand === 'L' && n.midi < 55;
      } else onsets.push({ t: n.start, vel: n.velocity, bass: n.hand === 'L' && n.midi < 55, gap: n.start - lastEnd, dense: 0 });
      lastEnd = Math.max(lastEnd, n.end);
    }
    for (const o of onsets) o.dense = onsets.filter((p) => Math.abs(p.t - o.t) < 0.5).length;
    const beats = beatTimes(tempos, D);
    const onBar = (t: number) => {
      let best = Infinity;
      let bi = 0;
      for (let k = 0; k < beats.length; k++) {
        const d = Math.abs(beats[k] - t);
        if (d < best) {
          best = d;
          bi = k;
        }
        if (beats[k] > t + 1) break;
      }
      return best < 0.07 ? (bi % 4 === 0 ? 1 : bi % 2 === 0 ? 0.5 : 0.15) : 0;
    };
    // candidate cuts: a hair before the attack, so the new shot sees it land
    type Cand = { t: number; q: number };
    const cands: Cand[] = [{ t: 0, q: 0 }];
    for (const o of onsets) {
      if (o.t < 1.5 || o.t > D - 2) continue;
      const q = 0.8 * o.vel + 1.2 * clamp(o.gap / 0.4, 0, 1) + 1.0 * onBar(o.t) + (o.bass ? 0.5 : 0) - Math.max(0, o.dense - 4) * 0.3;
      cands.push({ t: Math.max(0, o.t - 0.05), q });
    }
    cands.push({ t: D, q: 0 });
    // dynamic programming over the cuts
    const target = (t: number) => lerp(7.5, 3.8, ctx.peak(t));
    const N = cands.length;
    const best = new Float64Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    best[0] = 0;
    for (let j = 1; j < N; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const len = cands[j].t - cands[i].t;
        if (len < 2.2) continue;
        // the last shot (the pull-back) may hold as long as the ending rings
        if (len > (j === N - 1 ? 30 : 12)) break;
        const tl = target((cands[i].t + cands[j].t) / 2);
        const c = best[i] + (j === N - 1 ? 0.3 * Math.max(0, len - 9) : ((len - tl) / 2) ** 2 - cands[j].q);
        if (c < best[j]) {
          best[j] = c;
          from[j] = i;
        }
      }
    }
    const cuts: number[] = [];
    if (isFinite(best[N - 1])) for (let j = N - 1; j > 0; j = from[j]) cuts.push(cands[j].t);
    else {
      // nothing to cut to (pathological files, live playing): every few seconds
      const every = opts.cadence ?? 6;
      for (let t = Math.floor((D - 0.01) / every) * every; t > 0; t -= every) cuts.push(t);
    }
    cuts.push(0);
    cuts.reverse();
    if (cuts[cuts.length - 1] < D) cuts.push(D);

    // shots by grammar
    const seedBase = Math.round(sorted.reduce((s, n) => s + n.midi * 7 + n.start * 13, 17)) >>> 0;
    const rand = rng(seedBase);
    const recent: string[] = [];
    let prevScale: Scale | null = null;
    let prevHand: Hand | null = null;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k];
      const b = cuts[k + 1];
      const inSeg = sorted.filter((n) => n.start >= a && n.start < b);
      let pk = 0;
      let sp = 0;
      for (let i = 0; i < 8; i++) {
        const t = lerp(a, b, (i + 0.5) / 8);
        pk += ctx.peak(t) / 8;
        sp += ctx.span(t) / 8;
      }
      const leadW = (() => {
        let w = 0;
        for (let i = 0; i < 8; i++) w += ctx.lead(lerp(a, b, (i + 0.5) / 8)) / 8;
        return w;
      })();
      const lead: Hand = leadW >= 0.5 ? 'R' : 'L';
      const x0 = ctx.tip(lead, a).x;
      let travel = 0;
      for (let i = 1; i <= 8; i++) travel = Math.max(travel, Math.abs(ctx.tip(lead, lerp(a, b, i / 8)).x - x0));
      const f: Features = {
        intensity: pk,
        density: inSeg.length / Math.max(0.5, b - a),
        span: sp,
        travel,
        lead,
        first: k === 0,
        last: k + 2 === cuts.length,
        length: b - a,
      };
      let pick = SHOTS[0];
      let bestScore = -Infinity;
      for (const shot of SHOTS) {
        let sc = shot.fit(f);
        if (!isFinite(sc)) continue;
        const ago = recent.lastIndexOf(shot.id);
        if (ago >= 0) sc -= ago === recent.length - 1 ? 100 : 1.6 / (recent.length - ago);
        if (prevScale) {
          const d = Math.abs(SCALE_ORDER.indexOf(shot.scale) - SCALE_ORDER.indexOf(prevScale));
          sc += d === 0 ? -0.6 : d === 1 ? 0.25 : d === 2 ? 0.1 : -0.2; // move one or two steps in scale
        }
        if (!f.first && shot.id === 'establishing') sc -= 0.5;
        sc += rand() * 0.35;
        if (sc > bestScore) {
          bestScore = sc;
          pick = shot;
        }
      }
      // close shots go to the leading hand; wider ones alternate sides now and then
      let hand: Hand = lead;
      if ((pick.scale === 'medium' || pick.scale === 'wide') && prevHand === lead && rand() < 0.35) hand = lead === 'R' ? 'L' : 'R';
      const handNotes = inSeg.filter((n) => n.hand === hand && n.start > a + 0.6 && n.start < b - 0.4);
      const key = handNotes.length ? handNotes.reduce((m, n) => (n.velocity > m.velocity ? n : m)) : null;
      this.segments.push({ a, b, shot: pick, hand, side: hand === 'R' ? 1 : -1, key, seed: (seedBase + k * 101) >>> 0 });
      recent.push(pick.id);
      prevScale = pick.scale;
      prevHand = hand;
    }
  }

  private segAt(t: number): Segment {
    const S = this.segments;
    let lo = 0;
    let hi = S.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (S[m].a <= t) lo = m;
      else hi = m - 1;
    }
    return S[lo];
  }

  evaluate(t: number): CameraState {
    let s = this.segAt(clamp(t, 0, this.ctx.duration));
    if (this.handAt) {
      const hand = this.handAt(s.a);
      s = { ...s, hand, side: hand === 'R' ? 1 : -1 };
    }
    return s.shot.frame(this.ctx, t, s);
  }

  /** the shot on screen at t, for the interface */
  shotAt(t: number): { name: string; index: number; count: number; start: number; end: number } {
    const s = this.segAt(clamp(t, 0, this.ctx.duration));
    return { name: s.shot.name, index: this.segments.indexOf(s), count: this.segments.length, start: s.a, end: s.b };
  }

  static get shotCount() {
    return SHOTS.length;
  }

  /** every shot, framed on its own around t (for tools: a contact sheet of the whole library) */
  previewShot(index: number, t: number, hand: Hand = 'R'): { name: string; state: CameraState } {
    const shot = SHOTS[index % SHOTS.length];
    const notes = this.segments.flatMap((sg) => (sg.key ? [sg.key] : []));
    const key = notes.length ? notes.reduce((m, n) => (Math.abs(n.start - t) < Math.abs(m.start - t) ? n : m)) : null;
    const seg: Segment = { a: t - 3, b: t + 3, shot, hand, side: hand === 'R' ? 1 : -1, key, seed: 7 };
    return { name: shot.name, state: shot.frame(this.ctx, t, seg) };
  }
}
