// One hand's complete pose at time t: wrist and palm from the planned
// channels, every fingertip target from that finger's notes, joint angles from
// the IK. A pure function of (track, keys, t).
import { KEYS, keySurfacePoint, keyTopNear } from '../core/keyboard';
import { REST_TIPS, TIP_RADIUS, THUMB, apply, fingerFK, FINGERS, mul, rotX, rotY, rotZ, thumbFK, transpose, type M3, type V3 } from '../core/handGeometry';
import { clamp, lastAtOrBefore, smoothstep } from '../core/math';
import { drift } from '../core/random';
import type { Hand } from '../core/types';
import { solveFinger, solveThumb, type FingerSolution, type ThumbSolution } from './HandIK';
import type { KeyMechanics } from './KeyMechanics';
import { ELBOW_Z, SHOULDER_X, type HandTrack, type PlannedNote } from './MotionPlanner';

export type FingerPhase = 'idle' | 'prepare' | 'attack' | 'hold' | 'release';

export interface FingerState {
  phase: FingerPhase;
  /** the note whose key the fingertip is on (attack, hold, or riding the key up) */
  note: PlannedNote | null;
  /** the note this finger is preparing to play */
  next: PlannedNote | null;
  /** fingertip-centre target and the FK result, world space */
  target: V3;
  tip: V3;
  error: number;
}

export interface HandPose {
  hand: Hand;
  sx: 1 | -1;
  wrist: V3;
  /** palm rotation in the hand's canonical (mirrored for L) frame */
  rot: M3;
  forearm: M3;
  fingers: FingerSolution[]; // index..little
  thumb: ThumbSolution;
  states: FingerState[]; // 1..5 (0 unused)
}

/** a quick rise that carries on about 5% past its end and settles back, arriving at rest (mechanical give) */
const easeOutGive = (u: number) => {
  const v = clamp(u, 0, 1) - 1;
  return 1 + 2.2 * v * v * v + 1.2 * v * v;
};

/** When the fingertip leaves a key after release (planned: see PlannedNote.leave). */
function liftoff(pn: PlannedNote): number {
  return pn.leave;
}

function toWorld(wrist: V3, R: M3, sx: number, p: V3): V3 {
  const q = apply(R, p);
  return [wrist[0] + sx * q[0], wrist[1] + q[1], wrist[2] + q[2]];
}

function toCanonical(wrist: V3, Rt: M3, sx: number, p: V3): V3 {
  return apply(Rt, [sx * (p[0] - wrist[0]), p[1] - wrist[1], p[2] - wrist[2]]);
}

const tmp = [0, 0, 0];

function surfaceY(pn: PlannedNote, d: number): number {
  keySurfacePoint(pn.key, pn.cz, d, tmp, pn.cx);
  return tmp[1];
}

interface FingerTarget {
  target: V3;
  phase: FingerPhase;
  note: PlannedNote | null;
  next: PlannedNote | null;
}

function fingerTarget(track: HandTrack, f: number, t: number, keys: KeyMechanics, wrist: V3, R: M3): FingerTarget {
  const list = track.fingers[f];
  const r = TIP_RADIUS[f];
  const i = lastAtOrBefore(list, t, (pn) => pn.stroke.contact);
  const cur = i >= 0 ? list[i] : null;
  const nxt = list[i + 1] ?? null;

  if (cur && t <= liftoff(cur)) {
    // in contact: the fingertip rides the key surface exactly
    const d = keys.depression(cur.note.midi, t);
    keySurfacePoint(cur.key, cur.cz, d, tmp, cur.cx);
    const phase: FingerPhase = t < cur.stroke.bottom ? 'attack' : t <= cur.stroke.release ? 'hold' : 'release';
    return { target: [tmp[0], tmp[1] + r, tmp[2]], phase, note: cur, next: null };
  }

  // free: between notes, preparing, or idle
  const seed = (track.hand === 'R' ? 20 : 40) + f;
  const restC: V3 = [
    REST_TIPS[f][0] + 0.0009 * drift(t * 0.31, seed),
    REST_TIPS[f][1] + 0.0016 * drift(t * 0.27 + 5, seed),
    REST_TIPS[f][2] + 0.0012 * drift(t * 0.23 + 9, seed),
  ];
  // with the other hand close, a free thumb rests tucked in and up under the palm
  if (f === 1 && track.thumbTuck) {
    const w = track.thumbTuck.at(t);
    restC[0] += 0.033 * w;
    restC[1] += 0.02 * w;
    restC[2] += 0.009 * w;
  }
  const restW = toWorld(wrist, R, track.sx, restC);
  const tr = cur ? liftoff(cur) : -Infinity;
  const tc = nxt ? nxt.stroke.contact : Infinity;
  const avail = Math.min(4, tc - tr);
  const wPrev = cur ? 1 - smoothstep(tr, tr + 0.22, t) : 0;
  const prepT = clamp(avail * 0.85, 0.05, 0.55);
  const leadT = clamp(avail * 0.18, 0.008, 0.05);
  const wNext = nxt ? smoothstep(tc - prepT, tc - leadT, t) : 0;
  let lx = restW[0];
  let lz = restW[2];
  if (cur) {
    lx += (cur.cx - lx) * wPrev;
    lz += (cur.cz - lz) * wPrev;
  }
  if (nxt) {
    lx += (nxt.cx - lx) * wNext;
    lz += (nxt.cz - lz) * wNext;
  }
  const hover = keyTopNear(lx, lz, r + 0.0022) + r + 0.0035;
  let lift = 0;
  if (nxt) {
    lift = clamp(0.0035 + 0.015 * nxt.note.velocity, 0.004, 0.02) * Math.min(1, avail / 0.3);
    if (nxt.transit === 'over') lift += 0.012 * Math.min(1, avail / 0.2);
    if (nxt.transit === 'under') lift = Math.min(lift, 0.002);
  }
  const plateau = Math.max(restW[1], hover) + (nxt ? lift * smoothstep(tc - prepT, tc - prepT * 0.4, t) : 0);
  let y = plateau;
  let phase: FingerPhase = nxt && wNext > 0.01 ? 'prepare' : 'idle';
  // rising off the previous key
  if (cur) {
    const rho = clamp(avail * 0.35, 0.02, 0.09);
    if (t < tr + rho) {
      const y0 = surfaceY(cur, keys.depression(cur.note.midi, tr)) + r;
      const rise = y0 + (plateau - y0) * easeOutGive((t - tr) / rho);
      y = plateau > y0 ? rise : Math.min(y, rise);
      phase = 'release';
    }
    // never sink into the key that is still rising beneath
    if (Math.abs(lx - cur.cx) < 0.012) y = Math.max(y, surfaceY(cur, keys.depression(cur.note.midi, t)) + r);
  }
  // the strike: accelerating down onto the next key
  if (nxt) {
    const v = nxt.note.velocity;
    const delta = clamp(avail * 0.45, 0.028, 0.11) * (1.15 - 0.35 * v);
    if (t > tc - delta) {
      const yk = surfaceY(nxt, keys.depression(nxt.note.midi, tc)) + r;
      const u = (t - (tc - delta)) / delta;
      y = Math.min(y, plateau + (yk - plateau) * u * u);
      phase = 'prepare';
    }
  }
  return { target: [lx, y, lz], phase, note: null, next: nxt && wNext > 0.01 ? nxt : null };
}

/** wrist and palm frame at t */
export function handFrame(track: HandTrack, t: number, d?: number[]): { wrist: V3; R: M3 } {
  const wrist: V3 = [track.x.at(t), track.y.at(t), track.z.at(t)];
  let yaw = track.yaw.at(t);
  let roll = track.roll.at(t);
  let pitch = track.pitch.at(t);
  if (d) {
    wrist[0] += d[0];
    wrist[1] += d[1];
    wrist[2] += d[2];
    yaw += d[3];
    roll += d[4];
    pitch += d[5];
  }
  const R = mul(mul(rotY(yaw), rotX(pitch)), rotZ(roll));
  return { wrist, R };
}

interface Solved {
  states: FingerState[];
  fingers: FingerSolution[];
  thumb: ThumbSolution;
  /** weighted contact residuals, 3 per finger 1..5 */
  res: number[];
}

/** contact weight: fingers on keys count fully; fingers about to land ease in; releasing fingers ease out */
function contactWeight(ft: FingerTarget, t: number): number {
  if (ft.note) {
    if (ft.phase === 'attack' || ft.phase === 'hold') return 1;
    return 1 - smoothstep(ft.note.stroke.release, liftoff(ft.note), t); // riding the key up
  }
  // reaching full weight exactly as the fingertip lands, so the hand never jumps at contact
  if (ft.next) return smoothstep(ft.next.stroke.contact - 0.09, ft.next.stroke.contact, t);
  return 0;
}

function solveAll(track: HandTrack, keys: KeyMechanics, t: number, d: number[]): Solved {
  const { wrist, R } = handFrame(track, t, d);
  const Rt = transpose(R);
  const sx = track.sx;
  const states: FingerState[] = [{ phase: 'idle', note: null, next: null, target: [0, 0, 0], tip: [0, 0, 0], error: 0 }];
  const fingers: FingerSolution[] = [];
  let thumb: ThumbSolution = { swing: 0, twist: 0, angles: [0, 0, 0], error: 0 };
  const res: number[] = [];
  for (let f = 1; f <= 5; f++) {
    const ft = fingerTarget(track, f, t, keys, wrist, R);
    const q = toCanonical(wrist, Rt, sx, ft.target);
    let tipC: V3;
    let error: number;
    if (f === 1) {
      thumb = solveThumb(q);
      tipC = thumbFK(THUMB, thumb)[3];
      error = thumb.error;
    } else {
      const sol = solveFinger(f - 2, q, ft.phase === 'idle' ? 0.08 : 0);
      fingers.push(sol);
      tipC = fingerFK(FINGERS[f - 2], sol)[3];
      error = sol.error;
    }
    const tip = toWorld(wrist, R, sx, tipC);
    states.push({ phase: ft.phase, note: ft.note, next: ft.next, target: ft.target, tip, error });
    const w = contactWeight(ft, t);
    res.push(w * (ft.target[0] - tip[0]), w * (ft.target[1] - tip[1]), w * (ft.target[2] - tip[2]));
  }
  return { states, fingers, thumb, res };
}

/** regularisation: how much the hand resists leaving its planned pose (per parameter) */
const PRIOR = [0.2, 0.12, 0.2, 0.012, 0.012, 0.012];
const STEP = [1e-4, 1e-4, 1e-4, 1e-3, 1e-3, 1e-3];
const NP = PRIOR.length;

/**
 * Contact has priority: if fingers on keys (or about to land) cannot reach
 * them from the planned hand, the hand yields: a few damped Gauss-Newton steps
 * over wrist position, yaw, roll and pitch. Recomputed from scratch at every t,
 * from the same start, so it is as deterministic as everything else.
 */
function comply(track: HandTrack, keys: KeyMechanics, t: number): number[] {
  const d = [0, 0, 0, 0, 0, 0];
  let cur = solveAll(track, keys, t, d);
  for (let it = 0; it < 6; it++) {
    const r0 = cur.res;
    let rr = 0;
    for (const v of r0) rr += v * v;
    if (rr < 1e-8) break; // all contacts within ~0.1 mm
    // J^T J and J^T r by finite differences (5 parameters)
    const J: number[][] = [];
    for (let k = 0; k < NP; k++) {
      const dk = d.slice();
      dk[k] += STEP[k];
      const rk = solveAll(track, keys, t, dk).res;
      J.push(rk.map((v, i) => (v - r0[i]) / STEP[k]));
    }
    const A: number[][] = [];
    const b: number[] = [];
    for (let a = 0; a < NP; a++) {
      A.push([]);
      for (let c = 0; c < NP; c++) {
        let sum = 0;
        for (let i = 0; i < r0.length; i++) sum += J[a][i] * J[c][i];
        A[a].push(sum + (a === c ? PRIOR[a] * PRIOR[a] + 1e-9 : 0));
      }
      let sb = 0;
      for (let i = 0; i < r0.length; i++) sb += J[a][i] * r0[i];
      b.push(-sb - PRIOR[a] * PRIOR[a] * d[a]);
    }
    const step = solve5(A, b);
    for (let k = 0; k < NP; k++) d[k] += step[k];
    for (let k = 0; k < 3; k++) d[k] = clamp(d[k], -0.05, 0.05);
    for (let k = 3; k < NP; k++) d[k] = clamp(d[k], -0.4, 0.4);
    cur = solveAll(track, keys, t, d);
  }
  return d;
}

/** half-width of the window the compliance is averaged over (s) */
const COMPLY_BLUR = 1 / 120;

/**
 * The hand at t. Where several fingers converge on a chord the compliance
 * solve can hop between near-equal compromises from one instant to the next,
 * so for display it is averaged over a frame either side (still a pure
 * function of t); planning, which only probes steady moments, can skip that.
 */
export function poseHand(track: HandTrack, keys: KeyMechanics, t: number, steady = true): HandPose {
  const sx = track.sx;
  const d1 = comply(track, keys, t);
  let d = d1;
  if (steady) {
    const d0 = comply(track, keys, t - COMPLY_BLUR);
    const d2 = comply(track, keys, t + COMPLY_BLUR);
    d = d1.map((v, k) => 0.25 * d0[k] + 0.5 * v + 0.25 * d2[k]);
  }
  const cur = solveAll(track, keys, t, d);
  const { wrist, R } = handFrame(track, t, d);
  const { states, fingers, thumb } = cur;
  // the forearm points from the wrist back toward an elbow that trails the hand
  const ex = sx * SHOULDER_X + 0.5 * (wrist[0] - sx * SHOULDER_X);
  const dx = sx * (ex - wrist[0]);
  const dy = 0.02;
  const dz = ELBOW_Z - wrist[2];
  const l = Math.hypot(dx, dy, dz);
  const yawF = Math.atan2(dx / l, dz / l);
  const pitchF = -Math.asin(dy / l);
  const forearm = mul(mul(rotY(yawF), rotX(pitchF)), rotZ(track.roll.at(t) * 0.5));
  return { hand: track.hand, sx, wrist, rot: R, forearm, fingers, thumb, states };
}

/** Gaussian elimination with partial pivoting for the small normal equations. */
function solve5(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k];
    x[r] = sum / (M[r][r] || 1e-12);
  }
  return x;
}

export { KEYS };
