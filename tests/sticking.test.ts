import { describe, expect, it } from 'vitest';
import { assignLimbs } from '../src/drums/Sticking';
import type { DrumHit, DrumPerformance, Zone } from '../src/drums/DrumScore';
import type { DrumId } from '../src/drums/KitLayout';

/** a performance from (t, piece, zone, velocity) */
function perfOf(notes: [number, DrumId, Zone?, number?][], opts: { bpm?: number; chokes?: { t: number; piece: DrumId }[] } = {}): DrumPerformance {
  const bpm = opts.bpm ?? 120;
  const sorted = notes.map(([t, piece, zone, velocity]) => ({ t, piece, zone: zone ?? (piece === 'hihat' || piece === 'ride' || piece === 'crash' ? 'bow' : 'head'), velocity: velocity ?? 0.8 })).sort((a, b) => a.t - b.t);
  const hits: DrumHit[] = sorted.map((n, i) => ({ i, t: n.t, midi: 0, velocity: n.velocity, piece: n.piece, zone: n.zone as Zone, r: n.zone === 'edge' || n.zone === 'rim' ? 0.95 : 0.3, angle: 0 }));
  const end = hits.length ? hits[hits.length - 1].t + 1 : 1;
  const bar = (240 / bpm);
  const bars: number[] = [];
  for (let t = 0; t <= end; t += bar) bars.push(t);
  return { name: 'test', duration: end, hits, hihat: [{ t: 0, closed: 1 }], hihatFromCC: false, chokes: opts.chokes ?? [], bars, bpm };
}

describe('sticking', () => {
  it('plays a rock beat: right hand on the hi-hat, left on the snare backbeat, right foot on the kick', () => {
    const notes: [number, DrumId, Zone?, number?][] = [];
    const e = 0.25; // eighths at 120 bpm
    for (let k = 0; k < 16; k++) {
      notes.push([k * e, 'hihat', 'bow', k % 2 ? 0.6 : 0.9]);
      if (k % 4 === 2) notes.push([k * e, 'snare', 'head', 1]);
      if (k % 8 === 0 || k % 8 === 5) notes.push([k * e, 'kick', 'head', 0.9]);
    }
    const s = assignLimbs(perfOf(notes));
    for (const h of s.hits) {
      if (h.piece === 'hihat') expect(h.limb).toBe('R');
      if (h.piece === 'snare') expect(h.limb).toBe('L');
      if (h.piece === 'kick') expect(h.limb).toBe('RF');
    }
    expect(s.dropped).toHaveLength(0);
  });
});
