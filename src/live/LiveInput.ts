// What the player plays on: a MIDI keyboard (Web MIDI: any connected input,
// plugged in or out while playing), or the computer keyboard laid out like a
// piano, the way music software does: the middle row the white keys (A is C),
// the row above the black ones, Z and X an octave down and up, C and V softer
// and louder, the space bar the sustain pedal.
import { HIGHEST_MIDI, LOWEST_MIDI } from '../core/keyboard';

export interface InputHandlers {
  note(on: boolean, midi: number, velocity: number): void;
  pedal(down: boolean): void;
  /** the devices or the keyboard's octave and loudness changed */
  changed(): void;
}

export type MidiState = 'asking' | 'connected' | 'none' | 'unavailable';

/** physical keys (KeyboardEvent.code) -> semitones above the octave's C */
export const KEYS: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
  Quote: 17,
};

const VELOCITIES = [0.25, 0.4, 0.55, 0.7, 0.85, 1];

/** a note within the piano's range (MIDI controllers reach further) */
const fold = (m: number) => {
  while (m < LOWEST_MIDI) m += 12;
  while (m > HIGHEST_MIDI) m -= 12;
  return m;
};

export class LiveInput {
  midi: MidiState = 'asking';
  devices: string[] = [];
  /** the computer keyboard: C of this octave on A (4 = middle C) */
  octave = 4;
  loudness = 3; // index into VELOCITIES
  private access: MIDIAccess | null = null;
  /** computer keys down, and the note each sounded (the octave may change while held) */
  private down = new Map<string, number>();
  private pedalKey = false;

  constructor(private h: InputHandlers) {}

  get velocity() {
    return VELOCITIES[this.loudness];
  }

  async startMidi() {
    const nav = navigator as Navigator & { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) {
      this.midi = 'unavailable';
      this.h.changed();
      return;
    }
    try {
      this.access = await nav.requestMIDIAccess({ sysex: false });
    } catch {
      this.midi = 'unavailable';
      this.h.changed();
      return;
    }
    this.access.onstatechange = () => this.listen();
    this.listen();
  }

  private listen() {
    if (!this.access) return;
    this.devices = [];
    this.access.inputs.forEach((input) => {
      if (input.state !== 'connected') return;
      this.devices.push(input.name || 'MIDI keyboard');
      input.onmidimessage = (e) => this.message(e.data);
    });
    this.midi = this.devices.length ? 'connected' : 'none';
    this.h.changed();
  }

  private message(d: Uint8Array | null) {
    if (!d || d.length < 2) return;
    const kind = d[0] & 0xf0;
    if (kind === 0x90 && d[2] > 0) this.h.note(true, fold(d[1]), d[2] / 127);
    else if (kind === 0x80 || (kind === 0x90 && d[2] === 0)) this.h.note(false, fold(d[1]), 0);
    else if (kind === 0xb0 && d[1] === 64) this.h.pedal(d[2] >= 64);
  }

  /** a computer key went down or up: true when it was the piano's */
  key(e: KeyboardEvent, down: boolean): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const code = e.code;
    if (code === 'Space') {
      e.preventDefault();
      if (down !== this.pedalKey) {
        this.pedalKey = down;
        this.h.pedal(down);
      }
      return true;
    }
    if (code in KEYS) {
      e.preventDefault();
      if (down) {
        if (e.repeat || this.down.has(code)) return true;
        const midi = fold(12 * (this.octave + 1) + KEYS[code]);
        this.down.set(code, midi);
        this.h.note(true, midi, this.velocity);
      } else {
        const midi = this.down.get(code);
        this.down.delete(code);
        if (midi !== undefined) this.h.note(false, midi, 0);
      }
      return true;
    }
    if (!down) return false;
    const step = (k: 'octave' | 'loudness', d: number, lo: number, hi: number) => {
      e.preventDefault();
      this[k] = Math.max(lo, Math.min(hi, this[k] + d));
      this.h.changed();
      return true;
    };
    if (code === 'KeyZ') return step('octave', -1, 1, 7);
    if (code === 'KeyX') return step('octave', 1, 1, 7);
    if (code === 'KeyC') return step('loudness', -1, 0, VELOCITIES.length - 1);
    if (code === 'KeyV') return step('loudness', 1, 0, VELOCITIES.length - 1);
    return false;
  }

  /** let go of every computer key (the window lost focus) */
  releaseKeys() {
    for (const midi of this.down.values()) this.h.note(false, midi, 0);
    this.down.clear();
    if (this.pedalKey) {
      this.pedalKey = false;
      this.h.pedal(false);
    }
  }

  stop() {
    this.releaseKeys();
    if (this.access) {
      this.access.onstatechange = null;
      this.access.inputs.forEach((i) => (i.onmidimessage = null));
    }
    this.access = null;
  }
}
