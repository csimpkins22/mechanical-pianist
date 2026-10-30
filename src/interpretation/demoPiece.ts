// The built-in demonstration pieces, written as data and rendered to a real
// Standard MIDI File, so they go through exactly the same parser as a file the
// user drops in.
//
// "Nocturne for Mechanical Hands" (original, A minor, about 85 s):
//   1. a slow, expressive melody over a simple broken-chord left hand
//   2. flowing arpeggios, handed from the left hand to the right
//   3. a rapid two-octave harmonic minor scale with thumb crossings
//   4. rich two-handed chords, pedalled
//   5. a large leap: the right hand jumps two octaves up, the left to the bass
//   6. the opening motif returns, and a quiet final chord with a long release
import { Midi } from '@tonejs/midi';
import { parseNoteName } from '../core/keyboard';
import { mulberry32 } from '../core/random';

type HandName = 'R' | 'L';

interface Ev {
  hand: HandName;
  beat: number;
  dur: number; // sounding length in beats
  midi: number;
  vel: number;
}

class Composer {
  events: Ev[] = [];
  tempos: { beat: number; bpm: number }[] = [];
  pedal: { beat: number; down: boolean }[] = [];
  private rnd = mulberry32(0x5eed);

  tempo(beat: number, bpm: number) {
    this.tempos.push({ beat, bpm });
  }

  /** a gradual tempo change made of small steps */
  ramp(beat0: number, beat1: number, bpm0: number, bpm1: number, steps = 6) {
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      this.tempo(beat0 + (beat1 - beat0) * u, bpm0 + (bpm1 - bpm0) * u);
    }
  }

  /** pedal down from b0 to b1 (re-pedalled just after the beat, as a pianist does) */
  ped(b0: number, b1: number) {
    this.pedal.push({ beat: b0 + 0.12, down: true });
    this.pedal.push({ beat: b1 - 0.06, down: false });
  }

  /**
   * A line of notes: "A4:1 C5:1 E5:2", chords with "+" ("A2+E3:2"), rests "r:1".
   * `legato` overlaps each note slightly into the next, like finger legato.
   * `vel` is a base velocity; `arc` shapes a phrase swell over the line.
   */
  line(hand: HandName, beat: number, text: string, vel: number, opts: { legato?: number; arc?: number; spread?: number } = {}) {
    const legato = opts.legato ?? 0.06;
    const arc = opts.arc ?? 0.08;
    const tokens = text.trim().split(/\s+/);
    const total = tokens.reduce((s, tk) => s + parseFloat(tk.split(':')[1]), 0);
    let b = beat;
    for (const tk of tokens) {
      const [pitchText, durText] = tk.split(':');
      const dur = parseFloat(durText);
      if (pitchText !== 'r') {
        const u = (b - beat + dur / 2) / total;
        const shape = Math.sin(Math.PI * Math.min(1, u * 1.15)); // peaks a little after the middle
        const pitches = pitchText.split('+').map(parseNoteName);
        pitches.forEach((midi, i) => {
          // chords: roll upward by a few ms, bass first; tiny human variation
          const roll = (opts.spread ?? 0.012) * i;
          const jitter = (this.rnd() - 0.5) * 0.02;
          const v = vel + arc * shape + (this.rnd() - 0.5) * 0.05 - (pitches.length > 1 && i > 0 && i < pitches.length - 1 ? 0.05 : 0);
          this.events.push({ hand, beat: b + roll + jitter, dur: dur + legato, midi, vel: Math.max(0.12, Math.min(0.98, v)) });
        });
      }
      b += dur;
    }
    return b;
  }

  toMidi(name: string): Midi {
    const midi = new Midi();
    midi.name = name;
    const ppq = midi.header.ppq;
    const ticks = (beat: number) => Math.max(0, Math.round(beat * ppq));
    midi.header.tempos = this.tempos
      .slice()
      .sort((a, b) => a.beat - b.beat)
      .map((t) => ({ bpm: t.bpm, ticks: ticks(t.beat) }));
    midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
    midi.header.update();
    for (const hand of ['R', 'L'] as HandName[]) {
      const tr = midi.addTrack();
      tr.name = hand === 'R' ? 'Right Hand' : 'Left Hand';
      tr.channel = 0;
      tr.instrument.number = 0;
      for (const e of this.events.filter((x) => x.hand === hand).sort((a, b) => a.beat - b.beat)) {
        tr.addNote({ midi: e.midi, ticks: ticks(e.beat), durationTicks: Math.max(1, ticks(e.beat + e.dur) - ticks(e.beat)), velocity: e.vel });
      }
      if (hand === 'R') {
        for (const p of this.pedal) tr.addCC({ number: 64, ticks: ticks(p.beat), value: p.down ? 1 : 0 });
      }
    }
    return midi;
  }
}

export function composeNocturne(): Midi {
  const c = new Composer();
  const bar = (n: number) => (n - 1) * 4;

  // 1. Andante: the five-note phrase opens the piece -------------------------
  c.tempo(0, 58);
  c.line('R', bar(1), 'A4:1 C5:1 E5:2 D5:1.5 C5:0.5 B4:2', 0.42, { arc: 0.12 });
  c.line('R', bar(3), 'C5:1 E5:1 A5:1.5 G5:0.5 F5:1 E5:1 D5:1 B4:1', 0.44, { arc: 0.14 });
  c.line('R', bar(5), 'C5:1 B4:0.5 A4:0.5 G#4:2 A4:3', 0.4, { arc: 0.1 });
  c.line('L', bar(1), 'A2:1 E3:1 A3:2 G2:1 D3:1 G3:2', 0.3, { arc: 0.05 });
  c.line('L', bar(3), 'F2:1 C3:1 A3:2 D2:1 A2:1 F3:2', 0.3, { arc: 0.05 });
  c.line('L', bar(5), 'E2:1 B2:1 E3:2 A2:1 E3:1 C4:2', 0.28, { arc: 0.05 });
  for (let b = 1; b <= 6; b++) c.ped(bar(b), bar(b + 1));
  c.ramp(bar(5), bar(6) + 3, 58, 50, 5);

  // 2. Flowing arpeggios, left hand into right ------------------------------
  c.tempo(bar(7), 66);
  c.line('L', bar(7), 'A2:0.25 E3:0.25 A3:0.25 C4:0.25 E4:0.25 C4:0.25 A3:0.25 E3:0.25 '.repeat(2), 0.36, { legato: 0.03, arc: 0.1 });
  c.line('L', bar(8), 'F2:0.25 C3:0.25 F3:0.25 A3:0.25 C4:0.25 A3:0.25 F3:0.25 C3:0.25 G2:0.25 D3:0.25 G3:0.25 B3:0.25 D4:0.25 B3:0.25 G3:0.25 D3:0.25', 0.38, { legato: 0.03, arc: 0.1 });
  c.line('R', bar(7), 'E5:2 D5:1 C5:1 C5:2 B4:1 D5:1', 0.5, { arc: 0.1 });
  c.ped(bar(7), bar(7) + 2);
  c.ped(bar(7) + 2, bar(8));
  c.ped(bar(8), bar(8) + 2);
  c.ped(bar(8) + 2, bar(9));
  c.tempo(bar(9), 70);
  c.line('R', bar(9), 'A4:0.25 C5:0.25 E5:0.25 A5:0.25 C6:0.25 A5:0.25 E5:0.25 C5:0.25 A4:0.25 C5:0.25 E5:0.25 A5:0.25 C6:0.25 E6:0.25 C6:0.25 A5:0.25', 0.46, { legato: 0.03, arc: 0.12 });
  c.line('R', bar(10), 'F4:0.25 A4:0.25 C5:0.25 F5:0.25 A5:0.25 F5:0.25 C5:0.25 A4:0.25 E4:0.25 G#4:0.25 B4:0.25 E5:0.25 G#5:0.25 E5:0.25 B4:0.25 G#4:0.25', 0.48, { legato: 0.03, arc: 0.12 });
  c.line('L', bar(9), 'A2+E3:2 A2+E3:2 F2+C3:2 E2+B2:2', 0.34, { legato: -0.1 });
  c.ped(bar(9), bar(9) + 2);
  c.ped(bar(9) + 2, bar(10));
  c.ped(bar(10), bar(10) + 2);
  c.ped(bar(10) + 2, bar(11));

  // 3. Rapid scale with thumb crossings ---------------------------------------
  c.tempo(bar(11), 84);
  const up = 'A4 B4 C5 D5 E5 F5 G#5 A5 B5 C6 D6 E6 F6 G#6';
  const down = 'A6 G#6 F6 E6 D6 C6 B5 A5 G#5 F5 E5 D5 C5 B4';
  c.line('R', bar(11), up.split(' ').map((p) => `${p}:0.25`).join(' ') + ' ' + down.split(' ').map((p) => `${p}:0.25`).join(' ') + ' A4:0.5 r:0.5 ', 0.5, { legato: 0.015, arc: 0.18 });
  c.line('L', bar(11), 'A2+A3:4 E2+E3:2 A2+E3:1 r:1', 0.4, { arc: 0.06, legato: -0.1 });
  c.ped(bar(12) + 2, bar(13));

  // 4. Rich two-handed chords --------------------------------------------------
  c.tempo(bar(13), 58);
  c.line('L', bar(13), 'F2+C3+F3:2 G2+D3+G3:2 E2+B2+E3:2 A2+E3+A3:2', 0.62, { arc: 0.12, spread: 0.008, legato: -0.12 });
  c.line('R', bar(13), 'A4+C5+F5:2 B4+D5+G5:2 G#4+B4+E5:2 A4+C5+E5+A5:2', 0.64, { arc: 0.16, spread: 0.006, legato: -0.12 });
  c.line('L', bar(15), 'D2+A2+D3:2 B1+F2+B2:2 E2+E3:4', 0.6, { arc: 0.1, spread: 0.008, legato: -0.12 });
  c.line('R', bar(15), 'F4+A4+D5+F5:2 G#4+B4+D5+F5:2 G#4+B4+D5+E5:4', 0.66, { arc: 0.12, spread: 0.006, legato: -0.12 });
  for (let k = 0; k < 6; k++) c.ped(bar(13) + 2 * k, bar(13) + 2 * k + 2);
  c.ped(bar(16), bar(17));
  c.ramp(bar(16), bar(16) + 4, 58, 50, 4);

  // 5. The leap: right hand two octaves up, left hand to the bass ----------
  c.tempo(bar(17), 62);
  c.line('R', bar(17), 'A6:1 E6:0.5 C7:0.5 B6:2 G#6:1 E6:0.5 B6:0.5 A6:2', 0.5, { arc: 0.12 });
  c.line('L', bar(17), 'A1+A2:4 E1+E2:2 A1+A2:2', 0.42, { arc: 0.06, legato: -0.1 });
  c.ped(bar(17), bar(18));
  c.ped(bar(18), bar(19));

  // 6. Coda: the opening returns, and a quiet A major chord ------------------
  c.tempo(bar(19), 54);
  c.line('R', bar(19), 'A4:1 C5:1 E5:2 D5:1.5 C5:0.5 B4:1 G#4:1', 0.34, { arc: 0.08 });
  c.line('L', bar(19), 'A2+E3:4 F2+C3:2 E2+B2:2', 0.24, { arc: 0.04, legato: -0.1 });
  c.ramp(bar(20), bar(21), 54, 44, 5);
  c.tempo(bar(21), 40);
  c.line('L', bar(21), 'A1+E2+A2:6', 0.24, { spread: 0.03, legato: 0 });
  c.line('R', bar(21), 'C#5+E5+A5:6', 0.27, { spread: 0.03, legato: 0 });
  c.ped(bar(19), bar(20));
  c.ped(bar(20), bar(21));
  c.ped(bar(21), bar(21) + 7.4);
  return c.toMidi('Nocturne for Mechanical Hands');
}

/** The first visual milestone: one five-note phrase, played beautifully. */
export function composePhrase(): Midi {
  const c = new Composer();
  c.tempo(0, 56);
  c.line('R', 1, 'A4:1 C5:1 E5:2 D5:1.5 C5:2.5', 0.44, { arc: 0.14 });
  c.line('L', 1, 'A2+E3:8', 0.26, { legato: 0 });
  c.ped(1, 9.3);
  return c.toMidi('Five-Note Phrase');
}

/**
 * Études: the test passages, one after another, so each can be watched (and
 * checked in the debug view): five-finger position, two-octave scales in both
 * hands with thumb crossings, a trill, repeated notes, fast arpeggios, wide
 * leaps, interlocking hands in the same register, a tempo change and pedalled
 * two-handed chords.
 */
export function composeEtudes(): Midi {
  const c = new Composer();
  const sixteenths = (notes: string) => notes.split(' ').map((p) => `${p}:0.25`).join(' ');
  c.tempo(0, 92);
  // five-finger position, then the same in the left hand
  c.line('R', 0, 'C4:0.5 D4:0.5 E4:0.5 F4:0.5 G4:0.5 F4:0.5 E4:0.5 D4:0.5 C4:1', 0.5, { legato: 0.04 });
  c.line('L', 5, 'C3:0.5 D3:0.5 E3:0.5 F3:0.5 G3:0.5 F3:0.5 E3:0.5 D3:0.5 C3:1', 0.45, { legato: 0.04 });
  // two-octave C major scales, up and down, right then left (thumb crossings)
  const up = 'C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6';
  const dn = 'B5 A5 G5 F5 E5 D5 C5 B4 A4 G4 F4 E4 D4 C4';
  c.line('R', 11, sixteenths(`${up} ${dn}`) + ' r:0.75', 0.5, { legato: 0.02, arc: 0.15 });
  c.line('L', 19, sixteenths(`${up.replace(/(\d)/g, (d) => String(+d - 2))} ${dn.replace(/(\d)/g, (d) => String(+d - 2))}`) + ' r:0.75', 0.48, { legato: 0.02, arc: 0.15 });
  // a trill, then fast repeated notes
  c.line('R', 27, sixteenths('E5 F5 E5 F5 E5 F5 E5 F5 E5 F5 E5 F5 E5 F5 E5 D5') + ' E5:1', 0.45, { legato: 0.01 });
  c.line('R', 32, 'G4:0.25 G4:0.25 G4:0.25 G4:0.25 G4:0.25 G4:0.25 G4:0.25 G4:0.25 C5:1', 0.5, { legato: -0.06 });
  c.line('L', 32, 'C3+G3:2 C3+G3:1', 0.35, { legato: -0.05 });
  // a tempo change: fast arpeggios in both hands
  c.tempo(36, 112);
  c.line('L', 36, sixteenths('C2 G2 C3 E3 G3 C4 G3 E3 C3 G2 C2 G2 C3 E3 G3 C4'), 0.45, { legato: 0.02, arc: 0.12 });
  c.line('R', 40, sixteenths('C4 E4 G4 C5 E5 G5 C6 G5 E5 C5 G4 E4 C4 E4 G4 C5'), 0.5, { legato: 0.02, arc: 0.12 });
  c.ped(36, 40);
  c.ped(40, 44.2);
  // wide leaps: bass to treble and back
  c.tempo(44.5, 76);
  c.line('L', 44.5, 'C1+C2:1 r:1 C2+G2:1 r:1', 0.55, { legato: -0.1 });
  c.line('R', 45.5, 'E6+G6+C7:1 r:1 C4+E4+G4:1 r:0.5', 0.5, { legato: -0.1 });
  // interlocking hands in the same register
  c.line('L', 49.5, 'E4:0.5 G4:0.5 E4:0.5 G4:0.5 F4:0.5 A4:0.5 F4:0.5 A4:0.5', 0.4, { legato: -0.05 });
  c.line('R', 49.75, 'C5:0.5 B4:0.5 C5:0.5 B4:0.5 D5:0.5 C5:0.5 D5:0.5 C5:0.25', 0.45, { legato: -0.05 });
  // pedalled chords and a slow close
  c.tempo(54, 60);
  c.line('L', 54, 'F2+C3+F3:2 G2+D3+G3:2 C2+G2+C3:4', 0.55, { legato: -0.12, spread: 0.01 });
  c.line('R', 54, 'A4+C5+F5:2 B4+D5+G5:2 C5+E5+G5+C6:4', 0.58, { legato: -0.12, spread: 0.008 });
  c.ped(54, 56);
  c.ped(56, 58);
  c.ped(58, 62.5);
  return c.toMidi('Études for Mechanical Hands');
}

export function midiBytes(m: Midi): Uint8Array {
  return m.toArray();
}
