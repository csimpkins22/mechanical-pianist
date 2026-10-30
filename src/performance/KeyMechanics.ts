// How far each key is down at time t, as a pure function of the performance.
//
// A key is pressed by its finger: it starts moving when the fingertip lands
// (a little before the MIDI onset; soft notes travel more slowly), bottoms out
// exactly at the onset (when the hammer strikes), stays down while the finger
// holds it, and returns on its spring when the finger lets go. Repeated notes
// can restrike a half-risen key. Sound is a separate matter: a pedalled note
// keeps sounding after its key has risen.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import type { PerformanceNote } from '../core/types';

export const KEY_RETURN = 0.085; // seconds for a released key to rise

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

export function strokeOf(n: PerformanceNote): KeyStroke {
  return { note: n, contact: n.start - keyTravel(n.velocity), bottom: n.start, release: Math.max(n.keyEnd, n.start + 0.02) };
}

/** Depression of a released key at time t after its release from depth d0. */
function releaseCurve(d0: number, dt: number): number {
  if (dt <= 0) return d0;
  if (dt >= KEY_RETURN) return 0;
  const u = dt / KEY_RETURN;
  // fast spring return that settles softly
  return d0 * (1 - u) * (1 - u) * (1 + 0.6 * u);
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

function strokeDepth(strokes: readonly KeyStroke[], i: number, t: number): number {
  const s = strokes[i];
  if (t >= s.release) return releaseCurve(1, t - s.release);
  if (t >= s.bottom) return 1;
  // pressing: from wherever the key was when the finger landed
  const d0 = i > 0 ? depthBefore(strokes, i - 1, s.contact) : 0;
  const u = (t - s.contact) / Math.max(1e-4, s.bottom - s.contact);
  const e = Math.pow(Math.min(1, Math.max(0, u)), 1.5); // accelerating under the finger
  return d0 + (1 - d0) * e;
}

function depthBefore(strokes: readonly KeyStroke[], j: number, t: number): number {
  const s = strokes[j];
  if (t >= s.release) return releaseCurve(1, t - s.release);
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
