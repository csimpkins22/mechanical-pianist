// A drum performance read from MIDI: General MIDI percussion (channel 10)
// mapped onto the kit in KitLayout, with the Roland TD-11 note variants that
// Google's Groove MIDI Dataset was recorded with (closed and open hi-hat bow
// and edge, the pedal, rimshots and cross-sticks, the ride's bell and edge,
// crash bow and edge). The hi-hat pedal comes from CC4 where the file has it
// (an e-kit's pedal position), otherwise it is inferred from the notes:
// the foot lifts before an open hit and closes on the next closed or pedal
// note. Cymbal chokes come from polyphonic aftertouch (a hand grabbing the
// cymbal, as e-kits send it). Everything here is a pure function of the bytes.
import { Midi } from '@tonejs/midi';
import { DRUMS, type DrumId } from './KitLayout';
import { hash01 } from '../core/random';

/** where on a drum or cymbal a note is played */
export type Zone = 'head' | 'rim' | 'crossStick' | 'bow' | 'edge' | 'bell' | 'pedal';

export interface NoteMapping {
  piece: DrumId;
  zone: Zone;
  /** what it is, for the debug overlay and tests */
  name: string;
}

/**
 * General MIDI percussion, with the TD-11's own uses of some keys (the Groove
 * MIDI Dataset's mapping) where they differ: 22 and 26 are the hi-hat's edge,
 * 40 the snare's rim, 50, 47 and 58 the toms' rims, 55 and 52 the crashes' edges,
 * 59 the ride's edge. A second crash (57, 52) plays the one crash in the kit.
 * Keys with no drum in this kit (hand percussion) are left out.
 */
export const DRUM_MAP: Record<number, NoteMapping> = {
  35: { piece: 'kick', zone: 'head', name: 'Acoustic bass drum' },
  36: { piece: 'kick', zone: 'head', name: 'Bass drum' },
  37: { piece: 'snare', zone: 'crossStick', name: 'Cross-stick' },
  38: { piece: 'snare', zone: 'head', name: 'Snare' },
  40: { piece: 'snare', zone: 'rim', name: 'Snare rimshot' },
  48: { piece: 'tom1', zone: 'head', name: 'High tom' },
  50: { piece: 'tom1', zone: 'rim', name: 'High tom rim' },
  45: { piece: 'tom2', zone: 'head', name: 'Mid tom' },
  47: { piece: 'tom2', zone: 'rim', name: 'Mid tom rim' },
  43: { piece: 'floorTom', zone: 'head', name: 'Floor tom' },
  41: { piece: 'floorTom', zone: 'head', name: 'Low floor tom' },
  58: { piece: 'floorTom', zone: 'rim', name: 'Floor tom rim' },
  42: { piece: 'hihat', zone: 'bow', name: 'Hi-hat closed' },
  22: { piece: 'hihat', zone: 'edge', name: 'Hi-hat closed edge' },
  46: { piece: 'hihat', zone: 'bow', name: 'Hi-hat open' },
  26: { piece: 'hihat', zone: 'edge', name: 'Hi-hat open edge' },
  44: { piece: 'hihat', zone: 'pedal', name: 'Hi-hat pedal' },
  49: { piece: 'crash', zone: 'bow', name: 'Crash' },
  55: { piece: 'crash', zone: 'edge', name: 'Crash edge' },
  57: { piece: 'crash', zone: 'bow', name: 'Crash 2' },
  52: { piece: 'crash', zone: 'edge', name: 'Crash 2 edge' },
  51: { piece: 'ride', zone: 'bow', name: 'Ride' },
  59: { piece: 'ride', zone: 'edge', name: 'Ride edge' },
  53: { piece: 'ride', zone: 'bell', name: 'Ride bell' },
};

/** the GM keys that ask for an open hi-hat (the pedal is lifted for them when there is no CC4) */
const HH_OPEN_KEYS = new Set([46, 26]);
const HH_CLOSED_KEYS = new Set([42, 22]);

export interface DrumHit {
  /** index in time order */
  i: number;
  t: number;
  midi: number;
  /** 0..1 */
  velocity: number;
  piece: DrumId;
  zone: Zone;
  /** where the stick lands: 0 = the centre of the playing surface, 1 = its edge */
  r: number;
  /** and where around it, radians from the side nearest the drummer */
  angle: number;
  /**
   * a cross-stick note in the middle of the snare's own playing (another snare note within CLICK_WINDOW, as in a
   * second line's rolls): there is no time to lay the stick across the drum, so it is a rim click, the shaft on
   * the near hoop as for a rimshot. It still sounds as the cross-stick the kit recorded.
   */
  click?: boolean;
}

export interface PedalPoint {
  t: number;
  /** 0 = the foot up (the hi-hat open), 1 = pressed (closed) */
  closed: number;
}

export interface DrumPerformance {
  name: string;
  duration: number;
  hits: DrumHit[];
  /** the hi-hat pedal over time, piecewise linear */
  hihat: PedalPoint[];
  /** true when the pedal came from the file's CC4, false when inferred from the notes */
  hihatFromCC: boolean;
  /** a hand grabbing a cymbal: its ringing (and swing) stops */
  chokes: { t: number; piece: DrumId }[];
  /** bar lines (seconds), for the camera's cuts */
  bars: number[];
  bpm: number;
  /** the felt beat, in quarter notes: 1 (also when absent), or 1.5 in a compound meter (6/8, 9/8, 12/8: a dotted quarter) */
  pulse?: number;
}

/** where around the snare a cross-stick's shaft meets the hoop (radians from the side nearest the drummer, + to the right) */
export const CROSS_STICK_ANGLE = 2.5;
/** a cross-stick with another snare note this close (s) is a rim click (DrumHit.click) */
export const CLICK_WINDOW = 0.35;

/** TD-11's pedal sends at most about 90 when fully closed; anything above counts as closed */
export const CC4_CLOSED = 90 / 127;

/** where on its surface each kind of stroke lands (fraction of the radius), before a little per-hit variation */
function strikeRadius(zone: Zone, piece: DrumId): number {
  // (a cross-stick's shaft meets the hoop, as a rimshot's does)
  if (zone === 'rim' || zone === 'crossStick') return 0.97;
  if (zone === 'bell') return 0.14;
  if (zone === 'edge') return 0.95;
  if (zone === 'pedal') return 0;
  if (piece === 'crash') return 0.78;
  if (piece === 'ride') return 0.62;
  if (piece === 'hihat') return 0.55;
  if (piece === 'kick') return 0.1;
  return 0.2;
}

/** the hi-hat pedal as a closedness curve from CC4 events (0..1 MIDI values) */
function pedalFromCC(events: { time: number; value: number }[]): PedalPoint[] {
  const pts: PedalPoint[] = [];
  for (const e of events) {
    const closed = Math.min(1, e.value / CC4_CLOSED);
    if (pts.length && Math.abs(pts[pts.length - 1].t - e.time) < 1e-6) pts[pts.length - 1].closed = closed;
    else pts.push({ t: e.time, closed });
  }
  if (!pts.length || pts[0].t > 0) pts.unshift({ t: 0, closed: pts.length ? pts[0].closed : 1 });
  return pts;
}

/**
 * The pedal inferred from the hi-hat notes: closed by default; the foot lifts
 * just before an open hit (most of the way open), and comes down again for
 * the next closed hit, or onto the next pedal note (the "chick" is the moment
 * the cymbals meet). A pedal note while closed is a lift and a press.
 */
export function inferPedal(hh: { t: number; midi: number }[]): PedalPoint[] {
  const pts: PedalPoint[] = [{ t: 0, closed: 1 }];
  const push = (t: number, closed: number) => {
    const last = pts[pts.length - 1];
    if (t <= last.t + 1e-4) {
      if (t >= last.t - 1e-4) last.closed = closed;
      return;
    }
    pts.push({ t, closed });
  };
  const OPEN = 0.15; // the foot up: a typical open hi-hat, not the clutch's full travel
  let open = false;
  for (const n of hh) {
    if (HH_OPEN_KEYS.has(n.midi)) {
      if (!open) {
        push(n.t - 0.09, 1);
        push(n.t - 0.015, OPEN);
        open = true;
      }
    } else if (HH_CLOSED_KEYS.has(n.midi)) {
      if (open) {
        push(n.t - 0.07, OPEN);
        push(n.t - 0.01, 1);
        open = false;
      }
    } else if (n.midi === 44) {
      if (open) push(n.t - 0.08, OPEN);
      else {
        push(n.t - 0.16, 1);
        push(n.t - 0.08, 0.55);
      }
      push(n.t, 1);
      open = false;
    }
  }
  return pts;
}

/** the closedness of the hi-hat at t (linear between the points) */
export function pedalAt(pts: PedalPoint[], t: number): number {
  if (!pts.length) return 1;
  if (t <= pts[0].t) return pts[0].closed;
  let lo = 0;
  let hi = pts.length - 1;
  if (t >= pts[hi].t) return pts[hi].closed;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  return a.closed + ((b.closed - a.closed) * (t - a.t)) / Math.max(1e-6, b.t - a.t);
}

/**
 * Read a drum MIDI file. Notes on channel 10 (index 9) are drums; a file
 * with no channel-10 notes is read whole (some drum files are on another
 * channel). Unknown keys are dropped.
 */
export function readDrumMidi(bytes: Uint8Array, name = 'drums'): DrumPerformance {
  const midi = new Midi(bytes);
  const all = midi.tracks.flatMap((tr) => tr.notes.map((n) => ({ n, ch: tr.channel })));
  const onTen = all.filter((x) => x.ch === 9);
  const use = onTen.length ? onTen : all;
  const raw = use
    .map(({ n }) => ({ t: n.time, midi: n.midi, velocity: n.velocity }))
    .filter((n) => DRUM_MAP[n.midi])
    .sort((a, b) => a.t - b.t || a.midi - b.midi);
  // cross-sticks in the middle of the snare's own playing: rim clicks
  const snareT = raw.filter((n) => DRUM_MAP[n.midi].piece === 'snare').map((n) => n.t);
  const isClick = (t: number) => snareT.some((u) => u !== t && Math.abs(u - t) < CLICK_WINDOW);
  const hits: DrumHit[] = raw.map((n, i) => {
    const m = DRUM_MAP[n.midi];
    const click = m.zone === 'crossStick' && isClick(n.t);
    // (a cross-stick lies across the head from the hand resting on its near side: its shaft meets the hoop on the
    // far side, a little to the right, about half past one as the drummer sees it; a rim click is struck where a
    // rimshot is)
    const across = m.zone === 'crossStick' && !click;
    // a hand never lands twice on the same spot: a little, fixed scatter per hit
    const r0 = strikeRadius(m.zone, m.piece);
    const r = m.zone === 'pedal' ? 0 : Math.min(1, Math.max(0, r0 + (hash01(i, 11) - 0.5) * (m.zone === 'head' ? 0.16 : 0.06)));
    const angle = (hash01(i, 12) - 0.5) * (DRUMS[m.piece].kind === 'cymbal' ? 0.7 : across ? 0.2 : 0.5) + (across ? CROSS_STICK_ANGLE : 0);
    const h: DrumHit = { i, t: n.t, midi: n.midi, velocity: Math.max(0.02, Math.min(1, n.velocity)), piece: m.piece, zone: m.zone, r, angle };
    if (click) h.click = true;
    return h;
  });
  // the hi-hat pedal: CC4 when the file has it, else inferred
  const cc4 = midi.tracks
    .filter((tr) => !onTen.length || tr.channel === 9)
    .flatMap((tr) => (tr.controlChanges[4] ?? []).map((c) => ({ time: c.time, value: c.value })))
    .sort((a, b) => a.time - b.time);
  const hihatFromCC = cc4.length > 4;
  const hihat = hihatFromCC ? pedalFromCC(cc4) : inferPedal(hits.filter((h) => h.piece === 'hihat').map((h) => ({ t: h.t, midi: h.midi })));
  // chokes: polyphonic aftertouch (key pressure) on a cymbal's key, as e-kits send a grabbed cymbal
  const chokes: { t: number; piece: DrumId }[] = [];
  for (const a of scanAftertouch(bytes)) {
    const m = DRUM_MAP[a.key];
    if (!m || a.amount < 64 || DRUMS[m.piece].kind !== 'cymbal' || m.piece === 'hihat') continue;
    const t = midi.header.ticksToSeconds(a.tick);
    const last = chokes.filter((c) => c.piece === m.piece).pop();
    if (!last || t - last.t > 0.05) chokes.push({ t, piece: m.piece });
  }
  chokes.sort((a, b) => a.t - b.t);
  const lastHit = hits.length ? hits[hits.length - 1].t : 0;
  const duration = Math.max(midi.duration, lastHit) + 1.5;
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  // a bar's length in quarter notes from the time signature (3/4: 3; 6/8: 3, felt as two dotted quarters)
  const [num, den] = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const quartersPerBar = num > 0 && den > 0 ? (num * 4) / den : 4;
  const pulse = den === 8 && num >= 6 && num % 3 === 0 ? 1.5 : 1;
  const bars: number[] = [];
  const ppq = midi.header.ppq;
  for (let tick = 0; ; tick += ppq * quartersPerBar) {
    const t = midi.header.ticksToSeconds(tick);
    if (t > duration) break;
    bars.push(t);
  }
  return { name: midi.name || name, duration, hits, hihat, hihatFromCC, chokes, bars, bpm, pulse };
}

/**
 * Polyphonic aftertouch (key pressure) events in a Standard MIDI File, with
 * their absolute ticks: @tonejs/midi does not keep them.
 */
export function scanAftertouch(bytes: Uint8Array): { tick: number; key: number; amount: number }[] {
  const out: { tick: number; key: number; amount: number }[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => dv.getUint32(o);
  if (bytes.length < 14 || u32(0) !== 0x4d546864) return out;
  let o = 8 + u32(4);
  while (o + 8 <= bytes.length) {
    const id = u32(o);
    const len = u32(o + 4);
    o += 8;
    const end = Math.min(bytes.length, o + len);
    if (id === 0x4d54726b) {
      let p = o;
      let tick = 0;
      let status = 0;
      const vlq = () => {
        let v = 0;
        for (let k = 0; k < 4 && p < end; k++) {
          const b = bytes[p++];
          v = (v << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        return v;
      };
      while (p < end) {
        tick += vlq();
        let b = bytes[p];
        if (b & 0x80) {
          status = b;
          p++;
        } else b = status;
        if (status === 0xff) {
          p++; // meta type
          const n = vlq(); // (read first: vlq moves p)
          p += n;
          status = 0;
        } else if (status === 0xf0 || status === 0xf7) {
          const n = vlq();
          p += n;
          status = 0;
        } else {
          const hi = status & 0xf0;
          const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
          if (hi === 0xa0) out.push({ tick, key: bytes[p], amount: bytes[p + 1] });
          p += n;
        }
      }
    }
    o = end;
  }
  return out;
}

/**
 * A General MIDI drum file (format 0, channel 10) from hits, pedal positions
 * (CC4, 0..127) and chokes (aftertouch): for tests and short demos written in code.
 */
export function drumMidiBytes(
  hits: { t: number; midi: number; velocity: number }[],
  opts: { bpm?: number; cc4?: { t: number; value: number }[]; aftertouch?: { t: number; midi: number }[]; timeSignature?: [number, number] } = {},
): Uint8Array {
  const bpm = opts.bpm ?? 120;
  const [num, den] = opts.timeSignature ?? [4, 4];
  const ppq = 480;
  const tick = (t: number) => Math.round((t * bpm * ppq) / 60);
  const ev: { tick: number; order: number; data: number[] }[] = [];
  const us = Math.round(60e6 / bpm);
  ev.push({ tick: 0, order: 0, data: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  ev.push({ tick: 0, order: 0, data: [0xff, 0x58, 4, num, Math.round(Math.log2(den)), 24, 8] });
  for (const h of hits) {
    const v = Math.max(1, Math.min(127, Math.round(h.velocity * 127)));
    ev.push({ tick: tick(h.t), order: 2, data: [0x99, h.midi, v] });
    ev.push({ tick: tick(h.t + 0.05), order: 1, data: [0x89, h.midi, 0] });
  }
  for (const c of opts.cc4 ?? []) ev.push({ tick: tick(c.t), order: 1, data: [0xb9, 4, Math.max(0, Math.min(127, Math.round(c.value)))] });
  for (const a of opts.aftertouch ?? []) ev.push({ tick: tick(a.t), order: 3, data: [0xa9, a.midi, 127] });
  ev.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  const vlq = (v: number) => {
    const s = [v & 0x7f];
    while ((v >>= 7)) s.unshift((v & 0x7f) | 0x80);
    body.push(...s);
  };
  let last = 0;
  for (const e of ev) {
    vlq(e.tick - last);
    last = e.tick;
    body.push(...e.data);
  }
  vlq(0);
  body.push(0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 255, ppq & 255];
  const len = body.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body]);
}
