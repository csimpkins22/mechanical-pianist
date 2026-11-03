// The pedals as the mechanism sees them: where each one is at time t, half
// positions included, as pure functions of the score.
//
// The sustain pedal raises the damper lift rail, which takes every damper off
// its strings together. Its first part is free play; from there the rail
// moves with the pedal, so half-pedalling lifts the dampers part of the way
// (a little lift leaves the felts still brushing the strings). The soft pedal
// of an upright moves the hammer rest rail toward the strings, so every
// hammer starts its blow from closer in.
import type { PedalLevel, Score } from '../core/types';

/** the foot takes this long to move the sustain pedal (as PerformanceTimeline.pedalAt) */
export const SUSTAIN_RAMP = 0.06;
/** and the soft pedal's rail */
export const SOFT_RAMP = 0.1;
/** free play at the top of the sustain pedal's travel, before the rail moves */
export const PEDAL_FREE = 0.2;
/**
 * The pedal position from which the dampers are clear of the strings: half
 * down, as the sound takes it (MIDIEngine: CC64 >= 64). Below it the rail has
 * lifted them part of the way, but the felts still brush the strings.
 */
export const PEDAL_CLEAR = 0.5;
/** the rail's travel there */
export const RAIL_CLEAR = (PEDAL_CLEAR - PEDAL_FREE) / (1 - PEDAL_FREE);
/** how far the soft pedal brings the resting hammers toward the strings (fraction of the blow) */
export const SOFT_BLOW = 0.35;

/** the sustain pedal's positions: the score's levels, or (older plans) its down/up events */
export function sustainLevels(score: Pick<Score, 'pedal' | 'pedalLevels'>): PedalLevel[] {
  return score.pedalLevels ?? score.pedal.map((e) => ({ time: e.time, value: e.down ? 1 : 0 }));
}

/** a pedal's position at t, each change taking `ramp` seconds from wherever the last one had got to */
export function levelAt(levels: readonly PedalLevel[], t: number, ramp: number): number {
  let lo = 0;
  let hi = levels.length - 1;
  let i = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (levels[m].time <= t) {
      i = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return rampFrom(levels, i, t, ramp, 0);
}

function rampFrom(levels: readonly PedalLevel[], i: number, t: number, ramp: number, depth: number): number {
  if (i < 0) return 0;
  const e = levels[i];
  // where the pedal was when this change began: the previous one may still have been under way
  const from = i === 0 ? 0 : depth < 8 && e.time - levels[i - 1].time < ramp ? rampFrom(levels, i - 1, e.time, ramp, depth + 1) : levels[i - 1].value;
  const u = Math.min(1, Math.max(0, (t - e.time) / ramp));
  return from + (e.value - from) * u;
}

/** the damper lift rail's travel (0..1) for a sustain pedal position */
export function railTravel(pedal: number): number {
  return Math.min(1, Math.max(0, (pedal - PEDAL_FREE) / (1 - PEDAL_FREE)));
}

/**
 * When the rail holds every damper clear of its strings: [from, to) intervals.
 * The rail follows the pedal's ramps; the dampers leave the strings as the
 * pedal passes PEDAL_CLEAR going down and are back on them as it comes back up past it.
 */
export function railClearIntervals(levels: readonly PedalLevel[], until = 1e6): [number, number][] {
  const clear = (v: number) => v >= PEDAL_CLEAR;
  const edge = PEDAL_CLEAR;
  const out: [number, number][] = [];
  let from: number | null = null;
  let prev = 0;
  for (const e of levels) {
    const was = clear(prev);
    const now = clear(e.value);
    // where along this ramp the edge is crossed
    const at = e.time + SUSTAIN_RAMP * Math.min(1, Math.max(0, (edge - prev) / (e.value - prev || 1)));
    if (!was && now) from = at;
    else if (was && !now && from !== null) {
      out.push([from, at]);
      from = null;
    }
    prev = e.value;
  }
  if (from !== null) out.push([from, until]);
  return out;
}
