// Inverse kinematics for the robot drummer, in the kit's frame (KitLayout).
//
// Arms. A stroke is asked for as a contact on a playing surface: the point,
// the surface's normal, the stick's angle to the surface (a drummer plays a
// drum head at about 10-25 degrees, a ride's bow flatter, and crashes a cymbal
// with the shoulder of the stick over its edge), how far the tip is lifted
// above that contact, and how far the hand is turned about the stick (palm
// down, as in German grip, to thumb up, as in French grip; American is in
// between). That fixes the stick; the grip (a fulcrum between thumb and index
// finger a third of the way up the stick) fixes the palm, and the palm the
// wrist. A two-bone solve with a natural elbow (hanging, a little out to the
// side, never flapping) places the elbow; the forearm's roll and the wrist's
// two axes take up the rest exactly. A lifted stick is the impact pose turned
// up the way a drummer's stroke is made: mostly at the wrist, some at the
// elbow, the rest in the fingers (the stick rocks about its fulcrum as the
// back fingers open). Only if a joint would leave its range are the free
// choices (the hand's turn, the elbow's swivel, the stick's line across the
// surface) searched, in a fixed order, so the same targets always give the
// same pose.
//
// Torso. A drummer sits leaning in from the hips, the upper back a little
// rounded and the shoulders a little forward (clips 4 and 8); far targets
// (floor tom, ride, crash) add their turn and lean on top of that, shared
// over the pelvis and three spine joints, rather than overstretching the arm;
// the shoulder girdle rises and comes forward with the reach. The elbows hang
// beside the body, never out behind the back. The head turns a little toward
// where the sticks are going.
//
// Legs. A foot on its pedal, heel down (the sole on the footboard) or heel up
// (the ball of the foot on the board, the toes bent): the ankle follows, and
// the hip and knee reach it with the knee tracking over the foot.
//
// The left side is solved as the right in the mirrored world and mirrored back
// (M R M), so its angles mean the same. Everything is closed form or a fixed
// number of iterations, and nothing is allocated per solve.
import { PEDALS, PEDAL_TRAVEL, SEAT, STICK, type PedalId } from './KitLayout';
import { kitProxies, proxyDistance, segSegDistance, type Proxy } from './KitProxy';
import {
  DOF_BASE,
  DRUMMER,
  J,
  JOINTS,
  NDOF,
  NJ,
  OFFSET,
  addScaled3,
  apply3,
  applyT3,
  axisAngle3,
  composeYXZ,
  copy3,
  copyM3,
  cross3,
  dist3,
  dot3,
  eulerYXZ,
  eulerZXY,
  eulerZYX,
  forwardKinematics,
  fromCols3,
  identity3,
  len3,
  mat3,
  mirrorM3,
  mulM3,
  mulTM3,
  norm3,
  perpNorm3,
  rotX3,
  rotY3,
  rotZ3,
  scale3,
  set3,
  sub3,
  vec3,
  type Mat3,
  type Side,
  type V3,
  type Vec3,
} from './DrummerSpec';
import { FINGERS, THUMB, thumbBase } from '../core/handGeometry';
import { solveFinger, solveThumb } from '../performance/HandIK';

// ---------------------------------------------------------------- public types
export interface StickTarget {
  /** the contact: where the tip (or for crashes the shoulder of the stick) meets the surface, kit frame */
  point: V3;
  /** the playing surface's normal there */
  normal: V3;
  /**
   * the stick's angle to the surface at contact, radians: positive comes down
   * onto the surface toward the tip (drums, a ride's bow); negative rises over
   * an edge toward the tip (a crash struck with the shoulder of the stick)
   */
  angle: number;
  /**
   * which point of the stick touches, as its distance back from the stick's end along its axis: STICK_BEAD
   * (the tip's bead) for ordinary strokes, STICK_SHOULDER for crashes. The stick's surface there meets the point.
   */
  contactFromTip: number;
  /** how far the tip is lifted above where it is at impact, metres (0 = the moment of impact) */
  lift: number;
  /** the hand's turn about the stick: 0 palm down (German), about 0.6 American, about 1.3 thumb up (French) */
  palmRoll: number;
  /** the stick's line across the surface, turned this much from its natural line (radians, + toward the drummer's left) */
  sweep?: number;
}

export interface FootTarget {
  pedal: PedalId;
  heel: 'down' | 'up';
  /** instead of `heel`, how far the heel is lifted (0 = down, 1 = up), for blends between poses */
  heelLift?: number;
  /** 0 = pedal up, 1 = pressed all the way */
  press: number;
}

export interface DrummerTargets {
  R: StickTarget;
  L: StickTarget;
  feet: { R: FootTarget; L: FootTarget };
  /** the leading hand: the torso and head favour it */
  lead: Side;
  /** instead of `lead`, how much the left hand leads (0..1), for blends between poses */
  leadL?: number;
  /** where the head looks (default: the leading stick's contact) */
  look?: V3;
}

/** fingers of one hand: node local rotations, 9 each, in this order (the hand's own node names) */
export const FINGER_NODES = [...FINGERS.flatMap((f) => [0, 1, 2].map((k) => `F${f.id}_${k}`)), 'T_0', 'T_1', 'T_2'];

export interface StickState {
  tip: Vec3;
  butt: Vec3;
  fulcrum: Vec3;
  /** unit, butt to tip */
  dir: Vec3;
  /** the point of the stick meant to touch (the tip, or the shoulder for a crash) */
  contact: Vec3;
}

export interface DrummerPose {
  /** where the model's origin sits (the seat top) */
  root: Vec3;
  /** local rotations, 9 per joint (row-major), in spec order */
  local: Float64Array;
  /** world rotations and positions, from the local ones */
  world: Float64Array;
  pos: Float64Array;
  /** every joint angle, in spec DOF order (see DOFS) */
  angles: Float64Array;
  /** the fingers' local rotations, 15 x 9 per hand (FINGER_NODES order), mirrored for L */
  fingers: Record<Side, Float64Array>;
  stick: Record<Side, StickState>;
  /** how far each stick is from where it was asked to be, metres (at impact: the contact's distance from its target) */
  error: Record<Side, number>;
  /** how far each ankle is from where its foot on the pedal needs it, metres */
  footError: Record<Side, number>;
  /** each pedal's footboard turn about its heel hinge (radians, negative = pressed) */
  pedal: Record<PedalId, number>;
  /** the torso's total turn (+ left), lean (- forward) and side bend (+ left), radians */
  torso: Vec3;
  /** the stick's angle to the surface, as solved (radians; positive coming down onto it toward the tip) */
  stickAngle: Record<Side, number>;
}

export function createPose(): DrummerPose {
  const st = (): StickState => ({ tip: vec3(), butt: vec3(), fulcrum: vec3(), dir: vec3(), contact: vec3() });
  const pose: DrummerPose = {
    root: vec3(),
    local: new Float64Array(NJ * 9),
    world: new Float64Array(NJ * 9),
    pos: new Float64Array(NJ * 3),
    angles: new Float64Array(NDOF),
    fingers: { R: new Float64Array(15 * 9), L: new Float64Array(15 * 9) },
    stick: { R: st(), L: st() },
    error: { R: 0, L: 0 },
    footError: { R: 0, L: 0 },
    pedal: { kickPedal: 0, hihatPedal: 0 },
    torso: vec3(),
    stickAngle: { R: 0, L: 0 },
  };
  for (let j = 0; j < NJ; j++) identity3(pose.local.subarray(j * 9, j * 9 + 9));
  return pose;
}

// ---------------------------------------------------------------- constants
const SEG = DRUMMER.segments;
const LU = SEG.upperArm;
const LF = SEG.forearm;
const LT = SEG.thigh;
const LS = SEG.shin;
const FOOT = DRUMMER.foot;
const GRIP = DRUMMER.grip;
const G_F = vec3(...GRIP.fulcrum);
const G_D = vec3(...GRIP.direction);
const G_A = vec3(...GRIP.rockAxis);
/** fulcrum to tip, and fulcrum to butt (metres) */
export const STICK_FRONT = STICK.length - GRIP.fulcrumFromButt;
export const STICK_BACK = GRIP.fulcrumFromButt;
/** the shoulder of the stick (where its taper begins), from the tip */
export const STICK_SHOULDER = DRUMMER.stick.shoulderFromTip;
/** the tip's bead: its radius, and so the distance of its centre from the stick's end */
export const STICK_BEAD = DRUMMER.stick.tipDiameter / 2;
/** the stick's radius at a distance back from its end (the bead, the taper, then the shaft) */
export function stickRadiusAt(c: number) {
  const rt = DRUMMER.stick.tipDiameter / 2;
  const rs = DRUMMER.stick.diameter / 2;
  const u = clamp((c - 1.5 * rt) / (DRUMMER.stick.taper - 1.5 * rt), 0, 1);
  return rt + (rs - rt) * u * u * (3 - 2 * u);
}
/** the stick's turn inward from the line of the forearm (radians) */
const STICK_INWARD = 0.18;
/** how far a pedal's footboard turns down about its heel hinge when pressed all the way (KitLayout's; re-exported for older callers) */
export { PEDAL_TRAVEL };
/** heel-up technique: the foot turned up about the ball (radians; the heel about 7 cm off the board) */
export const HEEL_UP = 0.4;

const lim = (joint: number, dof: number) => JOINTS[joint].dofs[dof].limits;
const ROCK = lim(J.arm.R.stick, 0);
const NECK_PITCH = lim(J.neck, 1);

/** a stroke's share of the turn: wrist, elbow, fingers (as in real technique: mostly wrist) */
const SHARE_WRIST = 0.73;
const SHARE_ARM = 0.12;
const SHARE_FINGERS = 0.15;

// the torso's turn (yaw), lean (pitch) and side bend (roll), shared over the pelvis, lumbar, lower thorax and chest
const YAW_SHARE = [0.12, 0.13, 0.33, 0.42];
const PITCH_SHARE = [0.3, 0.27, 0.2, 0.23];
const ROLL_SHARE = [0.1, 0.3, 0.35, 0.25];
const TORSO = [J.pelvis, J.spine1, J.spine2, J.chest];
/**
 * A drummer's posture (clips 4 and 8): leaning in from the hips, the upper
 * back a little rounded. The torso's lean when nothing pulls it further: the
 * back, from the pelvis to the chest's pivot, about 12 degrees off upright,
 * the chest about 17.
 */
const BASE_LEAN = -0.3;
/** the neck's forward carriage of the head, on top of where it looks (radians of the neck's pitch) */
const NECK_FORWARD = -0.12;
/** and the shoulders a little rounded: each clavicle's protraction when the hands are close (radians) */
const ROUND_SHOULDERS = 0.1;
/** the share of full reach an arm may use before the body turns and leans to help */
const COMFORT = 0.9;
/** the torso's half-depth beside the elbows (the lower thorax's shell), and how far inside the back an elbow's middle keeps (its barrel's radius) */
const BACK_DEPTH = 0.092;
const ELBOW_BEHIND = 0.045;
/** joint limits are kept this far inside (radians), so a solved pose never sits on a stop */
const LIMIT_MARGIN = 0.03;

const UP = vec3(0, 1, 0);
const SIDES: Side[] = ['R', 'L'];
const firstArm = { butt: vec3(), tip: vec3(), elbow: vec3(), wrist: vec3(), knuckle: vec3() };

function clamp(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x;
}
function mirrorV(o: Vec3, a: ArrayLike<number>) {
  return set3(o, -a[0], a[1], a[2]);
}

// ---------------------------------------------------------------- the kit as obstacles
// Arms and legs keep clear of the kit's solids (KitProxy): as the right side sees them, and mirrored for the
// left's solve. Built once; call refreshKit() if KitLayout's objects are moved.
let KIT: Proxy[] = [];
let KIT_M: Proxy[] = [];
/** each solid's bounding sphere (x, y, z, r), for both */
let KIT_B = new Float64Array(0);
let KIT_MB = new Float64Array(0);
function bounds(kit: Proxy[]) {
  const b = new Float64Array(kit.length * 4);
  kit.forEach((x, j) => {
    let c: V3, r: number;
    if (x.kind === 'rod') {
      c = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2, (x.a[2] + x.b[2]) / 2];
      r = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1], x.b[2] - x.a[2]) / 2 + x.radius;
    } else if (x.kind === 'cymbal') {
      c = x.centre;
      r = Math.hypot(x.radius, x.profile.bellHeight + x.profile.drop);
    } else {
      c = [x.centre[0] - (x.normal[0] * x.depth) / 2, x.centre[1] - (x.normal[1] * x.depth) / 2, x.centre[2] - (x.normal[2] * x.depth) / 2];
      r = Math.hypot(x.radius, x.depth / 2);
    }
    b.set([c[0], c[1], c[2], r], j * 4);
  });
  return b;
}
const mx = (p: V3): V3 => [-p[0], p[1], p[2]];
function mirrorProxy(x: Proxy): Proxy {
  if (x.kind === 'rod') return { ...x, a: mx(x.a), b: mx(x.b) };
  return { ...x, centre: mx(x.centre), normal: mx(x.normal) };
}
/** rebuild the obstacles from KitLayout (after its objects are moved; not needed otherwise) */
export function refreshKit() {
  KIT = kitProxies();
  KIT_M = KIT.map(mirrorProxy);
  KIT_B = bounds(KIT);
  KIT_MB = bounds(KIT_M);
  near = new Uint8Array(KIT.length);
}
/** which solids are near the arm being tried */
let near = new Uint8Array(0);
refreshKit();
/** clearance kept from the kit (metres) */
const CLEAR = 0.02;
const OBSTACLE_WEIGHT = 150;
/** how much more an actual penetration costs than the clearance zone */
const PENETRATION = 100;
/** the gap kept between the two arms and sticks (metres) */
const ARM_GAP = 0.003;

// ---------------------------------------------------------------- the grip: fingers wrapped round the stick
// Finger poses are solved once, at load, for a range of rock angles with the
// hand's own IK (which allocates), and interpolated per frame.
const ROCK_SAMPLES = 9;
/** per sample: [abd, a0, a1, a2] x 4 fingers, then the thumb [swing, twist, a0, a1, a2] */
const gripTable: Float64Array[] = [];
/** which way round the stick each finger closes (from its axis, made perpendicular to it), and how loosely */
const FINGER_WRAP: [number, number, number][] = [
  [-0.4, -0.6, 0.0],
  [0.0, -0.6, 0.1],
  [0.05, -0.55, 0.1],
  [0.05, -0.5, 0.1],
];
const FINGER_GAP = [0.0003, 0.0009, 0.0018, 0.003];
/** the fingers' residual distance from their grip targets at the neutral rock (for tests), metres */
export const GRIP_FIT: number[] = [];

const sdM = mat3();
/** the stick's direction in the palm frame at a rock angle */
function stickDirInPalm(o: Vec3, rock: number) {
  axisAngle3(sdM, G_A, rock);
  return apply3(o, sdM, G_D);
}

function buildGripTable() {
  const rs = DRUMMER.stick.diameter / 2;
  for (let k = 0; k < ROCK_SAMPLES; k++) {
    const rock = ROCK[0] + ((ROCK[1] - ROCK[0]) * k) / (ROCK_SAMPLES - 1);
    const d = stickDirInPalm(vec3(), rock);
    const row = new Float64Array(21);
    const fit: number[] = [];
    FINGERS.forEach((f, i) => {
      // each finger closes round the stick where the stick crosses the finger's own plane
      const at = addScaled3(vec3(), G_F, d, (f.mcp[0] - G_F[0]) / d[0]);
      const wrap = perpNorm3(vec3(), vec3(...FINGER_WRAP[i]), d);
      const tgt = addScaled3(vec3(), at, wrap, rs + f.tipRadius + FINGER_GAP[i]);
      const s = solveFinger(i, [tgt[0], tgt[1], tgt[2]], 0.2);
      row.set([s.abduction, s.angles[0], s.angles[1], s.angles[2]], i * 4);
      fit.push(s.error);
    });
    // the thumb's pad presses the stick from above, on the thumb's side, opposite the index finger
    const side = perpNorm3(vec3(), vec3(-0.6, 0.75, 0.1), d);
    const tgt = addScaled3(vec3(), addScaled3(vec3(), G_F, d, -0.005), side, rs + THUMB.tipRadius * 0.85);
    const t = solveThumb([tgt[0], tgt[1], tgt[2]]);
    row.set([t.swing, t.twist, t.angles[0], t.angles[1], t.angles[2]], 16);
    fit.push(t.error);
    gripTable.push(row);
    if (k === Math.round(((0 - ROCK[0]) / (ROCK[1] - ROCK[0])) * (ROCK_SAMPLES - 1))) GRIP_FIT.push(...fit);
  }
}
buildGripTable();

const T_BASE = Float64Array.from(thumbBase(THUMB));
const gripRow = new Float64Array(21);
const gfR = mat3();
const gfT = mat3();

function writeFingers(out: Float64Array, rock: number, mirror: boolean) {
  const u = clamp((rock - ROCK[0]) / (ROCK[1] - ROCK[0]), 0, 1) * (ROCK_SAMPLES - 1);
  const k = Math.min(ROCK_SAMPLES - 2, Math.floor(u));
  const f = u - k;
  const a = gripTable[k];
  const b = gripTable[k + 1];
  for (let i = 0; i < 21; i++) gripRow[i] = a[i] + (b[i] - a[i]) * f;
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    rotY3(gfR, FINGERS[i].baseYaw + gripRow[o]);
    mulM3(gfR, gfR, rotX3(gfT, -gripRow[o + 1]));
    out.set(gfR, i * 3 * 9);
    out.set(rotX3(gfR, -gripRow[o + 2]), (i * 3 + 1) * 9);
    out.set(rotX3(gfR, -gripRow[o + 3]), (i * 3 + 2) * 9);
  }
  rotY3(gfR, gripRow[16]);
  mulM3(gfR, gfR, T_BASE);
  mulM3(gfR, gfR, rotZ3(gfT, gripRow[17]));
  mulM3(gfR, gfR, rotX3(gfT, -gripRow[18]));
  out.set(gfR, 12 * 9);
  out.set(rotX3(gfR, -gripRow[19]), 13 * 9);
  out.set(rotX3(gfR, -gripRow[20]), 14 * 9);
  if (mirror)
    for (let n = 0; n < 15; n++) {
      mirrorM3(gfR, out, n * 9);
      out.set(gfR, n * 9);
    }
}

// ---------------------------------------------------------------- the arm (canonical: the right, or the left mirrored)
interface ArmIn {
  /** chest and clavicle world rotations, shoulder joint position */
  chest: Mat3;
  clav: Mat3;
  shoulder: Vec3;
  point: Vec3;
  normal: Vec3;
  angle: number;
  contactFromTip: number;
  lift: number;
  palmRoll: number;
  sweep: number;
  /** the kit as this side sees it, and which of its solids the stick is striking (it may touch those near the contact) */
  kit: Proxy[];
  kitBounds: Float64Array;
  struck: Uint8Array;
  /** the back of the torso beside the elbows: a point on it and its outward normal (an elbow keeps in front of it) */
  backP: Vec3;
  backN: Vec3;
  /** the other arm's stick, forearm and hand (capsules: a, b, radius), already solved, to keep clear of */
  other: Float64Array;
  nOther: number;
}
interface ArmOut {
  /** local rotations: upper arm (relative to the clavicle), forearm, forearm roll, palm, stick */
  upper: Mat3;
  forearm: Mat3;
  twist: Mat3;
  palm: Mat3;
  stick: Mat3;
  /** world: the palm's rotation, wrist, elbow, fulcrum, stick direction and tip */
  palmW: Mat3;
  wrist: Vec3;
  elbow: Vec3;
  fulcrum: Vec3;
  dir: Vec3;
  tip: Vec3;
  /** shoulder flexion, abduction, rotation; elbow; supination; wrist flexion, deviation; rock */
  ang: Float64Array;
  rock: number;
  /** how far the wrist is from where the stick needs it (metres) */
  short: number;
  cost: number;
}
const mkArmIn = (): ArmIn => ({
  chest: mat3(),
  clav: mat3(),
  shoulder: vec3(),
  point: vec3(),
  normal: vec3(),
  angle: 0,
  contactFromTip: 0,
  lift: 0,
  palmRoll: 0,
  sweep: 0,
  kit: [],
  kitBounds: new Float64Array(0),
  struck: new Uint8Array(64),
  backP: vec3(),
  backN: vec3(),
  other: new Float64Array(3 * 7),
  nOther: 0,
});
const mkArmOut = (): ArmOut => ({
  upper: mat3(),
  forearm: mat3(),
  twist: mat3(),
  palm: mat3(),
  stick: mat3(),
  palmW: mat3(),
  wrist: vec3(),
  elbow: vec3(),
  fulcrum: vec3(),
  dir: vec3(),
  tip: vec3(),
  ang: new Float64Array(8),
  rock: 0,
  short: 0,
  cost: 0,
});
const armIn = mkArmIn();
const armTrial = mkArmOut();
const armBest = mkArmOut();

const ARM_LIMITS: [number, number][] = [
  lim(J.arm.R.upper, 0),
  lim(J.arm.R.upper, 1),
  lim(J.arm.R.upper, 2),
  lim(J.arm.R.forearm, 0),
  lim(J.arm.R.twist, 0),
  lim(J.arm.R.palm, 0),
  lim(J.arm.R.palm, 1),
  ROCK,
];

// palmFromStick scratch
const pfD = vec3();
const pfE2 = vec3();
const pfE3 = vec3();
const pfW2 = vec3();
const pfW3 = vec3();
const pfY = vec3();
const pfP = mat3();
const pfW = mat3();
const pfT = mat3();
/**
 * The palm's world rotation that holds the stick along u at a rock angle, the
 * back of the hand toward `up`, then turned `roll` about the stick (positive
 * raises the thumb).
 */
function palmFromStick(o: Mat3, u: Vec3, up: Vec3, roll: number, rock: number) {
  stickDirInPalm(pfD, rock);
  perpNorm3(pfE2, set3(pfY, 0, 1, 0), pfD);
  cross3(pfE3, pfD, pfE2);
  fromCols3(pfP, pfD, pfE2, pfE3);
  perpNorm3(pfW2, up, u, set3(pfY, 0, 0, 1));
  cross3(pfW3, u, pfW2);
  fromCols3(pfW, u, pfW2, pfW3);
  axisAngle3(pfT, u, roll);
  mulM3(pfW, pfT, pfW);
  // o = W P^T
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = pfW[r * 3] * pfP[c * 3] + pfW[r * 3 + 1] * pfP[c * 3 + 1] + pfW[r * 3 + 2] * pfP[c * 3 + 2];
  return o;
}

// armFromHand scratch
const ahSW = vec3();
const ahWH = vec3();
const ahOut = vec3();
const ahBack = vec3();
const ahPref = vec3();
const ahEH = vec3();
const ahU = vec3();
const ahF = vec3();
const ahX = vec3();
const ahY = vec3();
const ahZ = vec3();
const ahT = vec3();
const ahRu = mat3();
const ahRf = mat3();
const ahQ = mat3();
const ahM = mat3();
const ahAng = new Float64Array(3);

// obstacle scratch
const obDir = vec3();
const obButt = vec3();
const obTip = vec3();
const obC = vec3();
const obP = vec3();
const obK = vec3();
const obA = vec3();
const obB = vec3();
const STICK_R = DRUMMER.stick.diameter / 2;
const CAPS = DRUMMER.capsules;

/** how far a point (a sphere of radius r) is inside the kit's clearance; `letOff` (0..1) excuses the struck surface */
function pointPenalty(inp: ArmIn, p: Vec3, r: number, letOff: number): number {
  let pen = 0;
  const kit = inp.kit;
  for (let j = 0; j < kit.length; j++) {
    if (!near[j]) continue;
    const d = proxyDistance(p, kit[j]) - r;
    // a soft zone of clearance, then much stiffer once actually into the solid
    if (d < CLEAR) pen += ((CLEAR - d) * (CLEAR - d) + (d < 0 ? PENETRATION * d * d : 0)) * (inp.struck[j] ? 1 - letOff : 1);
  }
  return pen;
}

/**
 * How far into the kit (and into the other arm) this arm's stick, hand and forearm go, as a sum of squared
 * depths inside the clearance. The stick may touch what it strikes near its contact.
 */
function obstaclePenalty(inp: ArmIn, out: ArmOut, Rp: Mat3, rock: number): number {
  stickDirInPalm(obP, rock);
  apply3(obDir, Rp, obP);
  addScaled3(obButt, out.fulcrum, obDir, -STICK_BACK);
  addScaled3(obTip, out.fulcrum, obDir, STICK_FRONT);
  addScaled3(obC, obTip, obDir, -inp.contactFromTip);
  // the solids whose bounding spheres reach the arm's (butt, tip, elbow, wrist)
  let cx = 0.25 * (obButt[0] + obTip[0] + out.elbow[0] + out.wrist[0]);
  let cy = 0.25 * (obButt[1] + obTip[1] + out.elbow[1] + out.wrist[1]);
  let cz = 0.25 * (obButt[2] + obTip[2] + out.elbow[2] + out.wrist[2]);
  const ra = Math.max(Math.hypot(obButt[0] - cx, obButt[1] - cy, obButt[2] - cz), Math.hypot(obTip[0] - cx, obTip[1] - cy, obTip[2] - cz), Math.hypot(out.elbow[0] - cx, out.elbow[1] - cy, out.elbow[2] - cz), Math.hypot(out.wrist[0] - cx, out.wrist[1] - cy, out.wrist[2] - cz)) + 0.06;
  const B = inp.kitBounds;
  for (let j = 0; j < inp.kit.length; j++) near[j] = Math.hypot(B[j * 4] - cx, B[j * 4 + 1] - cy, B[j * 4 + 2] - cz) < ra + B[j * 4 + 3] ? 1 : 0;
  cx = cy = cz = 0;
  let pen = 0;
  const n = 8;
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    for (let i = 0; i < 3; i++) obP[i] = obButt[i] + (obTip[i] - obButt[i]) * u;
    // near the contact the struck surface is let off, fading back in as the stick lifts or the point moves away
    const dc = dist3(obP, obC);
    const off = (1 - clamp((inp.lift - 0.002) / 0.01, 0, 1)) * (1 - clamp((dc - 0.035) / 0.02, 0, 1));
    pen += pointPenalty(inp, obP, STICK_R, off);
  }
  // the hand, out to the knuckles, and the forearm
  apply3(obK, Rp, set3(obP, 0, -0.012, -0.085));
  addScaled3(obK, obK, out.wrist, 1);
  for (let k = 1; k <= 2; k++) {
    for (let i = 0; i < 3; i++) obP[i] = out.wrist[i] + (obK[i] - out.wrist[i]) * (k / 2);
    pen += pointPenalty(inp, obP, CAPS.hand * 0.8, 0);
  }
  for (let k = 1; k <= 3; k++) {
    for (let i = 0; i < 3; i++) obP[i] = out.elbow[i] + (out.wrist[i] - out.elbow[i]) * (0.25 + 0.25 * k);
    pen += pointPenalty(inp, obP, CAPS.forearm, 0);
  }
  // the other arm: stick, forearm and hand against this one's
  const O = inp.other;
  for (let c = 0; c < inp.nOther; c++) {
    const o = c * 7;
    copy3(obA, O, o);
    copy3(obB, O, o + 3);
    const ro = O[o + 6];
    const ds = segSegDistance(obButt, obTip, obA, obB) - STICK_R - ro;
    const dh = segSegDistance(out.wrist, obK, obA, obB) - CAPS.hand * 0.8 - ro;
    const df = segSegDistance(out.elbow, out.wrist, obA, obB) - CAPS.forearm - ro;
    // the arms only keep out of each other (a clearance zone between them would flip the way one passes the other)
    if (ds < ARM_GAP) pen += (1 + PENETRATION) * (ARM_GAP - ds) * (ARM_GAP - ds);
    if (dh < ARM_GAP) pen += (1 + PENETRATION) * (ARM_GAP - dh) * (ARM_GAP - dh);
    if (df < ARM_GAP) pen += (1 + PENETRATION) * (ARM_GAP - df) * (ARM_GAP - df);
  }
  return pen;
}

/**
 * One arm, given the palm's world rotation, its rock and the fulcrum (in
 * out.fulcrum): the wrist from the grip, the elbow on its swivel circle, then
 * the local rotations and angles. Writes `out`; returns the cost (limit
 * excess, squared, plus how far the wrist falls short).
 */
function armFromHand(inp: ArmIn, Rp: Mat3, rock: number, swivel: number, out: ArmOut): number {
  out.palmW.set(Rp);
  const W = out.wrist;
  apply3(ahT, Rp, G_F);
  sub3(W, out.fulcrum, ahT);
  const S = inp.shoulder;
  sub3(ahSW, W, S);
  let d = len3(ahSW);
  const dmax = LU + LF - 1e-4;
  const dmin = 0.16;
  out.short = Math.max(0, d - dmax, dmin - d);
  scale3(ahWH, ahSW, 1 / (d || 1));
  d = clamp(d, dmin, dmax);
  addScaled3(W, S, ahWH, d);
  // the elbow hangs, a little out to the side and back; the swivel turns it about the shoulder-wrist line
  apply3(ahOut, inp.chest, set3(ahT, 1, 0, 0));
  apply3(ahBack, inp.chest, set3(ahT, 0, 0, 1));
  set3(ahPref, 0.45 * ahOut[0] + 0.2 * ahBack[0], -1 + 0.45 * ahOut[1] + 0.2 * ahBack[1], 0.45 * ahOut[2] + 0.2 * ahBack[2]);
  perpNorm3(ahEH, ahPref, ahWH, ahBack);
  if (swivel !== 0) {
    axisAngle3(ahM, ahWH, swivel);
    apply3(ahEH, ahM, ahEH);
  }
  const a = (LU * LU - LF * LF + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, LU * LU - a * a));
  const E = out.elbow;
  addScaled3(E, S, ahWH, a);
  addScaled3(E, E, ahEH, h);
  // the upper arm's frame: -Y along the arm, -Z toward the forearm, X the elbow's hinge
  scale3(ahU, sub3(ahU, E, S), 1 / LU);
  scale3(ahF, sub3(ahF, W, E), 1 / LF);
  scale3(ahY, ahU, -1);
  perpNorm3(ahZ, ahF, ahU, ahBack);
  scale3(ahZ, ahZ, -1);
  cross3(ahX, ahY, ahZ);
  fromCols3(ahRu, ahX, ahY, ahZ);
  const e = Math.acos(clamp(dot3(ahF, ahU), -1, 1));
  // the forearm's world rotation; the forearm's roll and the wrist take up the rest: Q = Rz(-sup) Ry(dev) Rx(-flex)
  mulM3(ahRf, ahRu, rotX3(ahM, e - Math.PI / 2));
  mulTM3(ahQ, ahRf, Rp);
  eulerZYX(ahQ, ahAng);
  const sup = -ahAng[0];
  const dev = ahAng[1];
  const flex = -ahAng[2];
  mulTM3(out.upper, inp.clav, ahRu);
  rotX3(out.forearm, e - Math.PI / 2);
  rotZ3(out.twist, -sup);
  rotY3(out.palm, dev);
  mulM3(out.palm, out.palm, rotX3(ahM, -flex));
  axisAngle3(out.stick, G_A, rock);
  const A = out.ang;
  eulerZXY(out.upper, ahAng);
  A[0] = ahAng[1];
  A[1] = ahAng[0];
  A[2] = ahAng[2];
  A[3] = e;
  A[4] = sup;
  A[5] = flex;
  A[6] = dev;
  A[7] = rock;
  out.rock = rock;
  // a joint past its range costs most; then how far the wrist is short of the stick; then comfort: the wrist
  // near straight with a little ulnar give (as in matched grip), the upper arm not drawn back behind the body nor
  // lifted out like a wing, the arm not wrung about its own axis, the forearm not rolled past thumb-up
  let over = 0;
  for (let i = 0; i < 8; i++) {
    const lo = ARM_LIMITS[i][0] + LIMIT_MARGIN;
    const hi = ARM_LIMITS[i][1] - LIMIT_MARGIN;
    const x = A[i];
    const ex = x < lo ? lo - x : x > hi ? x - hi : 0;
    // inside the margin it is a preference; past the joint's real stop it is not allowed
    const hard = Math.max(0, ex - LIMIT_MARGIN);
    over += ex * ex + 3000 * hard * hard;
  }
  const back = Math.max(0, -A[0] - 0.05);
  const wing = Math.max(0, A[1] - 0.55);
  // the elbow kept in front of the back: it may hang beside the torso, not poke out behind it
  const BP = inp.backP, BN = inp.backN;
  const behind = Math.max(0, (E[0] - BP[0]) * BN[0] + (E[1] - BP[1]) * BN[1] + (E[2] - BP[2]) * BN[2] + ELBOW_BEHIND);
  const comfort =
    0.5 * (flex - 0.05) ** 2 +
    0.6 * (dev + 0.15) ** 2 +
    0.8 * back * back +
    0.6 * wing * wing +
    150 * behind * behind +
    0.12 * A[2] * A[2] +
    0.15 * Math.max(0, sup - 1.4) ** 2;
  out.cost = 100 * over + 40 * out.short * out.short + comfort + OBSTACLE_WEIGHT * obstaclePenalty(inp, out, Rp, rock);
  return out.cost;
}

// stickAtContact scratch
const scAnchor = vec3();
const scPlan = vec3();
const scFb = vec3();
const scM = mat3();
/** the stick at contact for these choices: its direction u, its fulcrum F and its tip */
function stickAtContact(inp: ArmIn, sweep: number, u: Vec3, F: Vec3, tip: Vec3) {
  const N = inp.normal;
  // its natural line: forearm and stick run on from the elbow hanging at the body's side toward the contact,
  // the stick turned a little inward of that line (the grip's angle less the wrist's ulnar give), so the two
  // sticks make a V
  apply3(scAnchor, inp.chest, set3(scFb, 0.06, -0.26, -0.06));
  addScaled3(scAnchor, scAnchor, inp.shoulder, 1);
  sub3(scPlan, inp.point, scAnchor);
  perpNorm3(scPlan, scPlan, N, set3(scFb, 0, 0, -1));
  axisAngle3(scM, N, sweep + STICK_INWARD);
  apply3(scPlan, scM, scPlan);
  // down onto the surface toward the tip (or, at a negative angle, rising over an edge), the contact point of the stick on the target
  const ca = Math.cos(inp.angle);
  const sa = Math.sin(inp.angle);
  set3(u, ca * scPlan[0] - sa * N[0], ca * scPlan[1] - sa * N[1], ca * scPlan[2] - sa * N[2]);
  // the stick's surface meets the point: its axis passes one stick radius above it
  addScaled3(tip, inp.point, N, stickRadiusAt(inp.contactFromTip));
  addScaled3(tip, tip, u, inp.contactFromTip);
  addScaled3(F, tip, u, -STICK_FRONT);
}

// liftStroke scratch
const lsE0 = vec3();
const lsW0 = vec3();
const lsHinge = vec3();
const lsPlan = vec3();
const lsAx = vec3();
const lsW = vec3();
const lsT = vec3();
const lsR0 = mat3();
const lsRot = mat3();
const lsR = mat3();
const lsTip = vec3();

let lsInp: ArmIn;
let lsOut: ArmOut;
let lsRock = 0;
/** the stroke turned up by theta (shared by forearm, wrist and fingers): writes the stick, returns the tip's height */
function liftTip(theta: number) {
  const out = lsOut;
  axisAngle3(lsRot, lsHinge, SHARE_ARM * theta);
  sub3(lsW, lsW0, lsE0);
  apply3(lsW, lsRot, lsW);
  addScaled3(lsW, lsE0, lsW, 1);
  mulM3(lsR, lsRot, lsR0);
  const want = SHARE_FINGERS * theta;
  lsRock = Math.min(ROCK[1] - LIMIT_MARGIN, want);
  axisAngle3(lsRot, lsAx, SHARE_WRIST * theta + (want - lsRock));
  mulM3(lsR, lsRot, lsR);
  stickDirInPalm(lsT, lsRock);
  apply3(out.dir, lsR, lsT);
  apply3(out.fulcrum, lsR, G_F);
  addScaled3(out.fulcrum, out.fulcrum, lsW, 1);
  addScaled3(lsTip, out.fulcrum, out.dir, STICK_FRONT);
  return dot3(sub3(lsT, lsTip, lsInp.point), lsInp.normal);
}

/**
 * Lift the stick `inp.lift` above where it is at impact, the way a stroke is
 * made: the forearm turns up about the elbow, the hand about the wrist (about
 * a level axis across the stick, so the tip rises straight) and the back
 * fingers open (the stick rocks about the fulcrum; past the rock's range the
 * wrist takes the rest). Rp holds the impact palm in, the lifted palm out;
 * out.fulcrum likewise. Returns the rock.
 */
function liftStroke(inp: ArmIn, out: ArmOut, Rp: Mat3, swivel: number): number {
  const N = inp.normal;
  armFromHand(inp, Rp, 0, swivel, out);
  copy3(lsE0, out.elbow);
  copy3(lsW0, out.wrist);
  // the elbow's hinge in the world: the upper arm's X
  apply3(lsHinge, out.upper, set3(lsT, 1, 0, 0));
  apply3(lsHinge, inp.clav, lsHinge);
  copyM3(lsR0, Rp);
  perpNorm3(lsPlan, out.dir, UP, set3(lsT, 0, 0, -1));
  // level and across the stick, so that turning about it raises the tip; without its part about the back of the
  // hand's normal, so the wrist extends and the forearm rolls (as in American grip) rather than bending sideways
  norm3(lsAx, cross3(lsAx, lsPlan, UP));
  apply3(lsT, lsR0, set3(lsT, 0, 1, 0));
  perpNorm3(lsAx, lsAx, lsT, lsAx);
  lsInp = inp;
  lsOut = out;
  const h0 = liftTip(0);
  let lo = 0;
  let hi = 1.9;
  for (let i = 0; i < 17; i++) {
    const mid = 0.5 * (lo + hi);
    if (liftTip(mid) - h0 < inp.lift) lo = mid;
    else hi = mid;
  }
  liftTip(0.5 * (lo + hi));
  Rp.set(lsR);
  copy3(out.tip, lsTip);
  return lsRock;
}

// armTry scratch
const atUp = vec3();
const atRp = mat3();
/** the arm for given free choices; the result in `out`, its cost returned */
function armTry(inp: ArmIn, roll: number, swivel: number, sweep: number, out: ArmOut): number {
  stickAtContact(inp, sweep, out.dir, out.fulcrum, out.tip);
  // the back of the hand away from the surface (blended with up, so a tilted cymbal does not tip the hand over)
  norm3(atUp, set3(atUp, inp.normal[0] + UP[0], inp.normal[1] + UP[1], inp.normal[2] + UP[2]));
  palmFromStick(atRp, out.dir, atUp, roll, 0);
  const rock = inp.lift > 1e-5 ? liftStroke(inp, out, atRp, swivel) : 0;
  const cost = armFromHand(inp, atRp, rock, swivel, out);
  // stay near the natural choices
  return cost + 0.15 * (roll - inp.palmRoll) ** 2 + 0.06 * swivel * swivel + 0.1 * (sweep - inp.sweep) ** 2;
}

function copyArm(o: ArmOut, a: ArmOut) {
  o.upper.set(a.upper);
  o.forearm.set(a.forearm);
  o.twist.set(a.twist);
  o.palm.set(a.palm);
  o.stick.set(a.stick);
  o.palmW.set(a.palmW);
  o.wrist.set(a.wrist);
  o.elbow.set(a.elbow);
  o.fulcrum.set(a.fulcrum);
  o.dir.set(a.dir);
  o.tip.set(a.tip);
  o.ang.set(a.ang);
  o.rock = a.rock;
  o.short = a.short;
  o.cost = a.cost;
}

const searchP = new Float64Array(3);

const searchStep = new Float64Array(3);
/**
 * Solve one arm over its free choices (the hand's turn about the stick and the elbow's swivel; the stick keeps
 * its natural line), toward the most comfortable pose that keeps every joint in its range and clear of the kit.
 * A fixed grid of choices is costed and their soft minimum taken (a weighted mean, weights falling off with the
 * cost), then a few damped Newton steps refine it. Every step is a smooth function of the targets, so the pose is
 * too: the same targets give the same pose, and nearby targets nearby poses (no jumps as a stroke moves), while
 * the grid keeps it out of the poor basins a single descent can fall into.
 */
function solveArm(inp: ArmIn, out: ArmOut) {
  let cmin = Infinity;
  for (let i = 0; i < ARM_GRID.length; i++) {
    const g = ARM_GRID[i];
    gridCost[i] = armTry(inp, inp.palmRoll + g[0], g[1], inp.sweep + g[2], armTrial);
    if (gridCost[i] < cmin) cmin = gridCost[i];
  }
  let W = 0;
  searchP[0] = searchP[1] = searchP[2] = 0;
  for (let i = 0; i < ARM_GRID.length; i++) {
    const w = Math.exp(-(gridCost[i] - cmin) / SOFT_T);
    W += w;
    searchP[0] += w * (inp.palmRoll + ARM_GRID[i][0]);
    searchP[1] += w * ARM_GRID[i][1];
    searchP[2] += w * (inp.sweep + ARM_GRID[i][2]);
  }
  for (let k = 0; k < 3; k++) searchP[k] /= W;
  const h = 0.02;
  let c0 = armTry(inp, searchP[0], searchP[1], searchP[2], armTrial);
  for (let it = 0; it < NEWTON_STEPS; it++) {
    for (let k = 0; k < 3; k++) {
      const was = searchP[k];
      searchP[k] = was + h;
      const cp = armTry(inp, searchP[0], searchP[1], searchP[2], armTrial);
      searchP[k] = was - h;
      const cm = armTry(inp, searchP[0], searchP[1], searchP[2], armTrial);
      searchP[k] = was;
      // a Newton step where the cost curves upward, a gradient step otherwise; never more than STEP_MAX
      searchStep[k] = -((cp - cm) / (2 * h)) / Math.max((cp - 2 * c0 + cm) / (h * h), NEWTON_MIN_CURV);
    }
    // take the step, halved until the cost comes down (a joint's stop or the kit can make the valley steep)
    for (let k = 0; k < 3; k++) searchStep[k] = clamp(searchStep[k], -STEP_MAX, STEP_MAX) * NEWTON_DAMP;
    let f = 1;
    for (let tries = 0; tries < 5; tries++, f *= 0.5) {
      const c1 = armTry(inp, searchP[0] + f * searchStep[0], searchP[1] + f * searchStep[1], searchP[2] + f * searchStep[2], armTrial);
      if (c1 < c0) {
        for (let k = 0; k < 3; k++) searchP[k] += f * searchStep[k];
        c0 = c1;
        break;
      }
    }
  }
  const best = armTry(inp, searchP[0], searchP[1], searchP[2], armBest);
  copyArm(out, armBest);
  return best;
}
/** the grid of choices: the hand's turn about the stick (offsets from the instrument's), the elbow's swivel, the stick's line */
const ARM_GRID: [number, number, number][] = [];
for (const r of [-0.4, 0, 0.4, 0.8]) for (const w of [-0.9, -0.55, -0.2, 0.15, 0.5, 0.85]) for (const sw of [-0.3, 0, 0.3]) ARM_GRID.push([r, w, sw]);
const gridCost = new Float64Array(ARM_GRID.length);
/** the soft minimum's temperature (cost units) */
const SOFT_T = 0.04;
const NEWTON_STEPS = 3;
const NEWTON_MIN_CURV = 1.5;
const NEWTON_DAMP = 0.7;
const STEP_MAX = 0.15;

// ---------------------------------------------------------------- the leg (canonical)
interface LegIn {
  /** the kit as this side sees it */
  kit: Proxy[];
  pelvis: Mat3;
  hip: Vec3;
  /** the pedal's heel hinge and ball point */
  heel: Vec3;
  ball: Vec3;
  /** 0 heel down .. 1 heel up */
  heelLift: number;
  press: number;
}
interface LegOut {
  thigh: Mat3;
  shin: Mat3;
  foot: Mat3;
  toes: Mat3;
  /** hip flexion, abduction, rotation; knee; ankle plantar flexion, inversion, abduction; toes */
  ang: Float64Array;
  short: number;
  board: number;
  /** how far the knee is splayed out from over the foot (radians) */
  splay: number;
  /** the shin's turn about its axis */
  twist: number;
}
const legIn: LegIn = { kit: [], pelvis: mat3(), hip: vec3(), heel: vec3(), ball: vec3(), heelLift: 0, press: 0 };
const legOut: LegOut = { thigh: mat3(), shin: mat3(), foot: mat3(), toes: mat3(), ang: new Float64Array(8), short: 0, board: 0, splay: 0, twist: 0 };
const lgB = vec3();
const lgBH = vec3();
const lgXB = vec3();
const lgNB = vec3();
const lgBall = vec3();
const lgZ = vec3();
const lgA = vec3();
const lgT = vec3();
const lgHA = vec3();
const lgWH = vec3();
const lgFwd = vec3();
const lgPref = vec3();
const lgKH = vec3();
const lgK = vec3();
const lgAJ = vec3();
const lgTH = vec3();
const lgSH = vec3();
const lgX = vec3();
const lgY = vec3();
const lgM = mat3();
const lgRb = mat3();
const lgRfoot = mat3();
const lgRt = mat3();
const lgRs = mat3();
const lgAng = new Float64Array(3);
const MAX_KNEE = lim(J.leg.R.shin, 0)[1];
const KNEE_ROT = lim(J.leg.R.shin, 1);
const lgOut = vec3();
const lgKT = vec3();
const lgP = vec3();
/** the knee's outward splays tried, from over the foot (radians) */
const KNEE_SPLAY = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const splayCost = new Float64Array(KNEE_SPLAY.length);

function solveLeg(inp: LegIn, out: LegOut) {
  // the footboard, turned down about its heel hinge as it is pressed
  sub3(lgB, inp.ball, inp.heel);
  const bl = len3(lgB);
  scale3(lgBH, lgB, 1 / bl);
  norm3(lgXB, cross3(lgXB, lgBH, UP));
  const turn = -PEDAL_TRAVEL * clamp(inp.press, 0, 1);
  out.board = turn;
  axisAngle3(lgM, lgXB, turn);
  apply3(lgBH, lgM, lgBH);
  cross3(lgNB, lgXB, lgBH);
  addScaled3(lgBall, inp.heel, lgBH, bl);
  fromCols3(lgRb, lgXB, lgNB, scale3(lgZ, lgBH, -1));
  // the foot on it: the ball of the foot on the board's ball point and the toes flat on the board, the heel
  // lifted by turning the foot about the ball (none: the whole sole on the board)
  const gamma = HEEL_UP * clamp(inp.heelLift, 0, 1);
  mulM3(lgRfoot, lgRb, rotX3(lgM, -gamma));
  addScaled3(lgT, lgBall, lgNB, FOOT.ankleHeight + FOOT.ball[1]);
  apply3(lgA, lgRfoot, set3(lgZ, FOOT.ball[0], FOOT.ball[1], FOOT.ball[2]));
  sub3(lgA, lgT, lgA);
  rotX3(out.toes, gamma);
  // hip to ankle, with the knee over the foot
  const H = inp.hip;
  sub3(lgHA, lgA, H);
  let d = len3(lgHA);
  const dmax = LT + LS - 1e-4;
  const dmin = Math.sqrt(LT * LT + LS * LS - 2 * LT * LS * Math.cos(Math.PI - MAX_KNEE)) + 1e-4;
  out.short = Math.max(0, d - dmax, dmin - d);
  scale3(lgWH, lgHA, 1 / (d || 1));
  d = clamp(d, dmin, dmax);
  perpNorm3(lgFwd, lgBH, UP, set3(lgZ, 0, 0, -1));
  set3(lgPref, lgFwd[0], lgFwd[1] + 0.35, lgFwd[2]);
  perpNorm3(lgKH, lgPref, lgWH, lgFwd);
  const a = (LT * LT - LS * LS + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, LT * LT - a * a));
  addScaled3(lgAJ, H, lgWH, d);
  // the knee tracks over the foot; if the thigh or shin would meet the kit (a snare over the thigh, a kick in
  // front of the knee) it splays outward round it, as a drummer's left knee goes round the snare
  perpNorm3(lgOut, set3(lgZ, 1, 0, 0), lgWH, lgKH);
  perpNorm3(lgOut, lgOut, lgKH, lgOut);
  let cmin = Infinity;
  for (let k = 0; k < KNEE_SPLAY.length; k++) {
    const sa = KNEE_SPLAY[k];
    for (let i = 0; i < 3; i++) lgKT[i] = lgKH[i] * Math.cos(sa) + lgOut[i] * Math.sin(sa);
    addScaled3(lgK, H, lgWH, a);
    addScaled3(lgK, lgK, lgKT, h);
    let pen = 0;
    for (let q = 1; q <= 7; q++) {
      const thigh = q <= 4;
      const u = thigh ? q / 4 : (q - 4) / 3.5;
      for (let i = 0; i < 3; i++) lgP[i] = thigh ? H[i] + (lgK[i] - H[i]) * u : lgK[i] + (lgAJ[i] - lgK[i]) * u;
      const r = thigh ? CAPS.thigh : CAPS.shin;
      for (let j = 0; j < inp.kit.length; j++) {
        const dd = proxyDistance(lgP, inp.kit[j]) - r;
        if (dd < CLEAR) pen += (CLEAR - dd) * (CLEAR - dd);
      }
    }
    splayCost[k] = OBSTACLE_WEIGHT * pen + 0.25 * sa * sa;
    if (splayCost[k] < cmin) cmin = splayCost[k];
  }
  // the soft minimum (a smooth function of where the foot and the drums are)
  let W = 0;
  let bestA = 0;
  for (let k = 0; k < KNEE_SPLAY.length; k++) {
    const w = Math.exp(-(splayCost[k] - cmin) / 0.01);
    W += w;
    bestA += w * KNEE_SPLAY[k];
  }
  bestA /= W;
  out.splay = bestA;
  for (let i = 0; i < 3; i++) lgKH[i] = lgKH[i] * Math.cos(bestA) + lgOut[i] * Math.sin(bestA);
  addScaled3(lgK, H, lgWH, a);
  addScaled3(lgK, lgK, lgKH, h);
  scale3(lgTH, sub3(lgTH, lgK, H), 1 / LT);
  scale3(lgSH, sub3(lgSH, lgAJ, lgK), 1 / LS);
  // the thigh's frame: -Z along the thigh, -Y toward the shin, X the knee's hinge
  scale3(lgZ, lgTH, -1);
  perpNorm3(lgY, lgSH, lgTH, lgKH);
  scale3(lgY, lgY, -1);
  cross3(lgX, lgY, lgZ);
  fromCols3(lgRt, lgX, lgY, lgZ);
  const fk = Math.acos(clamp(dot3(lgSH, lgTH), -1, 1));
  mulTM3(out.thigh, inp.pelvis, lgRt);
  // the shin turns about its own axis to take most of the foot's turn relative to it (the ankle the rest)
  rotX3(out.shin, Math.PI / 2 - fk);
  mulM3(lgRs, lgRt, out.shin);
  mulTM3(out.foot, lgRs, lgRfoot);
  eulerYXZ(out.foot, lgAng);
  const twist = clamp(0.8 * lgAng[0], KNEE_ROT[0] + LIMIT_MARGIN, KNEE_ROT[1] - LIMIT_MARGIN);
  mulM3(out.shin, out.shin, rotY3(lgM, twist));
  mulM3(lgRs, lgRt, out.shin);
  mulTM3(out.foot, lgRs, lgRfoot);
  out.twist = twist;
  const A = out.ang;
  eulerYXZ(out.thigh, lgAng);
  A[0] = lgAng[1];
  A[1] = -lgAng[0];
  A[2] = lgAng[2];
  A[3] = fk;
  eulerYXZ(out.foot, lgAng);
  A[4] = -lgAng[1];
  A[5] = -lgAng[2];
  A[6] = -lgAng[0];
  A[7] = gamma;
}

// ---------------------------------------------------------------- torso and shoulder girdle
const toM = mat3();
/** the torso's locals from its total turn, lean and side bend, then forward kinematics down to the chest */
function setTorso(pose: DrummerPose, yaw: number, pitch: number, roll: number) {
  for (let k = 0; k < 4; k++) {
    composeYXZ(toM, YAW_SHARE[k] * yaw, PITCH_SHARE[k] * pitch, ROLL_SHARE[k] * roll);
    pose.local.set(toM, TORSO[k] * 9);
  }
  forwardKinematics(pose.local, pose.root, pose.world, pose.pos, 0, J.chest + 1);
}

const clS0 = vec3();
const clT = vec3();
const clW = vec3();
const clM = mat3();
const clN = mat3();
/** a clavicle: the shoulder rises with the hand and comes forward with its reach; then the shoulder joint's place */
function setClavicle(pose: DrummerPose, side: Side, wrist: Vec3) {
  const c = J.arm[side].clavicle;
  const u = J.arm[side].upper;
  const sg = side === 'R' ? 1 : -1;
  // the shoulder joint's rest place
  set3(clT, OFFSET[c * 3] + OFFSET[u * 3], OFFSET[c * 3 + 1] + OFFSET[u * 3 + 1], OFFSET[c * 3 + 2] + OFFSET[u * 3 + 2]);
  apply3(clS0, pose.world, clT, J.chest * 9);
  clS0[0] += pose.pos[J.chest * 3];
  clS0[1] += pose.pos[J.chest * 3 + 1];
  clS0[2] += pose.pos[J.chest * 3 + 2];
  // the wrist from there, in the chest frame (canonical: x outward)
  applyT3(clW, pose.world, sub3(clW, wrist, clS0), J.chest * 9);
  clW[0] *= sg;
  const elev = clamp(0.38 * (clW[1] + 0.24), -0.06, 0.32);
  const prot = clamp(ROUND_SHOULDERS + 0.55 * (-clW[2] - 0.3) + 0.45 * Math.max(0, -clW[0] - 0.08), -0.08, 0.42);
  rotY3(clM, prot);
  mulM3(clM, clM, rotZ3(clN, elev));
  if (sg < 0) mirrorM3(clM, clM);
  pose.local.set(clM, c * 9);
  pose.angles[DOF_BASE[c]] = elev;
  pose.angles[DOF_BASE[c] + 1] = prot;
  forwardKinematics(pose.local, pose.root, pose.world, pose.pos, c, u + 1);
}

/** the canonical arm input for a side, from the pose's torso as it stands */
function armInput(pose: DrummerPose, side: Side, t: StickTarget, inp: ArmIn) {
  const a = J.arm[side];
  copyM3(inp.chest, pose.world, J.chest * 9);
  copyM3(inp.clav, pose.world, a.clavicle * 9);
  copy3(inp.shoulder, pose.pos, a.upper * 3);
  copy3(inp.point, t.point);
  copy3(inp.normal, t.normal);
  if (side === 'L') {
    mirrorM3(inp.chest, inp.chest);
    mirrorM3(inp.clav, inp.clav);
    mirrorV(inp.shoulder, inp.shoulder);
    mirrorV(inp.point, inp.point);
    mirrorV(inp.normal, inp.normal);
  }
  norm3(inp.normal, inp.normal);
  inp.angle = t.angle;
  inp.contactFromTip = Math.max(0, t.contactFromTip);
  inp.lift = Math.max(0, t.lift);
  inp.palmRoll = t.palmRoll;
  inp.sweep = (t.sweep ?? 0) * (side === 'L' ? -1 : 1);
  inp.kit = side === 'L' ? KIT_M : KIT;
  inp.kitBounds = side === 'L' ? KIT_MB : KIT_B;
  // the back of the lower thorax (the shell the elbows hang beside): its pivot, out along its back by the shell's half-depth
  const sb = J.spine2 * 9;
  set3(inp.backN, pose.world[sb + 2], pose.world[sb + 5], pose.world[sb + 8]);
  addScaled3(inp.backP, set3(inp.backP, pose.pos[J.spine2 * 3], pose.pos[J.spine2 * 3 + 1], pose.pos[J.spine2 * 3 + 2]), inp.backN, BACK_DEPTH);
  if (side === 'L') {
    mirrorV(inp.backN, inp.backN);
    mirrorV(inp.backP, inp.backP);
  }
  inp.struck.fill(0);
  for (let j = 0; j < inp.kit.length && j < inp.struck.length; j++) {
    const x = inp.kit[j];
    if (x.kind !== 'rod' && Math.abs(proxyDistance(inp.point, x)) < 0.012) inp.struck[j] = 1;
  }
  inp.nOther = 0;
}

// reach scratch
const reU = vec3();
const reF = vec3();
const reTip = vec3();
const reUp = vec3();
const reRp = mat3();
const reW = vec3();
const wristNeed = { R: vec3(), L: vec3() };
/** how far a wrist is past a comfortable reach (metres; negative within). Leaves where it must be in wristNeed. */
function reachExcess(pose: DrummerPose, t: DrummerTargets, side: Side): number {
  armInput(pose, side, t[side], armIn);
  stickAtContact(armIn, armIn.sweep, reU, reF, reTip);
  norm3(reUp, set3(reUp, armIn.normal[0], armIn.normal[1] + 1, armIn.normal[2]));
  palmFromStick(reRp, reU, reUp, armIn.palmRoll, 0);
  apply3(reW, reRp, G_F);
  sub3(reW, reF, reW);
  const ex = dist3(reW, armIn.shoulder) - COMFORT * (LU + LF);
  const store = wristNeed[side];
  if (side === 'L') mirrorV(store, reW);
  else copy3(store, reW);
  return ex;
}

// ---------------------------------------------------------------- the whole drummer
const torsoAng = new Float64Array(3);
const torsoJac = new Float64Array(6);
const tsA = mat3();
const tsG = vec3();
const tsX = vec3();
const fM = mat3();
const fV = vec3();
const fN = vec3();
const fD = vec3();

/** a capsule of the other arm, mirrored into this side's frame */
function putOther(O: Float64Array, k: number, a: Vec3, b: Vec3, r: number) {
  O[k * 7] = -a[0];
  O[k * 7 + 1] = a[1];
  O[k * 7 + 2] = a[2];
  O[k * 7 + 3] = -b[0];
  O[k * 7 + 4] = b[1];
  O[k * 7 + 5] = b[2];
  O[k * 7 + 6] = r;
}

function putLocal(pose: DrummerPose, j: number, R: Mat3, mirror: boolean) {
  if (mirror) mirrorM3(fM, R);
  else fM.set(R);
  pose.local.set(fM, j * 9);
}

/**
 * Solve the drummer for the targets, into `pose`. Deterministic, and it
 * allocates nothing. The model's origin goes on KitLayout's seat.
 */
export function solveDrummer(t: DrummerTargets, pose: DrummerPose): DrummerPose {
  set3(pose.root, SEAT.centre[0], SEAT.centre[1], SEAT.centre[2]);
  identity3(fM);
  for (let j = 0; j < NJ; j++) pose.local.set(fM, j * 9);
  pose.angles.fill(0);
  forwardKinematics(pose.local, pose.root, pose.world, pose.pos);
  // --- torso: turn toward the playing, lean in, bend toward low far targets
  const wl = 0.38 + 0.24 * (t.leadL ?? (t.lead === 'L' ? 1 : 0));
  const cx = wl * t.L.point[0] + (1 - wl) * t.R.point[0];
  const cy = wl * t.L.point[1] + (1 - wl) * t.R.point[1];
  const cz = wl * t.L.point[2] + (1 - wl) * t.R.point[2];
  const pi = J.pelvis * 3;
  const dx = cx - pose.pos[pi];
  const dz = cz - pose.pos[pi + 2];
  const horiz = Math.hypot(dx, dz);
  torsoAng[0] = 0.42 * Math.atan2(-dx, -dz);
  torsoAng[1] = BASE_LEAN - 0.35 * Math.max(0, horiz - 0.42) - 0.3 * Math.max(0, 0.72 - cy);
  torsoAng[2] = -0.4 * dx * clamp((1.0 - cy) / 0.4, 0, 1);
  // --- reach: while a wrist would be past a comfortable reach, turn and lean toward it (damped Gauss-Newton)
  for (let iter = 0; iter < 6; iter++) {
    setTorso(pose, torsoAng[0], torsoAng[1], torsoAng[2]);
    for (let si = 0; si < 2; si++) {
      const s = SIDES[si];reachExcess(pose, t, s);
      setClavicle(pose, s, wristNeed[s]);
    }
    const exR = reachExcess(pose, t, 'R');
    const exL = reachExcess(pose, t, 'L');
    const h = 0.01;
    for (let k = 0; k < 3; k++) {
      torsoAng[k] += h;
      setTorso(pose, torsoAng[0], torsoAng[1], torsoAng[2]);
      for (let si = 0; si < 2; si++) setClavicle(pose, SIDES[si], wristNeed[SIDES[si]]);
      torsoJac[k] = (reachExcess(pose, t, 'R') - exR) / h;
      torsoJac[3 + k] = (reachExcess(pose, t, 'L') - exL) / h;
      torsoAng[k] -= h;
    }
    // only the arms that are over (weights easing in over the first centimetre, so nothing switches)
    const wR = clamp(exR / 0.01, 0, 1);
    const wL = clamp(exL / 0.01, 0, 1);
    const rR = Math.max(0, exR);
    const rL = Math.max(0, exL);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) tsA[r * 3 + c] = wR * torsoJac[r] * torsoJac[c] + wL * torsoJac[3 + r] * torsoJac[3 + c] + (r === c ? 0.02 : 0);
      tsG[r] = wR * torsoJac[r] * rR + wL * torsoJac[3 + r] * rL;
    }
    solve3(tsA, tsG, tsX);
    torsoAng[0] = clamp(torsoAng[0] - tsX[0], -0.75, 0.75);
    torsoAng[1] = clamp(torsoAng[1] - tsX[1], -0.62, 0.15);
    torsoAng[2] = clamp(torsoAng[2] - tsX[2], -0.35, 0.35);
  }
  setTorso(pose, torsoAng[0], torsoAng[1], torsoAng[2]);
  copy3(pose.torso, torsoAng);
  for (let k = 0; k < 4; k++) eulerYXZ(pose.local, pose.angles, DOF_BASE[TORSO[k]], TORSO[k] * 9);
  // --- arms
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];reachExcess(pose, t, s);
    setClavicle(pose, s, wristNeed[s]);
  }
  // the right arm first; the left keeps clear of it (a fixed order, so blends between poses never switch it)
  let first = true;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];armInput(pose, s, t[s], armIn);
    if (!first) {
      // the first arm's stick, forearm and hand, in this side's (mirrored) frame
      putOther(armIn.other, 0, firstArm.butt, firstArm.tip, STICK_R);
      putOther(armIn.other, 1, firstArm.elbow, firstArm.wrist, CAPS.forearm);
      putOther(armIn.other, 2, firstArm.wrist, firstArm.knuckle, CAPS.hand * 0.8);
      armIn.nOther = 3;
    }
    solveArm(armIn, armBest);
    if (first) {
      // remember it in the canonical world of its own side (the next side's frame is its mirror)
      stickDirInPalm(fV, armBest.rock);
      apply3(fV, armBest.palmW, fV);
      addScaled3(firstArm.butt, armBest.fulcrum, fV, -STICK_BACK);
      addScaled3(firstArm.tip, armBest.fulcrum, fV, STICK_FRONT);
      copy3(firstArm.elbow, armBest.elbow);
      copy3(firstArm.wrist, armBest.wrist);
      apply3(firstArm.knuckle, armBest.palmW, set3(fN, 0, -0.012, -0.085));
      addScaled3(firstArm.knuckle, firstArm.knuckle, armBest.wrist, 1);
      first = false;
    }
    const a = J.arm[s];
    const mir = s === 'L';
    putLocal(pose, a.upper, armBest.upper, mir);
    putLocal(pose, a.forearm, armBest.forearm, mir);
    putLocal(pose, a.twist, armBest.twist, mir);
    identity3(fM);
    pose.local.set(fM, a.hand * 9);
    putLocal(pose, a.palm, armBest.palm, mir);
    putLocal(pose, a.stick, armBest.stick, mir);
    const A = pose.angles;
    A[DOF_BASE[a.upper]] = armBest.ang[0];
    A[DOF_BASE[a.upper] + 1] = armBest.ang[1];
    A[DOF_BASE[a.upper] + 2] = armBest.ang[2];
    A[DOF_BASE[a.forearm]] = armBest.ang[3];
    A[DOF_BASE[a.twist]] = armBest.ang[4];
    A[DOF_BASE[a.palm]] = armBest.ang[5];
    A[DOF_BASE[a.palm] + 1] = armBest.ang[6];
    A[DOF_BASE[a.stick]] = armBest.ang[7];
    writeFingers(pose.fingers[s], armBest.rock, mir);
  }
  // --- head: a little toward where the sticks are going
  forwardKinematics(pose.local, pose.root, pose.world, pose.pos);
  // look at the leading stick's contact (a blend of the two, by how much each leads)
  const ll = t.leadL ?? (t.lead === 'L' ? 1 : 0);
  const lx = t.look ? t.look[0] : ll * t.L.point[0] + (1 - ll) * t.R.point[0];
  const ly = t.look ? t.look[1] : ll * t.L.point[1] + (1 - ll) * t.R.point[1];
  const lz = t.look ? t.look[2] : ll * t.L.point[2] + (1 - ll) * t.R.point[2];
  const nb = J.neck * 3;
  set3(fD, lx - pose.pos[nb], ly - pose.pos[nb + 1], lz - pose.pos[nb + 2]);
  applyT3(fD, pose.world, fD, J.chest * 9);
  const lookYaw = clamp(Math.atan2(-fD[0], -fD[2]), -1.2, 1.2) * 0.6;
  const lookPitch = clamp(Math.atan2(fD[1], Math.hypot(fD[0], fD[2])) + 0.12, -1.0, 0.4) * 0.62;
  // the neck carries the head a little forward of the shoulders (as the lean rounds the upper back), the head looking down
  composeYXZ(fM, 0.5 * lookYaw, clamp(0.55 * lookPitch + NECK_FORWARD, NECK_PITCH[0] + LIMIT_MARGIN, NECK_PITCH[1] - LIMIT_MARGIN), 0);
  pose.local.set(fM, J.neck * 9);
  composeYXZ(fM, 0.5 * lookYaw, 0.45 * lookPitch, -0.03 * lookYaw);
  pose.local.set(fM, J.head * 9);
  eulerYXZ(pose.local, pose.angles, DOF_BASE[J.neck], J.neck * 9);
  eulerYXZ(pose.local, pose.angles, DOF_BASE[J.head], J.head * 9);
  // --- legs
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];const ft = t.feet[s];
    const pd = PEDALS[ft.pedal];
    const lg = J.leg[s];
    copyM3(legIn.pelvis, pose.world, J.pelvis * 9);
    copy3(legIn.hip, pose.pos, lg.thigh * 3);
    copy3(legIn.heel, pd.heel);
    copy3(legIn.ball, pd.ball);
    if (s === 'L') {
      mirrorM3(legIn.pelvis, legIn.pelvis);
      mirrorV(legIn.hip, legIn.hip);
      mirrorV(legIn.heel, legIn.heel);
      mirrorV(legIn.ball, legIn.ball);
    }
    legIn.kit = s === 'L' ? KIT_M : KIT;
    legIn.heelLift = ft.heelLift ?? (ft.heel === 'up' ? 1 : 0);
    legIn.press = ft.press;
    solveLeg(legIn, legOut);
    const mir = s === 'L';
    putLocal(pose, lg.thigh, legOut.thigh, mir);
    putLocal(pose, lg.shin, legOut.shin, mir);
    putLocal(pose, lg.foot, legOut.foot, mir);
    putLocal(pose, lg.toes, legOut.toes, mir);
    const A = pose.angles;
    A[DOF_BASE[lg.thigh]] = legOut.ang[0];
    A[DOF_BASE[lg.thigh] + 1] = legOut.ang[1];
    A[DOF_BASE[lg.thigh] + 2] = legOut.ang[2];
    A[DOF_BASE[lg.shin]] = legOut.ang[3];
    A[DOF_BASE[lg.shin] + 1] = legOut.twist;
    A[DOF_BASE[lg.foot]] = legOut.ang[4];
    A[DOF_BASE[lg.foot] + 1] = legOut.ang[5];
    A[DOF_BASE[lg.foot] + 2] = legOut.ang[6];
    A[DOF_BASE[lg.toes]] = legOut.ang[7];
    pose.pedal[ft.pedal] = legOut.board;
    pose.footError[s] = legOut.short;
  }
  // --- everything in the world; the sticks and how close they came
  forwardKinematics(pose.local, pose.root, pose.world, pose.pos);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];const st = pose.stick[s];
    const j = J.arm[s].stick;
    set3(fV, s === 'R' ? G_D[0] : -G_D[0], G_D[1], G_D[2]);
    apply3(st.dir, pose.world, fV, j * 9);
    copy3(st.fulcrum, pose.pos, j * 3);
    addScaled3(st.tip, st.fulcrum, st.dir, STICK_FRONT);
    addScaled3(st.butt, st.fulcrum, st.dir, -STICK_BACK);
    const tg = t[s];
    const c = Math.max(0, tg.contactFromTip);
    norm3(fN, set3(fN, tg.normal[0], tg.normal[1], tg.normal[2]));
    // the point of the stick's surface meant to touch: on its axis c back from the end, one radius below
    addScaled3(st.contact, st.tip, st.dir, -c);
    addScaled3(st.contact, st.contact, fN, -stickRadiusAt(c));
    pose.stickAngle[s] = Math.asin(clamp(-dot3(st.dir, fN), -1, 1));
    if (tg.lift > 1e-5) {
      // lifted: the end's height above where it is at impact
      const h0 = stickRadiusAt(c) - c * Math.sin(tg.angle);
      sub3(fV, st.tip, tg.point);
      pose.error[s] = Math.abs(dot3(fV, fN) - h0 - tg.lift);
    } else pose.error[s] = dist3(st.contact, tg.point);
  }
  return pose;
}

/** solve A x = b for a 3x3 A (Cramer's rule), into o */
function solve3(A: Mat3, b: Vec3, o: Vec3) {
  const a = A;
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-14) return set3(o, 0, 0, 0);
  const x = (b[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (b[1] * a[8] - a[5] * b[2]) + a[2] * (b[1] * a[7] - a[4] * b[2])) / det;
  const y = (a[0] * (b[1] * a[8] - a[5] * b[2]) - b[0] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * b[2] - b[1] * a[6])) / det;
  const z = (a[0] * (a[4] * b[2] - b[1] * a[7]) - a[1] * (a[3] * b[2] - b[1] * a[6]) + b[0] * (a[3] * a[7] - a[4] * a[6])) / det;
  return set3(o, x, y, z);
}

/** the joint angles outside their limits (for tests and the lab) */
export function limitViolations(pose: DrummerPose, tol = 1e-6): { name: string; value: number; limits: [number, number] }[] {
  const out: { name: string; value: number; limits: [number, number] }[] = [];
  let k = 0;
  for (const j of JOINTS)
    for (const d of j.dofs) {
      const x = pose.angles[k++];
      if (x < d.limits[0] - tol || x > d.limits[1] + tol) out.push({ name: `${j.name}.${d.name}`, value: x, limits: d.limits });
    }
  return out;
}

