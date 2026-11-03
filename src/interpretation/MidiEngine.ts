// MIDI file -> Score: tempo-aware, normalised note and pedal events.
import { Midi } from '@tonejs/midi';
import { HIGHEST_MIDI, LOWEST_MIDI } from '../core/keyboard';
import type { PedalEvent, PedalLevel, Score, ScoreNote, TempoEvent, TrackInfo } from '../core/types';

const MIN_DURATION = 0.035;
/** onsets closer than this on the same pitch are treated as one note */
const DUPLICATE_WINDOW = 0.012;

export interface ParsedMidi {
  midi: Midi;
  name: string;
  tracks: TrackInfo[];
}

export function readMidi(data: ArrayBuffer | Uint8Array, name: string): ParsedMidi {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const midi = new Midi(bytes);
  const tracks: TrackInfo[] = midi.tracks.map((t, index) => {
    const pitches = t.notes.map((n) => n.midi);
    const instrument = t.instrument?.name ?? '';
    const family = t.instrument?.family ?? '';
    const percussion = t.channel === 9 || t.instrument?.percussion === true;
    const lname = `${t.name} ${instrument}`.toLowerCase();
    const isPiano =
      !percussion &&
      t.notes.length > 0 &&
      ((t.instrument?.number ?? 0) <= 7 || family === 'piano' || /piano|keys|klavier|rh|lh|right|left|hand/.test(lname));
    return {
      index,
      name: t.name || `Track ${index + 1}`,
      instrument: percussion ? 'percussion' : instrument || 'piano',
      noteCount: t.notes.length,
      minMidi: pitches.length ? Math.min(...pitches) : 0,
      maxMidi: pitches.length ? Math.max(...pitches) : 0,
      isPiano,
      channel: t.channel,
    };
  });
  const title = midi.name?.trim() || name.replace(/\.(mid|midi)$/i, '');
  return { midi, name: title, tracks };
}

/** Tracks to perform by default: all piano tracks, else all melodic tracks with notes. */
export function defaultTrackSelection(tracks: TrackInfo[]): number[] {
  const piano = tracks.filter((t) => t.isPiano).map((t) => t.index);
  if (piano.length) return piano;
  return tracks.filter((t) => t.noteCount > 0 && t.instrument !== 'percussion').map((t) => t.index);
}

export function buildScore(parsed: ParsedMidi, selectedTracks?: number[]): Score {
  const { midi } = parsed;
  const selected = selectedTracks ?? defaultTrackSelection(parsed.tracks);
  const raw: Omit<ScoreNote, 'id'>[] = [];
  let outOfRange = 0;
  for (const ti of selected) {
    const t = midi.tracks[ti];
    if (!t) continue;
    for (const n of t.notes) {
      let p = n.midi;
      if (p < LOWEST_MIDI || p > HIGHEST_MIDI) {
        outOfRange++;
        // fold into range by octaves rather than lose the note
        while (p < LOWEST_MIDI) p += 12;
        while (p > HIGHEST_MIDI) p -= 12;
      }
      raw.push({
        midi: p,
        start: n.time,
        end: n.time + Math.max(n.duration, MIN_DURATION),
        velocity: Math.max(0.05, Math.min(1, n.velocity)),
        track: ti,
      });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.midi - b.midi || b.velocity - a.velocity);

  // same pitch: merge duplicates, then make sure a key is released before it is struck again
  const lastByPitch = new Map<number, Omit<ScoreNote, 'id'>>();
  const kept: Omit<ScoreNote, 'id'>[] = [];
  for (const n of raw) {
    const prev = lastByPitch.get(n.midi);
    if (prev && n.start - prev.start < DUPLICATE_WINDOW) {
      prev.end = Math.max(prev.end, n.end);
      prev.velocity = Math.max(prev.velocity, n.velocity);
      continue;
    }
    if (prev && prev.end > n.start - 0.004) {
      prev.end = Math.max(prev.start + 0.02, n.start - 0.004);
    }
    lastByPitch.set(n.midi, n);
    kept.push(n);
  }
  const notes: ScoreNote[] = kept.map((n, id) => ({ ...n, id }));

  // sustain pedal: from the selected tracks, or from any track if none carry it
  const pedalFrom = (tis: number[]) => {
    const ev: PedalEvent[] = [];
    for (const ti of tis) {
      const cc = midi.tracks[ti]?.controlChanges?.[64] ?? [];
      for (const c of cc) ev.push({ time: c.time, down: c.value >= 0.5 });
    }
    return ev;
  };
  let pedalRaw = pedalFrom(selected);
  if (!pedalRaw.length) pedalRaw = pedalFrom(midi.tracks.map((_, i) => i));
  pedalRaw.sort((a, b) => a.time - b.time);
  const pedal: PedalEvent[] = [];
  for (const e of pedalRaw) {
    if (pedal.length && pedal[pedal.length - 1].down === e.down) continue;
    if (!pedal.length && !e.down) continue;
    pedal.push(e);
  }

  // the pedals' positions, half-pedalling included: the sustain pedal from the
  // same tracks as above, the soft pedal (CC67) from any track
  const levels = (num: number, tis: number[]) => {
    const raw: PedalLevel[] = [];
    for (const ti of tis) for (const c of midi.tracks[ti]?.controlChanges?.[num] ?? []) raw.push({ time: c.time, value: Math.max(0, Math.min(1, c.value)) });
    raw.sort((a, b) => a.time - b.time);
    const out: PedalLevel[] = [];
    for (const e of raw) {
      const last = out.length ? out[out.length - 1].value : 0;
      if (Math.abs(e.value - last) < 1 / 254) continue;
      if (out.length && out[out.length - 1].time === e.time) out[out.length - 1] = e;
      else out.push(e);
    }
    return out;
  };
  const sustainTracks = pedalFrom(selected).length ? selected : midi.tracks.map((_, i) => i);
  const pedalLevels = levels(64, sustainTracks);
  const soft = levels(67, midi.tracks.map((_, i) => i));

  const tempos: TempoEvent[] = (midi.header.tempos.length ? midi.header.tempos : [{ bpm: 120, ticks: 0 }]).map((t) => ({
    time: midi.header.ticksToSeconds(t.ticks),
    bpm: t.bpm,
  }));

  const lastEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const lastPedal = pedal.length ? pedal[pedal.length - 1].time : 0;
  return {
    name: parsed.name,
    notes,
    pedal,
    pedalLevels,
    ...(soft.length ? { soft } : {}),
    tempos,
    tracks: parsed.tracks,
    selectedTracks: selected,
    duration: Math.max(lastEnd, lastPedal) + 1.5,
    outOfRange,
  };
}

/** Is the sustain pedal down at time t? */
export function pedalDownAt(pedal: PedalEvent[], t: number): boolean {
  let lo = 0;
  let hi = pedal.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pedal[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && pedal[ans].down;
}
