// How far a posed hand is into the piano: the hand as spheres along its palm,
// fingers and thumb, against the solid parts beneath it (the keys as they are
// at that moment, the key slip in front, the nameboard behind, the cheeks at
// either end). A measurement for tests and tools (tools/hand-check.cjs), not
// part of the plan.
import { BLACK_FRONT_Z, BLACK_WIDTH_BOTTOM, KEYS, KEY_COUNT, keySurfacePoint, noteName } from '../core/keyboard';
import { FINGERS, HAND_SPEC, THUMB, apply, fingerFK, thumbFK, type V3 } from '../core/handGeometry';
import type { HandPose } from './HandPoser';

export interface Sphere {
  part: string;
  p: V3;
  r: number;
  /** the body of the hand (palm, knuckles, thumb base) rather than a finger */
  body: boolean;
}

const PB = HAND_SPEC.palm.palmarBottom;
/** points on the underside of the palm (hand frame) */
const PALM: [string, V3][] = [
  ['heel (thumb side)', [-0.03, PB, -0.01]],
  ['heel (little-finger side)', [0.03, PB, -0.01]],
  ['palm', [0, PB, -0.05]],
  ['palm (index knuckle)', [-0.036, PB, -0.08]],
  ['palm (little knuckle)', [0.036, PB, -0.075]],
];

/** every part of a posed hand that could touch the piano, as spheres in world space */
export function handSpheres(pose: HandPose): Sphere[] {
  const { wrist, rot: R, sx } = pose;
  const world = (p: V3): V3 => {
    const q = apply(R, p);
    return [wrist[0] + sx * q[0], wrist[1] + q[1], wrist[2] + q[2]];
  };
  const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const out: Sphere[] = PALM.map(([part, p]) => ({ part, p: world(p), r: 0.002, body: true }));
  const chain = (name: string, joints: string[], pts: V3[], heights: V3, tip: number) => {
    for (let k = 0; k < 3; k++) {
      const r = heights[k] / 2;
      out.push({ part: `${name} ${joints[k]}`, p: world(pts[k]), r, body: k === 0 });
      out.push({ part: `${name} ${['first', 'middle', 'end'][k]} segment`, p: world(mid(pts[k], pts[k + 1])), r, body: false });
    }
    out.push({ part: `${name} tip`, p: world(pts[3]), r: tip, body: false });
  };
  FINGERS.forEach((f, i) => chain(f.name, ['knuckle', 'middle joint', 'end joint'], fingerFK(f, pose.fingers[i]), f.heights, f.tipRadius));
  chain('thumb', ['base', 'knuckle', 'end joint'], thumbFK(THUMB, pose.thumb), THUMB.heights, THUMB.tipRadius);
  return out;
}

const tmp = [0, 0, 0];
const LEFT = KEYS[0].frontLeft;
const RIGHT = KEYS[KEY_COUNT - 1].frontRight;

/**
 * The top of whatever solid part of the piano lies directly under (x, z), with
 * the keys depressed as given (fraction per key): its height and what it is.
 */
export function solidUnder(x: number, z: number, keys: Float32Array): { y: number; what: string } {
  if (x < LEFT - 0.001 || x > RIGHT + 0.001) return { y: 0.045, what: 'cheek' };
  if (z >= 0.026) return { y: -Infinity, what: '' };
  if (z > 0.004) return { y: -0.0128, what: 'key slip' };
  if (z < -0.1525) return { y: 0.07, what: 'nameboard' };
  if (z > 0) return { y: -0.0215, what: 'key front' };
  let lo = 0;
  let hi = KEYS.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (KEYS[m].frontRight < x) lo = m + 1;
    else hi = m;
  }
  let best = { y: -0.034, what: 'key bed' };
  for (let i = Math.max(0, lo - 2); i < Math.min(KEYS.length, lo + 3); i++) {
    const k = KEYS[i];
    if (k.black) {
      if (z > BLACK_FRONT_Z || Math.abs(x - k.x) > BLACK_WIDTH_BOTTOM / 2) continue;
    } else {
      const front = z > BLACK_FRONT_Z;
      if (x < (front ? k.frontLeft : k.tailLeft) || x > (front ? k.frontRight : k.tailRight)) continue;
    }
    keySurfacePoint(k, z, keys[k.index], tmp);
    if (tmp[1] > best.y) best = { y: tmp[1], what: noteName(k.midi) };
  }
  return best;
}

export interface Penetration {
  /** the deepest any part of the hand goes into the piano (m; negative: its clearance), the part and what it is in */
  depth: number;
  part: string;
  into: string;
  /** the same for the body of the hand alone (palm, knuckles, thumb base): a hand sunk into the keys */
  body: number;
}

export function penetration(pose: HandPose, keys: Float32Array): Penetration {
  const out: Penetration = { depth: -Infinity, part: '', into: '', body: -Infinity };
  for (const s of handSpheres(pose)) {
    const under = solidUnder(s.p[0], s.p[2], keys);
    const d = under.y - (s.p[1] - s.r);
    if (s.body) out.body = Math.max(out.body, d);
    if (d > out.depth) Object.assign(out, { depth: d, part: s.part, into: under.what });
  }
  return out;
}
