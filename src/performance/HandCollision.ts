// Where the two hands would pass through each other. Each hand is a set of
// capsules: the three segments of the thumb and of each finger (from the
// joint positions of the forward kinematics, sized from the hand spec) and
// three across the palm. The overlap of two hands is the deepest
// interpenetration of any pair of capsules (negative: the clearance).
import { FINGERS, HAND_SPEC, THUMB, apply, fingerFK, thumbFK, type V3 } from '../core/handGeometry';
import type { HandPose } from './HandPoser';

export interface Capsule {
  a: V3;
  b: V3;
  r: number;
  /** thumb, finger (2..5) or palm */
  part: 'thumb' | 'finger' | 'palm';
  digit: number;
}

const PALM = HAND_SPEC.palm as { knuckleWidth: number; wristWidth: number; dorsalTop: number; palmarBottom: number };
const PALM_Y = (PALM.dorsalTop + PALM.palmarBottom) / 2;
const PALM_R = (PALM.dorsalTop - PALM.palmarBottom) / 2;
/** palm capsules in the hand frame: from the wrist out to the knuckles */
const PALM_SEGS: [V3, V3][] = [
  [
    [-PALM.wristWidth / 2 + PALM_R, PALM_Y, -0.012],
    [-PALM.knuckleWidth / 2 + PALM_R, PALM_Y, -0.088],
  ],
  [
    [0, PALM_Y, -0.012],
    [0, PALM_Y, -0.094],
  ],
  [
    [PALM.wristWidth / 2 - PALM_R, PALM_Y, -0.012],
    [PALM.knuckleWidth / 2 - PALM_R, PALM_Y, -0.082],
  ],
];
const segR = (w: V3, h: V3, k: number) => (w[k] + h[k]) / 4;

export function handCapsules(pose: HandPose): Capsule[] {
  const toW = (p: V3): V3 => {
    const q = apply(pose.rot, p);
    return [pose.wrist[0] + pose.sx * q[0], pose.wrist[1] + q[1], pose.wrist[2] + q[2]];
  };
  const out: Capsule[] = [];
  const tp = thumbFK(THUMB, pose.thumb).map(toW);
  for (let k = 0; k < 3; k++) out.push({ a: tp[k], b: tp[k + 1], r: segR(THUMB.widths, THUMB.heights, k), part: 'thumb', digit: 1 });
  FINGERS.forEach((f, i) => {
    const fp = fingerFK(f, pose.fingers[i]).map(toW);
    for (let k = 0; k < 3; k++) out.push({ a: fp[k], b: fp[k + 1], r: segR(f.widths, f.heights, k), part: 'finger', digit: f.id });
  });
  for (const [a, b] of PALM_SEGS) out.push({ a: toW(a), b: toW(b), r: PALM_R, part: 'palm', digit: 0 });
  return out;
}

/**
 * Shortest distance between segments p1-q1 and p2-q2 (Ericson, Real-Time
 * Collision Detection 5.1.9); the closest points go in c1 and c2 if given.
 */
export function segmentDistance(p1: V3, q1: V3, p2: V3, q2: V3, c1?: V3, c2?: V3): number {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
  const d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s = 0;
  let t = 0;
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    t = clamp01(f / e);
  } else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
    if (e <= 1e-12) {
      s = clamp01(-c / a);
    } else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const a0 = p1[0] + d1[0] * s;
  const a1 = p1[1] + d1[1] * s;
  const a2 = p1[2] + d1[2] * s;
  const b0 = p2[0] + d2[0] * t;
  const b1 = p2[1] + d2[1] * t;
  const b2 = p2[2] + d2[2] * t;
  if (c1) [c1[0], c1[1], c1[2]] = [a0, a1, a2];
  if (c2) [c2[0], c2[1], c2[2]] = [b0, b1, b2];
  return Math.hypot(a0 - b0, a1 - b1, a2 - b2);
}

export interface Overlap {
  /** deepest interpenetration (m); negative = the clearance between the hands */
  depth: number;
  a: Capsule | null;
  b: Capsule | null;
  /** the closest points of a and b */
  pa: V3;
  pb: V3;
}

/**
 * How far the hand of capsule `up` must rise (straight up) for the two
 * capsules to clear by `margin`, from their closest points: side by side they
 * need much more height than their overlap.
 */
export function liftToClear(o: Overlap, upIsA: boolean, margin: number): number {
  if (!o.a || !o.b) return 0;
  const [u, d] = upIsA ? [o.pa, o.pb] : [o.pb, o.pa];
  const r = o.a.r + o.b.r + margin;
  const h = Math.hypot(u[0] - d[0], u[2] - d[2]);
  if (h >= r) return 0;
  return Math.max(0, Math.sqrt(r * r - h * h) - (u[1] - d[1]));
}

export function handOverlap(L: HandPose, R: HandPose): Overlap {
  const far = Math.hypot(L.wrist[0] - R.wrist[0], L.wrist[1] - R.wrist[1], L.wrist[2] - R.wrist[2]);
  if (far > 0.32) return { depth: -(far - 0.32), a: null, b: null, pa: [0, 0, 0], pb: [0, 0, 0] };
  const cl = handCapsules(L);
  const cr = handCapsules(R);
  let best: Overlap = { depth: -Infinity, a: null, b: null, pa: [0, 0, 0], pb: [0, 0, 0] };
  const c1: V3 = [0, 0, 0];
  const c2: V3 = [0, 0, 0];
  for (const a of cl)
    for (const b of cr) {
      const d = a.r + b.r - segmentDistance(a.a, a.b, b.a, b.b, c1, c2);
      if (d > best.depth) best = { depth: d, a, b, pa: [...c1], pb: [...c2] };
    }
  return best;
}
