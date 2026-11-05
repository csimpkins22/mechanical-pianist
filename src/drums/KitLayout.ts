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
  hihat: drum('hihat', 'cymbal', 14, 0, [-0.43, 0.95, -0.51], 4, 'R'),
  tom1: drum('tom1', 'drum', 10, 8, [-0.13, 0.86, -0.78], 14, 'either'),
  tom2: drum('tom2', 'drum', 12, 9, [0.18, 0.89, -0.75], 14, 'either'),
  floorTom: drum('floorTom', 'drum', 16, 16, [0.54, 0.64, -0.43], 3, 'R'),
  crash: drum('crash', 'cymbal', 18, 0, [-0.52, 1.2, -0.74], 16, 'either'),
  ride: drum('ride', 'cymbal', 21, 0, [0.7, 1.04, -0.66], 11, 'R'),
};

/** pedals: where the foot rests (the middle of the footboard) and where its heel sits */
export const PEDALS: Record<PedalId, { ball: V3; heel: V3; drives: DrumId }> = {
  kickPedal: { ball: [0.12, 0.05, -0.54], heel: [0.12, 0.02, -0.31], drives: 'kick' },
  hihatPedal: { ball: [-0.39, 0.05, -0.45], heel: [-0.35, 0.02, -0.23], drives: 'hihat' },
};

/** how far a pedal's footboard turns about its heel hinge from rest to fully down (the beater on the head, the hi-hat closed), radians */
export const PEDAL_TRAVEL = 0.11;

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
