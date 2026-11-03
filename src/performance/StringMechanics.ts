// The strings: how far each key's strings swing at time t, as a pure function
// of the same key strokes and pedal that move the action (ActionMechanics), so
// the open piano stays exactly as deterministic as everything else.
//
// A struck string vibrates far faster than any frame rate, so what a camera
// sees is not a moving wire but the envelope of its swing over the exposure
// (PianoInterior draws that); here we only need the envelope's size: the peak
// displacement at mid-span, in metres, and how much of it has turned into the
// second polarisation.
//
// Sizes are physical: a few millimetres for a bass string struck hard, tenths
// of a millimetre in the middle, hundredths at the top, so in practice only
// loud bass notes blur visibly. A struck string dies away in two stages (the
// quick "prompt" sound, then the long aftersound), slowly in the bass and
// quickly in the treble. Its damper ends it: from the moment the felt is back
// on the strings (the key risen far enough, and the sustain pedal up) the
// swing dies within tens of milliseconds in the treble and a few hundred in
// the bass, instead of stopping dead. The top strings, which have no dampers,
// and pedalled strings ring on. While the pedal holds the dampers off, other
// strings whose partials coincide with sounding notes (octaves, twelfths,
// fifths) take up a faint sympathetic swing of their own.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { hash01 } from '../core/random';
import type { PedalLevel } from '../core/types';
import { DAMPER_LAG, DAMPER_LIFT_FROM, RELEASE_TO_DAMPER, UNDAMPED_FROM } from './ActionMechanics';
import { depthBefore, type KeyStroke } from './KeyMechanics';
import { railClearIntervals } from './Pedals';

const NEVER = 1e6;
const ALWAYS = -1e3;

/** peak mid-span displacement (m) of key i's strings, struck at velocity v (0..1) */
export function strikeAmplitude(i: number, v: number): number {
  return 0.0035 * Math.pow(2, -i / 14) * Math.pow(Math.max(0, v), 1.6);
}

/** e-folding time (s) of key i's aftersound: about 4 s at the bottom, a sixth of a second at the top */
export function ringTime(i: number): number {
  return Math.exp(1.46 - 0.0172 * i - 0.00078 * Math.max(0, i - 39) ** 2);
}

/** e-folding time (s) of a swing once the damper is on the strings: 0.4 s at the bottom, 25 ms at the top damper */
export function dampTime(i: number): number {
  return 0.4 * Math.exp(-0.041 * i);
}

/** a free string's swing, as a fraction of its strike, dt after it: the prompt sound, then the aftersound */
export function naturalDecay(i: number, dt: number): number {
  if (dt <= 0) return 1;
  const t2 = ringTime(i);
  return 0.65 * Math.exp(-dt / (t2 / 5)) + 0.35 * Math.exp(-dt / t2);
}

/** the hammer is on the string for a few milliseconds: the swing builds over them */
const onset = (dt: number) => (dt <= 0 ? 0 : 1 - Math.exp(-dt / 0.003));

/** sympathetic coupling: semitones from a sounding string to one that shares a partial, and how strongly */
const SYMPATHY: [number, number][] = [
  [12, 0.06],
  [19, 0.035],
  [24, 0.03],
  [28, 0.015],
  [-12, 0.03],
  [-19, 0.015],
  [7, 0.012],
  [-7, 0.01],
];


/** merge [start, end) intervals (sorted by start) */
function merge(iv: [number, number][]): [number, number][] {
  iv.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    if (b <= a) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** when each key's damper is off its strings: lifted by the key (deep enough), or by the sustain pedal's rail */
export function damperLifts(strokes: readonly (readonly KeyStroke[])[], pedal: readonly PedalLevel[]): [number, number][][] {
  const byPedal = railClearIntervals(pedal, NEVER);
  const out: [number, number][][] = [];
  for (let i = 0; i < KEY_COUNT; i++) {
    if (LOWEST_MIDI + i >= UNDAMPED_FROM) {
      out.push([[ALWAYS, NEVER]]);
      continue;
    }
    const iv: [number, number][] = byPedal.map(([a, b]) => [a, b]);
    const list = strokes[i];
    for (let j = 0; j < list.length; j++) {
      const s = list[j];
      // the key goes down from wherever the last stroke left it (KeyMechanics.strokeDepth)
      const d0 = j > 0 ? Math.max(0, depthBefore(list, j - 1, s.contact)) : 0;
      let from = s.contact;
      if (d0 < DAMPER_LIFT_FROM) {
        const u = Math.pow((DAMPER_LIFT_FROM - d0) / (1 - d0), 1 / 1.5);
        from = s.contact + u * (s.bottom - s.contact);
      }
      iv.push([from, s.release + RELEASE_TO_DAMPER + DAMPER_LAG]);
    }
    out.push(merge(iv));
  }
  return out;
}

/**
 * The swing of every key's strings over a performance. Built once per plan
 * (it is a few hundred numbers per key) and asked about any time.
 */
export class StringMechanics {
  /** per key: lifted intervals (starts, ends) and the lifted time before each */
  private liftA: Float64Array[] = [];
  private liftB: Float64Array[] = [];
  private liftSum: Float64Array[] = [];
  /** per key: strike times, the swing each leaves (with what was already there), and that residue */
  private strikeT: Float64Array[] = [];
  private strikeS: Float64Array[] = [];
  private strikeR: Float64Array[] = [];
  private own = new Float32Array(KEY_COUNT);

  constructor(strokes: readonly (readonly KeyStroke[])[], pedal: readonly PedalLevel[]) {
    const lifts = damperLifts(strokes, pedal);
    for (let i = 0; i < KEY_COUNT; i++) {
      const L = lifts[i];
      const a = new Float64Array(L.length);
      const b = new Float64Array(L.length);
      const sum = new Float64Array(L.length);
      let acc = 0;
      L.forEach(([x, y], k) => {
        a[k] = x;
        b[k] = y;
        sum[k] = acc;
        acc += y - x;
      });
      this.liftA.push(a);
      this.liftB.push(b);
      this.liftSum.push(sum);
      const list = strokes[i];
      const T = new Float64Array(list.length);
      const S = new Float64Array(list.length);
      const R = new Float64Array(list.length);
      this.strikeT.push(T);
      this.strikeS.push(S);
      this.strikeR.push(R);
      list.forEach((s, k) => {
        T[k] = s.bottom;
        const fresh = strikeAmplitude(i, s.note.velocity);
        const left = k > 0 ? this.swingFrom(i, k - 1, s.bottom, false) : 0;
        S[k] = Math.hypot(fresh, left);
        R[k] = left;
      });
    }
  }

  /** time key i's damper has been off its strings, from the start up to t */
  private liftedBefore(i: number, t: number): number {
    const a = this.liftA[i];
    let lo = 0;
    let hi = a.length - 1;
    let k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m] <= t) {
        k = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (k < 0) return 0;
    return this.liftSum[i][k] + Math.min(t, this.liftB[i][k]) - a[k];
  }

  /** is key i's damper off its strings at t? */
  lifted(i: number, t: number): boolean {
    const a = this.liftA[i];
    const b = this.liftB[i];
    for (let lo = 0, hi = a.length - 1; lo <= hi; ) {
      const m = (lo + hi) >> 1;
      if (t < a[m]) hi = m - 1;
      else if (t >= b[m]) lo = m + 1;
      else return true;
    }
    return false;
  }

  /** how much of a swing survives on key i's strings at t, given the damper (1 while it is off) */
  private damperFactor(i: number, from: number, t: number): number {
    const damped = t - from - (this.liftedBefore(i, t) - this.liftedBefore(i, from));
    return damped > 0 ? Math.exp(-damped / dampTime(i)) : 1;
  }

  /** the swing of strike k on key i at t (with or without its onset) */
  private swingFrom(i: number, k: number, t: number, withOnset = true): number {
    const t0 = this.strikeT[i][k];
    const dt = t - t0;
    const S = this.strikeS[i][k];
    let a = S * naturalDecay(i, dt) * this.damperFactor(i, t0, t);
    if (withOnset) {
      // the old swing is there at once, the new one builds while the hammer is on the string
      const r = this.strikeR[i][k] / Math.max(S, 1e-12);
      a *= r + (1 - r) * onset(dt);
    }
    return a;
  }

  /** key i's own swing at t: peak mid-span displacement (m) */
  amplitude(i: number, t: number): number {
    const T = this.strikeT[i];
    let lo = 0;
    let hi = T.length - 1;
    let k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) {
        k = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (k < 0) return 0;
    const a = this.swingFrom(i, k, t);
    return a < 1e-7 ? 0 : a;
  }

  /** time since key i was last struck (Infinity: never) */
  sinceStrike(i: number, t: number): number {
    const T = this.strikeT[i];
    let k = -1;
    for (let lo = 0, hi = T.length - 1; lo <= hi; ) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) {
        k = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return k < 0 ? Infinity : t - T[k];
  }

  /**
   * Every key's strings at t: out[2i] the swing in the plane the hammer
   * drives (toward the soundboard), out[2i+1] across it (m, peak at mid-span).
   * The second polarisation grows from the first over a few tenths of a second.
   */
  evaluate(t: number, out = new Float32Array(KEY_COUNT * 2)): Float32Array {
    const own = this.own;
    for (let i = 0; i < KEY_COUNT; i++) {
      const a = this.amplitude(i, t);
      own[i] = a;
      if (a === 0) {
        out[2 * i] = 0;
        out[2 * i + 1] = 0;
        continue;
      }
      const rho = 0.08 + (0.3 + 0.25 * hash01(i, 3)) * (1 - Math.exp(-this.sinceStrike(i, t) / 0.25));
      out[2 * i] = a;
      out[2 * i + 1] = a * rho;
    }
    // sympathetic swings, wherever a damper is off (always, at the top)
    for (let i = 0; i < KEY_COUNT; i++) {
      const a = own[i];
      if (a < 2e-6) continue;
      for (const [d, c] of SYMPATHY) {
        const j = i + d;
        if (j < 0 || j >= KEY_COUNT) continue;
        const s = c * a * this.freeFactor(j, t);
        if (s < 1e-7) continue;
        out[2 * j] = Math.hypot(out[2 * j], s);
        out[2 * j + 1] = Math.hypot(out[2 * j + 1], 0.5 * s);
      }
    }
    return out;
  }

  /** 1 while key i's damper is off its strings; after it lands, what is left of a swing */
  private freeFactor(i: number, t: number): number {
    if (this.lifted(i, t)) return 1;
    const b = this.liftB[i];
    const a = this.liftA[i];
    let k = -1;
    for (let lo = 0, hi = a.length - 1; lo <= hi; ) {
      const m = (lo + hi) >> 1;
      if (a[m] <= t) {
        k = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (k < 0) return 0;
    return Math.exp(-(t - b[k]) / dampTime(i));
  }
}
