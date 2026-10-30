// Recognising familiar figures in one hand's notes, so the fingering search
// can lean toward the fingerings pianists learn for them.
//
// Patterns only produce soft priors: a finger the search is nudged toward,
// with a weight. The search still weighs them against reach, held keys,
// timing and everything else, so a recognised scale fragment that sits under
// five fingers, or a run that collides with a held note, is still fingered
// sensibly.
//
//   scale runs      stepwise runs (one or two semitones, one direction) longer
//                   than a hand position, fitted to a major key: its
//                   conventional fingering (Conventions.ts)
//   chromatic runs  semitone runs: thumb on white keys, 3 on black, 2 where two
//                   white keys meet
//   arpeggios       broken root-position triads on white roots spanning more
//                   than an octave: 1-2-3 (right), 5-4-2-1 (left)
//   motifs          an exact repeat of an earlier figure is nudged toward the
//                   fingering that figure was given (see Fingering.fingerHand)
import { isBlack } from '../core/keyboard';
import type { Finger, Hand, ScoreNote } from '../core/types';
import { MAJOR_STEPS, MINOR_STEPS, scaleFingers } from './Conventions';
import { groupOnsets } from './HandAssignment';

export interface Prior {
  fingers: Finger[];
  weight: number;
  source: 'scale' | 'chromatic' | 'arpeggio' | 'motif';
}

export type Priors = Map<number, Prior>;

const MAX_IOI = 0.45; // slower than this, a stepwise line is a melody, not a run
const SCALE_W = 1.4;
const ARP_W = 1.2;

/** single-note events of the hand, in order, with chords breaking runs */
function events(notes: ScoreNote[]) {
  return groupOnsets(notes).map((g) => ({ time: g.time, note: g.notes.length === 1 ? g.notes[0] : null }));
}

/** maximal one-direction runs whose steps pass `step(a, b)` */
function runs(ev: ReturnType<typeof events>, step: (d: number) => boolean): ScoreNote[][] {
  const out: ScoreNote[][] = [];
  let cur: ScoreNote[] = [];
  let dir = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    dir = 0;
  };
  for (let i = 0; i < ev.length; i++) {
    const n = ev[i].note;
    if (!n) {
      flush();
      continue;
    }
    if (!cur.length) {
      cur = [n];
      continue;
    }
    const p = cur[cur.length - 1];
    const d = n.midi - p.midi;
    const ioi = n.start - p.start;
    const sd = Math.sign(d);
    if (ioi <= MAX_IOI && step(Math.abs(d)) && (dir === 0 || sd === dir)) {
      cur.push(n);
      dir = sd;
    } else {
      // a turn shares its turning note with the next run
      flush();
      if (ioi <= MAX_IOI && step(Math.abs(d))) {
        cur = [p, n];
        dir = sd;
      } else cur = [n];
    }
  }
  flush();
  return out;
}

interface Key {
  tonic: number;
  steps: number[];
  minor: boolean;
}

const KEYS: Key[] = [];
for (let k = 0; k < 12; k++) {
  KEYS.push({ tonic: k, steps: MAJOR_STEPS, minor: false });
  // minors only on white-key tonics, whose conventional fingering is their parallel major's
  if (!isBlack(k + 60)) for (const steps of Object.values(MINOR_STEPS)) KEYS.push({ tonic: k, steps, minor: true });
}

/** the key (major or minor) a stepwise run belongs to, or null */
function fitKey(run: ScoreNote[]): Key | null {
  const pcs = new Set(run.map((n) => n.midi % 12));
  const fits = KEYS.filter((k) => [...pcs].every((pc) => k.steps.includes((pc - k.tonic + 12) % 12)));
  if (!fits.length) return null;
  // prefer a key whose tonic starts or ends the run, then major, then the fewest accidentals
  const ends = new Set([run[0].midi % 12, run[run.length - 1].midi % 12]);
  const fifths = (k: number) => Math.min((k * 7) % 12, 12 - ((k * 7) % 12));
  fits.sort((a, b) => Number(ends.has(b.tonic)) - Number(ends.has(a.tonic)) || Number(a.minor) - Number(b.minor) || fifths(a.tonic) - fifths(b.tonic));
  return fits[0];
}

export function patternPriors(notes: ScoreNote[], hand: Hand): Priors {
  const priors: Priors = new Map();
  const ev = events(notes);

  // scales: longer than a five-finger position (steps of up to three
  // semitones: the harmonic minor's augmented second)
  for (const run of runs(ev, (d) => d >= 1 && d <= 3)) {
    const distinct = new Set(run.map((n) => n.midi)).size;
    const span = Math.abs(run[run.length - 1].midi - run[0].midi);
    if (distinct < 6 || span < 8) continue;
    // a scale has at most one augmented second per octave; more is a broken chord
    const wide = run.filter((n, i) => i > 0 && Math.abs(n.midi - run[i - 1].midi) === 3).length;
    if (wide > Math.ceil(span / 12)) continue;
    const chromatic = run.every((n, i) => i === 0 || Math.abs(n.midi - run[i - 1].midi) === 1);
    if (chromatic) {
      for (const n of run) {
        const pc = n.midi % 12;
        const f: Finger = isBlack(n.midi) ? 3 : (hand === 'R' ? pc === 5 || pc === 0 : pc === 4 || pc === 11) ? 2 : 1;
        priors.set(n.id, { fingers: [f], weight: SCALE_W, source: 'chromatic' });
      }
      continue;
    }
    const key = fitKey(run);
    if (!key) continue;
    const fs = scaleFingers(key.tonic, hand, run.map((n) => n.midi), key.steps);
    run.forEach((n, i) => {
      const f = fs[i];
      // the run's two ends are left free unless they are the tonic: a run
      // often starts or stops mid-pattern, on whatever finger the music needs
      const end = i === 0 || i === run.length - 1;
      if (f && (!end || (n.midi - key.tonic) % 12 === 0)) priors.set(n.id, { fingers: [f], weight: SCALE_W, source: 'scale' });
    });
  }

  // arpeggios: thirds and fourths in one direction, over more than an octave
  for (const run of runs(ev, (d) => d >= 3 && d <= 5)) {
    const span = Math.abs(run[run.length - 1].midi - run[0].midi);
    if (run.length < 5 || span <= 12) continue;
    const pcs = new Set(run.map((n) => n.midi % 12));
    if (pcs.size !== 3) continue;
    let root = -1;
    let third = 4;
    for (const r of pcs)
      for (const t of [3, 4])
        if (pcs.has((r + t) % 12) && pcs.has((r + 7) % 12)) {
          root = r;
          third = t;
        }
    if (root < 0 || isBlack(root + 60)) continue;
    const up = run[run.length - 1].midi > run[0].midi;
    const lo = up ? 0 : run.length - 1;
    const hi = up ? run.length - 1 : 0;
    run.forEach((n, i) => {
      const iv = (n.midi % 12 - root + 12) % 12;
      let f: Finger[];
      // (left hand: the third after the thumb takes 4 or 3, pianists use both)
      if (hand === 'R') f = [i === hi ? 5 : iv === 0 ? 1 : iv === third ? 2 : 3];
      else f = i === lo && iv === 0 ? [5] : iv === 0 ? [1] : iv === third ? [4, 3] : [2];
      priors.set(n.id, { fingers: f, weight: ARP_W, source: 'arpeggio' });
    });
  }
  return priors;
}

/**
 * Motifs: for each note that begins (or continues) an exact repeat of an
 * earlier figure of at least `len` onsets, the finger the earlier note got.
 */
export function motifPriors(notes: ScoreNote[], fingers: Map<number, Finger>, len = 4, weight = 1.2): Priors {
  const priors: Priors = new Map();
  const groups = groupOnsets(notes).map((g) => ({ time: g.time, notes: g.notes.slice().sort((a, b) => a.midi - b.midi) }));
  const sig = groups.map((g) => g.notes.map((n) => n.midi).join('.'));
  const seen = new Map<string, number>(); // window signature -> first start index
  for (let i = 0; i + len <= groups.length; i++) {
    const ioi = (k: number) => (groups[k + 1] ? groups[k + 1].time - groups[k].time : 0);
    const key = sig.slice(i, i + len).join('|') + '#' + Array.from({ length: len - 1 }, (_, k) => Math.round(ioi(i + k) * 20)).join(',');
    const j = seen.get(key);
    if (j === undefined) {
      seen.set(key, i);
      continue;
    }
    if (j + len > i) continue; // overlapping with itself (a repeated note or trill)
    for (let k = 0; k < len; k++) {
      const a = groups[j + k].notes;
      const b = groups[i + k].notes;
      a.forEach((n, x) => {
        const f = fingers.get(n.id);
        if (f && !priors.has(b[x].id)) priors.set(b[x].id, { fingers: [f], weight, source: 'motif' });
      });
    }
  }
  return priors;
}
