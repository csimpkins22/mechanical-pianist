import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KEY_COUNT } from '../src/core/keyboard';
import { KEY_RETURN, KeyMechanics, releaseCurve, restrikeRepeats, keyReturn, type KeyStroke } from '../src/performance/KeyMechanics';
import { HAMMER_REST, SHANK } from '../src/presentation/ActionLayout';
import { hammerQuaternion } from '../src/presentation/ActionParts';
import {
  hammerLeanAt,
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

  it('linger at the string for about a fifth of the rise, without bouncing off it', () => {
    const s = strokes([note(60, 1, 2, 0.5)], 60);
    const c = hammerShape(s[0]);
    expect(c.linger).toBeGreaterThan(0.15 * c.rise);
    expect(c.linger).toBeLessThan(0.26 * c.rise);
    for (let t = 1; t < 1 + c.linger; t += 1e-4) expect(hammerAt(s, t)).toBe(1);
    // straight down from the string into the check felt, and never back up to the string
    const down = sample(s, 1, 1 + c.linger + c.rebound);
    for (let k = 1; k < down.length; k++) expect(down[k]).toBeLessThanOrEqual(down[k - 1] + 1e-12);
    for (const h of sample(s, 1 + c.linger + c.rebound, 1.5)) expect(h).toBeLessThan(c.check + c.overshoot * c.ratio + 1e-9);
  });

  it('come back about twice as fast as they rose and land in the check: sinking in past it, springing back, settling', () => {
    const s = strokes([note(60, 1, 2.5, 0.5)], 60);
    const c = hammerShape(s[0]);
    expect(c.check).toBeGreaterThan(0.55);
    expect(c.check).toBeLessThan(0.65);
    const rebound = sample(s, 1 + c.linger, 1.4);
    // the main rebound: until it is nine tenths of the way to the check, against the whole rise
    const k90 = rebound.findIndex((h) => h <= c.check + 0.1 * (1 - c.check));
    const ratio = (0.9 * (1 - c.check)) / (k90 * 1e-4) / (1 / c.rise);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.8);
    // the footage: past the check by 10-15% of the blow (and the strike's own +-30%), then back past it by about a fifth of that
    const low = Math.min(...rebound);
    expect(c.check - low).toBeGreaterThan(0.06);
    expect(c.check - low).toBeLessThan(0.22);
    const iLow = rebound.indexOf(low);
    const after = rebound.slice(iLow);
    const high = Math.max(...after);
    expect((high - c.check) / (c.check - low)).toBeGreaterThan(0.14);
    expect((high - c.check) / (c.check - low)).toBeLessThan(0.26);
    // the first swing back takes about half the rise; the whole settle about one to one and a half rises
    const iHigh = iLow + after.indexOf(high);
    expect(((iHigh - iLow) * 1e-4) / c.rise).toBeGreaterThan(0.45);
    expect(((iHigh - iLow) * 1e-4) / c.rise).toBeLessThan(0.65);
    expect(Math.abs(hammerAt(s, 1 + c.linger + c.rebound + 1.5 * c.rise) - c.check)).toBeLessThan(0.006);
    // about one and a half swings to see: two turns more than 1% of the blow from the check, no third
    let turns = 0;
    for (let k = 1; k + 1 < rebound.length; k++) {
      const [a, b, d] = [rebound[k - 1], rebound[k], rebound[k + 1]];
      if ((b < a && b <= d) || (b > a && b >= d)) if (Math.abs(b - c.check) > 0.01) turns++;
    }
    expect(turns).toBe(2);
    // then dead still while the key is held
    for (const t of [1.4, 1.8, 2.4]) expect(hammerAt(s, t)).toBeCloseTo(c.check, 6);
  });

  it('rise more slowly and rebound more gently on a soft note, sink less into the check, and are caught a little higher', () => {
    const soft = hammerShape(strokes([note(60, 1, 2, 0.2)], 60)[0]);
    const loud = hammerShape(strokes([note(60, 1, 2, 0.95)], 60)[0]);
    expect(soft.rise).toBeGreaterThan(1.8 * loud.rise);
    expect(soft.rebound).toBeGreaterThan(1.8 * loud.rebound);
    expect(soft.check).toBeGreaterThan(loud.check + 0.02);
    // averaged over strikes (each varies), loud blows sink further into the check felt
    const mean = (v: number) => {
      let a = 0;
      for (let k = 0; k < 40; k++) a += hammerShape(strokes([note(60, 1 + k * 0.37, 2 + k * 0.37, v)], 60)[0]).overshoot;
      return a / 40;
    };
    expect(mean(0.95)).toBeGreaterThan(1.5 * mean(0.2));
  });

  it('are never quite the same twice, within the footage: each strike varies in size and time, deterministically', () => {
    const shapes = Array.from({ length: 60 }, (_, k) => hammerShape(strokes([note(60, 1 + k * 0.731, 1.5 + k * 0.731, 0.5)], 60)[0]));
    const o = shapes.map((c) => c.overshoot);
    const w = shapes.map((c) => c.swing / c.rise);
    expect(Math.min(...o) / Math.max(...o)).toBeLessThan(0.65);
    expect(Math.min(...o)).toBeGreaterThan(0.125 * 0.65 * 0.7 * 1.0);
    expect(Math.max(...o)).toBeLessThan(0.125 * 1.0 * 1.3 + 1e-9);
    expect(Math.min(...w)).toBeGreaterThan(0.55 * 0.85 - 1e-9);
    expect(Math.max(...w)).toBeLessThan(0.55 * 1.15 + 1e-9);
    expect(new Set(o.map((x) => x.toFixed(6))).size).toBe(60);
    // the same strike is always the same
    const again = hammerShape(strokes([note(60, 1 + 7 * 0.731, 1.5 + 7 * 0.731, 0.5)], 60)[0]);
    expect(again).toEqual(shapes[7]);
  });

  it('fall back to the rail with the key, come off its felt in one small bounce and a smaller one, and lie still', () => {
    const s = strokes([note(60, 1, 2)], 60);
    const c = hammerShape(s[0]);
    const r = s[0].release;
    const back = sample(s, r, r + c.ret + 0.1);
    // never below the rail
    for (const h of back) expect(h).toBeGreaterThanOrEqual(0);
    // falling, gathering speed, to the rail
    const k1 = Math.round(c.ret / 1e-4);
    for (let k = 1; k < k1 - 2; k++) expect(back[k]).toBeLessThanOrEqual(back[k - 1] + 1e-12);
    expect(back[k1 - 10] - back[k1 - 5]).toBeGreaterThan(back[10] - back[15]);
    // the bounce: a few percent of the blow, then a smaller one, then still within about 0.4 of the return
    const bounce = back.slice(k1);
    const peak = Math.max(...bounce);
    expect(peak).toBeGreaterThan(0.005);
    expect(peak).toBeLessThan(0.08);
    const iPeak = bounce.indexOf(peak);
    const iGround = bounce.findIndex((h, k) => k > iPeak && h < 0.01 * peak);
    const second = Math.max(...bounce.slice(iGround));
    expect(second).toBeGreaterThan(0.1 * peak);
    expect(second).toBeLessThan(0.4 * peak);
    expect(hammerAt(s, r + c.ret + 0.4 * c.ret * 1.2)).toBe(0);
  });

  it('bounce more off the rail after a quick release than a slow one', () => {
    const peak = (n: PerformanceNote) => {
      const s = strokes([n], n.midi);
      const c = hammerShape(s[0]);
      let m = 0;
      for (let t = s[0].release + c.ret; t < s[0].release + 2 * c.ret; t += 1e-4) m = Math.max(m, hammerAt(s, t));
      return m;
    };
    let quick = 0;
    let slow = 0;
    for (let k = 0; k < 20; k++) {
      quick += peak(note(60, 1 + k, 1.15 + k, 0.85));
      slow += peak(note(62, 1 + k, 3 + k, 0.25));
    }
    expect(quick).toBeGreaterThan(3 * slow);
  });

  it('swing a hint off the plane as they come up, and not at all at rest', () => {
    const q = new THREE.Quaternion();
    const head = new THREE.Vector3(0, SHANK, 0);
    for (let i = 0; i < KEY_COUNT; i++) {
      const s = strokes([note(21 + i, 1, 2)], 21 + i);
      const lean = hammerLeanAt(i, s, 1);
      // at rest: exactly the plain turn
      hammerQuaternion(i, 0, lean, q);
      const plain = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), HAMMER_REST);
      expect(q.angleTo(plain)).toBeLessThan(1e-6);
      // at the string: a few tenths of a millimetre to the side at the head
      hammerQuaternion(i, 1, lean, q);
      const x = Math.abs(head.clone().applyQuaternion(q).x);
      expect(x).toBeLessThan(0.0004);
    }
    const leans = Array.from({ length: KEY_COUNT }, (_, i) => hammerLeanAt(i, [], 0));
    expect(Math.max(...leans) - Math.min(...leans)).toBeGreaterThan(0.002);
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

describe('the keys coming back', () => {
  it('meet their rest stop and dip a little below it, once and once more, never rising above rest', () => {
    for (let k = 0; k < 40; k++) {
      const n = note(48 + (k % 30), 1, 1.1 + 0.05 * k, 0.3 + 0.015 * k);
      const km = new KeyMechanics([n]);
      const s = km.strokes[n.midi - 21];
      const r = keyReturn(s[0]);
      const rel = s[0].release;
      let low = Infinity;
      let deepest = 0;
      for (let t = rel; t < rel + 0.3; t += 1e-4) {
        const d = km.depression(n.midi, t);
        low = Math.min(low, d);
        if (t > rel + KEY_RETURN) deepest = Math.max(deepest, d);
      }
      expect(low).toBeGreaterThanOrEqual(0);
      expect(deepest).toBeLessThan(0.04);
      expect(deepest).toBeGreaterThan(0.002);
      expect(Math.abs(deepest - r.dip)).toBeLessThan(0.002);
      // settled well before a quarter of a second
      expect(km.depression(n.midi, rel + KEY_RETURN + 1.7 * r.time)).toBe(0);
    }
    expect(releaseCurve(1, KEY_RETURN + 0.5)).toBe(0);
  });

  it('bounce more after a brisk release than a slow one', () => {
    let brisk = 0;
    let slow = 0;
    for (let k = 0; k < 20; k++) {
      brisk += keyReturn(new KeyMechanics([note(60, 1 + k, 1.12 + k, 0.9)]).strokes[39][0]).dip;
      slow += keyReturn(new KeyMechanics([note(62, 1 + k, 3 + k, 0.2)]).strokes[41][0]).dip;
    }
    expect(brisk).toBeGreaterThan(3 * slow);
  });
});
