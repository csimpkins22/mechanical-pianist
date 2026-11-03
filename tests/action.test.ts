import { describe, expect, it } from 'vitest';
import { KeyMechanics, restrikeRepeats, type KeyStroke } from '../src/performance/KeyMechanics';
import {
  JACK_RESET_AT,
  JACK_TRIP_AT,
  RELEASE_TO_JACK,
  bridleAt,
  jackAt,
  DAMPER_LAG,
  DAMPER_SETTLE,
  HAMMER_LETOFF,
  RELEASE_TO_DAMPER,
  UNDAMPED_FROM,
  damperAt,
  hammerAt,
  hammerShape,
  railGap,
  riseCurve,
} from '../src/performance/ActionMechanics';
import { RAIL_CLEAR, SOFT_BLOW, levelAt, railClearIntervals, railTravel } from '../src/performance/Pedals';
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
const strokes = (notes: PerformanceNote[], midi: number) => new KeyMechanics(notes).strokes[midi - 21];
/** the hammer sampled every 0.1 ms over [a, b] */
const sample = (s: KeyStroke[], a: number, b: number, rest?: (t: number) => number) => {
  const out: number[] = [];
  for (let t = a; t <= b + 1e-9; t += 1e-4) out.push(hammerAt(s, t, rest));
  return out;
};

describe('the hammers, as the slow-motion footage shows them', () => {
  it('strike the string exactly at the onset, and not before', () => {
    const s = strokes([note(60, 1, 2)], 60);
    expect(hammerAt(s, 1)).toBe(1);
    expect(hammerAt(s, 0.999)).toBeLessThan(1);
    expect(hammerAt(s, 0.999)).toBeGreaterThan(0.9);
    // still on the rail until the jack has taken up the lost motion
    expect(hammerAt(s, s[0].contact - 0.001)).toBe(0);
    expect(hammerAt(s, hammerShape(s[0]).start)).toBe(0);
  });

  it('ease out of rest and accelerate, covering most of the blow in the second half of the rise, then slow into the string after let-off', () => {
    const s = strokes([note(60, 1, 2, 0.6)], 60);
    const c = hammerShape(s[0]);
    const at = (x: number) => hammerAt(s, c.start + x * c.rise);
    // no jump at the start
    expect(at(0.05)).toBeLessThan(0.01);
    expect(at(0.5)).toBeLessThan(0.35);
    // monotone all the way up
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.002) {
      const h = at(x);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = h;
    }
    // the free flight after let-off ends slower than it began
    const xl = Math.pow(0.9, 1 / 1.5);
    expect(at(xl)).toBeCloseTo(HAMMER_LETOFF, 6);
    const speed = (x: number) => (at(x + 0.001) - at(x)) / 0.001;
    expect(speed(0.999)).toBeLessThan(0.6 * speed(xl + 0.001));
  });

  it('linger at the string for about a fifth of the rise, without bouncing off', () => {
    const s = strokes([note(60, 1, 2, 0.5)], 60);
    const c = hammerShape(s[0]);
    expect(c.linger).toBeGreaterThan(0.15 * c.rise);
    expect(c.linger).toBeLessThan(0.26 * c.rise);
    for (let t = 1; t < 1 + c.linger; t += 1e-4) expect(hammerAt(s, t)).toBe(1);
    // and only ever come down from there while the key is held
    const after = sample(s, 1, 1.5);
    for (let k = 1; k < after.length; k++) expect(after[k]).toBeLessThanOrEqual(after[k - 1] + 1e-12);
  });

  it('come back two to two and a half times as fast as they rose, into a soft catch with no overshoot, then hold still', () => {
    const s = strokes([note(60, 1, 2.5, 0.6)], 60);
    const c = hammerShape(s[0]);
    expect(c.check).toBeGreaterThan(0.55);
    expect(c.check).toBeLessThan(0.65);
    const rebound = sample(s, 1 + c.linger, 1.3);
    // the main rebound: until it is nine tenths of the way to the check, against the whole rise
    const k90 = rebound.findIndex((h) => h <= c.check + 0.1 * (1 - c.check));
    const ratio = (0.9 * (1 - c.check)) / (k90 * 1e-4) / (1 / c.rise);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.7);
    // never below the check: the felt takes it without a jolt
    for (const h of rebound) expect(h).toBeGreaterThanOrEqual(c.check - 1e-9);
    // settled within about a third of the rise after leaving the string
    expect(hammerAt(s, 1 + c.linger + 0.4 * c.rise) - c.check).toBeLessThan(0.02 * (1 - c.check));
    // dead still while the key is held
    for (const t of [1.3, 1.8, 2.4]) expect(hammerAt(s, t)).toBeCloseTo(c.check, 6);
  });

  it('rise more slowly and rebound more gently on a soft note, and are caught a little higher', () => {
    const soft = hammerShape(strokes([note(60, 1, 2, 0.2)], 60)[0]);
    const loud = hammerShape(strokes([note(60, 1, 2, 0.95)], 60)[0]);
    expect(soft.rise).toBeGreaterThan(1.8 * loud.rise);
    expect(soft.tau).toBeGreaterThan(1.8 * loud.tau);
    expect(soft.check).toBeGreaterThan(loud.check + 0.02);
  });

  it('are not in perfect unison across a chord, though each strikes on its onset', () => {
    const chord = [60, 64, 67, 72].map((m) => note(m, 1, 2, 0.6));
    const km = new KeyMechanics(chord);
    const at = (t: number) => chord.map((n) => hammerAt(km.strokes[n.midi - 21], t));
    for (const h of at(1)) expect(h).toBe(1);
    const spread = (hs: number[]) => Math.max(...hs) - Math.min(...hs);
    expect(spread(at(1 - 0.012))).toBeGreaterThan(0.03);
    expect(spread(at(1.009))).toBeGreaterThan(0.01);
    expect(spread(at(1.6))).toBeGreaterThan(0.01);
  });

  it('go back to the rail with the key, smoothly and without a bounce', () => {
    const s = strokes([note(60, 1, 2)], 60);
    const c = hammerShape(s[0]);
    const r = s[0].release;
    const back = sample(s, r, r + c.ret + 0.05);
    for (let k = 1; k < back.length; k++) expect(back[k]).toBeLessThanOrEqual(back[k - 1] + 1e-12);
    for (const h of back) expect(h).toBeGreaterThanOrEqual(0);
    // arriving with almost no speed
    expect(hammerAt(s, r + c.ret - 0.002)).toBeLessThan(0.003);
    expect(hammerAt(s, r + c.ret)).toBe(0);
  });

  it('restrike a repeated note from where the half-risen key has left them, again exactly at the onset', () => {
    const notes = [note(64, 1, 1.3), note(64, 1.18, 1.5)];
    restrikeRepeats(notes);
    const s = strokes(notes, 64);
    expect(hammerAt(s, 1)).toBe(1);
    expect(hammerAt(s, 1.18)).toBe(1);
    const start = hammerShape(s[1]).start;
    const from = hammerAt(s, start);
    expect(from).toBeGreaterThan(0.02);
    expect(from).toBeLessThan(hammerShape(s[0]).check);
    let prev = from;
    for (let t = start; t <= 1.18; t += 0.0005) {
      const h = hammerAt(s, t);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h;
    }
  });

  it('rest, rise and return closer to the strings with the soft pedal down', () => {
    const s = strokes([note(60, 1, 1.5)], 60);
    const rest = () => SOFT_BLOW;
    expect(hammerAt(s, 0.5, rest)).toBe(SOFT_BLOW);
    expect(hammerAt(s, 1, rest)).toBe(1);
    expect(hammerAt(s, 3, rest)).toBe(SOFT_BLOW);
    // a shorter blow, from the rail's new place
    const c = hammerShape(s[0]);
    expect(hammerAt(s, c.start + 0.5 * c.rise, rest)).toBeCloseTo(riseCurve(SOFT_BLOW, 0.5), 9);
  });
});

describe('the dampers', () => {
  it('lift with the key, fall back a moment after it rises and settle into the strings; the top keys have none', () => {
    const s = strokes([note(60, 1, 2)], 60);
    expect(damperAt(60, s, 0.5, 0)).toBe(0);
    expect(damperAt(60, s, 1.5, 0)).toBe(1);
    // early in the key's travel it is still on the strings
    expect(damperAt(60, s, s[0].contact + 0.2 * (1 - s[0].contact), 0)).toBe(0);
    // the key is back past the damper's point, the damper not yet
    const keyBack = 2 + RELEASE_TO_DAMPER;
    expect(damperAt(60, s, keyBack + 0.5 * DAMPER_LAG, 0)).toBeGreaterThan(0);
    // then it lands, and the felt gives a little and settles, no more
    let low = 0;
    for (let t = keyBack + DAMPER_LAG; t < keyBack + DAMPER_LAG + 0.1; t += 0.0005) low = Math.min(low, damperAt(60, s, t, 0));
    expect(low).toBeLessThan(-0.5 * DAMPER_SETTLE);
    expect(low).toBeGreaterThanOrEqual(-DAMPER_SETTLE - 1e-9);
    expect(damperAt(60, s, keyBack + DAMPER_LAG + 0.1, 0)).toBe(0);
    expect(damperAt(UNDAMPED_FROM, strokes([note(UNDAMPED_FROM, 1, 2)], UNDAMPED_FROM), 1.5, 1)).toBe(0);
  });

  it('all lift together on the rail, each meeting it at its own point; half the rail lifts them part of the way', () => {
    const none: KeyStroke[] = [];
    const lifts = (rail: number) => Array.from({ length: 40 }, (_, i) => damperAt(21 + i, none, 1, rail));
    for (const d of lifts(1)) expect(d).toBe(1);
    for (const d of lifts(0)) expect(d).toBe(0);
    const half = lifts(0.5);
    expect(Math.min(...half)).toBeGreaterThan(0.4);
    expect(Math.max(...half)).toBeLessThan(0.55);
    expect(Math.max(...half) - Math.min(...half)).toBeGreaterThan(0.02);
    expect(new Set(Array.from({ length: 40 }, (_, i) => railGap(i))).size).toBe(40);
  });

  it('follow the pedal: free play first, half-pedalling as half the rail', () => {
    expect(railTravel(0.15)).toBe(0);
    expect(railTravel(1)).toBe(1);
    expect(railTravel(0.6)).toBeCloseTo(0.5, 9);
    const levels = [
      { time: 1, value: 0.58 },
      { time: 2, value: 0.3 },
      { time: 3, value: 1 },
      { time: 4, value: 0 },
    ];
    expect(levelAt(levels, 0.5, 0.06)).toBe(0);
    expect(levelAt(levels, 1.03, 0.06)).toBeCloseTo(0.29, 9);
    expect(levelAt(levels, 1.5, 0.06)).toBeCloseTo(0.58, 9);
    // the dampers clear the strings at 0.58, are back on them at 0.3 (the felts brushing), clear again, then down
    expect(railTravel(0.3)).toBeLessThan(RAIL_CLEAR);
    const iv = railClearIntervals(levels);
    expect(iv.length).toBe(2);
    expect(iv[0][0]).toBeGreaterThan(1);
    expect(iv[0][0]).toBeLessThan(1.06);
    expect(iv[1][1]).toBeGreaterThan(4);
    expect(iv[1][1]).toBeLessThan(4.06);
  });
});

describe('the pedals', () => {
  it('move continuously through quick changes, each from wherever the last had got to', () => {
    const levels = [
      { time: 1, value: 1 },
      { time: 2, value: 0.5 },
      { time: 2.02, value: 0 },
    ];
    let prev = levelAt(levels, 1.9, 0.06);
    for (let t = 1.9; t < 2.2; t += 0.0005) {
      const v = levelAt(levels, t, 0.06);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      prev = v;
    }
    expect(levelAt(levels, 2.2, 0.06)).toBe(0);
  });
});

describe('the jack and the bridle', () => {
  it('trips as the key passes let-off depth, stays out while it is held, and springs back as the key rises', () => {
    const notes = [note(60, 1, 1.6, 0.6)];
    const km = new KeyMechanics(notes);
    const s = km.strokes[60 - 21];
    const depth = (t: number) => km.depression(60, t);
    // under the butt until the key is nearly down
    let tTrip = 0;
    for (let t = s[0].contact; t < 1; t += 0.0002) {
      if (depth(t) < JACK_TRIP_AT - 0.01) expect(jackAt(s, t)).toBe(0);
      if (!tTrip && jackAt(s, t) > 0) tTrip = t;
    }
    expect(depth(tTrip)).toBeGreaterThan(JACK_TRIP_AT - 0.02);
    // slipping out as the hammer flies the last millimetres, fully out before it comes back from the string
    expect(jackAt(s, 1.0)).toBeGreaterThan(0.1);
    expect(jackAt(s, 1 + hammerShape(s[0]).linger)).toBeGreaterThan(0.95);
    for (const t of [1.1, 1.3, 1.59]) expect(jackAt(s, t)).toBe(1);
    // back under the butt once the key has risen past the reset depth
    const back = 1.6 + RELEASE_TO_JACK;
    expect(depth(back)).toBeLessThan(JACK_RESET_AT + 0.01);
    expect(jackAt(s, back + 0.03)).toBe(0);
    // moving smoothly both ways
    let prev = 0;
    for (let t = 0.97; t < 1.8; t += 0.0005) {
      const j = jackAt(s, t);
      expect(Math.abs(j - prev)).toBeLessThan(0.16); // a 5 ms slip, never a jump
      prev = j;
    }
  });

  it('resets for a quick repetition before the next stroke drives it again', () => {
    const notes = [note(64, 1, 1.1), note(64, 1.15, 1.4)];
    restrikeRepeats(notes);
    const s = strokes(notes, 64);
    // back under the butt by the time the finger lands again, out again after the second let-off
    expect(jackAt(s, s[1].contact)).toBeLessThan(0.05);
    expect(jackAt(s, 1.15 + hammerShape(s[1]).linger)).toBeGreaterThan(0.9);
  });

  it('sets the bridle tape swaying after a blow, more after a loud one, dying away', () => {
    const loud = strokes([note(60, 1, 2, 0.95)], 60);
    const soft = strokes([note(60, 1, 2, 0.2)], 60);
    const peak = (s: KeyStroke[], a: number, b: number) => {
      let m = 0;
      for (let t = a; t < b; t += 0.001) m = Math.max(m, Math.abs(bridleAt(39, s, t)));
      return m;
    };
    expect(peak(loud, 1, 1.3)).toBeGreaterThan(3 * peak(soft, 1, 1.3));
    expect(peak(loud, 1, 1.3)).toBeLessThan(0.0015);
    expect(peak(loud, 2.6, 2.9)).toBeLessThan(0.0003);
    expect(bridleAt(39, loud, 1.234)).toBe(bridleAt(39, loud, 1.234));
  });
});
