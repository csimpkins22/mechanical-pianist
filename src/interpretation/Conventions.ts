// Conventional fingerings from piano pedagogy, used two ways: as soft priors
// when a passage is recognised as a scale (see Patterns.ts), and as the
// reference the fingering report and tests compare the engine against.
//
// Major scales, ascending, by tonic pitch class. `start` is the finger on the
// tonic where the scale begins, `cyc` the fingers on degrees 1..7 in the
// middle of a run (the tonic changes finger there when the scale starts on a
// black key), `top` the finger on the tonic where an ascending run ends.
// Descending runs use the same finger on each note.
import type { Finger, Hand } from '../core/types';

export interface ScaleFingering {
  start: Finger;
  cyc: Finger[]; // degrees 1..7
  top: Finger;
}

const C_LIKE_R: ScaleFingering = { start: 1, cyc: [1, 2, 3, 1, 2, 3, 4], top: 5 };
const C_LIKE_L: ScaleFingering = { start: 5, cyc: [1, 4, 3, 2, 1, 3, 2], top: 1 };
const FLAT_L: ScaleFingering = { start: 3, cyc: [3, 2, 1, 4, 3, 2, 1], top: 3 }; // Bb, Eb, Ab, Db

export const MAJOR_SCALES: Record<Hand, Record<number, ScaleFingering>> = {
  R: {
    0: C_LIKE_R, // C
    7: C_LIKE_R, // G
    2: C_LIKE_R, // D
    9: C_LIKE_R, // A
    4: C_LIKE_R, // E
    11: C_LIKE_R, // B
    5: { start: 1, cyc: [1, 2, 3, 4, 1, 2, 3], top: 4 }, // F
    10: { start: 2, cyc: [4, 1, 2, 3, 1, 2, 3], top: 4 }, // Bb
    3: { start: 3, cyc: [3, 1, 2, 3, 4, 1, 2], top: 3 }, // Eb
    8: { start: 3, cyc: [3, 4, 1, 2, 3, 1, 2], top: 3 }, // Ab
    1: { start: 2, cyc: [2, 3, 1, 2, 3, 4, 1], top: 2 }, // Db
    6: { start: 2, cyc: [2, 3, 4, 1, 2, 3, 1], top: 2 }, // F#
  },
  L: {
    0: C_LIKE_L,
    7: C_LIKE_L,
    2: C_LIKE_L,
    9: C_LIKE_L,
    4: C_LIKE_L,
    5: C_LIKE_L, // F
    11: { start: 4, cyc: [1, 3, 2, 1, 4, 3, 2], top: 1 }, // B
    10: FLAT_L,
    3: FLAT_L,
    8: FLAT_L,
    1: FLAT_L,
    6: { start: 4, cyc: [4, 3, 2, 1, 3, 2, 1], top: 4 }, // F#
  },
};

export const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_STEPS = {
  natural: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  melodic: [0, 2, 3, 5, 7, 9, 11],
};
export const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/**
 * The conventional finger for each note of an ascending or descending scale
 * run. `steps` selects the mode; minor scales on white-key tonics take the
 * fingering of their parallel major, degree by degree (A minor as A major).
 */
export function scaleFingers(tonic: number, hand: Hand, midis: number[], steps: number[] = MAJOR_STEPS): (Finger | null)[] {
  const sf = MAJOR_SCALES[hand][tonic];
  const up = midis[midis.length - 1] > midis[0];
  const lo = up ? 0 : midis.length - 1;
  const hi = up ? midis.length - 1 : 0;
  return midis.map((m, i) => {
    const deg = steps.indexOf((((m - tonic) % 12) + 12) % 12);
    if (deg < 0) return null;
    if (deg === 0 && i === lo) return sf.start;
    if (deg === 0 && i === hi) return sf.top;
    return sf.cyc[deg];
  });
}

/**
 * Root-position major arpeggios on white-key roots (C, F, G), ascending, with
 * the accepted alternatives per note: right 1-2-3-1-2-3-5, left 5-4-2-1-4-2-1
 * (or 5-3-2-1-3-2-1: pianists use both).
 */
export function arpeggioFingers(hand: Hand, count: number): Finger[][] {
  const out: Finger[][] = [];
  for (let i = 0; i < count; i++) {
    if (hand === 'R') out.push([i === count - 1 ? 5 : ([1, 2, 3] as Finger[])[i % 3]]);
    else out.push(i === 0 ? [5] : ([[4, 3], [2], [1]] as Finger[][])[(i - 1) % 3]);
  }
  return out;
}

/** Chord shapes, low note to high. */
export const CHORDS: { name: string; notes: string; R: Finger[]; L: Finger[][] }[] = [
  { name: 'C major, root', notes: 'C4 E4 G4', R: [1, 3, 5], L: [[5, 3, 1]] },
  { name: 'C major, 1st inv.', notes: 'E4 G4 C5', R: [1, 2, 5], L: [[5, 3, 1], [5, 4, 1]] },
  { name: 'C major, 2nd inv.', notes: 'G3 C4 E4', R: [1, 3, 5], L: [[5, 2, 1]] },
  { name: 'G dominant 7th', notes: 'G3 B3 D4 F4', R: [1, 2, 3, 5], L: [[5, 3, 2, 1]] },
];
