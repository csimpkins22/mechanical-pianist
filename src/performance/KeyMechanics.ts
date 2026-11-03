// How far each key is down at time t, as a pure function of the performance.
//
// A key is pressed by its finger: it starts moving when the fingertip lands
// (a little before the MIDI onset; soft notes travel more slowly), bottoms out
// exactly at the onset (when the hammer strikes), stays down while the finger
// holds it, and returns on its spring when the finger lets go, with a tiny
// bounce off the felt as it arrives at rest. Repeated notes
// can restrike a half-risen key. Sound is a separate matter: a pedalled note
// keeps sounding after its key has risen.
//
// Coming back up, the key meets its rest stop and rebounds a little: it dips a
// few percent of its travel below rest, once and then once more, much less,
// before it settles (never rising above rest). How much depends on how briskly
// it was let go: a short, loud note springs back and bounces more, a long soft
// one barely at all, and every stroke is a little different.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { hash01 } from '../core/random';
import type { PerformanceNote } from '../core/types';

export const KEY_RETURN = 0.085; // seconds for a released key to rise

// the key arrives at its rest stop still moving (BOUNCE_V of the way, blended
// into the soft return), and rebounds into a small dip below rest
const BOUNCE_V = 0.4;

/** how a stroke's key comes back: its dip below rest after meeting the stop, and how long it lasts */
export interface KeyReturn {
  /** depth of the first dip (fraction of the key's travel) and its duration (s) */
  dip: number;
  time: number;
}

/** how briskly a note is let go, 0 (slowly, held long and soft) .. 1 (quickly: short and loud) */
export function releaseBrisk(n: PerformanceNote): number {
  const hold = Math.max(0, n.keyEnd - n.start);
  const short = 1 - Math.min(1, Math.max(0, (hold - 0.12) / (1.2 - 0.12)));
  const r = hash01(n.midi * 100003 + Math.round(n.start * 1000), 11);
  return Math.min(1, Math.max(0, 0.2 + 0.55 * short + 0.4 * (n.velocity - 0.5) + 0.3 * (r - 0.5)));
}

/** the average key's return (for timing that every stroke shares: the dampers, the jack) */
export const AVERAGE_RETURN: KeyReturn = { dip: 0.02, time: 0.034 };

const returns = new WeakMap<KeyStroke, KeyReturn>();

/** a stroke's key return: a few percent's dip, more for a brisk release, ±30% in depth and ±15% in time */
export function keyReturn(s: KeyStroke): KeyReturn {
  let c = returns.get(s);
  if (c) return c;
  const n = s.note;
  const seed = n.midi * 100003 + Math.round(n.start * 1000);
  const brisk = releaseBrisk(n);
  c = {
    dip: (0.005 + 0.025 * brisk) * (0.7 + 0.6 * hash01(seed, 12)),
    time: 0.034 * (0.85 + 0.3 * hash01(seed, 13)),
  };
  returns.set(s, c);
  return c;
}

/** Key travel time from first contact to key bottom (s). */
export function keyTravel(velocity: number): number {
  return 0.046 - 0.03 * velocity;
}

export interface KeyStroke {
  note: PerformanceNote;
  contact: number; // fingertip lands on the key surface
  bottom: number; // key bottom: the note onset
  release: number; // finger lets go (keyEnd)
}

/**
 * Repeated notes. An upright's action has to come most of the way back up
 * before its key can strike again, and the finger has to lift off to play it
 * again, so the earlier of two strikes on the same key lets go in time for
 * both: up to 120 ms before the next fingertip lands, less for fast
 * repetitions (never shorter than a 35 ms hold). The earlier note's sound ends
 * at the re-strike regardless (see PerformanceTimeline.releaseOf).
 */
export function restrikeRepeats(notes: readonly PerformanceNote[]) {
  const byKey = new Map<number, PerformanceNote[]>();
  for (const n of notes) {
    if (n.flags.includes('chord-overflow')) continue;
    const list = byKey.get(n.midi);
    if (list) list.push(n);
    else byKey.set(n.midi, [n]);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const ioi = b.start - a.start;
      if (ioi < 0.03) continue;
      const contact = b.start - keyTravel(b.velocity);
      const gap = Math.min(0.12, Math.max(0.035, 0.4 * ioi));
      const end = Math.max(a.start + 0.035, contact - gap);
      if (end < a.keyEnd) a.keyEnd = end;
    }
  }
}

export function strokeOf(n: PerformanceNote): KeyStroke {
  return { note: n, contact: n.start - keyTravel(n.velocity), bottom: n.start, release: Math.max(n.keyEnd, n.start + 0.02) };
}

/**
 * Depression of a released key at time dt after its release from depth d0:
 * the spring's quick return, arriving at rest still moving, then a small dip
 * below rest and a smaller one, settling by KEY_RETURN + 1.6 * time. Never
 * negative: the key does not rise above its rest stop.
 */
export function releaseCurve(d0: number, dt: number, r: KeyReturn = AVERAGE_RETURN): number {
  if (dt <= 0) return d0;
  if (dt < KEY_RETURN) {
    const u = dt / KEY_RETURN;
    // fast spring return, still moving a little as it reaches rest
    return d0 * ((1 - BOUNCE_V) * (1 - u) * (1 - u) * (1 + 0.6 * u) + BOUNCE_V * (1 - u));
  }
  return d0 * settleDips((dt - KEY_RETURN) / r.time, r.dip);
}

/**
 * Two dips after a stop (x in units of the first dip's duration): the first
 * of depth `a`, the second a quarter as deep and three-fifths as long, each a
 * smooth arc that leaves and meets rest gently (the felt), then nothing.
 */
export function settleDips(x: number, a: number): number {
  if (x <= 0) return 0;
  if (x < 1) return a * arc(x);
  const y = (x - 1) / 0.6;
  if (y < 1) return 0.25 * a * arc(y);
  return 0;
}

/** an arc over 0..1: rising quickly, falling back more slowly, meeting zero with a soft touch */
function arc(x: number): number {
  const s = Math.sin(Math.PI * Math.pow(x, 0.85));
  return s * Math.sqrt(s);
}

/** index of the last stroke whose fingertip has landed by t (-1: none yet) */
export function strokeIndexAt(strokes: readonly KeyStroke[], t: number): number {
  let lo = 0;
  let hi = strokes.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strokes[mid].contact <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return i;
}

/** Depression in [0, 1] of a key with strokes sorted by contact, at t. */
export function depressionAt(strokes: readonly KeyStroke[], t: number): number {
  // last stroke whose fingertip has landed
  let lo = 0;
  let hi = strokes.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strokes[mid].contact <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (i < 0) return 0;
  return strokeDepth(strokes, i, t);
}

export function strokeDepth(strokes: readonly KeyStroke[], i: number, t: number): number {
  const s = strokes[i];
  if (t >= s.release) return releaseCurve(1, t - s.release, keyReturn(s));
  if (t >= s.bottom) return 1;
  // pressing: from wherever the key was when the finger landed
  const d0 = i > 0 ? depthBefore(strokes, i - 1, s.contact) : 0;
  const u = (t - s.contact) / Math.max(1e-4, s.bottom - s.contact);
  const e = Math.pow(Math.min(1, Math.max(0, u)), 1.5); // accelerating under the finger
  return d0 + (1 - d0) * e;
}

export function depthBefore(strokes: readonly KeyStroke[], j: number, t: number): number {
  const s = strokes[j];
  if (t >= s.release) return releaseCurve(1, t - s.release, keyReturn(s));
  return 1;
}

export class KeyMechanics {
  readonly strokes: KeyStroke[][] = Array.from({ length: KEY_COUNT }, () => []);

  constructor(notes: readonly PerformanceNote[]) {
    for (const n of notes) {
      if (n.flags.includes('chord-overflow')) continue; // no finger: the key cannot honestly move
      this.strokes[n.midi - LOWEST_MIDI].push(strokeOf(n));
    }
    for (const list of this.strokes) list.sort((a, b) => a.contact - b.contact);
  }

  depression(midi: number, t: number): number {
    return depressionAt(this.strokes[midi - LOWEST_MIDI], t);
  }

  /** all 88 keys at t */
  evaluate(t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
    for (let i = 0; i < KEY_COUNT; i++) out[i] = depressionAt(this.strokes[i], t);
    return out;
  }
}
