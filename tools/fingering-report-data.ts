// Runs the fingering engine on reference material and compares it with the
// conventional fingerings in src/interpretation/Conventions.ts. Bundled and
// run by tools/fingering-report.cjs.
import { noteName } from '../src/core/keyboard';
import type { Finger, Hand, ScoreNote } from '../src/core/types';
import { arpeggioFingers, CHORDS, KEY_NAMES, MAJOR_STEPS, scaleFingers } from '../src/interpretation/Conventions';
import { fingerHand } from '../src/interpretation/Fingering';
import { parseNoteName } from '../src/core/keyboard';

export interface Row {
  group: string;
  name: string;
  hand: Hand;
  notes: { name: string; got: Finger; want: Finger[] | null; chord: number }[];
}

function run(midis: number[][], hand: Hand, step: number, dur = step * 1.02): Finger[][] {
  const notes: ScoreNote[] = [];
  midis.forEach((g, i) => g.forEach((m) => notes.push({ id: notes.length, midi: m, start: i * step, end: i * step + dur, velocity: 0.6, track: 0 })));
  const res = fingerHand(notes, hand, new Map());
  let k = 0;
  return midis.map((g) => g.map(() => res.fingers.get(k++)!));
}

export function report(): Row[] {
  const rows: Row[] = [];
  for (const hand of ['R', 'L'] as Hand[]) {
    for (let pc = 0; pc < 12; pc++) {
      const base = (hand === 'R' ? 60 : 36) + pc;
      const up: number[] = [];
      for (let o = 0; o < 2; o++) for (const s of MAJOR_STEPS) up.push(base + 12 * o + s);
      up.push(base + 24);
      const want = scaleFingers(pc, hand, up);
      const seq = [...up, ...up.slice(0, -1).reverse()];
      const wantSeq = [...want, ...want.slice(0, -1).reverse()];
      const got = run(seq.map((m) => [m]), hand, 0.125);
      rows.push({
        group: 'Major scales, two octaves up and down (sixteenths at ♩=120)',
        name: `${KEY_NAMES[pc]} major`,
        hand,
        notes: seq.map((m, i) => ({ name: noteName(m), got: got[i][0], want: wantSeq[i] ? [wantSeq[i]!] : null, chord: 0 })),
      });
    }
  }
  for (const hand of ['R', 'L'] as Hand[]) {
    for (const root of ['C', 'F', 'G']) {
      const base = parseNoteName(`${root}${hand === 'R' ? 4 : 2}`);
      const up = [0, 4, 7, 12, 16, 19, 24].map((x) => base + x);
      const want = arpeggioFingers(hand, up.length);
      const seq = [...up, ...up.slice(0, -1).reverse()];
      const wantSeq = [...want, ...want.slice(0, -1).reverse()];
      const got = run(seq.map((m) => [m]), hand, 0.15);
      rows.push({
        group: 'Arpeggios, two octaves up and down',
        name: `${root} major`,
        hand,
        notes: seq.map((m, i) => ({ name: noteName(m), got: got[i][0], want: wantSeq[i], chord: 0 })),
      });
    }
  }
  for (const hand of ['R', 'L'] as Hand[]) {
    for (const c of CHORDS) {
      const ms = c.notes.split(' ').map((n) => parseNoteName(n) - (hand === 'L' ? 24 : 0));
      const got = run([ms], hand, 1.0)[0];
      rows.push({
        group: 'Chords',
        name: c.name,
        hand,
        notes: ms.map((m, i) => ({
          name: noteName(m),
          got: got[i],
          want: hand === 'R' ? [c.R[i]] : c.L.map((l) => l[i]),
          chord: 1,
        })),
      });
    }
  }
  for (const [name, step, n] of [
    ['Repeated note, fast (0.1 s)', 0.1, 8],
    ['Repeated note, slow (0.6 s)', 0.6, 4],
  ] as const) {
    const got = run(Array.from({ length: n }, () => [parseNoteName('E5')]), 'R', step);
    rows.push({ group: 'Repeated notes', name, hand: 'R', notes: got.map((g) => ({ name: 'E5', got: g[0], want: null, chord: 0 })) });
  }
  return rows;
}
