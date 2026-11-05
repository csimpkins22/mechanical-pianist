// Which limb plays each hit of a drum performance: the sticking of a
// right-handed kit drummer.
//
// The feet are fixed: the right foot plays the kick, the left foot the hi-hat
// pedal (its notes and the pedal curve). The hands are chosen by a beam search
// over the hand hits in time order (and the chokes, where a hand grabs a
// cymbal), as Fingering.ts does for the piano's fingers. A state remembers
// where each hand last struck, when, and whether that stroke was fresh or off
// the rebound; which hand has been keeping time on the hi-hat and on the
// ride; and which hand played the previous hand note. Every hit may be
// played by either hand or dropped; dropping costs more than anything a hand
// can do, so a hit is dropped only when no hand can get there.
//
// Hard limits (a stroke that breaks one is impossible, not just expensive):
// a hand cannot be in two places at once; moving between instruments takes
// time (accelerating and stopping the arm, a top speed, and a stroke's
// preparation); one hand repeats single strokes at most 20 a second; a
// rebound (a double's second stroke, a buzz's further bounces) comes at
// least 18 ms after the stroke before it; a flam's two notes are one hand
// each.
//
// Everything else is a named cost (COSTS below), each with its reason, and
// each counted in the stats so a sticking can be explained.
//
// Positions are KitLayout's strike points (with each hit's own r and angle),
// read when the function runs, so the costs follow the kit when it moves.
import { DRUMS, PEDALS, strikePoint, type DrumId, type V3 } from './KitLayout';
import type { DrumHit, DrumPerformance, Zone } from './DrumScore';

export type Hand = 'R' | 'L';
export type Limb = Hand | 'RF' | 'LF';
/** how big a stroke is: it sets how high the stick is raised before it */
export type Level = 'ghost' | 'tap' | 'accent';

export interface LimbHit {
  /** the DrumHit's index (DrumHit.i); hits[k].hit === k */
  hit: number;
  limb: Limb;
  /** copied from the hit */
  t: number;
  piece: DrumId;
  zone: Zone;
  /** false when no limb could play it (it is listed in `dropped`); `limb` is then the hand that usually would */
  played: boolean;
  /** where the stick's tip lands (for a pedal: the ball of the foot on the footboard), KitLayout's frame, metres */
  at: V3;
  /** ghost, tap or accent (relative to how loud this performance plays that piece) */
  level: Level;
  /** the previous and next hits (indices into hits[]) played by the same limb, -1 when none */
  prev: number;
  next: number;
  /** played off the rebound of the same hand's stroke before (a double's second stroke, a buzz's further bounce):
   *  the fingers and wrist only, no fresh preparation */
  double: boolean;
  /** a flam's grace note: played low, just ahead of the main note by the other hand */
  grace: boolean;
  /** when the arms are crossed at this hit, the arm on top (R over L in the hi-hat groove); null when uncrossed */
  over: Hand | null;
}

export interface LimbStats {
  /** hits this limb plays */
  hits: number;
  /** the most strokes in any half second, per second */
  maxRate: number;
  /** the shortest time between two of its strokes (s); Infinity with fewer than two */
  minInterval: number;
  /** the fastest move between instruments: distance between strike points over the time between them (m/s) */
  maxTravelSpeed: number;
}

export interface StickingStats {
  limbs: Record<Limb, LimbStats>;
  /** hand hits played with the arms crossed at the same height (they would collide): what a sticking should avoid */
  crossings: number;
  /** hand hits played in the standard crossed position (right hand on the hi-hat or crash over the left on the snare) */
  hatCrosses: number;
  /** hand hits played with one arm crossed well above the other otherwise (the right on the crash over the left still on the floor tom) */
  overCrosses: number;
  /** strokes off the rebound: doubles' second strokes and buzz bounces */
  doubles: number;
  /** flams (a grace note and its main note on one drum, one hand each) */
  flams: number;
  dropped: number;
  /** kick notes closer to the previous kick than a single pedal comfortably repeats (about 13 a second): flagged, still played */
  fastKicks: number;
  /** moves between instruments with less time than a comfortable move needs */
  rushed: number;
  /** times the hand keeping time on the hi-hat or ride changed, other than by fast alternation between the hands */
  keeperSwaps: number;
  /** hi-hat or ride strokes played by the left hand */
  leftHandTime: number;
  /** chokes no hand was free for */
  chokesMissed: number;
  /** each named cost term: how often it applied and its total over the performance */
  costs: Record<CostTerm, { n: number; total: number }>;
  /** the search's total cost */
  cost: number;
}

export interface Sticking {
  /** one per DrumHit, in the same order */
  hits: LimbHit[];
  /** hits no limb could play, and why */
  dropped: { hit: number; why: string }[];
  /** a hand grabbing a cymbal to stop it ringing (chokes no hand was free for are left out and counted in the stats) */
  chokes: { t: number; piece: DrumId; hand: Hand }[];
  /** what each hand is home on over time (the time-keeping hand on the hi-hat or ride, the other on the snare), for posture; each entry holds until the next */
  home: { t: number; R: DrumId; L: DrumId }[];
  stats: StickingStats;
}

// ---------------------------------------------------------------------------
// Physical limits

/** a hand keeps up this many strokes a second indefinitely, with no strain */
const RATE_RELAX = 6;
/** ...and this many comfortably (single strokes, wrist and fingers); beyond it the strain climbs fast */
const RATE_COMF = 9;
/** the shortest interval one hand repeats single strokes at, briefly (20 a second) */
const SINGLE_MIN = 0.05;
/** the shortest interval between a stroke and a bounce off its rebound */
const REBOUND_MIN = 0.018;
/** a second stroke this soon after a fresh one can be played off its rebound (a double); slower, it is just another single */
const DOUBLE_MAX = 0.12;
/** bounces closer than this are a buzz (a press roll): the stick bounces freely, a few times per press */
const BUZZ_MAX = 0.06;
const BUZZ_BOUNCES = 5;
const BUZZ_SPAN = 0.3;
/** a stroke's preparation (the stick up and back down), comfortable and the least possible */
const PREP = 0.06;
const PREP_MIN = 0.03;
/**
 * Moving the stick's tip between instruments: the arm accelerates and stops
 * (time grows with the square root of the distance) up to a top speed, then
 * prepares the stroke. A comfortable move, and the fastest possible one:
 * between neighbouring drums (30 cm) about 0.18 s and 0.12 s; from the floor
 * tom to the crash (1.2 m) about 0.36 s and 0.23 s.
 */
const ACC_COMF = 90;
const V_COMF = 4;
const ACC_MAX = 150;
const V_MAX = 6;
const moveTime = (d: number) => PREP + Math.max(2 * Math.sqrt(d / ACC_COMF), d / V_COMF);
const moveTimeMin = (d: number) => PREP_MIN + Math.max(2 * Math.sqrt(d / ACC_MAX), d / V_MAX);
/** the tips farther apart than this across the kit, left hand to the right of the right hand, are crossed arms */
const CROSS_MARGIN = 0.08;
/** a choke: the hand holds the cymbal's edge this long */
const CHOKE_HOLD = 0.08;
/** a flam: a grace note on the same drum this soon before the main note, the pair clear of other notes on that drum */
const FLAM_MIN = 0.008;
const FLAM_MAX = 0.045;
const FLAM_CLEAR = 0.05;
/** a single kick pedal comfortably repeats about 13 notes a second (heel-toe and slides go faster, briefly) */
const KICK_MIN_INTERVAL = 1 / 13;

/** the named cost terms */
export type CostTerm =
  | 'travel'
  | 'rush'
  | 'effort'
  | 'double'
  | 'buzz'
  | 'role'
  | 'cross'
  | 'keeperSwap'
  | 'lead'
  | 'alternate'
  | 'flamLead'
  | 'drop'
  | 'chokeHand'
  | 'chokeMiss';
export const COST_TERMS: CostTerm[] = ['travel', 'rush', 'effort', 'double', 'buzz', 'role', 'cross', 'keeperSwap', 'lead', 'alternate', 'flamLead', 'drop', 'chokeHand', 'chokeMiss'];

export const COSTS = {
  /** per metre the stick's tip travels between instruments: moving the arm is work, and a hand that stays put plays more evenly */
  travel: 0.8,
  /** at most, for a move with less time than a comfortable one needs; it grows with the square of how far toward the
   *  fastest possible move it is squeezed: a hurried move lands late or loose */
  rush: 6,
  /** per stroke, at RATE_COMF strokes a second; grows with the square of the rate above RATE_RELAX, and with the
   *  stroke's loudness (a loud stroke needs a higher stick): one hand at speed tires and loses evenness, so a drummer
   *  shares fast notes between the hands */
  effort: 1,
  /** per double's second stroke: a rebound is weaker and harder to keep even than a fresh single, so doubles come in
   *  only where singles would be faster than a hand comfortably goes (above about 16 notes a second, shared) */
  double: 1,
  /** per unit a rebound is louder than the stroke it bounces off: a rebound gives back at most the stroke's energy,
   *  so a loud note straight after a soft one needs a fresh stroke (or the other hand) */
  reboundAccent: 4,
  /** per further bounce of a buzz (a press roll's stroke bounces freely three or four times), plus buzzVelocity × its
   *  velocity squared: a buzz is soft by nature, and a loud note cannot come from a free bounce */
  buzz: 0.3,
  buzzVelocity: 4,
  /** playing a piece with the hand that does not usually play it, per unit of ROLE (below) */
  role: 1,
  /** per 30 cm the left hand's tip is right of the right hand's: arms crossed. The standard right-over-left hi-hat
   *  position costs nothing; one arm well above the other (a cymbal over a drum) a fifth; level arms, which would
   *  collide, the full cost. Less as the other hand has been idle long enough to move out of the way */
  cross: 2,
  /** the hand keeping time on the hi-hat or ride changes, other than by fast alternation: a groove's time-keeping
   *  hand stays put, or the sticking reads as random and the groove's feel changes */
  keeperSwap: 0.8,
  /** the left hand on a beat while the right is free, where the right leads: a fill's beats, time-keeping strokes,
   *  a crash; half again on a bar's downbeat, half on a time-keeping "and". Fills lead with the right hand on the
   *  strong beats, two-handed time keeps the right on the beats and "ands", and a right-handed drummer's right plays
   *  the accents it can reach */
  lead: 0.5,
  /** in a fill, the same hand twice running: fills are single strokes, hand to hand */
  alternate: 0.8,
  /** a flam's main note by the left hand (the grace note by the right): the right-handed flam is the default */
  flamLead: 0.3,
  /** dropping a hit: more than any playable stroke costs, more for a louder note (ghosts go before accents) */
  drop: 25,
  dropVelocity: 50,
  /** a choke by the hand that does not usually take that cymbal (the left grabs the crash, the right the ride) */
  chokeHand: 0.4,
  /** a choke no hand was free for */
  chokeMiss: 15,
};

/**
 * ROLE: what playing a piece with the other hand costs (× COSTS.role). A
 * right-handed drummer's right hand keeps time on the hi-hat and ride and
 * plays the floor tom (all to the right of the left hand, or crossed over it);
 * the left plays the snare's backbeat, ghost notes and cross-stick; the toms
 * in the middle are either hand's. Which hand is usual comes from KitLayout's
 * `usual` (an 'either' piece leans right); this says what the other costs.
 */
const ROLE: Record<DrumId, number> = {
  kick: 0,
  // the left on the hi-hat: possible (and uncrossed), but the right keeps time there unless the hats are too fast for
  // it (sharing the hats with the right, two-handed, costs HATS_SHARED instead)
  hihat: 0.8,
  // the left reaching the ride, beyond the floor tom
  ride: 1.5,
  // the left reaching across the body (in a fill both hands play it, the right nearer)
  floorTom: 0.2,
  // either hand plays the snare; in a groove it is the left's
  snare: 0.15,
  tom1: 0,
  tom2: 0,
  // the right crashes when it is free; the left when the right is keeping time
  crash: 0.25,
};
/** the cross-stick lays the left stick across the snare: a left-hand technique for a right-handed player */
const ROLE_CROSS_STICK = 2;
/**
 * The left hand's share of two-handed hats (the right struck the hi-hat
 * within HATS_SHARED_WINDOW, two sixteenths at 100 bpm): less than keeping
 * time alone, but enough that one hand keeps sixteenths up to about 110 bpm,
 * as players do.
 */
const HATS_SHARED = 0.5;
const HATS_SHARED_WINDOW = 0.33;

function roleCost(piece: DrumId, zone: Zone, hand: Hand): number {
  if (piece === 'snare' && zone === 'crossStick') return hand === 'R' ? ROLE_CROSS_STICK : 0;
  const usualHand: Hand = DRUMS[piece].usual === 'L' ? 'L' : 'R';
  return hand === usualHand ? 0 : ROLE[piece];
}

const HAND_PIECES = new Set<DrumId>(['snare', 'hihat', 'tom1', 'tom2', 'floorTom', 'crash', 'ride']);

/** the limb a hit belongs to when the feet play it, or null for a hand hit */
export function footFor(h: DrumHit): Limb | null {
  if (h.piece === 'kick') return 'RF';
  if (h.piece === 'hihat' && h.zone === 'pedal') return 'LF';
  return HAND_PIECES.has(h.piece) ? null : 'RF';
}

/** a time-keeping stroke: the hi-hat (with a stick) or the ride */
export const isKeeper = (piece: DrumId, zone: Zone) => (piece === 'hihat' && zone !== 'pedal') || piece === 'ride';

/** where a hit lands: its strike point, or the ball of the foot on its pedal */
export function hitPoint(h: DrumHit): V3 {
  if (h.piece === 'kick') return PEDALS.kickPedal.ball.slice() as V3;
  if (h.piece === 'hihat' && h.zone === 'pedal') return PEDALS.hihatPedal.ball.slice() as V3;
  return strikePoint(DRUMS[h.piece], h.r, h.angle);
}

const dist = (a: V3, b: V3) => {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** stroke levels relative to how loud this performance plays each piece (its 90th percentile) */
export function strokeLevels(hits: DrumHit[]): Level[] {
  const ref = new Map<DrumId, number>();
  const by = new Map<DrumId, number[]>();
  for (const h of hits) {
    if (!by.has(h.piece)) by.set(h.piece, []);
    by.get(h.piece)!.push(h.velocity);
  }
  for (const [p, v] of by) {
    v.sort((a, b) => a - b);
    ref.set(p, Math.max(0.5, v[Math.min(v.length - 1, Math.floor(v.length * 0.9))]));
  }
  return hits.map((h) => {
    const r = ref.get(h.piece)!;
    return h.velocity < 0.55 * r ? 'ghost' : h.velocity >= 0.85 * r ? 'accent' : 'tap';
  });
}

/** where the beats are: the beat's length, the first bar line, and beats per bar */
export function beatGrid(perf: DrumPerformance) {
  const beat = 60 / (perf.bpm > 0 ? perf.bpm : 120);
  const origin = perf.bars.length ? perf.bars[0] : 0;
  const perBar = perf.bars.length > 1 ? Math.max(1, Math.round((perf.bars[1] - perf.bars[0]) / beat)) : 4;
  return { beat, origin, perBar };
}

/**
 * Flams: two hand hits on one drum 8-45 ms apart, the first no louder than
 * the second, clear of other notes on it (closer notes on both sides, or a
 * fading pair, are a roll or a buzz, not a flam).
 * Returns the grace note's index for each main note's index.
 */
export function findFlams(hits: DrumHit[]): Map<number, number> {
  const byPiece = new Map<DrumId, DrumHit[]>();
  for (const h of hits) {
    if (footFor(h)) continue;
    if (!byPiece.has(h.piece)) byPiece.set(h.piece, []);
    byPiece.get(h.piece)!.push(h);
  }
  const graceOf = new Map<number, number>();
  for (const list of byPiece.values())
    for (let j = 1; j < list.length; j++) {
      const g = list[j - 1];
      const m = list[j];
      const dt = m.t - g.t;
      if (dt < FLAM_MIN || dt > FLAM_MAX || g.velocity > m.velocity + 0.05) continue;
      if (j >= 2 && g.t - list[j - 2].t < FLAM_CLEAR) continue;
      if (j + 1 < list.length && list[j + 1].t - m.t < FLAM_CLEAR) continue;
      if (graceOf.has(g.i)) continue;
      graceOf.set(m.i, g.i);
    }
  return graceOf;
}

// ---------------------------------------------------------------------------
// The search

interface Ev {
  /** a hit's index, or -1 - choke index for a choke */
  k: number;
  choke: boolean;
  t: number;
  piece: DrumId;
  zone: Zone;
  at: V3;
  vel: number;
  keeper: boolean;
  /** between time-keeping strokes (one within three quarters of a beat each side): in a groove, not a fill */
  inGroove: boolean;
  onBeat: boolean;
  /** on an eighth-note "and" */
  onAnd: boolean;
  /** another hand note within 30 ms */
  together: boolean;
  downbeat: boolean;
  /** a flam's grace note; or, for a main note, its grace note's event index (-1 when none) */
  grace: boolean;
  graceEv: number;
}

interface HandState {
  /** the event of its last stroke, -1 when none yet */
  e: number;
  /** when it was last at an instrument: its last stroke, or the end of a choke's hold */
  t: number;
  at: V3;
  piece: DrumId | null;
  /** the interval before its last fresh stroke */
  gap: number;
  /** strokes off the rebound since its last fresh stroke, and that fresh stroke's time */
  bounces: number;
  pressT: number;
  /** its last stroke's velocity */
  vel: number;
}

const NO_HAND: HandState = { e: -1, t: -1e9, at: [0, 0, 0], piece: null, gap: Infinity, bounces: 0, pressT: -1e9, vel: 0 };

interface State {
  R: HandState;
  L: HandState;
  /** who kept time last on the hi-hat and on the ride, and when */
  keepHH: Hand | null;
  keepHHt: number;
  keepRide: Hand | null;
  keepRideT: number;
  /** the hand of the previous hand stroke and its time */
  lastHand: Hand | null;
  lastT: number;
  /** when the right hand last struck the hi-hat */
  rHatT: number;
  cost: number;
  /** the cost plus what the next few events will have to drop from here (for ranking the beam only) */
  rank: number;
  parent: State | null;
  /** 0 = right hand, 1 = left hand, 2 = dropped (or a choke no hand takes) */
  choice: 0 | 1 | 2;
}

/** what a transition did, for the stats (only filled when replaying the chosen path) */
interface Info {
  terms: Partial<Record<CostTerm, number>>;
  rebound: boolean;
  rushed: boolean;
  over: Hand | null;
  crossing: 'none' | 'standard' | 'over' | 'crossed';
  keeperSwap: boolean;
}

const newInfo = (): Info => ({ terms: {}, rebound: false, rushed: false, over: null, crossing: 'none', keeperSwap: false });

function add(info: Info | null, term: CostTerm, v: number) {
  if (info && v > 0) info.terms[term] = (info.terms[term] ?? 0) + v;
}

/** EFFORT: the strain of a fresh stroke `dt` after the hand's previous one (on any instrument) */
function effort(dt: number, vel: number): number {
  const over = 1 / dt - RATE_RELAX;
  if (over <= 0) return 0;
  return (COSTS.effort * (0.6 + 0.8 * vel) * over * over) / ((RATE_COMF - RATE_RELAX) * (RATE_COMF - RATE_RELAX));
}

/**
 * Whether a hand's next stroke on the same instrument at `t` can come off the
 * rebound: 1 a double (after a fresh stroke that was not itself part of a fast
 * run), 2 a buzz's further bounce, 0 neither.
 */
function reboundKind(me: HandState, t: number): 0 | 1 | 2 {
  const dt = t - me.t;
  if (dt < REBOUND_MIN) return 0;
  if (me.bounces === 0) return dt < DOUBLE_MAX && me.gap >= 1.6 * dt ? 1 : 0;
  return dt < BUZZ_MAX && me.bounces < BUZZ_BOUNCES && t - me.pressT < BUZZ_SPAN ? 2 : 0;
}

/** whether hand `h` can physically play `ev` from `st` at all (the hard limits only) */
function canPlay(st: State, ev: Ev, h: Hand): boolean {
  const me = h === 'R' ? st.R : st.L;
  if (ev.graceEv >= 0 && me.e === ev.graceEv) return false;
  if (me.piece === null) return true;
  const dt = ev.t - me.t;
  if (me.piece === ev.piece && !ev.choke) return dt >= SINGLE_MIN || reboundKind(me, ev.t) > 0;
  return dt >= moveTimeMin(dist(me.at, ev.at)) && (ev.choke || dt >= SINGLE_MIN);
}

/** set by strokeCost: whether the stroke it just costed is played off the rebound */
let strokeRebound = false;

/** the cost of hand `h` playing event `ev` from state `st` (Infinity when impossible) */
function strokeCost(st: State, ev: Ev, h: Hand, info: Info | null): number {
  strokeRebound = false;
  const me = h === 'R' ? st.R : st.L;
  const ot = h === 'R' ? st.L : st.R;
  const t = ev.t;
  let c = 0;

  // ---- a flam's two notes are one hand each
  if (ev.graceEv >= 0 && me.e === ev.graceEv) return Infinity;

  // ---- the hand's own motion: a fresh stroke, a rebound, or a move
  if (me.piece !== null) {
    const dt = t - me.t;
    if (me.piece === ev.piece && !ev.choke) {
      const single = dt >= SINGLE_MIN ? effort(dt, ev.vel) : Infinity;
      // off the rebound: a double (a fresh stroke, not itself part of a fast run, and its bounce), or a buzz's further bounces
      const kind = reboundKind(me, t);
      const louder = COSTS.reboundAccent * Math.max(0, ev.vel - me.vel - 0.2);
      const rebound = kind === 1 ? COSTS.double + louder : kind === 2 ? COSTS.buzz + COSTS.buzzVelocity * ev.vel * ev.vel + louder : Infinity;
      if (!isFinite(single) && !isFinite(rebound)) return Infinity;
      if (rebound < single) {
        c += rebound;
        add(info, me.bounces === 0 ? 'double' : 'buzz', rebound);
        strokeRebound = true;
        if (info) info.rebound = true;
      } else {
        c += single;
        add(info, 'effort', single);
      }
    } else {
      // a move: the arm accelerates, travels and stops, and the stroke is prepared
      const d = dist(me.at, ev.at);
      if (dt < moveTimeMin(d) || (!ev.choke && dt < SINGLE_MIN)) return Infinity;
      const need = moveTime(d);
      if (dt < need) {
        const u = (need - dt) / (need - moveTimeMin(d));
        const r = COSTS.rush * u * u;
        c += r;
        add(info, 'rush', r);
        if (info) info.rushed = true;
      }
      const tr = COSTS.travel * d;
      c += tr;
      add(info, 'travel', tr);
      if (!ev.choke) {
        const e = effort(dt, ev.vel);
        c += e;
        add(info, 'effort', e);
      }
    }
  }

  // ---- which hand usually plays it
  if (ev.choke) {
    if (h !== (ev.piece === 'ride' ? 'R' : 'L')) {
      c += COSTS.chokeHand;
      add(info, 'chokeHand', COSTS.chokeHand);
    }
  } else {
    const shared = h === 'L' && ev.keeper && ev.piece === 'hihat' && t - st.rHatT < HATS_SHARED_WINDOW;
    const r = COSTS.role * (shared ? HATS_SHARED : roleCost(ev.piece, ev.zone, h));
    c += r;
    add(info, 'role', r);
  }

  // ---- the arms: the left hand's tip to the right of the right hand's
  // (both sticks on one drum is two hands sharing it, not crossed arms)
  if (ot.piece !== null && ot.piece !== ev.piece) {
    // a hand idle a while has lifted out of the way
    const w = clamp01(1 - (t - ot.t - 0.05) / 0.3);
    if (w > 0) {
      const xR = h === 'R' ? ev.at[0] : ot.at[0];
      const xL = h === 'L' ? ev.at[0] : ot.at[0];
      const X = xL - xR;
      if (X > CROSS_MARGIN) {
        const pR = h === 'R' ? ev.piece : ot.piece;
        const pL = h === 'L' ? ev.piece : ot.piece;
        // the standard cross: the right hand up on the hi-hat (or the crash beside it) over the left on the snare
        const standard = (pR === 'hihat' || pR === 'crash') && pL === 'snare';
        const yR = h === 'R' ? ev.at[1] : ot.at[1];
        const yL = h === 'L' ? ev.at[1] : ot.at[1];
        // one arm well above the other passes over it; level arms collide
        const level = 1 - 0.8 * clamp01((Math.abs(yR - yL) - 0.05) / 0.15);
        // (the standard cross holds while the left rests on the snare; others count while the other hand is still mostly there)
        if (info && (standard || w >= 0.5)) {
          info.over = yR >= yL ? 'R' : 'L';
          info.crossing = standard ? 'standard' : level < 0.5 ? 'over' : 'crossed';
        }
        if (!standard) {
          const x = COSTS.cross * w * level * ((X - CROSS_MARGIN) / 0.3);
          c += x;
          add(info, 'cross', x);
        }
      }
    }
  }

  if (ev.choke) return c;

  // ---- time-keeping continuity
  if (ev.keeper) {
    const prev = ev.piece === 'hihat' ? st.keepHH : st.keepRide;
    const prevT = ev.piece === 'hihat' ? st.keepHHt : st.keepRideT;
    // (fast alternation between the hands is two-handed time, not a change of hand)
    if (prev && prev !== h && t - prevT > 0.2) {
      c += COSTS.keeperSwap;
      add(info, 'keeperSwap', COSTS.keeperSwap);
      if (info) info.keeperSwap = true;
    }
  }

  // ---- the right hand leads: the beats of a fill, time-keeping beats and crashes, when it is free
  // (with another hand note at the same moment, the right may well be busy with it)
  if (h === 'L' && !ev.grace && !ev.together) {
    const l = ev.onBeat && (!ev.inGroove || ev.keeper || ev.piece === 'crash') ? COSTS.lead * (ev.downbeat ? 1.5 : 1) : ev.onAnd && ev.keeper ? COSTS.lead * 0.8 : 0;
    c += l;
    add(info, 'lead', l);
  }
  // ---- fills go hand to hand (a rebound is the same hand by design; hands playing together, in unison, take turns with
  // neither: a floor tom and snare figure in both hands at once is not a repeated hand; and the time-keeping hand
  // leaving the hi-hat or ride to lead a fill is the fill's start, not a repeat)
  const fromTime = me.piece === 'hihat' || me.piece === 'ride';
  if (!ev.inGroove && st.lastHand === h && t - st.lastT < 0.4 && !strokeRebound && !ev.together && !fromTime && Math.abs(ot.t - st.lastT) >= 0.03) {
    c += COSTS.alternate;
    add(info, 'alternate', COSTS.alternate);
  }
  // ---- a flam's main note: the right hand's, by default
  if (h === 'L' && ev.graceEv >= 0) {
    c += COSTS.flamLead;
    add(info, 'flamLead', COSTS.flamLead);
  }
  return c;
}

function nextState(st: State, ev: Ev, e: number, h: Hand, cost: number, rebound: boolean): State {
  const me = h === 'R' ? st.R : st.L;
  const hs: HandState = ev.choke
    ? { e, t: ev.t + CHOKE_HOLD, at: ev.at, piece: ev.piece, gap: Infinity, bounces: 0, pressT: -1e9, vel: 0 }
    : rebound
      ? { e, t: ev.t, at: ev.at, piece: ev.piece, gap: me.gap, bounces: me.bounces + 1, pressT: me.pressT, vel: ev.vel }
      : { e, t: ev.t, at: ev.at, piece: ev.piece, gap: me.piece === null ? Infinity : ev.t - me.t, bounces: 0, pressT: ev.t, vel: ev.vel };
  const s: State = {
    R: h === 'R' ? hs : st.R,
    L: h === 'L' ? hs : st.L,
    keepHH: st.keepHH,
    keepHHt: st.keepHHt,
    keepRide: st.keepRide,
    keepRideT: st.keepRideT,
    lastHand: ev.choke ? st.lastHand : h,
    lastT: ev.choke ? st.lastT : ev.t,
    rHatT: h === 'R' && ev.keeper && ev.piece === 'hihat' ? ev.t : st.rHatT,
    cost: st.cost + cost,
    rank: 0,
    parent: st,
    choice: h === 'R' ? 0 : 1,
  };
  if (ev.keeper) {
    if (ev.piece === 'hihat') {
      s.keepHH = h;
      s.keepHHt = ev.t;
    } else {
      s.keepRide = h;
      s.keepRideT = ev.t;
    }
  }
  return s;
}

const BEAM = 20;
/** how far ahead the beam looks for notes a state has already made impossible */
const LOOKAHEAD = 0.12;

const dropCost = (ev: Ev) => (ev.choke ? COSTS.chokeMiss : COSTS.drop + COSTS.dropVelocity * ev.vel);

/**
 * A state that leaves no hand able to reach a note coming within LOOKAHEAD
 * will have to drop it: its rank counts that already, so the beam keeps the
 * states that drop the least important note rather than the next one.
 */
function lookahead(s: State, events: Ev[], e: number): number {
  let extra = 0;
  const t = events[e].t;
  for (let j = e + 1; j < events.length && j <= e + 3 && events[j].t - t < LOOKAHEAD; j++) {
    const ev = events[j];
    if (!canPlay(s, ev, 'R') && !canPlay(s, ev, 'L')) extra += dropCost(ev);
  }
  return extra;
}
const handCode = (h: Hand | null) => (h === null ? 0 : h === 'R' ? 1 : 2);

/** states that will cost the same from here on share a signature: only the cheapest is kept */
function signature(s: State, n: number): number {
  const code =
    Math.min(s.R.bounces, 4) +
    5 * (Math.min(s.L.bounces, 4) + 5 * ((s.R.gap < 0.2 ? 1 : 0) + 2 * ((s.L.gap < 0.2 ? 1 : 0) + 2 * (handCode(s.keepHH) + 3 * (handCode(s.keepRide) + 3 * handCode(s.lastHand))))));
  return s.R.e + 1 + n * (s.L.e + 1 + n * code);
}

/** the hand events of a performance: hand hits and chokes, in time order */
function handEvents(perf: DrumPerformance, at: V3[], graceOf: Map<number, number>): Ev[] {
  const hits = perf.hits;
  const { beat, origin, perBar } = beatGrid(perf);
  const graces = new Set(graceOf.values());

  // the hand events: hand hits and chokes, in time order
  const keeperTimes = hits.filter((h) => isKeeper(h.piece, h.zone)).map((h) => h.t);
  const events: Ev[] = [];
  const evOfHit = new Map<number, number>();
  let kp = 0;
  for (const h of hits) {
    if (footFor(h)) continue;
    // time-keeping strokes either side, within three quarters of a beat
    while (kp < keeperTimes.length && keeperTimes[kp] < h.t - 0.75 * beat) kp++;
    let before = false;
    let after = false;
    for (let j = kp; j < keeperTimes.length && keeperTimes[j] <= h.t + 0.75 * beat; j++) {
      if (keeperTimes[j] <= h.t + 0.02) before = true;
      if (keeperTimes[j] >= h.t - 0.02) after = true;
    }
    const keeper = isKeeper(h.piece, h.zone);
    const phase = (h.t - origin) / beat;
    const nearest = Math.round(phase);
    const onBeat = Math.abs(phase - nearest) < 0.12;
    evOfHit.set(h.i, events.length);
    events.push({
      k: h.i,
      choke: false,
      t: h.t,
      piece: h.piece,
      zone: h.zone,
      at: at[h.i],
      vel: h.velocity,
      keeper,
      inGroove: keeper || (before && after),
      onBeat,
      onAnd: !onBeat && Math.abs(phase * 2 - Math.round(phase * 2)) < 0.24,
      together: false,
      downbeat: onBeat && ((nearest % perBar) + perBar) % perBar === 0,
      grace: graces.has(h.i),
      graceEv: -1,
    });
  }
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    const g = graceOf.get(ev.k);
    if (g !== undefined) ev.graceEv = evOfHit.get(g)!;
    ev.together = (e > 0 && ev.t - events[e - 1].t < 0.03) || (e + 1 < events.length && events[e + 1].t - ev.t < 0.03);
  }
  const chokeEvents: Ev[] = perf.chokes.map((c, ci) => ({
    k: -1 - ci,
    choke: true,
    t: c.t,
    piece: c.piece,
    zone: 'edge',
    at: strikePoint(DRUMS[c.piece], 0.95, 0),
    vel: 0,
    keeper: false,
    inGroove: true,
    onBeat: false,
    onAnd: false,
    together: false,
    downbeat: false,
    grace: false,
    graceEv: -1,
  }));
  if (chokeEvents.length) {
    // a choke goes after the hits at its time (stable: the hits keep their order, and their grace links)
    const all = events.concat(chokeEvents).map((ev, j) => ({ ev, j }));
    all.sort((a, b) => a.ev.t - b.ev.t || Number(a.ev.choke) - Number(b.ev.choke) || a.j - b.j);
    const moved = new Map<number, number>();
    all.forEach((x, j) => moved.set(x.j, j));
    events.length = 0;
    for (const x of all) events.push({ ...x.ev, graceEv: x.ev.graceEv >= 0 ? moved.get(x.ev.graceEv)! : -1 });
  }

  return events;
}

/**
 * The sticking of a performance: which limb plays each hit. Pure and
 * deterministic. `trace` (for debugging) hears each hand hit's cost terms.
 */
export function assignLimbs(
  perf: DrumPerformance,
  opts: { trace?: (hit: number, hand: Hand, terms: Partial<Record<CostTerm, number>>) => void; beam?: number } = {},
): Sticking {
  const beamWidth = opts.beam ?? BEAM;
  const hits = perf.hits;
  const levels = strokeLevels(hits);
  const at = hits.map(hitPoint);
  const graceOf = findFlams(hits);
  const events = handEvents(perf, at, graceOf);

  const n = events.length + 1;
  const start: State = { R: NO_HAND, L: NO_HAND, keepHH: null, keepHHt: -1e9, keepRide: null, keepRideT: -1e9, lastHand: null, lastT: -1e9, rHatT: -1e9, cost: 0, rank: 0, parent: null, choice: 2 };
  let beam: State[] = [start];
  const next: State[] = [];
  const seen = new Set<number>();
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    next.length = 0;
    const drop = dropCost(ev);
    for (const st of beam) {
      for (let hi = 0; hi < 2; hi++) {
        const h: Hand = hi === 0 ? 'R' : 'L';
        const c = strokeCost(st, ev, h, null);
        if (c === Infinity) continue;
        const ns = nextState(st, ev, e, h, c, strokeRebound);
        ns.rank = ns.cost + lookahead(ns, events, e);
        next.push(ns);
      }
      // or nobody plays it
      const ds: State = {
        R: st.R,
        L: st.L,
        keepHH: st.keepHH,
        keepHHt: st.keepHHt,
        keepRide: st.keepRide,
        keepRideT: st.keepRideT,
        lastHand: st.lastHand,
        lastT: st.lastT,
        rHatT: st.rHatT,
        cost: st.cost + drop,
        rank: 0,
        parent: st,
        choice: 2,
      };
      ds.rank = ds.cost + lookahead(ds, events, e);
      next.push(ds);
    }
    // (stable sort: ties keep the order they were made in, right hand first)
    next.sort((a, b) => a.rank - b.rank);
    seen.clear();
    beam = [];
    for (const s of next) {
      const key = signature(s, n);
      if (seen.has(key)) continue;
      seen.add(key);
      beam.push(s);
      if (beam.length >= beamWidth) break;
    }
  }

  // the best path, replayed for its flags and the cost terms
  const path: State[] = [];
  for (let s: State | null = beam[0]; s && s.parent; s = s.parent) path.push(s);
  path.reverse();

  const out: LimbHit[] = hits.map((h, k) => ({
    hit: h.i,
    limb: footFor(h) ?? 'R',
    t: h.t,
    piece: h.piece,
    zone: h.zone,
    played: true,
    at: at[k],
    level: levels[k],
    prev: -1,
    next: -1,
    double: false,
    grace: false,
    over: null,
  }));
  const costs = Object.fromEntries(COST_TERMS.map((term) => [term, { n: 0, total: 0 }])) as StickingStats['costs'];
  const counted = { crossings: 0, hatCrosses: 0, overCrosses: 0, rushed: 0, keeperSwaps: 0, chokesMissed: 0 };
  const chokes: Sticking['chokes'] = [];
  const droppedK: number[] = [];
  for (let e = 0; e < path.length; e++) {
    const s = path[e];
    const ev = events[e];
    if (s.choice === 2) {
      const term: CostTerm = ev.choke ? 'chokeMiss' : 'drop';
      costs[term].n++;
      costs[term].total += ev.choke ? COSTS.chokeMiss : COSTS.drop + COSTS.dropVelocity * ev.vel;
      if (ev.choke) counted.chokesMissed++;
      else droppedK.push(ev.k);
      continue;
    }
    const h: Hand = s.choice === 0 ? 'R' : 'L';
    const info = newInfo();
    strokeCost(s.parent!, ev, h, info);
    if (!ev.choke) opts.trace?.(ev.k, h, info.terms);
    for (const [term, v] of Object.entries(info.terms) as [CostTerm, number][]) {
      costs[term].n++;
      costs[term].total += v;
    }
    if (info.rushed) counted.rushed++;
    if (info.keeperSwap) counted.keeperSwaps++;
    if (info.crossing === 'standard') counted.hatCrosses++;
    else if (info.crossing === 'over') counted.overCrosses++;
    else if (info.crossing === 'crossed') counted.crossings++;
    if (ev.choke) {
      chokes.push({ t: ev.t, piece: ev.piece, hand: h });
      continue;
    }
    const lh = out[ev.k];
    lh.limb = h;
    lh.double = info.rebound;
    lh.over = info.over;
  }
  // a dropped hit keeps the hand that would usually play it, for display
  for (const k of droppedK) {
    const h = hits[k];
    out[k].played = false;
    out[k].limb = roleCost(h.piece, h.zone, 'R') <= roleCost(h.piece, h.zone, 'L') ? 'R' : 'L';
  }
  const dropped = droppedK.map((k) => ({ hit: k, why: dropReason(hits[k], out) }));
  for (const [m, g] of graceOf) if (out[m].played && out[g].played && out[m].limb !== out[g].limb) out[g].grace = true;
  return finish(perf, out, dropped, chokes, costs, counted, beam[0].cost);
}

/** why a hit could not be played: the hands' strokes around it */
function dropReason(h: DrumHit, out: LimbHit[]): string {
  const near = out.filter((o) => o.played && (o.limb === 'R' || o.limb === 'L') && Math.abs(o.t - h.t) < 0.08);
  const level = h.velocity < 0.35 ? 'a ghost note' : h.velocity >= 0.75 ? 'an accent' : 'a note';
  const at = `${h.t.toFixed(3)} s`;
  const r = near.find((o) => o.limb === 'R');
  const l = near.find((o) => o.limb === 'L');
  if (r && l) {
    const together = Math.abs(r.t - h.t) < 0.03 && Math.abs(l.t - h.t) < 0.03;
    return `${together ? 'three hand notes at once' : 'both hands busy'} at ${at}: R on the ${r.piece}, L on the ${l.piece}; dropped ${level} on the ${h.piece} (velocity ${h.velocity.toFixed(2)}), the least important`;
  }
  return `no hand can reach the ${h.piece} at ${at} in time; dropped ${level} (velocity ${h.velocity.toFixed(2)})`;
}

/** links, home and stats over a finished assignment */
function finish(
  perf: DrumPerformance,
  out: LimbHit[],
  dropped: { hit: number; why: string }[],
  chokes: Sticking['chokes'],
  costs: StickingStats['costs'],
  counted: { crossings: number; hatCrosses: number; overCrosses: number; rushed: number; keeperSwaps: number; chokesMissed: number },
  cost: number,
): Sticking {
  const limbs: Limb[] = ['R', 'L', 'RF', 'LF'];
  const lastOf: Partial<Record<Limb, number>> = {};
  for (let k = 0; k < out.length; k++) {
    const h = out[k];
    if (!h.played) continue;
    const p = lastOf[h.limb];
    if (p !== undefined) {
      h.prev = p;
      out[p].next = k;
    }
    lastOf[h.limb] = k;
  }
  const stats: StickingStats = {
    limbs: {} as Record<Limb, LimbStats>,
    crossings: counted.crossings,
    hatCrosses: counted.hatCrosses,
    overCrosses: counted.overCrosses,
    doubles: out.filter((h) => h.played && h.double).length,
    flams: out.filter((h) => h.grace).length,
    dropped: dropped.length,
    fastKicks: 0,
    rushed: counted.rushed,
    keeperSwaps: counted.keeperSwaps,
    leftHandTime: out.filter((h) => h.played && h.limb === 'L' && isKeeper(h.piece, h.zone)).length,
    chokesMissed: counted.chokesMissed,
    costs,
    cost,
  };
  for (const limb of limbs) {
    const mine = out.filter((h) => h.played && h.limb === limb);
    let maxRate = 0;
    let minInterval = Infinity;
    let maxTravelSpeed = 0;
    for (let a = 0, b = 0; b < mine.length; b++) {
      while (mine[b].t - mine[a].t > 0.5 - 1e-9) a++;
      maxRate = Math.max(maxRate, (b - a + 1) / 0.5);
      if (b > 0) {
        const dt = mine[b].t - mine[b - 1].t;
        minInterval = Math.min(minInterval, dt);
        if (mine[b].piece !== mine[b - 1].piece) maxTravelSpeed = Math.max(maxTravelSpeed, dist(mine[b].at, mine[b - 1].at) / Math.max(dt, 1e-3));
        if (limb === 'RF' && dt < KICK_MIN_INTERVAL) stats.fastKicks++;
      }
    }
    stats.limbs[limb] = { hits: mine.length, maxRate, minInterval, maxTravelSpeed };
  }
  return { hits: out, dropped, chokes, home: homes(perf, out), stats };
}

/**
 * Each hand's home, bar by bar: the right hand's is the time-keeping piece it
 * plays most in the bar (the hi-hat or the ride), the left's the snare unless
 * most of its strokes in the bar keep time too (two-handed hats). A bar with
 * no time-keeping (a fill) keeps the homes before it.
 */
function homes(perf: DrumPerformance, out: LimbHit[]): Sticking['home'] {
  const bars = perf.bars.length ? perf.bars.slice() : [0];
  if (bars[0] > 0) bars.unshift(0);
  const first = out.find((h) => h.played && h.limb === 'R' && isKeeper(h.piece, h.zone));
  let R: DrumId = first ? first.piece : 'hihat';
  let L: DrumId = 'snare';
  const list: Sticking['home'] = [{ t: 0, R, L }];
  const keepers: DrumId[] = ['hihat', 'ride'];
  const best = (m: Map<DrumId, number>): DrumId | null => {
    let p: DrumId | null = null;
    let n = 0;
    for (const piece of keepers) {
      const c = m.get(piece) ?? 0;
      if (c > n) [p, n] = [piece, c];
    }
    return p;
  };
  let k = 0;
  for (let b = 0; b < bars.length; b++) {
    const end = b + 1 < bars.length ? bars[b + 1] : Infinity;
    const count = { R: new Map<DrumId, number>(), L: new Map<DrumId, number>() };
    let lAll = 0;
    let lKeep = 0;
    for (; k < out.length && out[k].t < end; k++) {
      const h = out[k];
      if (!h.played || (h.limb !== 'R' && h.limb !== 'L')) continue;
      if (h.limb === 'L') lAll++;
      if (!isKeeper(h.piece, h.zone)) continue;
      const m = count[h.limb];
      m.set(h.piece, (m.get(h.piece) ?? 0) + 1);
      if (h.limb === 'L') lKeep++;
    }
    const r = best(count.R);
    if (r) R = r;
    if (r || count.L.size) {
      const l = best(count.L);
      L = l && lKeep * 2 > lAll ? l : 'snare';
    }
    const last = list[list.length - 1];
    if (last.R !== R || last.L !== L) {
      if (last.t === bars[b]) list[list.length - 1] = { t: bars[b], R, L };
      else list.push({ t: bars[b], R, L });
    }
  }
  return list;
}

/**
 * What a given sticking costs under the same terms as the search: `hands[k]`
 * is the hand for hit k (null: dropped; feet hits ignored), chokes go to the
 * hand that usually takes that cymbal. For tests and for explaining a choice
 * ("the textbook sticking would cost this much more, here").
 */
export function scoreHands(perf: DrumPerformance, hands: (Hand | null)[]): { cost: number; terms: Partial<Record<CostTerm, number>>; impossible: number[] } {
  const at = perf.hits.map(hitPoint);
  const events = handEvents(perf, at, findFlams(perf.hits));
  let st: State = { R: NO_HAND, L: NO_HAND, keepHH: null, keepHHt: -1e9, keepRide: null, keepRideT: -1e9, lastHand: null, lastT: -1e9, rHatT: -1e9, cost: 0, rank: 0, parent: null, choice: 2 };
  const terms: Partial<Record<CostTerm, number>> = {};
  const impossible: number[] = [];
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    const h: Hand | null = ev.choke ? (ev.piece === 'ride' ? 'R' : 'L') : hands[ev.k];
    const info = newInfo();
    const c = h ? strokeCost(st, ev, h, info) : Infinity;
    if (h && c !== Infinity) {
      for (const [term, v] of Object.entries(info.terms) as [CostTerm, number][]) terms[term] = (terms[term] ?? 0) + v;
      st = nextState(st, ev, e, h, c, strokeRebound);
      continue;
    }
    if (h && !ev.choke) impossible.push(ev.k);
    const term: CostTerm = ev.choke ? 'chokeMiss' : 'drop';
    terms[term] = (terms[term] ?? 0) + dropCost(ev);
    st = { ...st, cost: st.cost + dropCost(ev), parent: st, choice: 2 };
  }
  return { cost: st.cost, terms, impossible };
}
