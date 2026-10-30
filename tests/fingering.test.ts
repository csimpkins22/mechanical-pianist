import { describe, expect, test } from 'vitest';
import type { Finger, Hand, ScoreNote } from '../src/core/types';
import { MAJOR_STEPS, scaleFingers } from '../src/interpretation/Conventions';
import { fingerHand } from '../src/interpretation/Fingering';
import { motifPriors } from '../src/interpretation/Patterns';
import { planPerformance } from '../src/interpretation/PerformancePlanner';
import { parseNoteName } from '../src/core/keyboard';
import { line, scoreOf } from './helpers';

function notesOf(midis: number[], step: number): ScoreNote[] {
  return midis.map((m, i) => ({ id: i, midi: m, start: i * step, end: i * step + step * 1.02, velocity: 0.6, track: 0 }));
}

function fingers(midis: number[], hand: Hand, step: number): Finger[] {
  const ns = notesOf(midis, step);
  const res = fingerHand(ns, hand, new Map());
  return ns.map((n) => res.fingers.get(n.id)!);
}

describe('fingering: conventions', () => {
  test('all 24 major scales, two octaves up and down, follow conventional fingering', () => {
    let match = 0;
    let total = 0;
    for (const hand of ['R', 'L'] as Hand[])
      for (let pc = 0; pc < 12; pc++) {
        const base = (hand === 'R' ? 60 : 36) + pc;
        const up: number[] = [];
        for (let o = 0; o < 2; o++) for (const s of MAJOR_STEPS) up.push(base + 12 * o + s);
        up.push(base + 24);
        const want = scaleFingers(pc, hand, up);
        const seq = [...up, ...up.slice(0, -1).reverse()];
        const wantSeq = [...want, ...want.slice(0, -1).reverse()];
        const got = fingers(seq, hand, 0.125);
        // every scale itself must be nearly conventional (turnarounds may differ)
        let m = 0;
        got.forEach((f, i) => (m += f === wantSeq[i] ? 1 : 0));
        expect(m, `${hand} ${pc}`).toBeGreaterThanOrEqual(seq.length - 3);
        match += m;
        total += seq.length;
      }
    expect(match / total).toBeGreaterThan(0.96);
  });

  test('right-hand C major arpeggio: 1-2-3 groups, 5 on top', () => {
    const up = ['C4', 'E4', 'G4', 'C5', 'E5', 'G5', 'C6'].map(parseNoteName);
    expect(fingers(up, 'R', 0.15).join('')).toBe('1231235');
  });

  test('A harmonic minor uses the A major pattern, thumb on A and D', () => {
    const run = ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G#5', 'A5', 'B5', 'C6', 'D6', 'E6', 'F6', 'G#6', 'A6'].map(parseNoteName);
    expect(fingers(run, 'R', 0.15).join('')).toBe('123123412312345');
  });

  test('fast repeated notes change finger down the hand; slow ones keep it', () => {
    const fast = fingers(Array(8).fill(parseNoteName('E5')), 'R', 0.1);
    for (let i = 1; i < fast.length; i++) {
      expect(fast[i]).not.toBe(fast[i - 1]);
      // never step back up by one (4-3-2-3): a cycle resets instead
      expect(fast[i] - fast[i - 1]).not.toBe(1);
    }
    const slow = fingers(Array(4).fill(parseNoteName('E5')), 'R', 0.6);
    expect(new Set(slow).size).toBe(1);
  });

  test('a repeated figure is pointed at the fingering of its first appearance', () => {
    const fig = ['E5', 'G5', 'F5', 'D5', 'E5'];
    const ns = notesOf([...['C5', 'D5'], ...fig, ...['A5', 'C6', 'B5'], ...fig].map(parseNoteName), 0.2);
    const first = new Map(ns.map((n) => [n.id, ((n.id % 5) + 1) as Finger]));
    const pri = motifPriors(ns, first);
    for (let k = 0; k < 5; k++) expect(pri.get(10 + k)?.fingers).toEqual([first.get(2 + k)]);
    expect(pri.has(2)).toBe(false); // the first appearance is free
  });

  test('a repeated figure after a different approach keeps its fingering', () => {
    const fig = ['E5', 'G5', 'F5', 'D5', 'E5'];
    const ns = [...['C5', 'D5'], ...fig, ...['B4', 'C5', 'D5', 'C5'], ...fig].map(parseNoteName);
    const f = fingers(ns, 'R', 0.2);
    expect(f.slice(2, 7)).toEqual(f.slice(11, 16));
  });

  test('recognised figures are labelled on the notes', () => {
    const p = planPerformance(scoreOf(line('C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6', { step: 0.15 })));
    expect(p.notes.filter((n) => n.flags.includes('scale')).length).toBeGreaterThan(10);
  });
});
