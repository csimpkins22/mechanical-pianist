import { describe, expect, it } from 'vitest';
import { KEY_COUNT } from '../src/core/keyboard';
import type { PedalLevel, PerformanceNote } from '../src/core/types';
import { DAMPER_LAG, RELEASE_TO_DAMPER, UNDAMPED_FROM } from '../src/performance/ActionMechanics';
import { KeyMechanics, restrikeRepeats } from '../src/performance/KeyMechanics';
import { railClearIntervals } from '../src/performance/Pedals';
import { StringMechanics, dampTime, naturalDecay, strikeAmplitude } from '../src/performance/StringMechanics';

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
const build = (notes: PerformanceNote[], pedal: PedalLevel[] = []) => new StringMechanics(new KeyMechanics(notes).strokes, pedal);

describe('the strings', () => {
  it('swing by physical amounts: millimetres in the bass struck hard, hundredths of one at the top', () => {
    expect(strikeAmplitude(0, 1)).toBeGreaterThan(0.002);
    expect(strikeAmplitude(19, 0.7)).toBeGreaterThan(0.0005);
    expect(strikeAmplitude(39, 0.7)).toBeLessThan(0.0005);
    expect(strikeAmplitude(80, 1)).toBeLessThan(0.0001);
    // softer is smaller, and not in proportion
    expect(strikeAmplitude(10, 0.3)).toBeLessThan(0.2 * strikeAmplitude(10, 0.9));
  });

  it('start swinging as the hammer strikes, then die away on their own while the key is held', () => {
    const i = 30;
    const s = build([note(21 + i, 1, 4)]);
    expect(s.amplitude(i, 0.99)).toBe(0);
    const A = strikeAmplitude(i, 0.7);
    // built up within a few milliseconds of the onset
    expect(s.amplitude(i, 1.0005)).toBeLessThan(0.3 * A);
    expect(s.amplitude(i, 1.02)).toBeGreaterThan(0.95 * A * naturalDecay(i, 0.02));
    // the prompt sound, then the slow aftersound
    for (const dt of [0.2, 1, 2.5]) expect(s.amplitude(i, 1 + dt)).toBeCloseTo(A * naturalDecay(i, dt), 9);
    expect(s.amplitude(i, 1.5) / A).toBeLessThan(0.8);
    expect(s.amplitude(i, 3) / A).toBeGreaterThan(0.1);
  });

  it('die quickly but smoothly once the damper is back on them, the treble faster than the bass', () => {
    for (const i of [8, 40, 64]) {
      const s = build([note(21 + i, 1, 2)]);
      const land = 2 + RELEASE_TO_DAMPER + DAMPER_LAG;
      const before = s.amplitude(i, land);
      expect(before).toBeCloseTo(strikeAmplitude(i, 0.7) * naturalDecay(i, land - 1), 9);
      // one damping time after the felt lands: about 1/e of it (with the string's own decay on top)
      const r = s.amplitude(i, land + dampTime(i)) / before;
      expect(r).toBeGreaterThan(0.3);
      expect(r).toBeLessThan(0.37);
      // never a sudden drop: at most a few percent per millisecond
      for (let t = land - 0.01; t < land + 0.05; t += 0.001) {
        const a = s.amplitude(i, t);
        const b = s.amplitude(i, t + 0.001);
        expect(b).toBeLessThanOrEqual(a);
        expect(a - b).toBeLessThan(0.05 * a + 1e-12);
      }
      expect(s.amplitude(i, land + 12 * dampTime(i))).toBe(0);
    }
    // a treble string is silent within about a tenth of a second, a bass string takes several tenths
    expect(dampTime(64) * Math.log(20)).toBeLessThan(0.12);
    expect(dampTime(5) * Math.log(20)).toBeGreaterThan(0.6);
  });

  it('ring on under the sustain pedal, and are damped when it comes up', () => {
    const i = 30;
    const pedal: PedalLevel[] = [
      { time: 0.5, value: 1 },
      { time: 3, value: 0 },
    ];
    const s = build([note(21 + i, 1, 1.4)], pedal);
    const A = strikeAmplitude(i, 0.7);
    // the key is up long before the pedal: the string rings on as if held
    expect(s.amplitude(i, 2.5)).toBeCloseTo(A * naturalDecay(i, 1.5), 9);
    const land = railClearIntervals(pedal)[0][1];
    expect(land).toBeGreaterThan(3);
    expect(land).toBeLessThan(3.06);
    expect(s.amplitude(i, land)).toBeCloseTo(A * naturalDecay(i, land - 1), 9);
    expect(s.amplitude(i, land + 3 * dampTime(i))).toBeLessThan(0.06 * s.amplitude(i, land));
  });

  it('above the last damper, ring on after the key is released', () => {
    const i = UNDAMPED_FROM - 21 + 2;
    const s = build([note(21 + i, 1, 1.2, 0.9)]);
    expect(s.amplitude(i, 1.6)).toBeCloseTo(strikeAmplitude(i, 0.9) * naturalDecay(i, 0.6), 12);
  });

  it('pick up a faint sympathetic swing an octave up while the pedal holds the dampers off, and none without it', () => {
    const i = 20;
    const struck = [note(21 + i, 1, 1.5, 0.9)];
    const withPedal = build(struck, [{ time: 0.5, value: 1 }]).evaluate(1.1);
    const without = build([note(21 + i, 1, 1.5, 0.9)]).evaluate(1.1);
    const own = withPedal[2 * i];
    const octave = withPedal[2 * (i + 12)];
    expect(octave).toBeGreaterThan(0.02 * own);
    expect(octave).toBeLessThan(0.1 * own);
    expect(without[2 * (i + 12)]).toBe(0);
    // an unrelated string stays still either way
    expect(withPedal[2 * (i + 1)]).toBe(0);
  });

  it('take a repeated strike on top of the swing already there', () => {
    const i = 25;
    const notes = [note(21 + i, 1, 1.4), note(21 + i, 1.3, 1.8)];
    restrikeRepeats(notes);
    const s = build(notes);
    const before = s.amplitude(i, 1.2999);
    const after = s.amplitude(i, 1.33);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(Math.hypot(before, strikeAmplitude(i, 0.7)) * 1.0001);
  });

  it('turn partly into the other polarisation over a few tenths of a second', () => {
    const i = 12;
    const s = build([note(21 + i, 1, 3)]);
    const early = s.evaluate(1.01);
    const late = s.evaluate(1.8);
    expect(early[2 * i + 1] / early[2 * i]).toBeLessThan(0.15);
    expect(late[2 * i + 1] / late[2 * i]).toBeGreaterThan(0.3);
  });

  it('are a pure function of time', () => {
    const notes = [note(40, 1, 2.2), note(52, 1.5, 1.9), note(64, 1.7, 3), note(40, 2.6, 3.1)];
    restrikeRepeats(notes);
    const pedal: PedalLevel[] = [
      { time: 1.2, value: 1 },
      { time: 2.4, value: 0 },
    ];
    const a = build(notes, pedal);
    const b = build(notes, pedal);
    const late = Array.from(a.evaluate(2.9));
    a.evaluate(1.3);
    expect(Array.from(a.evaluate(2.9))).toEqual(late);
    expect(Array.from(b.evaluate(2.9))).toEqual(late);
    expect(late.length).toBe(2 * KEY_COUNT);
  });
});
