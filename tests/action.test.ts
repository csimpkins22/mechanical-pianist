import { describe, expect, it } from 'vitest';
import { KeyMechanics, restrikeRepeats } from '../src/performance/KeyMechanics';
import { HAMMER_CHECK, UNDAMPED_FROM, damperAt, hammerAt } from '../src/performance/ActionMechanics';
import type { PerformanceNote } from '../src/core/types';

let id = 0;
const note = (midi: number, start: number, end: number, velocity = 0.7): PerformanceNote => ({
  id: id++,
  midi,
  start,
  end,
  velocity,
  track: 0,
  hand: 'R',
  finger: 2,
  keyEnd: end,
  flags: [],
});

describe('the piano action', () => {
  it('strikes the string exactly at the onset, and not before', () => {
    const km = new KeyMechanics([note(60, 1, 2)]);
    const s = km.strokes[60 - 21];
    expect(hammerAt(s, 1)).toBe(1);
    expect(hammerAt(s, 0.999)).toBeLessThan(1);
    expect(hammerAt(s, 0.999)).toBeGreaterThan(0.9);
    // at rest before the fingertip lands
    expect(hammerAt(s, s[0].contact - 0.001)).toBe(0);
  });

  it('is caught by the check while the key is held, and returns to rest after release', () => {
    const km = new KeyMechanics([note(60, 1, 2.5)]);
    const s = km.strokes[60 - 21];
    // well clear of the string within a few milliseconds
    expect(hammerAt(s, 1.02)).toBeLessThan(0.75);
    for (const t of [1.2, 1.6, 2.0, 2.4]) expect(hammerAt(s, t)).toBeCloseTo(HAMMER_CHECK, 3);
    expect(hammerAt(s, 2.5 + 0.4)).toBe(0);
    // never past the string, never behind the rail
    for (let t = 0.9; t < 3; t += 0.001) {
      const h = hammerAt(s, t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });

  it('restrikes a repeated note from the half-risen key, again exactly at its onset', () => {
    const notes = [note(64, 1, 1.3), note(64, 1.18, 1.5)];
    restrikeRepeats(notes);
    const km = new KeyMechanics(notes);
    const s = km.strokes[64 - 21];
    expect(hammerAt(s, 1)).toBe(1);
    expect(hammerAt(s, 1.18)).toBe(1);
    // when the second fingertip lands the hammer has not got back to its rail
    const atContact = hammerAt(s, s[1].contact);
    expect(atContact).toBeGreaterThan(0.02);
    expect(atContact).toBeLessThan(HAMMER_CHECK);
    // and it rises continuously from there
    let prev = atContact;
    for (let t = s[1].contact; t <= 1.18; t += 0.002) {
      const h = hammerAt(s, t);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h;
    }
  });

  it('lifts dampers with the key or the pedal, and the top keys have none', () => {
    expect(damperAt(60, 0, 0)).toBe(0);
    expect(damperAt(60, 1, 0)).toBe(1);
    expect(damperAt(60, 0, 1)).toBe(1);
    expect(damperAt(60, 0.2, 0)).toBe(0); // still on the strings early in the key's travel
    expect(damperAt(UNDAMPED_FROM, 1, 1)).toBe(0);
    expect(damperAt(UNDAMPED_FROM - 1, 1, 0)).toBe(1);
  });
});
