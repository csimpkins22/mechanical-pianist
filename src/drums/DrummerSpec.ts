// The robot drummer's skeleton, from drummer_spec.json (written by the Blender
// build, tools/blender/drummer_spec.py), plus allocation-free 3x3 math and
// forward kinematics. Pure math, no three.js: the IK, the rig, the clearance
// checks and the tests share it.
//
// Frames: the model's origin sits on the top of the stool's seat at its
// centre (DrummerRig puts it on KitLayout's SEAT); three.js axes, +x to the
// drummer's right, +y up, -z forward. Every joint's rest rotation is the
// identity (a seated pose). The left limbs are the right mirrored in x; a left
// joint's local rotation is the mirror image M R M of the matching right
// rotation, so every joint angle means the same thing on both sides.
import spec from './drummer_spec.json';

export type Side = 'R' | 'L';
export type V3 = [number, number, number];
/** a 3-vector, reused in place */
export type Vec3 = Float64Array;
/** a row-major 3x3 rotation, reused in place */
export type Mat3 = Float64Array;

export type JointKind =
  | 'euler_yxz'
  | 'clavicle'
  | 'shoulder'
  | 'elbow'
  | 'twist'
  | 'fixed'
  | 'wrist'
  | 'stick'
  | 'hip'
  | 'knee'
  | 'ankle'
  | 'toes';

export interface JointSpec {
  name: string;
  parent: string | null;
  offset: V3;
  kind: JointKind;
  dofs: { name: string; limits: [number, number] }[];
  side?: Side;
}

export interface DrummerSpecJson {
  joints: JointSpec[];
  segments: { upperArm: number; forearm: number; twistAt: number; thigh: number; shin: number };
  foot: { ankleHeight: number; ball: V3; heel: V3; toe: number; soleWidth: number; soleLength: number };
  seat: { hipUp: number; sitZ: number; hipHalf: number };
  grip: { fulcrum: V3; direction: V3; rockAxis: V3; fulcrumFromButt: number };
  stick: { length: number; diameter: number; tipDiameter: number; shoulderFromTip: number; taper: number };
  capsules: Record<'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'torso' | 'head', number>;
  hand: { spec: string; prefix: Record<Side, string> };
}

export const DRUMMER = spec as unknown as DrummerSpecJson;
export const JOINTS: JointSpec[] = DRUMMER.joints;
export const NJ = JOINTS.length;

const index = new Map(JOINTS.map((j, i) => [j.name, i]));
/** joint index by name */
export function jointIndex(name: string): number {
  const i = index.get(name);
  if (i === undefined) throw new Error(`drummer spec has no joint ${name}`);
  return i;
}
export const PARENT: Int32Array = Int32Array.from(JOINTS.map((j) => (j.parent ? jointIndex(j.parent) : -1)));
/** offsets, flat (3 per joint) */
export const OFFSET: Float64Array = Float64Array.from(JOINTS.flatMap((j) => j.offset));

/** the joints the IK drives, by role */
export const J = {
  pelvis: jointIndex('Pelvis'),
  spine1: jointIndex('Spine1'),
  spine2: jointIndex('Spine2'),
  chest: jointIndex('Chest'),
  neck: jointIndex('Neck'),
  head: jointIndex('Head'),
  arm: {
    R: armJoints('R'),
    L: armJoints('L'),
  },
  leg: {
    R: legJoints('R'),
    L: legJoints('L'),
  },
};
function armJoints(s: Side) {
  return {
    clavicle: jointIndex(`Clavicle${s}`),
    upper: jointIndex(`UpperArm${s}`),
    forearm: jointIndex(`Forearm${s}`),
    twist: jointIndex(`ForearmTwist${s}`),
    hand: jointIndex(`Hand${s}`),
    palm: jointIndex(`${s}_Palm`),
    stick: jointIndex(`Stick${s}`),
  };
}
function legJoints(s: Side) {
  return {
    thigh: jointIndex(`Thigh${s}`),
    shin: jointIndex(`Shin${s}`),
    foot: jointIndex(`Foot${s}`),
    toes: jointIndex(`Toes${s}`),
  };
}

/** every scalar joint angle the IK reports, in spec order: [joint, dof] */
export const DOFS: { joint: number; dof: number; name: string; limits: [number, number] }[] = JOINTS.flatMap((j, ji) =>
  j.dofs.map((d, di) => ({ joint: ji, dof: di, name: `${j.name}.${d.name}`, limits: d.limits })),
);
/** first DOF slot of each joint in a flat angle array */
export const DOF_BASE: Int32Array = (() => {
  const out = new Int32Array(NJ);
  let k = 0;
  JOINTS.forEach((j, i) => {
    out[i] = k;
    k += j.dofs.length;
  });
  return out;
})();
export const NDOF = DOFS.length;

// ---------------------------------------------------------------- tiny in-place linear algebra
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => Float64Array.of(x, y, z);
export const mat3 = (): Mat3 => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

export function set3(o: Vec3, x: number, y: number, z: number): Vec3 {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}
export function copy3(o: Vec3, a: ArrayLike<number>, ai = 0): Vec3 {
  o[0] = a[ai];
  o[1] = a[ai + 1];
  o[2] = a[ai + 2];
  return o;
}
export function add3(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  o[0] = a[0] + b[0];
  o[1] = a[1] + b[1];
  o[2] = a[2] + b[2];
  return o;
}
export function sub3(o: Vec3, a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  o[0] = a[0] - b[0];
  o[1] = a[1] - b[1];
  o[2] = a[2] - b[2];
  return o;
}
/** o = a + b * s */
export function addScaled3(o: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  o[0] = a[0] + b[0] * s;
  o[1] = a[1] + b[1] * s;
  o[2] = a[2] + b[2] * s;
  return o;
}
export function scale3(o: Vec3, a: Vec3, s: number): Vec3 {
  o[0] = a[0] * s;
  o[1] = a[1] * s;
  o[2] = a[2] * s;
  return o;
}
export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
export function dist3(a: ArrayLike<number>, b: ArrayLike<number>) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export function cross3(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}
export function norm3(o: Vec3, a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  o[0] = a[0] / l;
  o[1] = a[1] / l;
  o[2] = a[2] / l;
  return o;
}
/** o = the part of a perpendicular to unit n, normalised (falls back to `fb` when a is parallel to n) */
export function perpNorm3(o: Vec3, a: Vec3, n: Vec3, fb?: Vec3): Vec3 {
  const d = dot3(a, n);
  const x = a[0] - n[0] * d;
  const y = a[1] - n[1] * d;
  const z = a[2] - n[2] * d;
  const l = Math.hypot(x, y, z);
  if (l < 1e-9) return fb ? perpNorm3(o, fb, n) : set3(o, 0, 0, 0);
  return set3(o, x / l, y / l, z / l);
}

export function identity3(o: Mat3): Mat3 {
  o.fill(0);
  o[0] = o[4] = o[8] = 1;
  return o;
}
export function copyM3(o: Mat3, a: ArrayLike<number>, ai = 0): Mat3 {
  for (let i = 0; i < 9; i++) o[i] = a[ai + i];
  return o;
}
const tmpM = new Float64Array(9);
/** o = a * b (o may alias a or b) */
export function mulM3(o: Mat3, a: ArrayLike<number>, b: ArrayLike<number>, ai = 0, bi = 0): Mat3 {
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) tmpM[r * 3 + c] = a[ai + r * 3] * b[bi + c] + a[ai + r * 3 + 1] * b[bi + 3 + c] + a[ai + r * 3 + 2] * b[bi + 6 + c];
  o.set(tmpM);
  return o;
}
/** o = a^T * b (o may alias) */
export function mulTM3(o: Mat3, a: ArrayLike<number>, b: ArrayLike<number>, ai = 0, bi = 0): Mat3 {
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) tmpM[r * 3 + c] = a[ai + r] * b[bi + c] + a[ai + 3 + r] * b[bi + 3 + c] + a[ai + 6 + r] * b[bi + 6 + c];
  o.set(tmpM);
  return o;
}
/** o = m v */
export function apply3(o: Vec3, m: ArrayLike<number>, v: ArrayLike<number>, mi = 0): Vec3 {
  const x = m[mi] * v[0] + m[mi + 1] * v[1] + m[mi + 2] * v[2];
  const y = m[mi + 3] * v[0] + m[mi + 4] * v[1] + m[mi + 5] * v[2];
  const z = m[mi + 6] * v[0] + m[mi + 7] * v[1] + m[mi + 8] * v[2];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}
/** o = m^T v */
export function applyT3(o: Vec3, m: ArrayLike<number>, v: ArrayLike<number>, mi = 0): Vec3 {
  const x = m[mi] * v[0] + m[mi + 3] * v[1] + m[mi + 6] * v[2];
  const y = m[mi + 1] * v[0] + m[mi + 4] * v[1] + m[mi + 7] * v[2];
  const z = m[mi + 2] * v[0] + m[mi + 5] * v[1] + m[mi + 8] * v[2];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}
export function rotX3(o: Mat3, a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = 1; o[1] = 0; o[2] = 0;
  o[3] = 0; o[4] = c; o[5] = -s;
  o[6] = 0; o[7] = s; o[8] = c;
  return o;
}
export function rotY3(o: Mat3, a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = c; o[1] = 0; o[2] = s;
  o[3] = 0; o[4] = 1; o[5] = 0;
  o[6] = -s; o[7] = 0; o[8] = c;
  return o;
}
export function rotZ3(o: Mat3, a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = c; o[1] = -s; o[2] = 0;
  o[3] = s; o[4] = c; o[5] = 0;
  o[6] = 0; o[7] = 0; o[8] = 1;
  return o;
}
/** rotation about a unit axis */
export function axisAngle3(o: Mat3, ax: ArrayLike<number>, a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const x = ax[0], y = ax[1], z = ax[2];
  o[0] = t * x * x + c; o[1] = t * x * y - s * z; o[2] = t * x * z + s * y;
  o[3] = t * x * y + s * z; o[4] = t * y * y + c; o[5] = t * y * z - s * x;
  o[6] = t * x * z - s * y; o[7] = t * y * z + s * x; o[8] = t * z * z + c;
  return o;
}
/** the matrix whose columns are x, y, z */
export function fromCols3(o: Mat3, x: Vec3, y: Vec3, z: Vec3): Mat3 {
  o[0] = x[0]; o[1] = y[0]; o[2] = z[0];
  o[3] = x[1]; o[4] = y[1]; o[5] = z[1];
  o[6] = x[2]; o[7] = y[2]; o[8] = z[2];
  return o;
}
/** o = M a M with M = diag(-1, 1, 1): the mirror image of a rotation (o may alias a) */
export function mirrorM3(o: Mat3, a: ArrayLike<number>, ai = 0): Mat3 {
  const a0 = a[ai], a1 = a[ai + 1], a2 = a[ai + 2], a3 = a[ai + 3], a4 = a[ai + 4], a5 = a[ai + 5], a6 = a[ai + 6], a7 = a[ai + 7], a8 = a[ai + 8];
  o[0] = a0; o[1] = -a1; o[2] = -a2;
  o[3] = -a3; o[4] = a4; o[5] = a5;
  o[6] = -a6; o[7] = a7; o[8] = a8;
  return o;
}
/** R = Ry(y) Rx(x) Rz(z): writes [y, x, z] */
export function eulerYXZ(R: ArrayLike<number>, out: Float64Array, oi = 0, ri = 0) {
  out[oi + 1] = Math.asin(Math.max(-1, Math.min(1, -R[ri + 5])));
  out[oi] = Math.atan2(R[ri + 2], R[ri + 8]);
  out[oi + 2] = Math.atan2(R[ri + 3], R[ri + 4]);
}
/** R = Rz(z) Rx(x) Ry(y): writes [z, x, y] */
export function eulerZXY(R: ArrayLike<number>, out: Float64Array, oi = 0, ri = 0) {
  out[oi + 1] = Math.asin(Math.max(-1, Math.min(1, R[ri + 7])));
  out[oi] = Math.atan2(-R[ri + 1], R[ri + 4]);
  out[oi + 2] = Math.atan2(-R[ri + 6], R[ri + 8]);
}
/** R = Rz(z) Ry(y) Rx(x): writes [z, y, x] */
export function eulerZYX(R: ArrayLike<number>, out: Float64Array, oi = 0, ri = 0) {
  out[oi + 1] = Math.asin(Math.max(-1, Math.min(1, -R[ri + 6])));
  out[oi] = Math.atan2(R[ri + 3], R[ri + 0]);
  out[oi + 2] = Math.atan2(R[ri + 7], R[ri + 8]);
}
/** R = Ry(y) Rx(x) Rz(z), into o */
export function composeYXZ(o: Mat3, y: number, x: number, z: number): Mat3 {
  rotY3(o, y);
  mulM3(o, o, rotX3(tmpA, x));
  return mulM3(o, o, rotZ3(tmpA, z));
}
const tmpA = new Float64Array(9);

// ---------------------------------------------------------------- forward kinematics
/** world rotation (9 per joint) and position (3 per joint) of every joint, from local rotations (9 per joint) */
export function forwardKinematics(local: Float64Array, rootPos: ArrayLike<number>, worldRot: Float64Array, worldPos: Float64Array, from = 0, to = NJ) {
  for (let j = from; j < to; j++) {
    const p = PARENT[j];
    if (p < 0) {
      copyM3(tmpA, local, j * 9);
      worldRot.set(tmpA, j * 9);
      worldPos[j * 3] = rootPos[0] + OFFSET[j * 3];
      worldPos[j * 3 + 1] = rootPos[1] + OFFSET[j * 3 + 1];
      worldPos[j * 3 + 2] = rootPos[2] + OFFSET[j * 3 + 2];
      continue;
    }
    fkJoint(local, worldRot, worldPos, j);
  }
}

const tmpV = new Float64Array(3);
const tmpR = new Float64Array(9);
/** one joint's world transform from its parent's (already computed) */
export function fkJoint(local: Float64Array, worldRot: Float64Array, worldPos: Float64Array, j: number) {
  const p = PARENT[j];
  tmpV[0] = OFFSET[j * 3];
  tmpV[1] = OFFSET[j * 3 + 1];
  tmpV[2] = OFFSET[j * 3 + 2];
  apply3(tmpV, worldRot, tmpV, p * 9);
  worldPos[j * 3] = worldPos[p * 3] + tmpV[0];
  worldPos[j * 3 + 1] = worldPos[p * 3 + 1] + tmpV[1];
  worldPos[j * 3 + 2] = worldPos[p * 3 + 2] + tmpV[2];
  mulM3(tmpR, worldRot, local, p * 9, j * 9);
  worldRot.set(tmpR, j * 9);
}

/** a point given in joint j's frame, in the world */
export function jointToWorld(o: Vec3, worldRot: Float64Array, worldPos: Float64Array, j: number, p: ArrayLike<number>) {
  apply3(o, worldRot, p, j * 9);
  o[0] += worldPos[j * 3];
  o[1] += worldPos[j * 3 + 1];
  o[2] += worldPos[j * 3 + 2];
  return o;
}
