import { parseNoteName } from '../src/core/keyboard';
import type { Score, ScoreNote } from '../src/core/types';

/** "C4 D4 E4" at a fixed note length -> notes (all on track 0) */
export function line(text: string, opts: { start?: number; step?: number; dur?: number; track?: number; vel?: number } = {}): Omit<ScoreNote, 'id'>[] {
  const step = opts.step ?? 0.2;
  const dur = opts.dur ?? step * 1.02;
  let t = opts.start ?? 0;
  const out: Omit<ScoreNote, 'id'>[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (tok !== 'r') for (const p of tok.split('+')) out.push({ midi: parseNoteName(p), start: t, end: t + dur, velocity: opts.vel ?? 0.6, track: opts.track ?? 0 });
    t += step;
  }
  return out;
}

export function scoreOf(...parts: Omit<ScoreNote, 'id'>[][]): Score {
  const notes = parts
    .flat()
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
    .map((n, id) => ({ ...n, id }));
  const tracks = Array.from(new Set(notes.map((n) => n.track)))
    .sort((a, b) => a - b)
    .map((index) => ({
    index,
    name: `Track ${index + 1}`,
    instrument: 'piano',
    noteCount: notes.filter((n) => n.track === index).length,
    minMidi: 0,
    maxMidi: 127,
    isPiano: true,
    channel: 0,
  }));
  return {
    name: 'test',
    notes,
    pedal: [],
    tempos: [{ time: 0, bpm: 120 }],
    tracks,
    selectedTracks: tracks.map((t) => t.index),
    duration: Math.max(...notes.map((n) => n.end)) + 1,
    outOfRange: 0,
  };
}
