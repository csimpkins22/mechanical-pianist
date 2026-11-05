// Which limb plays each hit of a drum performance: the sticking of a
// right-handed kit drummer.
//
// The feet are fixed (the right foot on the kick pedal, the left on the
// hi-hat pedal). The hands are chosen here. This first version keeps each
// drum's usual hand (KitLayout's `usual`) and gives a hit to the other hand
// when the usual one is still busy; the search with named costs replaces it
// behind the same signature.
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
  /** false when no limb could play it (it is listed in `dropped`); `limb` is then the hand that would have */
  played: boolean;
  /** where the stick's tip lands (for a pedal: the ball of the foot on the footboard), KitLayout's frame, metres */
  at: V3;
  /** ghost, tap or accent (relative to how loud this performance plays that piece) */
  level: Level;
  /** the previous and next hits (indices into hits[]) played by the same limb, -1 when none */
  prev: number;
  next: number;
  /** the second stroke of a double (RR or LL): played off the rebound with the fingers, no fresh preparation */
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
  /** hand hits played with the arms crossed, other than the standard right-over-left hi-hat groove */
  crossings: number;
  /** hand hits played in the standard crossed hi-hat groove (right hand on the hi-hat over the left) */
  hatCrosses: number;
  /** second strokes of doubles */
  doubles: number;
  /** flams (a grace note and its main note on one drum, one hand each) */
  flams: number;
  dropped: number;
  /** kick notes closer to the previous kick than a single pedal comfortably repeats (about 13 per second) */
  fastKicks: number;
  /** moves between instruments with less time than a comfortable move needs */
  rushed: number;
  /** times the time-keeping hand changed in the middle of a groove */
  keeperSwaps: number;
  /** hi-hat or ride strokes played by the left hand */
  leftHandTime: number;
  /** chokes no hand was free for */
  chokesMissed: number;
  /** each named cost term: how often it applied and its total over the performance */
  costs: Record<string, { n: number; total: number }>;
}

export interface Sticking {
  /** one per DrumHit, in the same order */
  hits: LimbHit[];
  /** hits no limb could play, and why */
  dropped: { hit: number; why: string }[];
  /** a hand grabbing a cymbal to stop it ringing */
  chokes: { t: number; piece: DrumId; hand: Hand }[];
  /** what each hand is home on over time (the time-keeping hand on the hi-hat or ride, the other on the snare), for posture; each entry holds until the next */
  home: { t: number; R: DrumId; L: DrumId }[];
  stats: StickingStats;
}

const HAND_PIECES = new Set<DrumId>(['snare', 'hihat', 'tom1', 'tom2', 'floorTom', 'crash', 'ride']);

/** the limb a hit belongs to when the feet play it, or null for a hand hit */
export function footFor(h: DrumHit): Limb | null {
  if (h.piece === 'kick') return 'RF';
  if (h.piece === 'hihat' && h.zone === 'pedal') return 'LF';
  return HAND_PIECES.has(h.piece) ? null : 'RF';
}

/** where a hit lands: its strike point, or the ball of the foot on its pedal */
export function hitPoint(h: DrumHit): V3 {
  if (h.piece === 'kick') return PEDALS.kickPedal.ball.slice() as V3;
  if (h.piece === 'hihat' && h.zone === 'pedal') return PEDALS.hihatPedal.ball.slice() as V3;
  return strikePoint(DRUMS[h.piece], h.r, h.angle);
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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

/** the shortest time a hand needs between two strokes, by distance (s) */
const minGap = (d: number) => (d < 1e-6 ? 0.03 : 0.035 + d / 6);

/**
 * The sticking of a performance. Pure and deterministic.
 * (First version: usual hands, the other hand when the usual one is busy.)
 */
export function assignLimbs(perf: DrumPerformance): Sticking {
  const hits = perf.hits;
  const levels = strokeLevels(hits);
  const out: LimbHit[] = hits.map((h, k) => ({
    hit: h.i,
    limb: footFor(h) ?? 'R',
    t: h.t,
    piece: h.piece,
    zone: h.zone,
    played: true,
    at: hitPoint(h),
    level: levels[k],
    prev: -1,
    next: -1,
    double: false,
    grace: false,
    over: null,
  }));
  const dropped: { hit: number; why: string }[] = [];
  const last: Record<Hand, { t: number; at: V3 } | null> = { R: null, L: null };
  const free = (hand: Hand, t: number, at: V3) => {
    const l = last[hand];
    return !l || t - l.t >= minGap(dist(l.at, at));
  };
  hits.forEach((h, k) => {
    if (footFor(h)) return;
    const usual = DRUMS[h.piece].usual;
    const want: Hand = usual === 'L' ? 'L' : 'R';
    const other: Hand = want === 'R' ? 'L' : 'R';
    const at = out[k].at;
    const hand = free(want, h.t, at) ? want : free(other, h.t, at) ? other : null;
    if (!hand) {
      out[k].played = false;
      out[k].limb = want;
      dropped.push({ hit: h.i, why: `both hands busy at ${h.t.toFixed(3)} s` });
      return;
    }
    out[k].limb = hand;
    last[hand] = { t: h.t, at };
  });
  const chokes = perf.chokes.map((c) => ({ t: c.t, piece: c.piece, hand: (c.piece === 'ride' ? 'R' : 'L') as Hand }));
  return finish(perf, out, dropped, chokes, {});
}

/** links, flags, home and stats over a finished assignment */
function finish(perf: DrumPerformance, out: LimbHit[], dropped: { hit: number; why: string }[], chokes: Sticking['chokes'], costs: StickingStats['costs']): Sticking {
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
    crossings: 0,
    hatCrosses: 0,
    doubles: 0,
    flams: 0,
    dropped: dropped.length,
    fastKicks: 0,
    rushed: 0,
    keeperSwaps: 0,
    leftHandTime: 0,
    chokesMissed: 0,
    costs,
  };
  for (const limb of limbs) {
    const mine = out.filter((h) => h.played && h.limb === limb);
    let maxRate = 0;
    let minInterval = Infinity;
    let maxTravelSpeed = 0;
    for (let a = 0, b = 0; b < mine.length; b++) {
      while (mine[b].t - mine[a].t > 0.5) a++;
      maxRate = Math.max(maxRate, (b - a + 1) / 0.5);
      if (b > 0) {
        const dt = mine[b].t - mine[b - 1].t;
        minInterval = Math.min(minInterval, dt);
        const d = dist(mine[b].at, mine[b - 1].at);
        if (d > 0.05) maxTravelSpeed = Math.max(maxTravelSpeed, d / Math.max(dt, 1e-3));
      }
    }
    stats.limbs[limb] = { hits: mine.length, maxRate, minInterval, maxTravelSpeed };
  }
  const home: Sticking['home'] = [{ t: 0, R: 'hihat', L: 'snare' }];
  return { hits: out, dropped, chokes, home, stats };
}
