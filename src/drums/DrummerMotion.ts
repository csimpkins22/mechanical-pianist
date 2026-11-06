// The robot drummer's performance: from a drum performance (DrumScore) and
// its sticking (Sticking), the targets the IK turns into a pose at any time
// t. Planned once at load, then evaluated as a pure function of t: the same
// t gives the same targets whether the performance was played up to it or
// sought, and evaluating allocates nothing.
//
// Hands. Each hand's strokes, in time order, become a lift curve (how far
// the stick's tip is above the contact it is heading for) and an aim (where
// that contact is, on which instrument, with the stick's angle, the hand's
// turn and which part of the stick touches). The shapes come from footage of
// real players (the user's clips 6 and 9, tracked frame by frame; see
// scratchpad/drums/motion):
//   - a stroke's height is set by its loudness: ghost notes 1-3 cm, taps
//     5-10 cm, accents 25-40 cm (clip 6: taps rise 5-6 cm, ghosts about 2,
//     up strokes 8-10; clip 9: full strokes 45-50 cm), scaled by its velocity
//     within its level, held down by the tempo (a hand cannot lift as far
//     between fast strokes), and varied per hit;
//   - the downstroke starts from rest at the top and accelerates all the way
//     into the head (most of its travel in its second half); the stick
//     dwells a few milliseconds and leaves at about two thirds of the speed
//     it came in with;
//   - between strokes the stick rebounds, and the hand decides where it
//     stops: a full stroke lets it rise into the next one's preparation, a
//     down stroke (an accent before taps) catches it low, an up stroke (a
//     tap before an accent) lifts from low to high; with time to spare the
//     stick settles to a low hover and lifts again for the next stroke
//     (clip 6: the lift takes 0.2-0.35 s, the downstroke about 0.1);
//   - big, slow strokes lead with the forearm (clip 9: the hand peaks about
//     0.3 s before the stick, and comes down first: Moeller's whip); fast and
//     soft ones barely move it, the wrist and fingers making the stroke;
//   - doubles' second notes come off the rebound, lower, mostly fingers;
//     buzz strokes press, barely lifting; a flam's grace note comes from a
//     few centimetres while the main note comes from its own height;
//   - crashes are struck with the shoulder of the stick across the edge and
//     follow through past it; the ride's bow with the tip, its bell and edge
//     with the shoulder; a rimshot lays the stick flatter so its shaft meets
//     the rim as the tip meets the head; a cymbal is struck where it is at
//     that moment (still swinging from an earlier hit, the hi-hat lifted by
//     its pedal: KitPose);
//   - moving between instruments the hand follows a minimum-jerk path,
//     leaving early enough to arrive before the downstroke, the stick lifted
//     clear of what lies between (more around the cymbals and the ride);
//   - a hand with nothing to play hovers with a little life in it; before the
//     first note the sticks are up and the drummer counts in.
// Body. The torso turns toward where the hands are working (the leading
// hand's more), smoothed and a little ahead of them, leans further for the
// far drums, rises into big crashes and follows through; the shoulders rise
// with effort; the head looks a little ahead of the hands, mostly at the
// snare and hi-hat, and nods with the pulse, more as the playing grows;
// breathing. Nothing repeats exactly: each bar's sway and nod, each stroke's
// height and timing are varied by a hash, never by a random number per frame.
// Feet. The kick's footboard is KitMotion's beater (one function: KitLayout's
// footboardAt), the foot on it heel up for most strokes, the leg lifting
// before loud ones, heel down for soft feathering; the hi-hat foot follows
// the pedal curve, rocking heel to toe for chicks, and keeps time with a heel
// bounce while the hi-hat is held closed.
import { DRUMS, HIHAT_OPEN_GAP, SPOTS, STICK, strikePoint, surfaceNormal, type DrumId, type V3 } from './KitLayout';
import { pedalAt, type DrumHit, type DrumPerformance, type PedalPoint, type Zone } from './DrumScore';
import { beatGrid, type Hand, type Level, type Sticking } from './Sticking';
import type { CymbalId, KitMotion } from './KitMotion';
import { cymbalPoint } from './KitPose';
import { STICK_BEAD, STICK_SHOULDER, createPose, naturalTorso, solveDrummer, type BodyTarget, type DrummerPose, type DrummerTargets, type StickTarget, type WarmStart } from './DrummerIK';
import { PALM_ROLL, STICK_ANGLE } from './DrummerPoses';
import { gaussianBlur, Signal } from '../core/math';
import { JOINTS } from './DrummerSpec';
import { drift, hash01 } from '../core/random';

const D2R = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));

// ---------------------------------------------------------------- measured and chosen numbers
/** the stick's height above the contact at the top of its preparation, by level: [softest, loudest] within the level (m) */
export const PREP: Record<Level, [number, number]> = {
  ghost: [0.012, 0.03],
  tap: [0.045, 0.1],
  accent: [0.24, 0.4],
};
/** strokes on these are smaller (a ride's bow, the hi-hat) or larger (a crash) than on a drum */
const PREP_SCALE: Partial<Record<DrumId, number>> = { ride: 0.55, hihat: 0.75, crash: 1.15 };
/** the most a hand lifts between strokes D seconds apart (m): fast strokes are low */
export const maxLift = (D: number) => 0.9 * Math.pow(Math.max(0, D), 1.4);
/** the downstroke: its duration from a height (s), and how the stick accelerates (h = H (1 - u^p)) */
export const downTime = (H: number) => 0.045 + 0.2 * Math.sqrt(Math.max(0, H));
export const DOWN_POWER = 2.2;
/** the stick on the surface: it dwells this long and leaves at this share of the speed it came in with */
export const DWELL = 0.003;
const RESTITUTION = { drum: 0.68, cymbal: 0.55 };
/** the most a stick under the other, crossed arm lifts (m): with the hands as low as real drummers hold them, the right
 * stick crossing to the hi-hat runs about 20 cm over the snare */
const UNDER_ARM = 0.14;
/** where a waiting stick hovers (m) */
const HOVER = 0.035;
/** the sticks' height before the first note (ready) */
const READY = 0.11;
/** the forearm's lead in big strokes (radians at the top of a 40 cm stroke) */
const ARM_MAX = 0.2;
/** how far ahead of the hands the torso turns and the head looks (s) */
const TORSO_LEAD = 0.1;
const LOOK_LEAD = 0.15;
/** the planned signals' rate (samples a second) */
const RATE = 120;
/** Newton steps for each planned key, from the key before */
const WARM_STEPS = 2;
/** a key whose arms cost more than this is searched afresh too */
const KEY_COST = 0.6;
/** a key is added between two where the interpolated arms cost this much more than either end */
const REFINE_COST = 0.4;
/** a frame whose arms cost this much more than the keys around it is refined on its own */
const FIX_COST = 0.5;
const FIX_RANGE = 2;
/** a frame still costing this much after that (a joint near or past its stop) takes the nearer key's arms */
const GLITCH_COST = 5;

export type StrokeKind = 'ready' | 'full' | 'down' | 'up' | 'tap' | 'double' | 'buzz' | 'grace' | 'choke';

/** one stroke of one hand, planned */
export interface Stroke {
  t: number;
  /** the DrumHit (-1: a choke; -2: the ready position before the first note) */
  hit: number;
  piece: DrumId;
  zone: Zone | 'choke';
  kind: StrokeKind;
  level: Level;
  velocity: number;
  // the contact: where, the surface's normal, the stick's angle to it, which part of the stick, the hand's turn, the stick's line
  P: Float64Array;
  N: Float64Array;
  angle: number;
  cft: number;
  roll: number;
  sweep: number;
  /** the top of the preparation (m above the contact) and when the downstroke leaves it */
  prep: number;
  top: number;
  /** speed into the surface and out of it (m/s) */
  vin: number;
  vout: number;
  /** the interval before this stroke: the rebound's speed out of the last contact, then up to two keys (time, height) */
  v0: number;
  k1t: number;
  k1h: number;
  k2t: number;
  k2h: number;
  /** travel from the last stroke's instrument: leave, arrive, and how far the stick is lifted clear on the way */
  tl: number;
  ta: number;
  clear: number;
  /** the forearm: its turn at the top, when it peaks and when it is down again; the fingers' share */
  arm: number;
  armUp: number;
  armPeak: number;
  armDown: number;
  fingers: number;
  /** the arm on top when the arms are crossed at this stroke (Sticking's), or null */
  over: Hand | null;
  /** 1 on the hi-hat's top cymbal: its contact rises and falls with the pedal (added at evaluation) */
  hh: number;
  /** after a crash, the stick follows through past the edge (offset, m) over ftT seconds */
  ft: Float64Array;
  ftT: number;
}

function newStroke(): Stroke {
  return {
    t: 0,
    hit: -2,
    piece: 'snare',
    zone: 'head',
    kind: 'tap',
    level: 'tap',
    velocity: 0.5,
    P: new Float64Array(3),
    N: new Float64Array(3),
    angle: 0,
    cft: STICK_BEAD,
    roll: 0.5,
    sweep: 0,
    prep: 0.05,
    top: 0,
    vin: 0,
    vout: 0,
    v0: 0,
    k1t: NaN,
    k1h: 0,
    k2t: NaN,
    k2h: 0,
    tl: 0,
    ta: 0,
    clear: 0,
    arm: 0,
    armUp: 0,
    armPeak: 0,
    armDown: 0,
    fingers: 0.3,
    over: null,
    hh: 0,
    ft: new Float64Array(3),
    ftT: 0,
  };
}

/** how a stroke on an instrument meets it: which part of the stick, at what angle (radians) */
function contactOf(piece: DrumId, zone: Zone): { cft: number; angle: number } {
  if (piece === 'crash') return { cft: STICK_SHOULDER, angle: zone === 'edge' ? -10 * D2R : -14 * D2R };
  if (piece === 'ride') {
    // (the bell with the tip, the stick steeper than on the bow: struck with the shoulder at a flat angle the tip
    // would lie over the crown and the wing nut, so a bell pattern is played with the tip, as many players do)
    if (zone === 'bell') return { cft: STICK_BEAD, angle: 22 * D2R };
    if (zone === 'edge') return { cft: STICK_SHOULDER, angle: -12 * D2R };
    return { cft: STICK_BEAD, angle: STICK_ANGLE.ride };
  }
  if (piece === 'hihat') {
    if (zone === 'edge') return { cft: STICK_SHOULDER, angle: -12 * D2R };
    return { cft: STICK_BEAD, angle: STICK_ANGLE.hihat };
  }
  // a rimshot: the shaft meets the near rim as the tip meets the head toward its middle (a flatter stick, held where
  // it always is); a cross-stick lies nearly flat across the head from the hand resting on it, its shaft on the
  // far hoop a few centimetres from the tip, which overhangs it
  if (zone === 'rim') return { cft: 0.14, angle: 3.8 * D2R };
  if (zone === 'crossStick') return { cft: CROSS_STICK.cft, angle: CROSS_STICK.angle };
  return { cft: STICK_BEAD, angle: STICK_ANGLE[piece] };
}

/**
 * A cross-stick (rim click): the hand rests on the near half of the head, palm down, and the stick lies across the
 * drum, the shaft meeting the far hoop (DrumScore puts the spot there) CROSS_STICK.cft back from the tip; the stick
 * rises gently from the hoop to the hand. Its line is turned across the drum (sweep), and the stroke is the far end
 * lifted a few centimetres and dropped, the hand staying where it rests. (The grip cannot turn the stick round, as
 * some players do to strike the hoop with the butt; this is the other common way, the stick held as usual.)
 */
/** a rimshot's stick turned toward the hand's own side from its natural line (radians) */
const RIM_SWEEP = 0.3;

const CROSS_STICK = { cft: 0.075, angle: 3.5 * D2R, sweep: -0.25, roll: 0.15, maxPrep: 0.06 };

/**
 * Two hands on the snare (a second line's sixteenths, a train beat, a press roll): each plays its own side of it,
 * the left hand SHARED_SIDE to the left of the hit's spot and the right hand as far to the right, so the tips stay
 * apart and the sticks make a V rather than crossing. That is any passage of ROLL_MIN or more hand strokes on the
 * snare's head, each within ROLL_GAP of the one before (an eighth at 120 bpm), both hands among them. (Not the
 * toms: the first rack tom stands against the hi-hat, and the left hand moved to its left side would reach under
 * the hi-hat.) A rimshot (or a rim click) is struck on the hand's own side of the near rim, its spot turned
 * RIM_TURN round the rim toward the hand, and the stick laid across the head from there toward its middle: the
 * right hand's from about five o'clock, the left's from about seven, as the drummer sees it, so a rimshot's stick
 * does not lie across the other hand's.
 */
export const SHARED_SIDE = 0.025;
const ROLL_GAP = 0.25;
const ROLL_MIN = 2;
/** how far round the rim, toward its hand, a rimshot is struck (radians) */
export const RIM_TURN = 0.45;
/**
 * how far round toward the drummer's left the left hand strikes the hi-hat's edge (radians): sitting up, the edge
 * nearest the drummer is too close for the stick and the hand in front of it, so the left hand plays it from its side
 */
export const HIHAT_EDGE_TURN = 1.3;

/** per hit, the side its hand plays on: -1 (left), +1 (right) in a two-handed passage on the snare's head, for every rimshot or rim click, and the left hand's hi-hat edge strokes; or 0 */
export function sharedDrumSides(st: Sticking, hits: readonly DrumHit[]): Int8Array {
  const out = new Int8Array(st.hits.length);
  const hand = (h: (typeof st.hits)[number]) => h.played && (h.limb === 'R' || h.limb === 'L');
  const list = st.hits.filter((h) => hand(h) && h.zone === 'head' && h.piece === 'snare');
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    while (j < list.length && list[j].t - list[j - 1].t <= ROLL_GAP) j++;
    const run = list.slice(i, j);
    if (run.length >= ROLL_MIN && run.some((h) => h.limb === 'L') && run.some((h) => h.limb === 'R'))
      for (const h of run) out[h.hit] = h.limb === 'L' ? -1 : 1;
    i = j;
  }
  for (const h of st.hits) if (hand(h) && (h.zone === 'rim' || hits[h.hit].click)) out[h.hit] = h.limb === 'L' ? -1 : 1;
  // (and the left hand playing the hi-hat's edge, uncrossed: from its own side)
  for (const h of st.hits) if (hand(h) && h.limb === 'L' && h.piece === 'hihat' && h.zone === 'edge') out[h.hit] = -1;
  return out;
}

/**
 * a hit's spot as its hand plays it: its own r and angle, moved to the hand's side of the snare in a two-handed
 * passage (side -1 or +1), or, for a rimshot or a rim click, turned round the rim toward the hand
 */
export function handSpot(d: (typeof DRUMS)[DrumId], h: DrumHit, side: number): V3 {
  if (side && (h.zone === 'rim' || h.click)) return strikePoint(d, h.r, h.angle + side * RIM_TURN);
  if (side && d.id === 'hihat' && h.zone === 'edge') return strikePoint(d, h.r, h.angle + side * HIHAT_EDGE_TURN);
  const p = strikePoint(d, h.r, h.angle);
  if (side) {
    // across the head, toward the drummer's right
    const o = strikePoint(d, 0, 0);
    const x = strikePoint(d, 1, Math.PI / 2);
    const l = Math.hypot(x[0] - o[0], x[1] - o[1], x[2] - o[2]);
    for (let k = 0; k < 3; k++) p[k] += ((x[k] - o[k]) / l) * SHARED_SIDE * side;
  }
  return p;
}

/** the hi-hat's axis, along which its pedal lifts the top cymbal */
const HH_AXIS = surfaceNormal(DRUMS.hihat);
/** the rim's height above the head (the hoop): a rimshot's contact is on it */
const HOOP = 0.008;

// ---------------------------------------------------------------- one hand
const ev = { P: new Float64Array(3), N: new Float64Array(3) };

class HandPlan {
  readonly strokes: Stroke[] = [];
  /** the strokes' times, for the binary search */
  times = new Float64Array(0);
  constructor(
    readonly hand: Hand,
    private hihat: PedalPoint[],
  ) {}

  /** the hi-hat's top cymbal lifted by its pedal at t, along its axis, weighted (the stick on or over it) */
  private lifted(o: StickTarget, t: number, w: number) {
    if (w <= 0) return;
    const g = HIHAT_OPEN_GAP * (1 - pedalAt(this.hihat, t)) * w;
    for (let k = 0; k < 3; k++) o.point[k] += HH_AXIS[k] * g;
  }

  finish() {
    this.times = Float64Array.from(this.strokes.map((s) => s.t));
  }

  /** the index of the first stroke after t (strokes.length if none) */
  nextIndex(t: number): number {
    const T = this.times;
    let lo = 0;
    let hi = T.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** the lift between strokes a and b at t (before b's downstroke) */
  private between(a: Stroke, b: Stroke, t: number): number {
    if (a.kind === 'ready') {
      // ready: up, waiting; then the preparation (keys: rest point k2, the top)
      if (Number.isNaN(b.k2t) || t <= b.k2t) return b.k2h;
      return hermite(b.k2t, b.k2h, 0, b.top, b.prep, 0, t);
    }
    const t0 = a.t + DWELL;
    if (t <= t0) return 0;
    let pt = t0;
    let ph = 0;
    let pv = b.v0;
    if (!Number.isNaN(b.k1t)) {
      if (t <= b.k1t) return hermite(pt, ph, pv, b.k1t, b.k1h, 0, t);
      pt = b.k1t;
      ph = b.k1h;
      pv = 0;
    }
    if (!Number.isNaN(b.k2t)) {
      if (t <= b.k2t) return hermite(pt, ph, pv, b.k2t, b.k2h, 0, t);
      pt = b.k2t;
      ph = b.k2h;
      pv = 0;
    }
    return hermite(pt, ph, pv, b.top, b.prep, 0, t);
  }

  /** the aim between strokes a and b at t: the contact frame travelling from a's (after its follow-through) to b's */
  private aim(a: Stroke, b: Stroke, t: number, o: StickTarget): number {
    const u = b.ta > b.tl ? clamp((t - b.tl) / (b.ta - b.tl), 0, 1) : t >= b.ta ? 1 : 0;
    const s = minJerk(u);
    // the follow-through after a crash: out past the edge and back
    let f = 0;
    if (a.ftT > 0) {
      const tau = (t - a.t) / a.ftT;
      f = tau <= 0 || tau >= 1 ? 0 : Math.sin(Math.PI * Math.pow(tau, 0.6));
    }
    for (let k = 0; k < 3; k++) {
      o.point[k] = a.P[k] + a.ft[k] * f + (b.P[k] - a.P[k] - a.ft[k] * f) * s;
      ev.N[k] = a.N[k] + (b.N[k] - a.N[k]) * s;
    }
    const nl = Math.hypot(ev.N[0], ev.N[1], ev.N[2]);
    for (let k = 0; k < 3; k++) o.normal[k] = ev.N[k] / nl;
    o.angle = a.angle + (b.angle - a.angle) * s;
    o.contactFromTip = a.cft + (b.cft - a.cft) * s;
    o.palmRoll = a.roll + (b.roll - a.roll) * s;
    o.sweep = a.sweep + (b.sweep - a.sweep) * s;
    // lifted clear on the way: a bump over the travel
    return b.clear * Math.sin(Math.PI * u);
  }

  private setFrame(s: Stroke, o: StickTarget) {
    for (let k = 0; k < 3; k++) {
      o.point[k] = s.P[k];
      o.normal[k] = s.N[k];
    }
    o.angle = s.angle;
    o.contactFromTip = s.cft;
    o.palmRoll = s.roll;
    o.sweep = s.sweep;
  }

  /** the forearm's turn at t, heading for stroke b (from a) */
  private armAt(b: Stroke, t: number): number {
    if (b.arm <= 0 || t <= b.armUp || t >= b.armDown) return 0;
    if (t < b.armPeak) return b.arm * minJerk((t - b.armUp) / (b.armPeak - b.armUp));
    return b.arm * (1 - minJerk((t - b.armPeak) / (b.armDown - b.armPeak)));
  }

  evaluate(t: number, o: StickTarget) {
    const S = this.strokes;
    const i = this.nextIndex(t);
    const b = i < S.length ? S[i] : null;
    const a = i > 0 ? S[i - 1] : null;
    let lift: number;
    if (b && a) {
      if (t >= b.top) {
        // the downstroke: from rest at the top, accelerating into the surface
        const u = (t - b.top) / (b.t - b.top);
        lift = b.prep * (1 - Math.pow(clamp(u, 0, 1), DOWN_POWER));
      } else lift = this.between(a, b, t);
      if (t >= b.ta) {
        this.setFrame(b, o);
        this.lifted(o, t, b.hh);
      } else {
        // on the way (a fast move goes on into the downstroke, arriving as the stick lands)
        const c = this.aim(a, b, t, o);
        const u = b.ta > b.tl ? minJerk(clamp((t - b.tl) / (b.ta - b.tl), 0, 1)) : 1;
        this.lifted(o, t, a.hh + (b.hh - a.hh) * u);
        // the stick lifted clear of what lies between: never lower than the bump (a smooth maximum)
        if (c > 0) lift = Math.sqrt(lift * lift + c * c);
      }
      // the forearm: a small share of every lift, and its own lead in big strokes
      o.arm = 0.2 * lift + this.armAt(b, t);
      o.fingers = t >= b.top || !a || t > a.t + 0.5 * (b.t - a.t) ? b.fingers : a.fingers + (b.fingers - a.fingers) * smooth((t - a.t) / (0.5 * (b.t - a.t)));
      // a little life in a waiting hand (none near a contact or a preparation)
      const w = a.kind === 'ready' ? smooth((b.top - 0.15 - t) / 0.3) : smooth((t - a.t - 0.25) / 0.3) * smooth((b.top - 0.25 - t) / 0.3);
      if (w > 0) {
        const seed = this.hand === 'R' ? 401 : 402;
        lift += w * 0.007 * drift(t * 0.45, seed);
        o.point[0] += w * 0.004 * drift(t * 0.3, seed + 10);
        o.point[2] += w * 0.004 * drift(t * 0.27, seed + 20);
      }
    } else if (a) {
      // after the last stroke: the rebound settles to a hover, and the hand waits
      this.setFrame(a, o);
      this.lifted(o, t, a.hh);
      const t0 = a.t + DWELL;
      const T1 = clamp((1.6 * HOVER) / Math.max(0.2, a.vout), 0.06, 0.3);
      lift = t <= t0 ? 0 : t < t0 + T1 ? hermite(t0, 0, Math.min(a.vout, (2.5 * HOVER) / T1), t0 + T1, HOVER * 1.6, 0, t) : HOVER * 1.6;
      const w = smooth((t - a.t - 0.3) / 0.4);
      lift += w * 0.007 * drift(t * 0.45, this.hand === 'R' ? 401 : 402);
      o.arm = 0.2 * lift;
      o.fingers = 0.3;
    } else if (b) {
      this.setFrame(b, o);
      this.lifted(o, t, b.hh);
      lift = b.prep;
      o.arm = 0;
      o.fingers = b.fingers;
    } else {
      lift = READY;
      o.arm = 0;
      o.fingers = 0.3;
    }
    o.lift = lift < 0 ? 0 : lift;
  }
}

/** a cubic Hermite from (t0, h0, v0) to (t1, h1, v1) at t */
function hermite(t0: number, h0: number, v0: number, t1: number, h1: number, v1: number, t: number): number {
  const T = t1 - t0;
  if (T <= 1e-9) return h1;
  const u = clamp((t - t0) / T, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  return h0 * (2 * u3 - 3 * u2 + 1) + v0 * T * (u3 - 2 * u2 + u) + h1 * (-2 * u3 + 3 * u2) + v1 * T * (u3 - u2);
}

// ---------------------------------------------------------------- the whole drummer
export interface DrummerMotionOptions {
  /** plan the arms' free choices (warm starts) at load; off for tests that only read the targets */
  warm?: boolean;
}

export class DrummerMotion {
  readonly hands: Record<Hand, HandPlan>;
  readonly duration: number;
  /** body signals at RATE */
  private sig: Record<string, Signal> = {};
  private beat: number;
  private origin: number;
  private perBar: number;
  /** warm-start keys: times and the arms' free choices (R roll, swivel, sweep, then L) */
  private keyT = new Float64Array(0);
  private keyF = new Float64Array(0);
  private warmBuf: WarmStart = { R: new Float64Array(3), L: new Float64Array(3), steps: 0, smooth: true };
  /** the time of the performance's first note */
  readonly first: number;
  /** per hit: -1 or +1 in a roll on the snare (the left hand's to the left, the right's to the right), else 0 */
  private shared: Int8Array = new Int8Array(0);

  constructor(
    readonly perf: DrumPerformance,
    readonly sticking: Sticking,
    readonly kit: KitMotion,
    opts: DrummerMotionOptions = {},
  ) {
    this.duration = perf.duration;
    this.hands = { R: new HandPlan('R', perf.hihat), L: new HandPlan('L', perf.hihat) };
    const g = beatGrid(perf);
    this.beat = g.beat;
    this.origin = g.origin;
    this.perBar = g.perBar;
    this.first = perf.hits.length ? perf.hits[0].t : 0;
    this.planHands();
    this.planBody();
    if (opts.warm !== false) this.planWarm();
  }

  // ------------------------------------------------------------ hands
  private planHands() {
    const perf = this.perf;
    const st = this.sticking;
    this.shared = sharedDrumSides(st, perf.hits);
    for (const hand of ['R', 'L'] as Hand[]) {
      const plan = this.hands[hand];
      const list: Stroke[] = plan.strokes;
      // ready: sticks up over the home instrument before the first note
      const ready = newStroke();
      ready.kind = 'ready';
      ready.t = -1e6;
      const home = st.home[0]?.[hand] ?? (hand === 'R' ? 'hihat' : 'snare');
      this.frameAt(ready, home, home === 'snare' ? 'head' : DRUMS[home].kind === 'cymbal' ? 'bow' : 'head', null, hand);
      ready.prep = READY;
      list.push(ready);
      const items: { t: number; k: number; choke: boolean }[] = [];
      st.hits.forEach((h, k) => {
        if (h.played && h.limb === hand) items.push({ t: h.t, k, choke: false });
      });
      st.chokes.forEach((c, k) => {
        if (c.hand === hand) items.push({ t: c.t, k, choke: true });
      });
      items.sort((x, y) => x.t - y.t);
      for (const it of items) {
        const s = newStroke();
        s.t = it.t;
        if (it.choke) {
          const c = st.chokes[it.k];
          s.hit = -1;
          s.kind = 'choke';
          s.zone = 'choke';
          s.piece = c.piece;
          s.level = 'tap';
          s.velocity = 0.4;
          this.frameAt(s, c.piece, 'choke', null, hand);
        } else {
          const lh = st.hits[it.k];
          const h = perf.hits[it.k];
          s.hit = it.k;
          s.piece = h.piece;
          // (a rim click is struck as a rimshot is, its shaft on the near hoop)
          s.zone = h.click ? 'rim' : h.zone;
          s.level = lh.level;
          s.velocity = h.velocity;
          s.kind = lh.grace ? 'grace' : lh.double ? 'double' : 'tap';
          s.over = lh.over;
          this.frameAt(s, h.piece, s.zone as Zone, h, hand);
        }
        list.push(s);
      }
      this.planStrokes(list, hand);
      plan.finish();
    }
  }

  /** the contact frame of a stroke on a piece (from the hit's own spot, on the kit as it is at that moment) */
  private frameAt(s: Stroke, piece: DrumId, zone: Zone | 'choke', h: DrumHit | null, hand: Hand) {
    const d = DRUMS[piece];
    const n = surfaceNormal(d);
    // the hit's own spot (its r and angle, as the kit's reactions take it), or the instrument's usual one; in a roll
    // on the snare, each hand to its own side of it
    let p: V3 = h ? handSpot(d, h, this.shared[h.i]) : (SPOTS.head(d).slice() as V3);
    // (the left hand, uncrossed on the hi-hat, plays its edge with the tip: its shoulder would have to reach across it)
    const c = zone === 'choke' ? { cft: STICK.length * 0.62, angle: 30 * D2R } : hand === 'L' && piece === 'hihat' ? contactOf('hihat', 'bow') : contactOf(piece, zone);
    if (zone === 'rim' || zone === 'crossStick') for (let k = 0; k < 3; k++) p[k] += n[k] * HOOP;
    if (zone === 'choke') p = edgeNear(piece);
    // a cymbal where it is at that instant: swinging from earlier hits, the hi-hat lifted by its pedal
    if (h && d.kind === 'cymbal') {
      const ks = this.kit.evaluate(Math.max(0, h.t - 1e-4));
      // (the hi-hat's lift by its pedal is added as the hand plays, so a stick waiting over it rises and falls with it)
      ks.hihatGap = 0;
      const id = piece as CymbalId;
      const q = [0, 0, 0];
      cymbalPoint(id, p, ks, q);
      const q1 = [0, 0, 0];
      cymbalPoint(id, [p[0] + n[0] * 0.05, p[1] + n[1] * 0.05, p[2] + n[2] * 0.05], ks, q1);
      p = q as V3;
      const nn = [(q1[0] - q[0]) / 0.05, (q1[1] - q[1]) / 0.05, (q1[2] - q[2]) / 0.05];
      s.N.set(nn);
    } else s.N.set(n);
    s.hh = piece === 'hihat' ? 1 : 0;
    s.P.set(p);
    s.angle = c.angle;
    s.cft = c.cft;
    s.roll = zone === 'crossStick' ? CROSS_STICK.roll : PALM_ROLL[piece];
    // the left hand on the snare plays from a little further right, its stick pointing more forward: clear of the
    // hi-hat beside it when it lifts. A rimshot's stick lies across the head from the near rim: turned toward the
    // hand's own side (pointing more forward), so its tip stays over the hand's own half, clear of the other stick
    // (and on the first rack tom, beside the hi-hat, the left hand plays from further right still: clear of the hi-hat's
    // edge, which its pedal can lift into a hand waiting there)
    s.sweep = zone === 'crossStick' ? CROSS_STICK.sweep : zone === 'rim' ? (hand === 'L' ? RIM_SWEEP : -RIM_SWEEP) : hand === 'L' && piece === 'snare' ? 0.12 : hand === 'L' && piece === 'tom1' ? 0.4 : 0;
  }

  /** heights, timings, rebounds, travel and the forearm, stroke by stroke for one hand */
  private planStrokes(list: Stroke[], hand: Hand) {
    for (let i = 1; i < list.length; i++) {
      const s = list[i];
      const a = list[i - 1];
      const D = a.kind === 'ready' ? 2 : s.t - a.t;
      const Dn = i + 1 < list.length ? list[i + 1].t - s.t : 2;
      const var1 = hash01(s.hit + 7, hand === 'R' ? 61 : 62);
      const var2 = hash01(s.hit + 7, hand === 'R' ? 63 : 64);
      // --- the height of its preparation
      let H: number;
      if (s.kind === 'choke') H = 0.06;
      else if (s.kind === 'grace') H = Math.max(0.006, Math.min(0.02 + 0.012 * var1, maxLift(D)));
      else if (s.kind === 'double') {
        // off the rebound of the stroke before: lower, the fingers pushing it down again
        H = D < 0.05 ? 0.004 + 0.004 * var1 : Math.min(Math.max(0.42 * a.prep, 0.008), Math.max(0.006, maxLift(D)));
        if (D < 0.05) s.kind = 'buzz';
      } else {
        const [lo, hi] = PREP[s.level];
        const rel = s.level === 'accent' ? clamp((s.velocity - 0.7) / 0.3, 0, 1) : s.level === 'tap' ? clamp((s.velocity - 0.35) / 0.4, 0, 1) : clamp(s.velocity / 0.45, 0, 1);
        H = (lo + (hi - lo) * rel) * (PREP_SCALE[s.piece] ?? 1);
        // never the same twice: ±20% per hit
        H *= 0.82 + 0.36 * var1;
        H = Math.min(H, maxLift(D));
        // under the other arm (the left hand on the snare with the right crossed over it to the hi-hat) a stroke
        // has only the room below that arm
        if (this.crossedOver(hand, s.t)) H = Math.min(H, UNDER_ARM * (0.9 + 0.2 * var1));
        // a cross-stick only lifts the stick's far end off the hoop, the hand resting on the head
        if (s.zone === 'crossStick') H = Math.min(H * 0.4, CROSS_STICK.maxPrep);
        H = Math.max(H, 0.006);
      }
      s.prep = H;
      // --- the downstroke: its time (varied ±8%), speed in and out
      const Td = Math.min(0.42 * Math.max(D, 0.02), downTime(H) * (0.92 + 0.16 * var2));
      s.top = s.t - Td;
      s.vin = (DOWN_POWER * H) / Td;
      s.vout = s.vin * (DRUMS[s.piece].kind === 'cymbal' ? RESTITUTION.cymbal : RESTITUTION.drum);
      // --- the kind of stroke, from this stroke's height and the next one's (the same hand)
      if (s.kind === 'tap') {
        const nextH = i + 1 < list.length ? list[i + 1].level : s.level;
        const high = (l: Level) => l === 'accent';
        s.kind = high(s.level) ? (high(nextH) ? 'full' : 'down') : high(nextH) ? 'up' : 'tap';
      }
      // --- the fingers' share and the forearm's lead
      const fast = clamp((0.3 - Math.min(D, Dn)) / 0.2, 0, 1);
      s.fingers = s.kind === 'double' || s.kind === 'buzz' ? 0.6 : s.level === 'ghost' ? 0.42 + 0.15 * fast : s.level === 'tap' ? 0.28 + 0.2 * fast : 0.12 + 0.1 * fast;
      const room = clamp((D - 0.22) / 0.35, 0, 1);
      s.arm = s.kind === 'double' || s.kind === 'buzz' || s.kind === 'grace' ? 0 : ARM_MAX * clamp((H - 0.08) / 0.3, 0, 1) * room;
      // --- the interval before it: the rebound out of the last contact, a hover if there is time, the lift
      const t0 = a.t + DWELL;
      const A = s.top - t0;
      // the lift into the preparation: clip 6's taps take about 0.25 s; clip 9's slow full strokes rise for most of
      // their cycle, the stick held up while the hand drops, then the snap
      const Tp = clamp(0.55 * A, 0.12 + 0.55 * H, s.level === 'accent' ? 0.9 : 0.3);
      s.k1t = NaN;
      s.k2t = NaN;
      if (a.kind === 'ready') {
        s.k2t = s.top - Tp;
        s.k2h = Math.min(READY, Math.max(H, READY * 0.6));
        s.v0 = 0;
      } else {
        const vout = a.vout;
        // the rebound alone rises about this far, and takes this long (decelerating)
        // (clip 6: after a tap or a ghost note the stick is held just off the head until the next lift; after an
        // accent it rebounds further before it is caught)
        const Hreb = a.level === 'accent' ? clamp(0.55 * a.prep + 0.008, 0.006, 0.18) : clamp(0.18 * a.prep + 0.003, 0.003, 0.03);
        const Treb = clamp((1.6 * Hreb) / Math.max(vout, 0.15), 0.035, 0.22);
        if (A > Treb + Tp + 0.06) {
          // time to spare: the rebound, a hover (or held low after a down stroke), then the preparation
          const H1 = a.kind === 'down' ? Math.min(Hreb, Math.max(H, 0.03)) : Hreb;
          s.k1t = t0 + Treb;
          s.k1h = H1;
          s.v0 = Math.min(vout, (2.6 * H1) / Treb);
          const hover = s.level === 'accent' ? Math.min(HOVER * (0.8 + 0.5 * var2), H) : 0.004 + 0.004 * var2;
          s.k2t = s.top - Tp;
          s.k2h = Math.min(H1, hover);
          if (s.k2t - s.k1t < 0.05) s.k2t = NaN;
        } else {
          // the rebound straight into the next preparation (a full stroke), or caught at the next one's height (down)
          s.v0 = Math.min(vout, (2.6 * H) / Math.max(A, 0.01));
        }
      }
      // --- the forearm: up with the preparation, ahead of the stick, and down first (the wrist lags, then snaps)
      if (s.arm > 0) {
        // (clip 9: the hand rises with the stick, peaks well before the stick's top, and is on its way down while the
        // stick is still up; it lands first and the wrist snaps the stick after it)
        s.armUp = Math.max(t0 + 0.02, s.top - Tp - 0.08);
        s.armPeak = s.top - 0.62 * Tp;
        s.armDown = s.t - 0.35 * Td;
        if (s.armPeak <= s.armUp + 0.04 || s.armDown <= s.armPeak + 0.03) s.arm = 0;
      }
      // --- travel from the last instrument
      const dist = Math.hypot(s.P[0] - a.P[0], s.P[1] - a.P[1], s.P[2] - a.P[2]);
      const moving = a.piece !== s.piece || dist > 0.06;
      // a comfortable move takes Tm and arrives before the downstroke; a hurried one leaves straight after the last
      // stroke and goes on into the downstroke, arriving as the stick lands (never faster than the sticking allows)
      const Tm = 0.12 + 0.55 * dist;
      const leave = a.kind === 'ready' ? -Infinity : t0 + 0.012;
      s.ta = s.top - 0.01;
      s.tl = Math.max(leave, s.ta - Tm);
      if (s.ta - s.tl < 0.75 * Tm && dist > 0.03) s.ta = Math.min(s.t, s.tl + 0.75 * Tm);
      if (s.ta - s.tl < 0.03) s.ta = Math.min(s.t, s.tl + 0.03);
      // (never before the last stroke has left the surface: it lands exactly on its own spot)
      if (a.kind !== 'ready' && s.tl < t0) s.tl = t0;
      if (s.ta <= s.tl) s.ta = Math.min(s.t, s.tl + 1e-3);
      s.clear = moving ? clearLift(a, s) : 0;
      // crossing over the other arm on the way (Sticking's arm on top): over it, higher
      if (moving && s.over === hand && s.piece !== 'hihat') s.clear += 0.1;
      // --- a crash follows through past its edge: along the stick's sweep and out, then the hand recovers
      if (s.piece === 'crash' && s.kind !== 'choke') {
        const d = DRUMS.crash;
        const out = [s.P[0] - d.centre[0], 0, s.P[2] - d.centre[2]];
        const ol = Math.hypot(out[0], out[2]) || 1;
        // (the left hand sweeps on outward; the right, already reaching across the body, follows through down and out)
        const side = hand === 'L' ? 0.035 : 0;
        s.ft[0] = (out[0] / ol) * 0.04 + side * -1;
        s.ft[1] = -0.035;
        s.ft[2] = (out[2] / ol) * 0.04;
        s.ftT = Math.min(0.3, 0.8 * Dn);
      }
    }
  }

  /** whether the other hand is crossed over this one near t (Sticking marks the hits played crossed with the arm on top) */
  private crossedOver(hand: Hand, t: number): boolean {
    const other: Hand = hand === 'R' ? 'L' : 'R';
    for (const h of this.sticking.hits) if (h.played && h.limb === other && h.over === other && Math.abs(h.t - t) < 0.4) return true;
    return false;
  }

  // ------------------------------------------------------------ body
  private planBody() {
    const n = Math.ceil(this.duration * RATE) + 2;
    const yaw = new Float32Array(n);
    const pitch = new Float32Array(n);
    const roll = new Float32Array(n);
    const lx = new Float32Array(n);
    const ly = new Float32Array(n);
    const lz = new Float32Array(n);
    const leadL = new Float32Array(n);
    const effR = new Float32Array(n);
    const effL = new Float32Array(n);
    const tR: StickTarget = blankStick();
    const tL: StickTarget = blankStick();
    const ang = [0, 0, 0];
    // which hand leads: the one playing louder and more, lately and soon (a blurred measure of each hand's activity)
    const act = { R: new Float32Array(n), L: new Float32Array(n) };
    for (const hand of ['R', 'L'] as Hand[])
      for (const s of this.hands[hand].strokes) {
        if (s.kind === 'ready') continue;
        const k = Math.round(s.t * RATE);
        if (k >= 0 && k < n) {
          act[hand][k] += 0.3 + s.prep * 4 + (s.piece === 'crash' ? 1.2 : 0);
          (hand === 'R' ? effR : effL)[k] += s.prep;
        }
      }
    const aR = gaussianBlur(act.R, 0.35 * RATE);
    const aL = gaussianBlur(act.L, 0.35 * RATE);
    for (let i = 0; i < n; i++) leadL[i] = clamp(0.5 + 1.6 * (aL[i] - aR[i]) / (aL[i] + aR[i] + 0.05), 0, 1);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      this.hands.R.evaluate(t + TORSO_LEAD, tR);
      this.hands.L.evaluate(t + TORSO_LEAD, tL);
      naturalTorso(tR.point, tL.point, leadL[i], ang);
      yaw[i] = ang[0];
      pitch[i] = ang[1];
      roll[i] = ang[2];
      this.hands.R.evaluate(t + LOOK_LEAD, tR);
      this.hands.L.evaluate(t + LOOK_LEAD, tL);
      // the head looks where the hands are going, mostly at the snare and the hi-hat
      const w = 0.35 + 0.3 * leadL[i];
      const sn = DRUMS.snare.centre;
      const hh = DRUMS.hihat.centre;
      for (let k = 0; k < 3; k++) {
        const hands = w * tL.point[k] + (1 - w) * tR.point[k];
        const home = 0.6 * sn[k] + 0.4 * hh[k];
        (k === 0 ? lx : k === 1 ? ly : lz)[i] = 0.62 * hands + 0.38 * home;
      }
    }
    const blur = (a: Float32Array, s: number) => gaussianBlur(a, s * RATE);
    const Y = blur(yaw, 0.16);
    const P = blur(pitch, 0.18);
    const Rr = blur(roll, 0.2);
    // crashes: the body rises into a big one and follows through after it (and turns a little further toward it)
    const B = this.beat;
    for (const hand of ['R', 'L'] as Hand[])
      for (const s of this.hands[hand].strokes) {
        if (s.piece !== 'crash' || s.kind === 'choke' || s.kind === 'ready') continue;
        const size = clamp(s.prep / 0.35, 0.3, 1.2) * (0.8 + 0.4 * hash01(s.hit, 71));
        const k0 = Math.round((s.t - 0.8) * RATE);
        const k1 = Math.round((s.t + 0.8) * RATE);
        for (let k = Math.max(0, k0); k < Math.min(n, k1); k++) {
          const tau = k / RATE - s.t;
          // rise before (up and back), then forward through it, settling
          const up = Math.exp(-(((tau + 0.12) / 0.11) ** 2));
          const through = tau > 0 ? (tau / 0.12) * Math.exp(1 - tau / 0.12) : 0;
          P[k] += size * (0.045 * up - 0.06 * through);
          // the right hand reaching across to the crash: the body turns with it
          if (hand === 'R') Y[k] += 0.2 * Math.exp(-((tau / 0.32) ** 2));
        }
      }
    // the pulse: the body sways and the head nods on the beat (or every other beat when fast, once a bar in a fast
    // three: a jazz waltz is felt in one), more as the playing grows
    const half = 60 / B > 130;
    const pulseLen = half ? (this.perBar % 2 === 1 ? this.perBar * B : 2 * B) : B;
    const intensity = blur(new Float32Array(Array.from({ length: n }, (_, i) => effR[i] + effL[i])), 0.8);
    let imax = 0;
    for (let i = 0; i < n; i++) imax = Math.max(imax, intensity[i]);
    const nod = new Float32Array(n);
    const breath = new Float32Array(n);
    const hy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const ph = (t - this.origin) / pulseLen;
      const bar = Math.floor((t - this.origin) / (B * this.perBar));
      const level = clamp(intensity[i] / (imax || 1), 0, 1);
      // before the first note: counting in, a nod on each beat of the bar before it
      const counting = t < this.first && t > this.first - B * this.perBar - 0.2 ? 0.7 : 0;
      const playing = t >= this.first - 0.1 && t <= this.lastNote() + 0.6 ? 1 : 0;
      const amp = (0.25 + 0.75 * level) * playing + counting;
      // a nod: down quickly onto the beat, up more slowly (each bar a little different)
      const barVar = 0.75 + 0.5 * hash01(bar + 1000, 81);
      const f = ph - Math.floor(ph);
      const shape = Math.exp(-(((f < 0.5 ? f : f - 1) / 0.13) ** 2)) - 0.3;
      nod[i] = amp * barVar * 0.07 * shape;
      P[i] += -amp * barVar * 0.018 * shape;
      // a slow sway, different every bar
      Y[i] += 0.025 * drift(t * 0.21 + bar * 0.37, 91) * (0.4 + 0.6 * level);
      Rr[i] += 0.012 * drift(t * 0.17, 92);
      hy[i] = 0.05 * drift(t * 0.13, 93);
      breath[i] = 0.014 * Math.sin((2 * Math.PI * t) / (4.1 + 0.6 * drift(t * 0.05, 94))) * (1 - 0.5 * level);
    }
    const nodB = blur(nod, 0.03);
    // the shoulders rise with effort (each side's strokes' heights, smoothed)
    const sR = blur(effR, 0.5);
    const sL = blur(effL, 0.5);
    for (let i = 0; i < n; i++) {
      sR[i] = clamp(sR[i] * 0.35, 0, 0.06);
      sL[i] = clamp(sL[i] * 0.35, 0, 0.06);
    }
    const mk = (a: Float32Array) => new Signal(0, RATE, a);
    this.sig = {
      yaw: mk(Y),
      pitch: mk(P),
      roll: mk(Rr),
      lx: mk(blur(lx, 0.08)),
      ly: mk(blur(ly, 0.08)),
      lz: mk(blur(lz, 0.08)),
      leadL: mk(blur(leadL, 0.1)),
      shrugR: mk(sR),
      shrugL: mk(sL),
      nod: mk(nodB),
      headYaw: mk(hy),
      breath: mk(breath),
    };
    // the feet's heels
    this.planFeet(n);
  }

  private lastNoteT = -1;
  private lastNote() {
    if (this.lastNoteT < 0) this.lastNoteT = this.perf.hits.length ? this.perf.hits[this.perf.hits.length - 1].t : 0;
    return this.lastNoteT;
  }

  /** the heels: the kick's heel up (the leg lifting before loud strokes) or down (soft feathering); the hi-hat's rocking or keeping time */
  private planFeet(n: number) {
    const kickHeel = new Float32Array(n).fill(1);
    const kicks = this.perf.hits.filter((h) => h.piece === 'kick');
    // heel down while the kick feathers softly (most kicks soft, nearby), heel up otherwise
    const soft = new Float32Array(n);
    const all = new Float32Array(n);
    for (const h of kicks) {
      const k = Math.round(h.t * RATE);
      if (k < 0 || k >= n) continue;
      all[k] += 1;
      if (h.velocity < 0.42) soft[k] += 1;
    }
    const sb = gaussianBlur(soft, 0.9 * RATE);
    const ab = gaussianBlur(all, 0.9 * RATE);
    for (let i = 0; i < n; i++) kickHeel[i] = ab[i] > 1e-3 ? 1 - 0.85 * smooth((sb[i] / ab[i] - 0.45) / 0.3) : 1;
    // the leg's drive: before a loud stroke the knee lifts the heel higher, and drives down into it
    for (const h of kicks) {
      if (h.velocity < 0.7) continue;
      const size = clamp((h.velocity - 0.7) / 0.3, 0, 1) * (0.25 + 0.15 * hash01(h.i, 101));
      const k0 = Math.round((h.t - 0.3) * RATE);
      for (let k = Math.max(0, k0); k < Math.min(n, k0 + Math.round(0.36 * RATE)); k++) {
        const tau = k / RATE - h.t;
        kickHeel[k] += size * Math.exp(-(((tau + 0.11) / 0.07) ** 2));
      }
    }
    // the hi-hat foot: rocking heel to toe with the pedal when it moves; otherwise, closed, a heel bounce keeping time
    const hhHeel = new Float32Array(n);
    const moveAct = new Float32Array(n);
    for (let i = 1; i < n; i++) moveAct[i] = Math.abs(pedalAt(this.perf.hihat, i / RATE) - pedalAt(this.perf.hihat, (i - 1) / RATE)) * RATE;
    const mv = gaussianBlur(moveAct, 0.35 * RATE);
    const B = this.beat;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const closed = pedalAt(this.perf.hihat, t);
      const rocking = smooth(mv[i] / 1.2);
      const ph = (t - this.origin) / B;
      const f = ph - Math.floor(ph);
      // the heel lands on the beat and lifts between
      const bounce = 0.5 - 0.5 * Math.cos(2 * Math.PI * f);
      const keep = t >= this.first - B * this.perBar && t <= this.lastNote() ? 1 : 0;
      const steady = closed > 0.9 ? 0.3 + keep * 0.42 * bounce : 0.12;
      hhHeel[i] = rocking * (0.12 + 0.8 * closed) + (1 - rocking) * steady;
    }
    this.sig.kickHeel = new Signal(0, RATE, gaussianBlur(kickHeel, 0.03 * RATE));
    this.sig.hhHeel = new Signal(0, RATE, gaussianBlur(hhHeel, 0.04 * RATE));
  }

  // ------------------------------------------------------------ warm starts
  /**
   * The arms' free choices (how each hand is turned about its stick, its elbow's swivel, the stick's line across
   * the surface) are planned at keys and interpolated between them. The keys are the strokes' contacts and the
   * tops of their preparations, and the middles of moves, solved in time order, each from the one before (a
   * continuation: an arm keeps the way it was holding its stick rather than jumping between equally good ways),
   * with a full search wherever that would leave a joint past its range. Between two keys the interpolation is
   * checked at the middle and, where it would bend a joint past its range or the choices change a lot, a key is
   * added there, down to 12 ms apart. Keys are solved lazily, in order, as frames need them (or ahead of time
   * with prepare()), so the same t always gives the same pose, however it was reached.
   */
  private planWarm() {
    const ts: number[] = [];
    for (const hand of ['R', 'L'] as Hand[])
      for (const s of this.hands[hand].strokes) {
        if (s.kind === 'ready') continue;
        ts.push(s.t, s.top);
        if (s.ta - s.tl > 0.1) ts.push(s.tl + 0.33 * (s.ta - s.tl), s.tl + 0.67 * (s.ta - s.tl));
      }
    ts.push(0, this.duration);
    ts.sort((a, b) => a - b);
    const keys: number[] = [];
    for (const t of ts) if (t >= 0 && t <= this.duration && (!keys.length || t - keys[keys.length - 1] > 0.012)) keys.push(t);
    this.baseT = Float64Array.from(keys);
    this.grow(keys.length * 2 + 16);
  }

  /** the keys to plan (base), how many are planned, and the planned keys (times and free choices, in time order) */
  private baseT = new Float64Array(0);
  private baseDone = 0;
  private nKeys = 0;
  private kPose = createPose();
  private kTargets = blankTargets();
  private kWarm: WarmStart = { R: new Float64Array(3), L: new Float64Array(3), steps: WARM_STEPS };
  private kFree = new Float64Array(6);
  private kCost = 0;

  private grow(cap: number) {
    if (cap <= this.keyT.length) return;
    const T = new Float64Array(cap);
    const F = new Float64Array(cap * 6);
    const C = new Float64Array(cap);
    T.set(this.keyT.subarray(0, this.nKeys));
    F.set(this.keyF.subarray(0, this.nKeys * 6));
    C.set(this.keyC.subarray(0, this.nKeys));
    this.keyT = T;
    this.keyF = F;
    this.keyC = C;
  }

  /** how far past their ranges the joints are (radians, summed) */
  private static excess(p: DrummerPose): number {
    let x = 0;
    let k = 0;
    for (const j of JOINTS)
      for (const d of j.dofs) {
        const v = p.angles[k++];
        if (v < d.limits[0]) x += d.limits[0] - v;
        else if (v > d.limits[1]) x += v - d.limits[1];
      }
    return x;
  }

  /** solve the arms at t from the free choices in `from` (6: R then L): writes kFree; returns the joints' excess */
  private solveKey(t: number, from: Float64Array | null): number {
    this.evaluate(t, this.kTargets);
    let ex = Infinity;
    if (from) {
      this.kWarm.R.set(from.subarray(0, 3));
      this.kWarm.L.set(from.subarray(3, 6));
      this.kWarm.steps = WARM_STEPS;
      this.kWarm.smooth = false;
      solveDrummer(this.kTargets, this.kPose, this.kWarm);
      ex = DrummerMotion.excess(this.kPose);
      this.kFree.set(this.kPose.free.R, 0);
      this.kFree.set(this.kPose.free.L, 3);
      this.kCost = this.kPose.cost.R + this.kPose.cost.L;
    }
    if (ex > 0.004 || this.kCost > KEY_COST) {
      // stuck past a joint's range, or into the kit or the other arm: search afresh, and keep that if it does better
      const c1 = from ? this.kCost : Infinity;
      solveDrummer(this.kTargets, this.kPose, null);
      const ex2 = DrummerMotion.excess(this.kPose);
      const c2 = this.kPose.cost.R + this.kPose.cost.L;
      if (ex2 < ex - 0.004 || (ex2 <= ex + 0.001 && c2 < c1 - 0.3) || !from) {
        ex = ex2;
        this.kFree.set(this.kPose.free.R, 0);
        this.kFree.set(this.kPose.free.L, 3);
        this.kCost = this.kPose.cost.R + this.kPose.cost.L;
      }
    }
    return ex;
  }

  private pushKey(t: number, F: Float64Array, cost: number) {
    this.grow(this.nKeys + 1 > this.keyT.length ? this.keyT.length * 2 : 0);
    this.keyT[this.nKeys] = t;
    this.keyF.set(F, this.nKeys * 6);
    this.keyC[this.nKeys] = cost;
    this.nKeys++;
  }
  /** each key's arms' cost */
  private keyC = new Float64Array(0);
  /** the keys' cost interpolated at the last warm start, and the keys either side */
  private warmCost = 0;
  private warmLo = 0;
  private warmHi = 0;
  private glitchBuf = new Float64Array(6);
  private fixBuf = new Float64Array(6);

  /** check the interpolation between the last key and (tb, Fb) at its middle, adding keys there as needed (depth-first, in time order) */
  private refine(tb: number, Fb: Float64Array, cb: number, depth: number) {
    const ia = this.nKeys - 1;
    const ta = this.keyT[ia];
    if (depth < 4 && tb - ta > 0.024) {
      const tm = 0.5 * (ta + tb);
      const Fa = this.keyF.subarray(ia * 6, ia * 6 + 6);
      let diff = 0;
      for (let k = 0; k < 6; k++) diff = Math.max(diff, Math.abs(Fb[k] - Fa[k]));
      // past a joint's range, the choices changing a lot, or much worse than both ends (into the kit or the other
      // arm), at a quarter, the half or three quarters of the way
      let bad = diff > 0.35;
      for (let q = 1; q <= 3 && !bad; q++) {
        const u = q === 1 ? 0.5 : q === 2 ? 0.25 : 0.75;
        for (let k = 0; k < 6; k++) this.kFree[k] = Fa[k] + (Fb[k] - Fa[k]) * u;
        this.evaluate(ta + (tb - ta) * u, this.kTargets);
        this.kWarm.R.set(this.kFree.subarray(0, 3));
        this.kWarm.L.set(this.kFree.subarray(3, 6));
        this.kWarm.steps = 0;
        solveDrummer(this.kTargets, this.kPose, this.kWarm);
        const cost = this.kPose.cost.R + this.kPose.cost.L;
        bad = DrummerMotion.excess(this.kPose) > 0.004 || cost > Math.max(this.keyC[ia], cb) + REFINE_COST;
      }
      if (bad) {
        this.solveKey(tm, Fa.slice());
        const Fm = this.kFree.slice();
        const cm = this.kCost;
        this.refine(tm, Fm, cm, depth + 1);
        this.pushKey(tm, Fm, cm);
        this.refine(tb, Fb, cb, depth + 1);
      }
    }
  }

  /** plan the keys in order up to the first base key at or after t */
  private planTo(t: number) {
    const B = this.baseT;
    while (this.baseDone < B.length && (this.nKeys === 0 || this.keyT[this.nKeys - 1] < t)) {
      const tb = B[this.baseDone++];
      if (this.nKeys === 0) {
        this.solveKey(tb, null);
        this.pushKey(tb, this.kFree, this.kCost);
        continue;
      }
      this.solveKey(tb, this.keyF.subarray((this.nKeys - 1) * 6, this.nKeys * 6).slice());
      const Fb = this.kFree.slice();
      const cb = this.kCost;
      this.refine(tb, Fb, cb, 0);
      this.pushKey(tb, Fb, cb);
    }
  }

  /** plan keys ahead for about `ms` milliseconds (for idle time); returns true when all are planned */
  prepare(ms = 8): boolean {
    const t0 = performance.now();
    while (this.baseDone < this.baseT.length && performance.now() - t0 < ms) this.planTo(this.baseT[this.baseDone]);
    return this.baseDone >= this.baseT.length;
  }

  /** plan every key now */
  solveKeys() {
    this.planTo(Infinity);
  }

  /** how many keys are planned (for tools) */
  get keyCount() {
    return this.nKeys;
  }

  /** the planned free choices at t (linear between keys), for solveDrummer */
  warm(t: number, steps = 0): WarmStart | null {
    if (!this.baseT.length) return null;
    this.planTo(t);
    const T = this.keyT;
    let lo = 0;
    let hi = this.nKeys - 1;
    if (t <= T[0]) hi = 0;
    else if (t >= T[hi]) lo = hi;
    else
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (T[mid] <= t) lo = mid;
        else hi = mid;
      }
    const u = hi > lo ? (t - T[lo]) / (T[hi] - T[lo]) : 0;
    const F = this.keyF;
    const o = this.warmBuf;
    for (let k = 0; k < 3; k++) {
      o.R[k] = F[lo * 6 + k] + (F[hi * 6 + k] - F[lo * 6 + k]) * u;
      o.L[k] = F[lo * 6 + 3 + k] + (F[hi * 6 + 3 + k] - F[lo * 6 + 3 + k]) * u;
    }
    o.steps = steps;
    o.smooth = true;
    this.warmCost = this.keyC[lo] + (this.keyC[hi] - this.keyC[lo]) * u;
    this.warmLo = lo;
    this.warmHi = hi;
    return o;
  }

  // ------------------------------------------------------------ evaluation
  /** the targets at t, into `out` (nothing allocated) */
  evaluate(t: number, out: DrummerTargets): DrummerTargets {
    this.hands.R.evaluate(t, out.R);
    this.hands.L.evaluate(t, out.L);
    const S = this.sig;
    // (the body and the look are written into the targets' own objects: a key planned while a frame is being
    // evaluated has targets of its own)
    const b = (out.body ??= { yaw: 0, pitch: 0, roll: 0, shrugR: 0, shrugL: 0, nod: 0, headYaw: 0, breath: 0 });
    b.yaw = S.yaw.at(t);
    b.pitch = S.pitch.at(t);
    b.roll = S.roll.at(t);
    b.shrugR = S.shrugR.at(t);
    b.shrugL = S.shrugL.at(t);
    b.nod = S.nod.at(t);
    b.headYaw = S.headYaw.at(t);
    b.breath = S.breath.at(t);
    const l = (out.look ??= [0, 0, 0]);
    l[0] = S.lx.at(t);
    l[1] = S.ly.at(t);
    l[2] = S.lz.at(t);
    const ll = S.leadL.at(t);
    out.leadL = ll;
    out.lead = ll > 0.5 ? 'L' : 'R';
    // the feet: the kick's footboard is the beater's (KitMotion), the hi-hat's the pedal curve
    const fr = out.feet.R;
    fr.pedal = 'kickPedal';
    fr.press = this.kit.beater(t);
    fr.heelLift = S.kickHeel.at(t);
    fr.heel = fr.heelLift > 0.5 ? 'up' : 'down';
    const fl = out.feet.L;
    fl.pedal = 'hihatPedal';
    fl.press = this.kit.hihatClosed(t);
    fl.heelLift = S.hhHeel.at(t);
    fl.heel = fl.heelLift > 0.5 ? 'up' : 'down';
    return out;
  }

  /** the drummer's pose at t: the targets, the planned warm start, the IK (nothing allocated) */
  pose(t: number, targets: DrummerTargets, pose: DrummerPose, steps = 0): DrummerPose {
    const w = this.warm(t, steps);
    this.evaluate(t, targets);
    solveDrummer(targets, pose, w);
    // where the interpolated arms cost much more than the keys around them (into the kit or the other arm, or a
    // joint near its stop between two keys), refine this frame from there with a couple of Newton steps
    const over = w ? pose.cost.R + pose.cost.L - this.warmCost - FIX_COST : 0;
    if (w && over > 0) {
      // the refined choices, eased in as the excess grows (so a frame never jumps to them)
      const f = this.fixBuf;
      f.set(w.R, 0);
      f.set(w.L, 3);
      w.steps = 2;
      w.smooth = false;
      solveDrummer(targets, pose, w);
      const k = smooth(over / FIX_RANGE);
      for (let i = 0; i < 3; i++) {
        w.R[i] = f[i] + (pose.free.R[i] - f[i]) * k;
        w.L[i] = f[3 + i] + (pose.free.L[i] - f[3 + i]) * k;
      }
      w.steps = 0;
      w.smooth = true;
      solveDrummer(targets, pose, w);
      // still far worse (between two keys that hold an arm in quite different ways, the way between them can pass a
      // joint's stop): hold the arms as the nearer of the two keys does instead, for this frame
      if (pose.cost.R + pose.cost.L > GLITCH_COST) {
        const F = this.keyF;
        const g = this.glitchBuf;
        let best = Infinity;
        for (let q = 0; q < 2; q++) {
          const k = q ? this.warmHi : this.warmLo;
          w.R.set(F.subarray(k * 6, k * 6 + 3));
          w.L.set(F.subarray(k * 6 + 3, k * 6 + 6));
          solveDrummer(targets, pose, w);
          const c = pose.cost.R + pose.cost.L;
          if (c < best) {
            best = c;
            g.set(w.R, 0);
            g.set(w.L, 3);
          }
        }
        w.R.set(g.subarray(0, 3));
        w.L.set(g.subarray(3, 6));
        solveDrummer(targets, pose, w);
      }
    }
    return pose;
  }
}

/** the edge of a cymbal nearest the drummer (where a hand grabs it to choke it) */
function edgeNear(piece: DrumId): V3 {
  return strikePoint(DRUMS[piece], 0.98, 0);
}

/** how far the stick is lifted clear when moving between two strokes' instruments (m) */
function clearLift(a: Stroke, b: Stroke): number {
  const cym = (s: Stroke) => s.piece === 'crash' || s.piece === 'ride' || s.piece === 'hihat';
  let c = 0.05;
  if (cym(a) || cym(b)) c = 0.09;
  // off the hi-hat (or onto it): up off its top cymbal and clear of its edge before crossing toward the drums
  if (a.piece === 'hihat' || b.piece === 'hihat') c = 0.14;
  if (a.piece === 'crash' || b.piece === 'crash' || a.piece === 'ride' || b.piece === 'ride') c = 0.14;
  // from under the ride (the floor tom) up to it, or across under the crash
  if ((a.piece === 'floorTom' && b.piece === 'ride') || (b.piece === 'floorTom' && a.piece === 'ride')) c = 0.2;
  if ((a.piece === 'tom1' && b.piece === 'crash') || (b.piece === 'tom1' && a.piece === 'crash')) c = 0.18;
  return c;
}

export function blankStick(): StickTarget {
  return { point: [0, 0, 0], normal: [0, 1, 0], angle: 0.25, contactFromTip: STICK_BEAD, lift: 0, palmRoll: 0.5, sweep: 0, arm: 0, fingers: 0.3 };
}

export function blankTargets(): DrummerTargets {
  return {
    R: blankStick(),
    L: blankStick(),
    lead: 'R',
    leadL: 0,
    feet: { R: { pedal: 'kickPedal', heel: 'up', heelLift: 1, press: 0 }, L: { pedal: 'hihatPedal', heel: 'down', heelLift: 0, press: 1 } },
    look: [0, 0, 0],
    body: { yaw: 0, pitch: 0, roll: 0, shrugR: 0, shrugL: 0, nod: 0, headYaw: 0, breath: 0 },
  };
}
