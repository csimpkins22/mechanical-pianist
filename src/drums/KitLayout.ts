// Where everything in the drum kit is, in metres: the contract between the
// kit (its models, sounds and reactions), the robot drummer (its reach and
// IK) and, later, the planner that decides which limb plays which hit.
//
// A conventional right-handed five-piece, set up the way a working drummer
// would set it for a seated player of human proportions:
//
//   frame   origin on the floor under the centre of the stool's seat;
//           +x to the drummer's right, +y up, -z forward (the drummer
//           faces -z, as a three.js camera does)
//   sizes   nominal drum and cymbal sizes in inches, as sold, and their
//           real diameters in metres
//   tilt    a playing surface's normal starts as +y and is turned toward
//           the drummer (about the drummer's x axis) by `tilt`, then about
//           y by `yaw` so it faces the stool; both in radians
//
// Everything that touches this file reads it rather than copying numbers, so
// moving a drum here moves its model, its stand, its sound position and the
// robot's targets together. Change positions only with the reach checks run.

export type V3 = [number, number, number];

export type DrumId = 'kick' | 'snare' | 'hihat' | 'tom1' | 'tom2' | 'floorTom' | 'crash' | 'ride';
export type PedalId = 'kickPedal' | 'hihatPedal';

export interface DrumSpec {
  id: DrumId;
  kind: 'drum' | 'cymbal';
  /** nominal size in inches (diameter; for drums, depth too) */
  inches: { diameter: number; depth?: number };
  /** diameter in metres */
  diameter: number;
  /** depth of a drum's shell in metres (cymbals: 0) */
  depth: number;
  /** centre of the playing surface (batter head, or the top of the cymbal's bow at the bell), metres */
  centre: V3;
  /** tilt of the playing surface toward the drummer, and its turn toward the stool (radians) */
  tilt: number;
  yaw: number;
  /** which hand normally plays it, for a right-handed drummer (feet for the kick) */
  usual: 'R' | 'L' | 'either' | 'RF' | 'LF';
}

const IN = 0.0254;

/** the stool: the top of its seat */
export const SEAT: { centre: V3; diameter: number } = { centre: [0, 0.52, 0], diameter: 0.36 };

// the stool is at the origin, so a drum's yaw is the angle that turns its tilt toward it
const yawTo = (x: number, z: number) => Math.atan2(-x, -z);

function drum(id: DrumId, kind: DrumSpec['kind'], diameterIn: number, depthIn: number, centre: V3, tiltDeg: number, usual: DrumSpec['usual']): DrumSpec {
  return {
    id,
    kind,
    inches: kind === 'drum' ? { diameter: diameterIn, depth: depthIn } : { diameter: diameterIn },
    diameter: diameterIn * IN,
    depth: depthIn * IN,
    centre,
    tilt: (tiltDeg * Math.PI) / 180,
    yaw: yawTo(centre[0], centre[2]),
    usual,
  };
}

// Moved from the first layout with what the robot drummer's stage found for a
// seated adult: there the snare's strike spot was 0.30 m from the stool and the
// kick pedal's heel under the seat, which drew the elbows behind the body, sat
// the snare on the left thigh and put the right knee into the kick. The hand
// instruments are now 12 to 18 cm further away (the snare also 4 cm higher,
// over the thighs), the kick 22 cm and the pedals 22 to 25 cm further forward.
// Where the kit's own parts would have collided, the nearest clear position
// was taken instead:
//   - the hi-hat's column stands 8 cm further than that stage asked (and 3 cm
//     to its right): a hi-hat's footboard runs from its heel plate to the foot
//     of the column, so the ball of the left foot has to be behind the column
//     (here 6 cm, within 2 cm of the footboard's centre line), not in front;
//   - the snare is 3 cm higher and 1 cm nearer than asked: lower, its bottom
//     hoop sat in the kick's batter hoop;
//   - the first rack tom is 5 cm further, 1 cm higher and 1 cm to the left,
//     the second 2 cm higher and 2 cm to the right: otherwise the first tom's
//     bottom hoop sank into the snare's far side and the two toms' hoops
//     overlapped (as they already did in the first layout).
// (tests/drums.test.ts checks every drum and cymbal, and every tripod's legs, for collisions.)
export const DRUMS: Record<DrumId, DrumSpec> = {
  // the kick lies on its side: its batter head faces the drummer (+z), centred at the beater's height
  kick: { ...drum('kick', 'drum', 22, 18, [0.1, 0.29, -0.62], 90, 'RF'), yaw: 0 },
  snare: drum('snare', 'drum', 14, 5.5, [-0.11, 0.73, -0.47], 8, 'L'),
  hihat: drum('hihat', 'cymbal', 14, 0, [-0.47, 0.95, -0.51], 4, 'R'),
  tom1: drum('tom1', 'drum', 10, 8, [-0.13, 0.86, -0.78], 14, 'either'),
  tom2: drum('tom2', 'drum', 12, 9, [0.18, 0.89, -0.75], 14, 'either'),
  floorTom: drum('floorTom', 'drum', 16, 16, [0.54, 0.64, -0.43], 3, 'R'),
  crash: drum('crash', 'cymbal', 18, 0, [-0.52, 1.2, -0.74], 16, 'either'),
  ride: drum('ride', 'cymbal', 21, 0, [0.7, 1.04, -0.66], 11, 'R'),
};

/**
 * pedals: where the heel sits (the heel plate) and where the ball of the foot rests on the footboard at rest
 * (`ball` is the footboard's top surface there: see footboardAt, which the kit's model and the drummer's foot
 * both use, so the board is under the foot at every press)
 */
export const PEDALS: Record<PedalId, { ball: V3; heel: V3; drives: DrumId }> = {
  kickPedal: { ball: [0, 0, 0], heel: [0.12, 0.02, -0.31], drives: 'kick' },
  // the hi-hat's footboard runs from its heel plate to the foot of the column (moved 4 cm left with the hi-hat,
  // so the left hand passes it on its way to tom 1): the heel 2 cm further left than before, the foot turned
  // a little more out toward the column
  hihatPedal: { ball: [0, 0, 0], heel: [-0.37, 0.02, -0.23], drives: 'hihat' },
};

/** how far a pedal's footboard turns about its heel hinge from rest to fully down (the beater on the head, the hi-hat closed), radians */
export const PEDAL_TRAVEL = 0.11;

/**
 * A pedal's footboard: hinged at its heel, turned toward what it drives
 * (the kick's beater axle, the hi-hat's column), its toe raised at rest by
 * the spring and pressed down by PEDAL_TRAVEL. The kit's model builds the
 * board from this and the drummer's foot stands on it, so both read one
 * function (footboardAt) of one press: for the kick the beater's travel
 * (KitMotion.beater, which springs a little past rest: -0.2..1), for the
 * hi-hat how closed it is (0..1).
 */
export interface PedalBoard {
  /** the hinge's axis, at the board's centre line (the board's top is FOOTBOARD_TOP above it) */
  hinge: V3;
  /** the board's heading on the floor, from the heel toward the toe (radians about y; 0 = toward +z, as three.js turns it) */
  yaw: number;
  /** from the hinge to the toe */
  length: number;
  /** how far the toe is raised at rest (radians) */
  rest: number;
  /** where the ball of the foot sits, from the hinge along the board */
  ballAlong: number;
}
/** the board's top surface above its hinge's axis */
export const FOOTBOARD_TOP = 0.01;
/** the lowest a press goes: the kick's footboard rides its beater past rest by at most this much */
export const PRESS_MIN = -0.2;

function boards(): Record<PedalId, PedalBoard> {
  const k = PEDALS.kickPedal;
  const h = PEDALS.hihatPedal;
  // the kick: the board reaches under the beater's axle (5 cm in front of the batter head), its toe 7.2 cm up at rest
  const kHinge: V3 = [k.heel[0], 0.02, k.heel[2] + 0.03];
  const kLen = kHinge[2] - (DRUMS.kick.centre[2] + 0.05 - 0.022);
  // the hi-hat: toward the column's foot, ending 3 cm short of it; closed, its toe is 2 cm up
  const col = hihatMount().column;
  const hHinge: V3 = [h.heel[0], 0.02, h.heel[2] + 0.03];
  const dx = col[0] - hHinge[0];
  const dz = col[1] - hHinge[2];
  const hLen = Math.hypot(dx, dz) - 0.03;
  return {
    kickPedal: { hinge: kHinge, yaw: Math.PI, length: kLen, rest: Math.atan2(0.072, kLen), ballAlong: 0.25 },
    hihatPedal: { hinge: hHinge, yaw: Math.atan2(dx, dz), length: hLen, rest: Math.atan2(0.02, hLen) + PEDAL_TRAVEL, ballAlong: 0.215 },
  };
}

/** the board's toe-up angle at a press (radians above the floor's level) */
export function footboardAngle(id: PedalId, press: number): number {
  const p = press < PRESS_MIN ? PRESS_MIN : press > 1 ? 1 : press;
  return PEDAL_BOARDS[id].rest - PEDAL_TRAVEL * p;
}

/**
 * The footboard at a press: the point on its top surface `along` metres from
 * the hinge, the unit vector along it toward the toe and its upward normal
 * (written into `out`, nothing allocated).
 */
export function footboardAt(
  id: PedalId,
  press: number,
  along: number,
  out: { point: number[] | Float64Array; along: number[] | Float64Array; normal: number[] | Float64Array },
) {
  const b = PEDAL_BOARDS[id];
  const a = footboardAngle(id, press);
  const sy = Math.sin(b.yaw);
  const cy = Math.cos(b.yaw);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // along: the heading (sin yaw, 0, cos yaw) raised by a; the normal: up, tipped back by a
  out.along[0] = sy * ca;
  out.along[1] = sa;
  out.along[2] = cy * ca;
  out.normal[0] = -sy * sa;
  out.normal[1] = ca;
  out.normal[2] = -cy * sa;
  for (let k = 0; k < 3; k++) out.point[k] = b.hinge[k] + out.along[k] * along + out.normal[k] * FOOTBOARD_TOP;
  return out;
}

/**
 * The hi-hat's column and its head: the cymbals sit on the head tilted as
 * KitLayout asks, the top cymbal's centre exactly on DRUMS.hihat.centre, so
 * the column's top stands that far back along the cymbals' axis (a few mm
 * from under the centre, as the tilt sets it).
 */
export function hihatMount(): { head: V3; column: [number, number]; topY: number; bottomY: number } {
  const d = DRUMS.hihat;
  const p = CYMBAL_PROFILES.hihat;
  const n = surfaceNormal(d);
  // heights along the axis, from the head: the bottom cymbal's bell on the seat's felt, the top cymbal edge to edge on it
  const below = 2 * p.drop + 2 * p.thickness[2] + 0.0005;
  const topY = below + p.bellHeight + 0.017;
  const head: V3 = [d.centre[0] - n[0] * topY, d.centre[1] - n[1] * topY, d.centre[2] - n[2] * topY];
  return { head, column: [head[0], head[2]], topY, bottomY: topY - below };
}

/**
 * A cymbal's cross-section, shared by its model and its strike spots. Heights
 * are from its reference plane, the top of the bow where it meets the bell
 * (DrumSpec.centre): the bell rises above it, the bow falls away toward the edge.
 */
export interface CymbalProfile {
  bellRadius: number;
  bellHeight: number;
  /** how far the bow's top falls from the bell to the edge */
  drop: number;
  /** thickness at the bell, the bow and the edge */
  thickness: [number, number, number];
}
export const CYMBAL_PROFILES: Record<'crash' | 'ride' | 'hihat', CymbalProfile> = {
  crash: { bellRadius: 0.078, bellHeight: 0.026, drop: 0.026, thickness: [0.0024, 0.0011, 0.0006] },
  ride: { bellRadius: 0.092, bellHeight: 0.032, drop: 0.03, thickness: [0.003, 0.0016, 0.001] },
  hihat: { bellRadius: 0.062, bellHeight: 0.02, drop: 0.012, thickness: [0.0024, 0.0013, 0.0009] },
};
/** the radius of a cymbal's centre hole */
export const CYMBAL_HOLE = 0.0068;

/** the height of a cymbal's top surface above its reference plane, r metres from its centre */
export function cymbalTop(p: CymbalProfile, R: number, r: number): number {
  if (r >= p.bellRadius) {
    // the bow: a gentle convex slope, flattening a little toward the edge
    const u = Math.min(1, (r - p.bellRadius) / (R - p.bellRadius));
    return -p.drop * u * (1.35 - 0.35 * u);
  }
  // the bell: rising steeply from the bow, rounding over its top
  const a = Math.min(1, (p.bellRadius - r) / (p.bellRadius - CYMBAL_HOLE - 0.004));
  return p.bellHeight * Math.sin((a * Math.PI) / 2) ** 0.8;
}

/** the drummer's sticks: hickory, 5A-ish */
export const STICK = { length: 0.406, diameter: 0.0145, tipDiameter: 0.011 };

/** the hi-hat's travel: how far the top cymbal lifts off the bottom when the pedal is up */
export const HIHAT_OPEN_GAP = 0.025;

/** the playing surface's normal, for a drum or cymbal */
export function surfaceNormal(d: DrumSpec): V3 {
  // +y tilted toward the drummer (+z) by `tilt`, then turned about y by `yaw`
  const ny = Math.cos(d.tilt);
  const nz = Math.sin(d.tilt);
  return [Math.sin(d.yaw) * nz, ny, Math.cos(d.yaw) * nz];
}

/**
 * Where a stick strikes: a point on the playing surface, `r` of the way from
 * the centre to the edge (0 = centre, 1 = edge), turned `angle` radians from
 * the side nearest the drummer. On a drum it lies in the batter head; on a
 * cymbal, on its metal (above the reference plane on the bell, below it out
 * on the bow), as the model is turned.
 */
export function strikePoint(d: DrumSpec, r: number, angle = 0): V3 {
  const n = surfaceNormal(d);
  const lift = d.kind === 'cymbal' ? cymbalTop(CYMBAL_PROFILES[d.id as keyof typeof CYMBAL_PROFILES], d.diameter / 2, (r * d.diameter) / 2) : 0;
  // a unit vector in the surface toward the drummer, then one across it
  const toward: V3 = [Math.sin(d.yaw) * Math.cos(d.tilt), -Math.sin(d.tilt), Math.cos(d.yaw) * Math.cos(d.tilt)];
  const across: V3 = [n[1] * toward[2] - n[2] * toward[1], n[2] * toward[0] - n[0] * toward[2], n[0] * toward[1] - n[1] * toward[0]];
  const rad = (r * d.diameter) / 2;
  const c = Math.cos(angle) * rad;
  const s = Math.sin(angle) * rad;
  return [
    d.centre[0] + toward[0] * c + across[0] * s + n[0] * lift,
    d.centre[1] + toward[1] * c + across[1] * s + n[1] * lift,
    d.centre[2] + toward[2] * c + across[2] * s + n[2] * lift,
  ];
}

/** the usual strike spots, as the IK and the planner will ask for them */
export const SPOTS = {
  /** a drum's head a little toward the player from centre; a cymbal's bow */
  head: (d: DrumSpec) => strikePoint(d, d.kind === 'cymbal' ? 0.55 : 0.18),
  /** a drum's rim (rimshots), or a cymbal's edge (crashes) */
  edge: (d: DrumSpec) => strikePoint(d, 0.97),
  /** the ride's bell */
  bell: (d: DrumSpec) => strikePoint(d, 0.12),
};

/** the pedals' footboards (read once: they follow DRUMS and PEDALS) */
export const PEDAL_BOARDS: Record<PedalId, PedalBoard> = boards();
// the ball of the foot on each board at rest
for (const id of ['kickPedal', 'hihatPedal'] as PedalId[]) {
  const o = { point: [0, 0, 0], along: [0, 0, 0], normal: [0, 0, 0] };
  footboardAt(id, 0, PEDAL_BOARDS[id].ballAlong, o);
  PEDALS[id].ball = o.point as V3;
}
