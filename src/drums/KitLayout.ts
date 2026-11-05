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

export const DRUMS: Record<DrumId, DrumSpec> = {
  // the kick lies on its side: its batter head faces the drummer (+z), centred at the beater's height
  kick: { ...drum('kick', 'drum', 22, 18, [0.1, 0.29, -0.4], 90, 'RF'), yaw: 0 },
  snare: drum('snare', 'drum', 14, 5.5, [-0.13, 0.66, -0.3], 8, 'L'),
  hihat: drum('hihat', 'cymbal', 14, 0, [-0.43, 0.9, -0.28], 4, 'R'),
  tom1: drum('tom1', 'drum', 10, 8, [-0.1, 0.82, -0.56], 14, 'either'),
  tom2: drum('tom2', 'drum', 12, 9, [0.18, 0.84, -0.58], 14, 'either'),
  floorTom: drum('floorTom', 'drum', 16, 16, [0.5, 0.6, -0.3], 3, 'R'),
  crash: drum('crash', 'cymbal', 18, 0, [-0.5, 1.2, -0.62], 16, 'either'),
  ride: drum('ride', 'cymbal', 21, 0, [0.66, 1.02, -0.5], 11, 'R'),
};

/** pedals: where the foot rests (the middle of the footboard) and where its heel sits */
export const PEDALS: Record<PedalId, { ball: V3; heel: V3; drives: DrumId }> = {
  kickPedal: { ball: [0.12, 0.05, -0.29], heel: [0.12, 0.02, -0.06], drives: 'kick' },
  hihatPedal: { ball: [-0.34, 0.05, -0.24], heel: [-0.31, 0.02, -0.02], drives: 'hihat' },
};

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
 * the side nearest the drummer.
 */
export function strikePoint(d: DrumSpec, r: number, angle = 0): V3 {
  const n = surfaceNormal(d);
  // a unit vector in the surface toward the drummer, then one across it
  const toward: V3 = [Math.sin(d.yaw) * Math.cos(d.tilt), -Math.sin(d.tilt), Math.cos(d.yaw) * Math.cos(d.tilt)];
  const across: V3 = [n[1] * toward[2] - n[2] * toward[1], n[2] * toward[0] - n[0] * toward[2], n[0] * toward[1] - n[1] * toward[0]];
  const rad = (r * d.diameter) / 2;
  const c = Math.cos(angle) * rad;
  const s = Math.sin(angle) * rad;
  return [d.centre[0] + toward[0] * c + across[0] * s, d.centre[1] + toward[1] * c + across[1] * s, d.centre[2] + toward[2] * c + across[2] * s];
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
