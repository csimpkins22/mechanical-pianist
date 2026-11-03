import { describe, expect, test } from 'vitest';
import { planPerformance } from '../src/interpretation/PerformancePlanner';
import { buildScore, readMidi } from '../src/interpretation/MidiEngine';
import { composeNocturne, composePhrase, midiBytes } from '../src/interpretation/demoPiece';
import { noteName } from '../src/core/keyboard';
import type { Performance } from '../src/core/types';
import { line, scoreOf } from './helpers';

const fingersOf = (p: Performance, hand?: 'L' | 'R') =>
  p.notes.filter((n) => !hand || n.hand === hand).map((n) => n.finger).join('');

/**
 * A two-octave scale played the way pianists do: three thumb crossings, each
 * after finger 3 or 4, finishing 3-4-5 (any of 123-1234-123-12345 and its
 * permutations is musically correct).
 */
function expectScaleFingering(f: string, ascending: boolean) {
  expect(f.startsWith('1')).toBe(ascending);
  const crossings = [...f.matchAll(/([2-5])1/g)];
  expect(crossings).toHaveLength(3);
  for (const c of crossings) expect(['3', '4']).toContain(c[1]);
  expect(f.endsWith('345')).toBe(true);
}

describe('fingering: scales and patterns', () => {
  test('five-finger position', () => {
    const p = planPerformance(scoreOf(line('C4 D4 E4 F4 G4', { step: 0.25 })));
    expect(fingersOf(p)).toBe('12345');
    expect(new Set(p.notes.map((n) => n.hand))).toEqual(new Set(['R']));
  });

  test('right hand C major, two octaves up: thumb passes under after 3 and 4', () => {
    const p = planPerformance(scoreOf(line('C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6', { step: 0.15 })));
    expectScaleFingering(fingersOf(p), true);
  });

  test('right hand C major, two octaves down: fingers cross over the thumb', () => {
    const p = planPerformance(scoreOf(line('C6 B5 A5 G5 F5 E5 D5 C5 B4 A4 G4 F4 E4 D4 C4', { step: 0.15 })));
    expectScaleFingering(fingersOf(p).split('').reverse().join(''), true);
  });

  test('left hand C major, one octave up', () => {
    const p = planPerformance(scoreOf(line('C3 D3 E3 F3 G3 A3 B3 C4', { step: 0.15 })));
    expect(new Set(p.notes.map((n) => n.hand))).toEqual(new Set(['L']));
    expect(fingersOf(p)).toBe('54321321');
  });

  test('A harmonic minor keeps the thumb off G#', () => {
    const p = planPerformance(scoreOf(line('A4 B4 C5 D5 E5 F5 G#5 A5 B5 C6 D6 E6 F6 G#6 A6', { step: 0.15 })));
    const thumbOnBlack = p.notes.filter((n) => n.finger === 1 && [1, 3, 6, 8, 10].includes(n.midi % 12));
    expect(thumbOnBlack).toHaveLength(0);
    expectScaleFingering(fingersOf(p), true);
  });

  test('triads use 1-3-5 (right) and 5-3-1 (left)', () => {
    const p = planPerformance(scoreOf(line('C4+E4+G4', { step: 1 }), line('C3+E3+G3', { step: 1, start: 2 })));
    const rh = p.byHand.R.map((n) => n.finger).join('');
    const lh = p.byHand.L.map((n) => n.finger).join('');
    expect(rh).toBe('135');
    expect(lh).toBe('531');
  });

  test('a fast trill alternates two fingers', () => {
    const p = planPerformance(scoreOf(line('C5 D5 C5 D5 C5 D5 C5 D5 C5 D5', { step: 0.08 })));
    const byPitch = new Map<number, Set<number>>();
    for (const n of p.notes) {
      if (!byPitch.has(n.midi)) byPitch.set(n.midi, new Set());
      byPitch.get(n.midi)!.add(n.finger);
    }
    const c = [...byPitch.get(72)!];
    const d = [...byPitch.get(74)!];
    expect(c).toHaveLength(1);
    expect(d).toHaveLength(1);
    expect(c[0]).not.toBe(d[0]);
  });

  test('fast repeated notes are allowed, never reported as conflicts', () => {
    const p = planPerformance(scoreOf(line('G4 G4 G4 G4 G4 G4', { step: 0.1, dur: 0.08 })));
    expect(p.notes.every((n) => !n.flags.includes('finger-conflict'))).toBe(true);
  });

  test('no finger is ever holding two keys', () => {
    const p = planPerformance(scoreFromDemo());
    for (const hand of ['L', 'R'] as const) {
      const list = p.byHand[hand].filter((n) => !n.flags.includes('chord-overflow'));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length && list[j].start < list[i].keyEnd; j++) {
          if (list[j].finger === list[i].finger && list[j].midi !== list[i].midi) {
            throw new Error(`${hand}${list[i].finger} holds ${noteName(list[i].midi)} and ${noteName(list[j].midi)} at ${list[j].start.toFixed(2)}`);
          }
        }
    }
  });
});

describe('hand assignment', () => {
  test('a melody that dips below middle C stays in one hand', () => {
    const p = planPerformance(scoreOf(line('E4 D4 C4 B3 A3 B3 C4 D4 E4', { step: 0.3 })));
    expect(new Set(p.notes.map((n) => n.hand)).size).toBe(1);
  });

  test('simultaneous bass and treble split between hands', () => {
    const p = planPerformance(scoreOf(line('C2+C6', { step: 1 })));
    expect(p.notes.map((n) => n.hand).join('')).toBe('LR');
  });

  test('overlapping registers: two lines crossing middle C keep their hands', () => {
    const lh = line('G3 A3 B3 C4 D4 C4 B3 A3', { step: 0.4, track: 1 });
    const rh = line('E4 D4 C4 B3 C4 D4 E4 F4', { step: 0.4, start: 0.2, track: 0 });
    const s = scoreOf(rh, lh);
    s.tracks[0].name = 'Right Hand';
    s.tracks[1].name = 'Left Hand';
    const p = planPerformance(s);
    expect(p.notes.filter((n) => n.track === 1).every((n) => n.hand === 'L')).toBe(true);
    expect(p.notes.filter((n) => n.track === 0).every((n) => n.hand === 'R')).toBe(true);
  });

  test('wide leaps are reachable for the hands, not flagged', () => {
    const p = planPerformance(scoreOf(line('C4 E4 G4 r C6 E6 G6', { step: 0.5 })));
    expect(p.stats.approximated).toBe(0);
  });

  test('an impossible chord is detected and flagged, not faked', () => {
    // twelve simultaneous notes: more than ten fingers
    const p = planPerformance(scoreOf(line('C2+E2+G2+C3+E3+G3+C5+E5+G5+C6+E6+G6', { step: 1 })));
    expect(p.notes.filter((n) => n.flags.includes('chord-overflow')).length).toBeGreaterThanOrEqual(2);
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  test('a bass note held under the pedal lets its hand go: the chord above is shared, not stretched over two octaves', () => {
    // as in Debussy's Clair de lune, bar 15: a low octave caught by the pedal,
    // then F-G♭-B♭ for the left hand and F-B♭-F an octave above for the right
    // (with or without the pedal: a hand gives up a key rather than reach two octaves)
    for (const pedalled of [true, false]) {
      const s = scoreOf(line('D#1+D#2', { step: 2.5 }), line('F4+F#4+A#4+F5+A#5+F6', { start: 0.65, step: 1.4 }));
      if (pedalled) s.pedal = [{ time: 0.15, down: true }, { time: 2.4, down: false }];
      const p = planPerformance(s);
      expect(p.notes.map((n) => `${noteName(n.midi)}${n.hand}`).join(' ')).toBe('D#1L D#2L F4L F#4L A#4L F5R A#5R F6R');
      expect(p.notes.filter((n) => n.flags.includes('unreachable') || n.flags.includes('chord-overflow'))).toEqual([]);
    }
  });

  test('overrides are honoured', () => {
    const s = scoreOf(line('C4 D4 E4 F4 G4', { step: 0.25 }));
    const p = planPerformance(s, new Map([[2, { finger: 4 as const }]]));
    expect(p.notes[2].finger).toBe(4);
    expect(p.notes[2].flags).toContain('finger-override');
    const q = planPerformance(s, new Map([[0, { hand: 'L' as const }]]));
    expect(q.notes[0].hand).toBe('L');
  });
});

function scoreFromDemo() {
  const parsed = readMidi(midiBytes(composeNocturne()), 'demo.mid');
  return buildScore(parsed);
}

describe('MIDI engine and demo', () => {
  test('the demo round-trips through a real MIDI file', () => {
    const parsed = readMidi(midiBytes(composeNocturne()), 'demo.mid');
    expect(parsed.tracks.map((t) => t.name)).toEqual(['Right Hand', 'Left Hand']);
    const score = buildScore(parsed);
    expect(score.notes.length).toBeGreaterThan(200);
    expect(score.tempos.length).toBeGreaterThan(5);
    expect(score.pedal.length).toBeGreaterThan(20);
    expect(score.duration).toBeGreaterThan(70);
    expect(score.duration).toBeLessThan(110);
    // tempo changes are honoured: the same beat length differs between sections
    const bpms = new Set(score.tempos.map((t) => Math.round(t.bpm)));
    expect(bpms.size).toBeGreaterThan(4);
  });

  test('the demo plans without approximations, deterministically', () => {
    const a = planPerformance(scoreFromDemo());
    const b = planPerformance(scoreFromDemo());
    expect(a.stats.approximated).toBe(0);
    expect(a.notes.map((n) => n.hand + n.finger).join()).toBe(b.notes.map((n) => n.hand + n.finger).join());
    // the left-hand track is played by the left hand
    expect(a.notes.filter((n) => n.track === 1).every((n) => n.hand === 'L')).toBe(true);
  });

  test('the five-note phrase', () => {
    const p = planPerformance(buildScore(readMidi(midiBytes(composePhrase()), 'phrase.mid')));
    const rh = p.byHand.R.map((n) => `${noteName(n.midi)}:${n.finger}`).join(' ');
    expect(p.byHand.R).toHaveLength(5);
    expect(rh.startsWith('A4:1')).toBe(true);
  });
});

describe('études (the test passages)', () => {
  test('plan with every note in reach and no finger conflicts', async () => {
    const { composeEtudes } = await import('../src/interpretation/demoPiece');
    const score = buildScore(readMidi(midiBytes(composeEtudes()), 'etudes.mid'));
    expect(score.tempos.some((t) => Math.round(t.bpm) === 112)).toBe(true);
    const p = planPerformance(score);
    expect(p.stats.approximated).toBe(0);
    // both scales get thumb crossings
    for (const hand of ['L', 'R'] as const) {
      const ones = p.byHand[hand].filter((n) => n.finger === 1).length;
      expect(ones).toBeGreaterThan(4);
    }
  });
});
