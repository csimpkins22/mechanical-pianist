// Inverse kinematics for the robot hand, in the right-hand canonical frame.
//
// Fingers: abduction turns the finger's flexion plane toward the target; in
// that plane the distal phalanx is given a preferred angle (steeper when the
// target is close under the knuckle, flatter when it is far), which fixes the
// DIP joint, and the MCP and PIP follow from the two-link solution. That is
// exact, has no iterations and no memory, so the same target always gives the
// same pose: a requirement for scrubbing.
//
// Thumb: its CMC swing turns a tilted flexion plane (set by the thumb's
// opposition) until it contains the target, solved in closed form, then the
// same planar solution runs in that plane.
import {
  FINGERS,
  REST_FINGER_POSES,
  REST_THUMB_POSE,
  REST_TIPS,
  THUMB,
  apply,
  fingerFK,
  flex,
  mul,
  rotY,
  sub,
  thumbBase,
  thumbFK,
  type FingerPose,
  type ThumbPose,
  type V3,
} from '../core/handGeometry';

const MCP_LIMIT: [number, number] = [-0.3, 1.45];
const PIP_LIMIT: [number, number] = [0.02, 1.8];
const DIP_LIMIT: [number, number] = [-0.08, 1.35];
/** abduction range per finger (index..little): the little finger spreads furthest */
const ABD_LIMIT = [0.42, 0.32, 0.38, 0.6];

interface Planar {
  angles: [number, number, number];
  error: number;
}

/**
 * Planar three-link chain reaching (fwd, down) with the last link at absolute
 * angle phi (radians below "forward"). Returns joint angles and residual.
 */
function planar3(L: readonly number[], fwd: number, down: number, phi: number, lim: [number, number][]): Planar {
  const emax = L[0] + L[1] - 1e-5;
  const emin = Math.abs(L[0] - L[1]) + 1e-5;
  const r = Math.hypot(fwd, down);
  const thT = Math.atan2(down, fwd);
  /** keep the DIP point within the annulus the first two links can reach */
  const fixReach = (p: number) => {
    const e = Math.hypot(fwd - L[2] * Math.cos(p), down - L[2] * Math.sin(p));
    const bound = e > emax ? emax : e < emin ? emin : -1;
    if (bound < 0 || r < 1e-6) return p;
    const c = (r * r + L[2] * L[2] - bound * bound) / (2 * r * L[2]);
    if (c >= 1) return thT;
    if (c <= -1) return thT + Math.PI;
    const d = Math.acos(c);
    const p1 = thT + d;
    const p2 = thT - d;
    return Math.abs(p1 - p) < Math.abs(p2 - p) ? p1 : p2;
  };
  let angles: [number, number, number] = [0, 0, 0];
  let p = phi;
  for (let iter = 0; iter < 8; iter++) {
    p = fixReach(p);
    const dx = fwd - L[2] * Math.cos(p);
    const dy = down - L[2] * Math.sin(p);
    const e = Math.min(emax, Math.max(emin, Math.hypot(dx, dy)));
    const cb = (L[0] * L[0] + L[1] * L[1] - e * e) / (2 * L[0] * L[1]);
    const b = Math.PI - Math.acos(Math.min(1, Math.max(-1, cb)));
    const a = Math.atan2(dy, dx) - Math.atan2(L[1] * Math.sin(b), L[0] + L[1] * Math.cos(b));
    const c = p - a - b;
    angles = [a, b, c];
    const cc = Math.min(lim[2][1], Math.max(lim[2][0], c));
    const bb = Math.min(lim[1][1], Math.max(lim[1][0], b));
    if (Math.abs(cc - c) < 1e-5 && Math.abs(bb - b) < 1e-5) break;
    // move the distal angle toward a pose the DIP (and PIP) limits allow
    p += (cc - c) * 0.85 + (bb - b) * 0.5;
  }
  angles = [
    Math.min(lim[0][1], Math.max(lim[0][0], angles[0])),
    Math.min(lim[1][1], Math.max(lim[1][0], angles[1])),
    Math.min(lim[2][1], Math.max(lim[2][0], angles[2])),
  ];
  // residual from forward kinematics of the clamped solution
  let x = 0;
  let y = 0;
  let acc = 0;
  for (let k = 0; k < 3; k++) {
    acc += angles[k];
    x += L[k] * Math.cos(acc);
    y += L[k] * Math.sin(acc);
  }
  return { angles, error: Math.hypot(x - fwd, y - down) };
}

/** distal angle at rest, and the rest reach, per finger (index 0..3) */
const FINGER_REST = FINGERS.map((f, i) => {
  const pts = fingerFK(f, REST_FINGER_POSES[i]);
  const d = sub(pts[3], f.mcp);
  return { phi: f.rest[0] + f.rest[1] + f.rest[2], reach: Math.hypot(d[0], d[1], d[2]) };
});

export interface FingerSolution extends FingerPose {
  error: number;
}

/** target: tip-centre in the hand's canonical frame; fi: 0..3 (index..little) */
export function solveFinger(fi: number, target: V3, curl = 0): FingerSolution {
  const f = FINGERS[fi];
  const d = sub(target, f.mcp);
  let psi = Math.atan2(-d[0], -d[2]);
  let abd = psi - f.baseYaw;
  abd = Math.min(ABD_LIMIT[fi], Math.max(-ABD_LIMIT[fi], abd));
  psi = f.baseYaw + abd;
  const fwd = -d[0] * Math.sin(psi) - d[2] * Math.cos(psi);
  const down = -d[1];
  const lateral = d[0] * Math.cos(psi) - d[2] * Math.sin(psi);
  const r = Math.hypot(fwd, down);
  const rest = FINGER_REST[fi];
  // closer targets: curl more (steeper tip); farther: flatten
  const phi = Math.min(1.85, Math.max(0.55, rest.phi + 1.5 * (rest.reach - r) / rest.reach + curl));
  const sol = planar3(f.segments, fwd, down, phi, [MCP_LIMIT, PIP_LIMIT, DIP_LIMIT]);
  return { abduction: abd, angles: sol.angles, error: Math.hypot(sol.error, lateral) };
}

// ---------------------------------------------------------------- thumb
const T_BASE = thumbBase(THUMB);
const THUMB_REST = (() => {
  const pts = thumbFK(THUMB, REST_THUMB_POSE);
  const d = sub(pts[3], THUMB.cmc);
  // azimuth of the rest tip in the palm plane, about the palm normal
  return { phi: THUMB.rest[1] + THUMB.rest[2] + THUMB.rest[3], reach: Math.hypot(d[0], d[1], d[2]), az: Math.atan2(-d[0], -d[2]) };
})();
const SWING_LIMIT = 0.95;
const TWIST_LIMIT = 0.75;

export interface ThumbSolution extends ThumbPose {
  error: number;
}

/**
 * The CMC is a ball joint: swing spreads the thumb in the palm plane (half of
 * the target's azimuth change, like a relaxed hand), twist turns the thumb's
 * flexion plane about the metacarpal until it contains the target, and the
 * planar solution does the rest.
 */
export function solveThumb(target: V3): ThumbSolution {
  const d = sub(target, THUMB.cmc);
  const az = Math.atan2(-d[0], -d[2]);
  const swing = Math.min(SWING_LIMIT, Math.max(-SWING_LIMIT, 0.85 * (az - THUMB_REST.az)));
  const F0 = mul(rotY(swing), T_BASE);
  // target in the swung base frame (before twist)
  const Ft = [F0[0], F0[3], F0[6], F0[1], F0[4], F0[7], F0[2], F0[5], F0[8]] as typeof F0;
  const l = apply(Ft, d);
  // twist so the flexion side (-Y) faces the target's component off the axis
  const px = l[0];
  const py = l[1];
  // (a nearly straight thumb has no well-defined plane: ease the twist out)
  const pm = Math.hypot(px, py);
  let twist = pm > 1e-6 ? Math.atan2(px, -py) * Math.min(1, Math.max(0, (pm - 0.002) / 0.006)) : 0;
  twist = Math.min(TWIST_LIMIT, Math.max(-TWIST_LIMIT, twist));
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  // in the twisted frame: x' = c x + s y, y' = -s x + c y
  const xT = ct * l[0] + st * l[1];
  const yT = -st * l[0] + ct * l[1];
  const fwd = -l[2];
  const down = -yT;
  const off = xT;
  const r = Math.hypot(fwd, down);
  const phi = Math.min(1.9, Math.max(-0.2, THUMB_REST.phi + 1.2 * (THUMB_REST.reach - r) / THUMB_REST.reach));
  const sol = planar3(THUMB.segments, fwd, down, phi, [
    [-0.45, 0.95],
    [-0.25, 1.25],
    [-0.35, 1.4],
  ]);
  return { swing, twist, angles: sol.angles, error: Math.hypot(sol.error, off) };
}

/** Rest tip of finger n (1..5), canonical frame. */
export function restTip(n: number): V3 {
  return REST_TIPS[n];
}

export { flex };
