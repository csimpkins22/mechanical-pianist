// Hand geometry from hand_spec.json, plus forward kinematics. Pure math, no
// three.js, so the fingering cost model, the IK and the tests share it.
import spec from './hand_spec.json';

export type V3 = [number, number, number];
/** row-major 3x3 */
export type M3 = [number, number, number, number, number, number, number, number, number];

export interface FingerSpec {
  name: string;
  id: number;
  mcp: V3;
  baseYaw: number;
  segments: V3;
  widths: V3;
  heights: V3;
  tipRadius: number;
  rest: V3;
  restAbduction: number;
}

export interface ThumbSpec {
  name: string;
  id: number;
  cmc: V3;
  baseYaw: number;
  basePitch: number;
  opposition: number;
  segments: V3;
  widths: V3;
  heights: V3;
  tipRadius: number;
  /** [swing, cmc flex, mcp flex, ip flex] */
  rest: [number, number, number, number];
}

export const HAND_SPEC = spec as unknown as {
  fingers: FingerSpec[];
  thumb: ThumbSpec;
  palm: { knuckleWidth: number; wristWidth: number; dorsalTop: number; palmarBottom: number };
  forearm: { length: number; wristRadius: [number, number]; elbowRadius: [number, number] };
};

export const FINGERS = HAND_SPEC.fingers; // index, middle, ring, little (ids 2..5)
export const THUMB = HAND_SPEC.thumb;

// ---------------------------------------------------------------- tiny linear algebra
export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul(a: M3, b: M3): M3 {
  const o = new Array(9) as M3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
export const apply = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export function rotX(a: number): M3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(a: number): M3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(a: number): M3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
/** flexion: rotation that curls -Z toward -Y (palm side) */
export const flex = (a: number) => rotX(-a);

// ---------------------------------------------------------------- forward kinematics
export interface FingerPose {
  abduction: number; // added to baseYaw
  angles: V3; // MCP, PIP, DIP flexion
}

export interface ThumbPose {
  swing: number; // CMC abduction about the palm's normal
  twist: number; // CMC rotation about the metacarpal's own axis (the joint is a ball)
  angles: V3; // CMC flex, MCP flex, IP flex
}

/** Joint positions of a finger in the hand frame: [mcp, pip, dip, tipCentre]. */
export function fingerFK(f: FingerSpec, pose: FingerPose): V3[] {
  let R = rotY(f.baseYaw + pose.abduction);
  const pts: V3[] = [f.mcp];
  let p = f.mcp;
  for (let k = 0; k < 3; k++) {
    R = mul(R, flex(pose.angles[k]));
    p = add(p, apply(R, [0, 0, -f.segments[k]]));
    pts.push(p);
  }
  return pts;
}

export function thumbBase(t: ThumbSpec): M3 {
  return mul(mul(rotY(t.baseYaw), rotX(t.basePitch)), rotZ(t.opposition));
}

/** Thumb joints in the hand frame: [cmc, mcp, ip, tipCentre]. */
export function thumbFK(t: ThumbSpec, pose: ThumbPose): V3[] {
  let R = mul(mul(rotY(pose.swing), thumbBase(t)), rotZ(pose.twist));
  const pts: V3[] = [t.cmc];
  let p = t.cmc;
  for (let k = 0; k < 3; k++) {
    R = mul(R, flex(pose.angles[k]));
    p = add(p, apply(R, [0, 0, -t.segments[k]]));
    pts.push(p);
  }
  return pts;
}

export const REST_FINGER_POSES: FingerPose[] = FINGERS.map((f) => ({ abduction: f.restAbduction, angles: [...f.rest] as V3 }));
export const REST_THUMB_POSE: ThumbPose = { swing: THUMB.rest[0], twist: 0, angles: [THUMB.rest[1], THUMB.rest[2], THUMB.rest[3]] };

/** Fingertip sphere centres at rest, hand frame, indexed by finger number 1..5 (0 unused). */
export const REST_TIPS: V3[] = (() => {
  const out: V3[] = [[0, 0, 0]];
  const th = thumbFK(THUMB, REST_THUMB_POSE);
  out.push(th[3]);
  FINGERS.forEach((f, i) => out.push(fingerFK(f, REST_FINGER_POSES[i])[3]));
  return out;
})();

export const TIP_RADIUS: number[] = [0, THUMB.tipRadius, ...FINGERS.map((f) => f.tipRadius)];

/**
 * Natural lateral offset of each fingertip from the hand's reference line
 * (the middle fingertip), in the right-hand canonical frame (+X = toward the
 * little finger). Index 1..5.
 */
export const NATURAL_OFFSET: number[] = REST_TIPS.map((p, i) => (i === 0 ? 0 : p[0] - REST_TIPS[3][0]));
