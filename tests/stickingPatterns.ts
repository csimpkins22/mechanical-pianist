// Small synthetic drum performances for the sticking tests and charts.
import type { DrumHit, DrumPerformance, Zone } from '../src/drums/DrumScore';
import type { DrumId } from '../src/drums/KitLayout';

export type Note = [t: number, piece: DrumId, zone?: Zone, velocity?: number, midi?: number];

/** a performance from (t, piece, zone, velocity) */
export function perfOf(name: string, notes: Note[], opts: { bpm?: number; chokes?: { t: number; piece: DrumId }[]; beatsPerBar?: number } = {}): DrumPerformance {
  const bpm = opts.bpm ?? 120;
  const sorted = notes
    .map(([t, piece, zone, velocity, midi]) => ({
      t: Math.round(t * 1e6) / 1e6,
      piece,
      zone: zone ?? (piece === 'hihat' || piece === 'ride' || piece === 'crash' ? 'bow' : 'head'),
      velocity: velocity ?? 0.8,
      midi: midi ?? 0,
    }))
    .sort((a, b) => a.t - b.t);
  const hits: DrumHit[] = sorted.map((n, i) => ({ i, t: n.t, midi: n.midi, velocity: n.velocity, piece: n.piece, zone: n.zone as Zone, r: n.zone === 'edge' || n.zone === 'rim' ? 0.95 : 0.3, angle: 0 }));
  const end = hits.length ? hits[hits.length - 1].t + 0.5 : 1;
  const bar = ((opts.beatsPerBar ?? 4) * 60) / bpm;
  const bars: number[] = [];
  for (let k = 0; k * bar <= end + 1e-9; k++) bars.push(k * bar);
  return { name, duration: end, hits, hihat: [{ t: 0, closed: 1 }], hihatFromCC: false, chokes: opts.chokes ?? [], bars, bpm };
}

/** beats -> seconds at a tempo */
const at = (bpm: number) => (beats: number) => (beats * 60) / bpm;

/** one bar of a rock beat from beat `b0`: eighths on the hi-hat, snare on 2 and 4, kick on 1, the "and" of 2 and 3 */
function rockBar(b0: number, bpm: number, out: Note[], opts: { hats?: boolean; crashOn1?: boolean } = {}) {
  const s = at(bpm);
  for (let e = 0; e < 8; e++) {
    const b = b0 + e / 2;
    if (opts.hats !== false && !(e === 0 && opts.crashOn1)) out.push([s(b), 'hihat', 'bow', e % 2 ? 0.55 : 0.85]);
    if (e === 2 || e === 6) out.push([s(b), 'snare', 'head', 0.95]);
    if (e === 0 || e === 3 || e === 4) out.push([s(b), 'kick', 'head', 0.85]);
  }
  if (opts.crashOn1) out.push([s(b0), 'crash', 'bow', 0.95]);
}

export function rockBeat(): DrumPerformance {
  const out: Note[] = [];
  for (let bar = 0; bar < 2; bar++) rockBar(bar * 4, 120, out);
  return perfOf('rock beat', out, { bpm: 120 });
}

/**
 * A jazz ride pattern at 140: "ding, ding-a-ding" swung (the skip note on the
 * last triplet), the hi-hat foot on 2 and 4, feathered quarter notes on the
 * kick, the left hand comping on the snare.
 */
export function jazzRide(): DrumPerformance {
  const bpm = 140;
  const s = at(bpm);
  const out: Note[] = [];
  const comp = [2 + 2 / 3, 5 + 2 / 3, 7, 10 + 2 / 3, 12 + 1 / 3, 14 + 2 / 3];
  for (let bar = 0; bar < 4; bar++) {
    const b0 = bar * 4;
    for (const b of [0, 1, 1 + 2 / 3, 2, 3, 3 + 2 / 3]) out.push([s(b0 + b), 'ride', 'bow', Number.isInteger(b) && b % 2 ? 0.8 : 0.6]);
    out.push([s(b0 + 1), 'hihat', 'pedal', 0.7]);
    out.push([s(b0 + 3), 'hihat', 'pedal', 0.7]);
    for (let q = 0; q < 4; q++) out.push([s(b0 + q), 'kick', 'head', 0.2]);
  }
  for (const b of comp) out.push([s(b), 'snare', 'head', 0.5]);
  return perfOf('jazz ride', out, { bpm });
}

/** single notes on the snare at `rate` notes a second for about two seconds, on a grid that fits */
export function snareRoll(rate: 8 | 14 | 24): DrumPerformance {
  // 8: sixteenths at 120; 14: thirty-seconds at 105; 24: thirty-seconds at 180
  const bpm = rate === 8 ? 120 : rate === 14 ? 105 : 180;
  const n = rate === 8 ? 16 : rate === 14 ? 28 : 48;
  const out: Note[] = [];
  for (let k = 0; k < n; k++) out.push([k / rate, 'snare', 'head', k % (rate === 8 ? 4 : 8) === 0 ? 0.85 : 0.7]);
  out.push([n / rate, 'snare', 'head', 0.95]);
  out.push([n / rate, 'kick', 'head', 0.9]);
  return perfOf(`snare roll, ${rate} notes a second`, out, { bpm });
}

/** quarter-note flams on the snare at 90, then on the toms: the grace note 30 ms ahead */
export function flams(): DrumPerformance {
  const bpm = 90;
  const s = at(bpm);
  const out: Note[] = [];
  const pieces: DrumId[] = ['snare', 'snare', 'snare', 'snare', 'tom1', 'tom2', 'floorTom', 'snare'];
  pieces.forEach((p, q) => {
    out.push([s(q) - 0.03, p, 'head', 0.3]);
    out.push([s(q), p, 'head', 0.95]);
    if (q % 2 === 0) out.push([s(q), 'kick', 'head', 0.8]);
  });
  return perfOf('flams', out, { bpm });
}

/**
 * A bar of rock beat, a bar-long fill down the kit in sixteenths at 100
 * (snare, high tom, mid tom, floor tom, a beat each), a crash with the kick on
 * the next 1, then the groove again.
 */
export function tomFill(): DrumPerformance {
  const bpm = 100;
  const s = at(bpm);
  const out: Note[] = [];
  rockBar(0, bpm, out);
  const pieces: DrumId[] = ['snare', 'tom1', 'tom2', 'floorTom'];
  for (let k = 0; k < 16; k++) {
    out.push([s(4 + k / 4), pieces[k >> 2], 'head', k % 4 === 0 ? 0.9 : 0.75]);
    if (k % 4 === 0 && k) out.push([s(4 + k / 4), 'kick', 'head', 0.7]);
  }
  rockBar(8, bpm, out, { crashOn1: true });
  rockBar(12, bpm, out);
  return perfOf('tom fill', out, { bpm });
}

/**
 * A fill with thirty-seconds in it, as rock bar 8 of the library groove has
 * (87 bpm): snare on 3, the "e" and a thirty-second after, high tom on the
 * "and", "a" and 4, mid tom a thirty-second after 4, then snare and mid tom
 * hand to hand into the floor tom and a crash on the 1. Hand to hand all the
 * way, as a drummer plays it.
 */
export function fill32(): DrumPerformance {
  const bpm = 87;
  const s = at(bpm);
  const groove: Note[] = [];
  rockBar(0, bpm, groove);
  rockBar(4, bpm, groove);
  rockBar(8, bpm, groove);
  // the groove stops for the fill on 3 of bar 2, and comes back after the 1 of bar 3
  const out = groove.filter(([t]) => t < s(6) - 1e-6 || t > s(8) + 1e-6);
  const fill: [number, DrumId][] = [
    [6, 'snare'],
    [6.25, 'snare'],
    [6.375, 'snare'],
    [6.5, 'tom1'],
    [6.75, 'tom1'],
    [7, 'tom1'],
    [7.125, 'tom2'],
    [7.25, 'snare'],
    [7.5, 'tom2'],
    [7.75, 'snare'],
  ];
  for (const [b, piece] of fill) out.push([s(b), piece, 'head', 0.95]);
  out.push([s(8), 'floorTom', 'head', 1], [s(8), 'kick', 'head', 0.9]);
  return perfOf('fill with thirty-seconds', out, { bpm });
}

/** three hand notes at once: hi-hat, snare and crash with the kick (the soft hi-hat has to go) */
export function threeAtOnce(): DrumPerformance {
  const out: Note[] = [];
  rockBar(0, 120, out);
  out.push([2, 'hihat', 'bow', 0.4], [2, 'snare', 'head', 1], [2, 'crash', 'edge', 0.95]);
  rockBar(4, 120, out, { hats: false });
  for (let e = 1; e < 8; e++) out.push([2 + e * 0.25, 'hihat', 'bow', 0.6]);
  return perfOf('three at once', out, { bpm: 120 });
}

/** a crash on the 1 choked on the "and" of 2, the groove going on under it */
export function choke(): DrumPerformance {
  const out: Note[] = [];
  rockBar(0, 120, out, { crashOn1: true });
  rockBar(4, 120, out, { crashOn1: true });
  return perfOf('choke', out, { bpm: 120, chokes: [{ t: 0.75, piece: 'crash' }, { t: 2.75, piece: 'crash' }] });
}

/** sixteenths on the hi-hat, snare on 2 and 4, at a tempo: one hand up to about 115, both above */
export function sixteenthHats(bpm: number): DrumPerformance {
  const s = at(bpm);
  const out: Note[] = [];
  for (let bar = 0; bar < 2; bar++)
    for (let k = 0; k < 16; k++) {
      const b = bar * 4 + k / 4;
      out.push([s(b), 'hihat', 'bow', k % 4 === 0 ? 0.85 : k % 2 ? 0.45 : 0.65]);
      if (k === 4 || k === 12) out.push([s(b), 'snare', 'head', 0.95]);
      if (k === 0 || k === 6 || k === 8 || k === 10) out.push([s(b), 'kick', 'head', 0.85]);
    }
  return perfOf(`sixteenth hats at ${bpm}`, out, { bpm });
}

/** a funk groove at 100: eighths on the hi-hat, ghost notes between them on the snare, backbeat on 2 and 4 */
export function ghostNotes(): DrumPerformance {
  const bpm = 100;
  const s = at(bpm);
  const out: Note[] = [];
  for (let bar = 0; bar < 2; bar++)
    for (let k = 0; k < 16; k++) {
      const b = bar * 4 + k / 4;
      if (k % 2 === 0) out.push([s(b), 'hihat', 'bow', k % 4 === 0 ? 0.8 : 0.6]);
      if (k === 4 || k === 12) out.push([s(b), 'snare', 'head', 1]);
      else if (k === 3 || k === 7 || k === 9 || k === 14 || k === 15) out.push([s(b), 'snare', 'head', 0.25]);
      if (k === 0 || k === 10) out.push([s(b), 'kick', 'head', 0.85]);
    }
  return perfOf('ghost notes', out, { bpm });
}

export const PATTERNS: Record<string, () => DrumPerformance> = {
  rock: rockBeat,
  jazz: jazzRide,
  roll8: () => snareRoll(8),
  roll14: () => snareRoll(14),
  roll24: () => snareRoll(24),
  flams,
  fill: tomFill,
  fill32,
  three: threeAtOnce,
  choke,
  hats100: () => sixteenthHats(100),
  hats140: () => sixteenthHats(140),
  ghosts: ghostNotes,
};
