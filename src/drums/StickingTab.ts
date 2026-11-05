// A sticking as a drum tab: one row per instrument, one column per
// subdivision of the beat, each note marked with the limb that plays it.
// For reviewing a sticking (tests, the lab, a drummer reading it), not for
// the stage.
import type { DrumPerformance } from './DrumScore';
import { DRUMS, type DrumId } from './KitLayout';
import type { Level, Limb, Sticking } from './Sticking';

export interface TabNote {
  hit: number;
  limb: Limb;
  level: Level;
  played: boolean;
  double: boolean;
  grace: boolean;
  /** an open hi-hat (the pedal lifted), a rimshot, a cross-stick, the ride's bell, a cymbal's edge */
  mark: '' | 'open' | 'rim' | 'xstick' | 'bell' | 'edge';
  /** how far off its column it was played, in columns (-0.5..0.5): a thirty-second on a sixteenth grid is about ±0.5 */
  off: number;
}

export interface TabRow {
  key: string;
  label: string;
  /** drums show ghost notes; cymbals and pedals do not (a soft cymbal note is just soft) */
  kind: 'drum' | 'cymbal' | 'foot';
  /** per column, the notes that fall in it (usually none or one) */
  cells: TabNote[][];
}

export interface StickingTabView {
  /** columns per beat */
  sub: number;
  perBar: number;
  firstBar: number;
  bars: number;
  /** count labels per column within a bar ("1 e & a ...") */
  counts: string[];
  rows: TabRow[];
}

const ROWS: { key: string; label: string; piece: DrumId; foot?: boolean }[] = [
  { key: 'crash', label: 'Crash', piece: 'crash' },
  { key: 'ride', label: 'Ride', piece: 'ride' },
  { key: 'hihat', label: 'Hi-hat', piece: 'hihat' },
  { key: 'tom1', label: 'Tom 1', piece: 'tom1' },
  { key: 'tom2', label: 'Tom 2', piece: 'tom2' },
  { key: 'snare', label: 'Snare', piece: 'snare' },
  { key: 'floorTom', label: 'Floor tom', piece: 'floorTom' },
  { key: 'kick', label: 'Kick', piece: 'kick', foot: true },
  { key: 'hhFoot', label: 'Hi-hat foot', piece: 'hihat', foot: true },
];

function countLabels(sub: number, perBar: number): string[] {
  const names: Record<number, string[]> = {
    1: [''],
    2: ['', '&'],
    3: ['', '&', 'a'],
    4: ['', 'e', '&', 'a'],
    6: ['', '.', '&', '.', 'a', '.'],
    8: ['', '.', 'e', '.', '&', '.', 'a', '.'],
  };
  const n = names[sub] ?? Array.from({ length: sub }, (_, i) => (i ? '.' : ''));
  const out: string[] = [];
  for (let b = 0; b < perBar; b++) for (let s = 0; s < sub; s++) out.push(s === 0 ? String(b + 1) : n[s]);
  return out;
}

/**
 * The grid a drummer would write the hits on: sixteenths, or eighth-note
 * triplets when they fit as well (swing), going finer (thirty-seconds,
 * sextuplets) only when more than a few notes on one instrument would share
 * a cell.
 */
export function bestSubdivision(hits: { t: number; piece: string; zone?: string }[], beat: number, origin: number): number {
  const err = (sub: number) => {
    let e = 0;
    for (const h of hits) {
      const x = ((h.t - origin) / beat) * sub;
      e += Math.abs(x - Math.round(x)) / sub;
    }
    return e / Math.max(1, hits.length);
  };
  const collisions = (sub: number) => {
    const seen = new Set<string>();
    let n = 0;
    for (const h of hits) {
      const key = `${h.piece}:${h.zone === 'pedal' ? 'p' : ''}:${Math.round(((h.t - origin) / beat) * sub)}`;
      if (seen.has(key)) n++;
      seen.add(key);
    }
    return n / Math.max(1, hits.length);
  };
  // (a swung feel sits between the grids: triplets when they fit about as well as sixteenths and the sixteenths fit loosely)
  const e4 = err(4);
  const ladder = e4 > 0.01 && err(3) <= e4 * 1.1 ? [3, 6, 12] : [4, 8, 16];
  for (const sub of ladder) if (collisions(sub) <= 0.06) return sub;
  return ladder[ladder.length - 1];
}

/** the tab for `bars` bars from `firstBar` (0-based) */
export function stickingTab(perf: DrumPerformance, s: Sticking, opts: { firstBar?: number; bars?: number; sub?: number } = {}): StickingTabView {
  const beat = 60 / (perf.bpm || 120);
  const barLines = perf.bars.length ? perf.bars : [0];
  const perBar = barLines.length > 1 ? Math.max(1, Math.round((barLines[1] - barLines[0]) / beat)) : 4;
  const barLen = perBar * beat;
  const origin = barLines[0];
  const firstBar = opts.firstBar ?? 0;
  const lastT = s.hits.length ? s.hits[s.hits.length - 1].t : origin;
  const bars = opts.bars ?? Math.max(1, Math.floor((lastT - origin + beat / 8) / barLen) + 1 - firstBar);
  // (a note a little ahead of the bar line belongs to it)
  const t0 = origin + firstBar * barLen;
  const t1 = t0 + bars * barLen;
  // a flam's grace note is written with its main note
  const at = s.hits.map((h) => {
    if (!h.grace) return h.t;
    for (let k = h.hit + 1; k < s.hits.length && s.hits[k].t - h.t < 0.06; k++) if (s.hits[k].piece === h.piece) return s.hits[k].t;
    return h.t;
  });
  const inWin = s.hits.filter((h) => at[h.hit] >= t0 - beat / 8 && at[h.hit] < t1 - beat / 8);
  const sub = opts.sub ?? bestSubdivision(inWin.filter((h) => !h.grace), beat, origin);
  const cols = bars * perBar * sub;
  const rows: TabRow[] = ROWS.map((r) => ({
    key: r.key,
    label: r.label,
    kind: r.foot ? 'foot' : DRUMS[r.piece].kind,
    cells: Array.from({ length: cols }, () => [] as TabNote[]),
  }));
  const hits = perf.hits;
  for (const h of inWin) {
    const src = hits[h.hit];
    const foot = h.limb === 'RF' || h.limb === 'LF';
    const ri = ROWS.findIndex((r) => r.piece === h.piece && !!r.foot === (foot || (h.piece === 'hihat' && h.zone === 'pedal')));
    if (ri < 0) continue;
    const x = ((at[h.hit] - t0) / beat) * sub;
    const col = Math.round(x);
    if (col < 0 || col >= cols) continue;
    const mark: TabNote['mark'] =
      h.zone === 'rim' ? 'rim' : h.zone === 'crossStick' ? 'xstick' : h.zone === 'bell' ? 'bell' : h.piece === 'hihat' && (src.midi === 46 || src.midi === 26) ? 'open' : h.zone === 'edge' && h.piece !== 'hihat' ? 'edge' : '';
    rows[ri].cells[col].push({
      hit: h.hit,
      limb: h.limb,
      level: h.level,
      played: h.played,
      double: h.double,
      grace: h.grace,
      mark,
      off: x - col,
    });
  }
  return { sub, perBar, firstBar, bars, counts: countLabels(sub, perBar), rows: rows.filter((r) => r.cells.some((c) => c.length)) };
}

/** one note as tab text: R or L (RF, LF for feet); ">" an accent, "( )" a ghost, a lowercase grace note before its main note, "x" dropped */
function noteText(ns: TabNote[], kind: TabRow['kind']): string {
  if (!ns.length) return '';
  return ns
    .map((n) => {
      if (!n.played) return 'x';
      let s: string = n.limb;
      if (n.grace) return s.toLowerCase();
      if (n.level === 'accent') s += '>';
      if (n.level === 'ghost' && kind === 'drum') s = `(${s})`;
      return s;
    })
    .join('');
}

/** the tab as text, a few bars to a line */
export function stickingText(perf: DrumPerformance, s: Sticking, opts: { firstBar?: number; bars?: number; sub?: number; barsPerLine?: number } = {}): string {
  const tab = stickingTab(perf, s, opts);
  const per = tab.perBar * tab.sub;
  const w = Math.max(4, ...tab.rows.flatMap((r) => r.cells.map((c) => noteText(c, r.kind).length + 1)));
  const pad = (x: string) => x + ' '.repeat(Math.max(0, w - x.length));
  const lines: string[] = [];
  const barsPerLine = opts.barsPerLine ?? 2;
  for (let b0 = 0; b0 < tab.bars; b0 += barsPerLine) {
    const b1 = Math.min(tab.bars, b0 + barsPerLine);
    let num = ''.padEnd(12);
    let head = ''.padEnd(12);
    for (let b = b0; b < b1; b++) {
      num += ('|bar ' + (tab.firstBar + b + 1)).padEnd(per * w + 1);
      head += '|' + tab.counts.map(pad).join('');
    }
    lines.push(num);
    lines.push(head + '|');
    for (const r of tab.rows) {
      let line = r.label.padEnd(12);
      for (let b = b0; b < b1; b++) {
        line += '|';
        for (let c = b * per; c < (b + 1) * per; c++) line += pad(noteText(r.cells[c], r.kind) || '-');
      }
      lines.push(line + '|');
    }
    lines.push('');
  }
  return lines.join('\n');
}
