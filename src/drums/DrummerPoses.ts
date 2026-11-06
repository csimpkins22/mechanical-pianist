// Named poses for the drummer, built from KitLayout's strike spots: every
// drum's head, the hi-hat closed and open, the ride's bow and bell, the
// crash's edge, the kick heel up and heel down, the crossed-hands hi-hat
// groove, a fill across the toms to the floor tom, a ghost note against an
// accent's preparation. The tests and the lab both use them, so the poses the
// tests prove are the poses the lab shows.
//
// Stick angles to the surface at impact follow reference footage of real
// players (a side view of a snare, a kit from above): about 15 degrees on a
// snare, a little steeper on toms and the low floor tom, flat on a ride's bow
// (8 degrees), steeper on its bell, and the shoulder of the stick rising over
// a crash's edge.
import { DRUMS, HIHAT_OPEN_GAP, SPOTS, surfaceNormal, type DrumId, type V3 } from './KitLayout';
import { STICK_BEAD, STICK_SHOULDER, type DrummerTargets, type FootTarget, type StickTarget } from './DrummerIK';
import type { Side } from './DrummerSpec';

const D = Math.PI / 180;

/** the stick's angle to the surface at impact, per instrument (radians) */
export const STICK_ANGLE: Record<DrumId, number> = {
  kick: 0,
  snare: 15 * D,
  hihat: 14 * D,
  tom1: 17 * D,
  tom2: 17 * D,
  floorTom: 20 * D,
  // negative: the stick rises over the edge (the shoulder of the stick strikes it)
  crash: -10 * D,
  ride: 8 * D,
};
/** how far each hand is turned about the stick, per instrument: American grip on drums, more thumb-up on cymbals */
export const PALM_ROLL: Record<DrumId, number> = {
  kick: 0,
  snare: 0.3,
  hihat: 0.4,
  tom1: 0.3,
  tom2: 0.3,
  floorTom: 0.3,
  crash: 0.8,
  ride: 0.45,
};

export type Spot = 'head' | 'edge' | 'bell';

/** a stroke on an instrument's spot; `lift` raises the tip above it, `open` lifts the hi-hat's top cymbal */
export function stroke(id: DrumId, spot: Spot = 'head', lift = 0, opts: { open?: boolean; along?: number; across?: number; angle?: number } = {}): StickTarget {
  const d = DRUMS[id];
  const n = surfaceNormal(d);
  const p = (spot === 'head' ? SPOTS.head(d) : spot === 'edge' ? SPOTS.edge(d) : SPOTS.bell(d)).slice() as V3;
  if (opts.open) for (let k = 0; k < 3; k++) p[k] += n[k] * HIHAT_OPEN_GAP;
  // small offsets across the surface (for two sticks on one drum)
  if (opts.across) {
    const ax = [Math.cos(d.yaw), 0, -Math.sin(d.yaw)];
    for (let k = 0; k < 3; k++) p[k] += ax[k] * opts.across;
  }
  const crash = d.kind === 'cymbal' && spot === 'edge';
  const bell = spot === 'bell';
  return {
    point: p,
    normal: n,
    angle: opts.angle ?? (bell ? 22 * D : STICK_ANGLE[id]),
    contactFromTip: crash ? STICK_SHOULDER : STICK_BEAD,
    lift,
    palmRoll: PALM_ROLL[id],
  };
}

const kickDown = (press = 0.15): FootTarget => ({ pedal: 'kickPedal', heel: 'down', press });
const kickUp = (press = 0.15): FootTarget => ({ pedal: 'kickPedal', heel: 'up', press });
const hatClosed = (): FootTarget => ({ pedal: 'hihatPedal', heel: 'down', press: 1 });
const hatOpen = (): FootTarget => ({ pedal: 'hihatPedal', heel: 'down', press: 0 });

function pose(R: StickTarget, L: StickTarget, lead: Side, feet?: { R?: FootTarget; L?: FootTarget }): DrummerTargets {
  return { R, L, lead, feet: { R: feet?.R ?? kickUp(0), L: feet?.L ?? hatClosed() } };
}

export interface NamedPose {
  name: string;
  label: string;
  targets: DrummerTargets;
  /** which hand(s) are at a strike (lift 0), for the reach tests */
  strikes: Side[];
}

/** every pose the lab offers and the tests prove */
export function namedPoses(): NamedPose[] {
  const groove = (R: StickTarget) => R;
  const list: NamedPose[] = [
    // each drum's head
    { name: 'snare', label: 'Snare head', targets: pose(stroke('snare', 'head', 0, { across: 0.03 }), stroke('snare', 'head', 0.12, { across: -0.035 }), 'R'), strikes: ['R'] },
    { name: 'snareL', label: 'Snare head (left hand)', targets: pose(stroke('hihat', 'head', 0.06), stroke('snare'), 'L'), strikes: ['L'] },
    { name: 'tom1', label: 'Tom 1 head', targets: pose(stroke('tom1'), stroke('snare', 'head', 0.1), 'R'), strikes: ['R'] },
    // the right hand waits to the snare's right, out of the left arm's way to tom 1 (the hi-hat is on its other side)
    { name: 'tom1L', label: 'Tom 1 head (left hand)', targets: pose(stroke('snare', 'head', 0.1, { across: 0.07 }), stroke('tom1'), 'L'), strikes: ['L'] },
    { name: 'tom2', label: 'Tom 2 head', targets: pose(stroke('tom2'), stroke('snare', 'head', 0.1), 'R'), strikes: ['R'] },
    { name: 'floorTom', label: 'Floor tom head', targets: pose(stroke('floorTom'), stroke('snare', 'head', 0.1), 'R'), strikes: ['R'] },
    // cymbals
    { name: 'hihatClosed', label: 'Hi-hat, closed', targets: pose(groove(stroke('hihat')), stroke('snare', 'head', 0.06), 'R', { L: hatClosed() }), strikes: ['R'] },
    { name: 'hihatOpen', label: 'Hi-hat, open', targets: pose(stroke('hihat', 'head', 0, { open: true }), stroke('snare', 'head', 0.06), 'R', { L: hatOpen() }), strikes: ['R'] },
    // turned toward the ride, the left hand drifts toward the snare's middle, clear of the hi-hat
    { name: 'rideBow', label: 'Ride, bow', targets: pose(stroke('ride'), stroke('snare', 'head', 0.06, { across: 0.04 }), 'R'), strikes: ['R'] },
    { name: 'rideBell', label: 'Ride, bell', targets: pose(stroke('ride', 'bell'), stroke('snare', 'head', 0.06, { across: 0.04 }), 'R'), strikes: ['R'] },
    { name: 'crash', label: 'Crash, edge (left hand)', targets: pose(stroke('snare', 'head', 0.15), stroke('crash', 'edge'), 'L', { R: kickUp(1) }), strikes: ['L'] },
    { name: 'crashR', label: 'Crash, edge (right hand)', targets: pose(stroke('crash', 'edge'), stroke('snare', 'head', 0.1), 'R', { R: kickUp(1) }), strikes: ['R'] },
    // feet
    { name: 'kickHeelUp', label: 'Kick, heel up', targets: pose(stroke('hihat', 'head', 0.04), stroke('snare', 'head', 0.05), 'R', { R: kickUp(1) }), strikes: [] },
    { name: 'kickHeelDown', label: 'Kick, heel down', targets: pose(stroke('hihat', 'head', 0.04), stroke('snare', 'head', 0.05), 'R', { R: kickDown(1) }), strikes: [] },
    // grooves and phrases
    { name: 'groove', label: 'Crossed-hands hi-hat groove (backbeat)', targets: pose(stroke('hihat', 'head', 0.05), stroke('snare'), 'L', { R: kickUp(0.2) }), strikes: ['L'] },
    { name: 'fill', label: 'Fill across the toms to the floor tom', targets: pose(stroke('floorTom'), stroke('tom2', 'head', 0.08), 'R', { R: kickUp(0.6) }), strikes: ['R'] },
    { name: 'ghost', label: 'Ghost note (left, 2.5 cm)', targets: pose(stroke('hihat', 'head', 0.03), stroke('snare', 'head', 0.025), 'L'), strikes: [] },
    { name: 'accent', label: 'Accent preparation (left, stick high)', targets: pose(stroke('hihat', 'head', 0.03), stroke('snare', 'head', 0.38, { across: 0.06 }), 'L'), strikes: [] },
  ];
  return list;
}

/** the poses in the slow sweep, in order (it returns to the first) */
export const SWEEP = ['groove', 'snare', 'tom1', 'tom2', 'floorTom', 'rideBow', 'rideBell', 'crash', 'hihatOpen', 'accent', 'ghost'];

/** a pose between two others: every target blended (deterministic, for the sweep) */
export function blendTargets(a: DrummerTargets, b: DrummerTargets, u: number, out: DrummerTargets): DrummerTargets {
  const s = u * u * (3 - 2 * u);
  const mix = (x: number, y: number) => x + (y - x) * s;
  for (const side of ['R', 'L'] as Side[]) {
    const A = a[side];
    const B = b[side];
    const O = out[side];
    for (let k = 0; k < 3; k++) {
      O.point[k] = mix(A.point[k], B.point[k]);
      O.normal[k] = mix(A.normal[k], B.normal[k]);
    }
    // travel between strokes with the stick up: a lift that peaks midway
    O.lift = mix(A.lift, B.lift) + 0.07 * Math.sin(Math.PI * s);
    O.angle = mix(A.angle, B.angle);
    O.palmRoll = mix(A.palmRoll, B.palmRoll);
    O.contactFromTip = mix(A.contactFromTip, B.contactFromTip);
    const fa = a.feet[side];
    const fb = b.feet[side];
    const lift = (f: FootTarget) => f.heelLift ?? (f.heel === 'up' ? 1 : 0);
    out.feet[side].pedal = fa.pedal;
    out.feet[side].heel = s < 0.5 ? fa.heel : fb.heel;
    out.feet[side].heelLift = mix(lift(fa), lift(fb));
    out.feet[side].press = mix(fa.press, fb.press);
  }
  const lead = (t: DrummerTargets) => t.leadL ?? (t.lead === 'L' ? 1 : 0);
  out.lead = s < 0.5 ? a.lead : b.lead;
  out.leadL = mix(lead(a), lead(b));
  return out;
}

/** an empty target set to blend into */
export function emptyTargets(): DrummerTargets {
  const st = (): StickTarget => ({ point: [0, 0, 0], normal: [0, 1, 0], angle: 0.25, contactFromTip: STICK_BEAD, lift: 0, palmRoll: 0.5 });
  return { R: st(), L: st(), lead: 'R', feet: { R: { pedal: 'kickPedal', heel: 'up', press: 0 }, L: { pedal: 'hihatPedal', heel: 'down', press: 1 } } };
}
