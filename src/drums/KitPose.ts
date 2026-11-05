// Where a point on a cymbal is while the kit moves: the same chain of
// transforms DrumKitModel applies (the stand's top giving about its boom
// joint, the cymbal tilted toward the stool, rocking on its felt about the
// bell and sinking into it; the hi-hat's top cymbal lifted by the pedal), as
// plain arithmetic, so the drummer's planner can put a stick on a cymbal
// where the viewer sees it, and the tests can check the sticks against the
// cymbals as they swing. (tests/drummerMotion.test.ts checks it against the
// model's own matrices.)
import { CYMBAL_PROFILES, DRUMS, hihatMount, surfaceNormal, type V3 } from './KitLayout';
import { boomStand } from './KitStands';
import type { CymbalId, KitState, Tilt } from './KitMotion';

type M3 = number[];

/** the rotation of a cymbal's frame: Euler(tilt, yaw, 0, 'YXZ'), as DrumKitModel's orientation() */
function frame(id: CymbalId): M3 {
  const d = DRUMS[id];
  const ct = Math.cos(d.tilt), st = Math.sin(d.tilt);
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
  // R = Ry(yaw) Rx(tilt), row-major
  return [cy, sy * st, sy * ct, 0, ct, -st, -sy, cy * st, cy * ct];
}
const FRAMES: Record<CymbalId, M3> = { crash: frame('crash'), ride: frame('ride'), hihat: frame('hihat') };
const JOINTS: Record<'crash' | 'ride', V3> = { crash: boomStand('crash').joint, ride: boomStand('ride').joint };
const MOUNT = hihatMount();

/** a rotation about a unit axis (x, 0, z) / |..| by its length, applied to v (Rodrigues), into o */
function tiltApply(t: Tilt, v: ArrayLike<number>, o: number[]) {
  const a = Math.hypot(t.x, t.z);
  if (a < 1e-12) {
    o[0] = v[0];
    o[1] = v[1];
    o[2] = v[2];
    return o;
  }
  const kx = t.x / a, kz = t.z / a;
  const c = Math.cos(a), s = Math.sin(a);
  const kv = kx * v[0] + kz * v[2];
  // k x v, k = (kx, 0, kz)
  const cx = -kz * v[1];
  const cy = kz * v[0] - kx * v[2];
  const cz = kx * v[1];
  o[0] = v[0] * c + cx * s + kx * kv * (1 - c);
  o[1] = v[1] * c + cy * s;
  o[2] = v[2] * c + cz * s + kz * kv * (1 - c);
  return o;
}
const mul = (R: M3, v: ArrayLike<number>, o: number[]) => {
  const x = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
  const y = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
  const z = R[6] * v[0] + R[7] * v[1] + R[8] * v[2];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
const mulT = (R: M3, v: ArrayLike<number>, o: number[]) => {
  const x = R[0] * v[0] + R[3] * v[1] + R[6] * v[2];
  const y = R[1] * v[0] + R[4] * v[1] + R[7] * v[2];
  const z = R[2] * v[0] + R[5] * v[1] + R[8] * v[2];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};

const a3 = [0, 0, 0];
const b3 = [0, 0, 0];

/**
 * A point on a cymbal (given where it is with the kit at rest, kit frame) as
 * the kit in `s` has moved it, into `out`. Nothing is allocated. The hi-hat's
 * point is on its top cymbal (the bottom one does not move).
 */
export function cymbalPoint(id: CymbalId, p: ArrayLike<number>, s: Pick<KitState, 'cymbals' | 'stands' | 'hihatGap'>, out: number[] | Float64Array): typeof out {
  const d = DRUMS[id];
  const R = FRAMES[id];
  const pr = CYMBAL_PROFILES[id];
  // the rocking pivot: the felt under the bell, (bell height - bell thickness) above the reference plane
  const h = pr.bellHeight - pr.thickness[0];
  const c = s.cymbals[id];
  // in the cymbal's frame, about the pivot: tilt, then back up to the pivot and down by the sink into the felt
  a3[0] = p[0] - d.centre[0];
  a3[1] = p[1] - d.centre[1];
  a3[2] = p[2] - d.centre[2];
  mulT(R, a3, a3);
  a3[1] -= h;
  tiltApply(c, a3, b3);
  b3[1] += h + c.drop + (id === 'hihat' ? s.hihatGap : 0);
  mul(R, b3, a3);
  if (id === 'hihat') {
    for (let k = 0; k < 3; k++) out[k] = d.centre[k] + a3[k];
    return out;
  }
  // the stand's top gives about its boom joint, about the cymbal's own tilt axis turned into the kit's frame
  const J = JOINTS[id];
  const g = s.stands[id];
  const ga = Math.hypot(g.x, g.z);
  for (let k = 0; k < 3; k++) a3[k] += d.centre[k] - J[k];
  if (ga > 1e-12) {
    // axis = R (gx, 0, gz) / |g|
    b3[0] = g.x / ga;
    b3[1] = 0;
    b3[2] = g.z / ga;
    mul(R, b3, b3);
    const kx = b3[0], ky = b3[1], kz = b3[2];
    const cs = Math.cos(ga), sn = Math.sin(ga);
    const kv = kx * a3[0] + ky * a3[1] + kz * a3[2];
    const cx = ky * a3[2] - kz * a3[1];
    const cy = kz * a3[0] - kx * a3[2];
    const cz = kx * a3[1] - ky * a3[0];
    const x = a3[0] * cs + cx * sn + kx * kv * (1 - cs);
    const y = a3[1] * cs + cy * sn + ky * kv * (1 - cs);
    const z = a3[2] * cs + cz * sn + kz * kv * (1 - cs);
    a3[0] = x;
    a3[1] = y;
    a3[2] = z;
  }
  for (let k = 0; k < 3; k++) out[k] = J[k] + a3[k];
  return out;
}

/** a cymbal's surface normal as the kit in `s` has turned it, into `out` */
export function cymbalNormal(id: CymbalId, s: Pick<KitState, 'cymbals' | 'stands' | 'hihatGap'>, out: number[] | Float64Array): typeof out {
  const d = DRUMS[id];
  const n = surfaceNormal(d);
  // the difference of two moved points along the normal at the centre (rotations only: exact)
  const p0 = [d.centre[0], d.centre[1], d.centre[2]];
  const p1 = [d.centre[0] + n[0], d.centre[1] + n[1], d.centre[2] + n[2]];
  const q0 = cymbalPoint(id, p0, s, [0, 0, 0]);
  const q1 = cymbalPoint(id, p1, s, [0, 0, 0]);
  for (let k = 0; k < 3; k++) out[k] = q1[k] - q0[k];
  return out;
}

/** the hi-hat's column head (for tests) */
export const HIHAT_HEAD = MOUNT.head;
