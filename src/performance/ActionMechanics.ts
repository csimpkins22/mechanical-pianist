// Inside the piano: where each key's hammer and damper are at time t, as pure
// functions of the same key strokes that move the keys (KeyMechanics), so the
// open piano is exactly as deterministic as everything else.
//
// The hammer (0 = against its rest rail, 1 = at the string) moves as slow-motion
// footage of a real action shows it. Driven by the jack, it eases out of the
// resting row and accelerates, covering most of its travel in the second half
// of the rise. A few millimetres from the string the jack trips (let-off) and
// the hammer flies the rest of the way on its own, slowing into the string
// rather than stopping dead. It reaches the string exactly at the note onset,
// when the key bottoms out, and lingers there (contact and the felt
// compressing) for about a fifth of the rise, without bouncing off. It comes
// back about twice as fast as it rose and settles softly into the backcheck,
// a little over halfway back, with no jolt or overshoot; then it is still
// while the key is held. As the key rises it goes back to its rest rail with
// the key, smoothly, with no bounce. A repeated note strikes again from
// wherever the half-risen key has left it.
//
// Loud and soft differ: a soft note rises more slowly (the key does), rebounds
// more gently and is caught a little higher. Real actions are never quite in
// unison: each note has a little lost motion before its jack takes up and its
// own small differences in linger, rebound and check, so the hammers of a chord
// all strike on their onsets but sit at different heights in between. The
// soft pedal moves the hammer rest rail toward the strings, so every hammer
// rests, and starts its blow, from closer in.
//
// The damper (0 = on its strings, 1 = fully off) is lifted by the key in the
// second half of its travel, and falls back a moment after the key rises,
// settling into the strings with a little give of its felt. The sustain pedal
// lifts them all together on the damper lift rail; each damper meets the rail
// at a slightly different point, and half-pedalling lifts them part of the way.
// The top keys, from F6 up, have no dampers, as in the sound.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { clamp } from '../core/math';
import { hash01 } from '../core/random';
import { depressionAt, depthBefore, releaseBrisk, releaseCurve, settleDips, strokeIndexAt, type KeyStroke } from './KeyMechanics';

/** where the jack trips: about 3 mm short of the string, of a 45 mm blow */
export const HAMMER_LETOFF = 0.935;
/** where the backcheck holds a hammer (fraction of the blow), on average: a loud blow a little lower, a soft one higher */
export const HAMMER_CHECK = 0.6;
/** a released hammer is back on its rail this long after its key lets go (about as long as the key takes) */
export const HAMMER_RETURN = 0.09;
/** F6 and above have no dampers (matches the audio) */
export const UNDAMPED_FROM = 89;
/** a key starts to lift its damper off the strings this far down (and the damper is back on them when it rises past it) */
export const DAMPER_LIFT_FROM = 0.35;
/** a damper follows its rising key back to the strings this much later */
export const DAMPER_LAG = 0.012;
/** how far a landing damper's felt gives into the strings (fraction of its swing), and how quickly it settles */
export const DAMPER_SETTLE = 0.06;
const SETTLE_T = 0.008;

/** the key's share of its dip when the jack trips: 90% of the way down (KeyMechanics presses as u^1.5) */
const U_LETOFF = Math.pow(0.9, 1 / 1.5);

/** how long after its release a key has risen far enough for its damper to touch the strings (before DAMPER_LAG) */
export const RELEASE_TO_DAMPER = (() => {
  let lo = 0;
  let hi = 0.085;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (releaseCurve(1, m) > DAMPER_LIFT_FROM) lo = m;
    else hi = m;
  }
  return hi;
})();

/** one strike's own character, fixed by its note */
export interface HammerShape {
  /** the jack takes up the lost motion and the hammer starts to move */
  start: number;
  /** from then to the string (the note onset) */
  rise: number;
  /** at the string */
  linger: number;
  /** from leaving the string to the deepest point in the check felt */
  rebound: number;
  /** where the check holds it, and how far past that the catcher first sinks into the felt (fractions of the blow) */
  check: number;
  overshoot: number;
  /** the swing back out of the felt: its duration, and its size against the overshoot */
  swing: number;
  ratio: number;
  /** its return to the rail after the key lets go, how much of its speed it keeps off the rail, and the bounce's duration */
  ret: number;
  restitution: number;
  bounce: number;
}

const shapes = new WeakMap<KeyStroke, HammerShape>();

/**
 * A stroke's hammer: timing, check and settles from its velocity and how it
 * is let go, with a little of the action's unevenness (each varies by a
 * fixed amount per strike: about 30% in size and 15% in time).
 */
export function hammerShape(s: KeyStroke): HammerShape {
  let c = shapes.get(s);
  if (c) return c;
  const n = s.note;
  const seed = n.midi * 100003 + Math.round(n.start * 1000);
  const r = (k: number) => hash01(seed, k);
  const v = clamp(n.velocity, 0, 1);
  const travel = Math.max(1e-3, s.bottom - s.contact);
  const slack = travel * (0.02 + 0.23 * r(1));
  const rise = travel - slack;
  const brisk = releaseBrisk(n);
  const ret = HAMMER_RETURN * (0.9 + 0.2 * r(5)) * (1.12 - 0.24 * brisk);
  c = {
    start: s.contact + slack,
    rise,
    linger: clamp(0.2 * rise * (0.85 + 0.3 * r(2)), 0.003, 0.012),
    rebound: 0.26 * rise * (1.1 - 0.2 * v) * (0.85 + 0.3 * r(3)),
    check: clamp(HAMMER_CHECK + 0.035 - 0.07 * v + 0.06 * (r(4) - 0.5), 0.54, 0.66),
    // loud blows sink further into the check felt
    overshoot: 0.125 * (0.65 + 0.7 * v) * (0.7 + 0.6 * r(6)),
    swing: 0.55 * rise * (0.85 + 0.3 * r(7)),
    ratio: 0.2 * (0.8 + 0.4 * r(8)),
    ret,
    // a quick release comes down harder and keeps more of it off the rail
    restitution: (0.05 + 0.4 * brisk) * (0.7 + 0.6 * r(9)),
    bounce: 0.25 * ret * (0.85 + 0.3 * r(10)),
  };
  shapes.set(s, c);
  return c;
}

/**
 * The rise, x from 0 (the hammer starts) to 1 (at the string), from h0: eased
 * out of rest and accelerating under the jack, then after let-off a short
 * free flight that slows into the string.
 */
export function riseCurve(h0: number, x: number): number {
  if (x <= 0) return h0;
  if (x >= 1) return 1;
  if (h0 >= HAMMER_LETOFF) return h0 + (1 - h0) * x * x * (3 - 2 * x);
  if (x < U_LETOFF) {
    const e = x / U_LETOFF;
    return h0 + (HAMMER_LETOFF - h0) * e * e;
  }
  // cubic Hermite from let-off (at the jack's last speed) to the string (a third of the average speed)
  const w = (x - U_LETOFF) / (1 - U_LETOFF);
  const d = 1 - HAMMER_LETOFF;
  const m0 = (2 * (HAMMER_LETOFF - h0) * (1 - U_LETOFF)) / U_LETOFF;
  const m1 = 0.35 * d;
  const w2 = w * w;
  const w3 = w2 * w;
  return HAMMER_LETOFF + m0 * (w3 - 2 * w2 + w) + d * (3 * w2 - 2 * w3) + m1 * (w3 - w2);
}

/**
 * At the string and after: the linger; the rebound, fast, the catcher meeting
 * the check felt on the way and sinking into it, past the check by
 * `overshoot`; then the felt springing it back, an elastic ease-out: out past
 * the check by `ratio` of that, and settling (about one and a half swings to
 * see, then nothing).
 */
export function strikeCurve(c: HammerShape, dt: number): number {
  if (dt < c.linger) return 1;
  const s = dt - c.linger;
  const low = c.check - c.overshoot;
  if (s < c.rebound) {
    const x = s / c.rebound;
    return 1 - (1 - low) * x * x * (3 - 2 * x);
  }
  // a damped swing about the check, released from its deepest point: extremes every `swing`, each `ratio` of the last
  const tau = s - c.rebound;
  const w = Math.PI / c.swing;
  const sigma = -Math.log(c.ratio) / c.swing;
  return c.check - c.overshoot * Math.exp(-sigma * tau) * (Math.cos(w * tau) + (sigma / w) * Math.sin(w * tau));
}

/**
 * Back to the rail after the key lets go: the hammer falls, gathering speed
 * (from h, at `x` of its return), meets the rail's felt and comes off it,
 * keeping `restitution` of its speed, in one small bounce and a smaller one.
 * Returned as the height above the rail, at time `dt` after it let go;
 * `still` is where it would be meanwhile had it not been let go (a settle in
 * the check that carries on under the fall).
 */
export function returnCurve(c: HammerShape, h0: number, dt: number, still = h0): number {
  if (dt <= 0) return still;
  const x = dt / c.ret;
  if (x < 1) return still * (1 - x * x);
  // arriving at 2 h0 / ret, it comes off the felt at restitution times that
  const up = c.restitution * ((2 * h0) / c.ret);
  const a = (up * c.bounce) / Math.PI;
  return settleDips((dt - c.ret) / c.bounce, a);
}

const atRest = () => 0;

/** where stroke j's hammer is at t (t at or after its fingertip landed) */
function strokeHammer(strokes: readonly KeyStroke[], j: number, t: number, rest: (t: number) => number, depth = 0): number {
  const s = strokes[j];
  const c = hammerShape(s);
  const before = (at: number) => (j > 0 && depth < 4 ? strokeHammer(strokes, j - 1, at, rest, depth + 1) : rest(at));
  if (t < c.start) return before(t);
  if (t < s.bottom) return riseCurve(Math.max(rest(c.start), before(c.start)), (t - c.start) / c.rise);
  if (t <= s.release) return strikeCurve(c, t - s.bottom);
  // let go: from wherever it was in the check (still settling, perhaps), back to the rail and off it
  const r = rest(t);
  return r + returnCurve(c, strikeCurve(c, s.release - s.bottom) - rest(s.release), t - s.release, strikeCurve(c, t - s.bottom) - r);
}

/** a key's hammer at t: 0 against its rest rail, 1 at the string (`rest`: where the rail holds it, soft pedal) */
export function hammerAt(strokes: readonly KeyStroke[], t: number, rest: (t: number) => number = atRest): number {
  const i = strokeIndexAt(strokes, t);
  return i < 0 ? rest(t) : clamp(strokeHammer(strokes, i, t, rest), 0, 1);
}

/** all 88 hammers at t */
export function hammersAt(strokes: readonly (readonly KeyStroke[])[], t: number, rest: (t: number) => number = atRest, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = hammerAt(strokes[i], t, rest);
  return out;
}

/** a damper's lift by its key's depression alone */
export function keyLift(depression: number): number {
  const d = clamp((depression - DAMPER_LIFT_FROM) / 0.4, 0, 1);
  return d * d * (3 - 2 * d);
}

/** where along the rail's travel each damper starts to move with it (each is regulated a little differently) */
export const railGap = (i: number) => 0.07 * hash01(i, 77);

/**
 * How far a key's damper is off its strings at t: lifted by its key at once,
 * falling back DAMPER_LAG behind it and settling into the strings as it lands;
 * or lifted by the rail (0..1 travel, the sustain pedal). Negative: the felt
 * giving into the strings as it lands.
 */
export function damperAt(midi: number, strokes: readonly KeyStroke[], t: number, rail: number): number {
  if (midi >= UNDAMPED_FROM) return 0;
  const i = midi - LOWEST_MIDI;
  const byKey = Math.max(keyLift(depressionAt(strokes, t)), keyLift(depressionAt(strokes, t - DAMPER_LAG)));
  const g = railGap(i);
  const byRail = clamp((rail - g) / (1 - g), 0, 1);
  const d = Math.max(byKey, byRail);
  if (d > 0) return d;
  // just landed after its key rose: the felt gives a little and settles
  const j = strokeIndexAt(strokes, t);
  if (j < 0) return 0;
  const s = t - (strokes[j].release + RELEASE_TO_DAMPER + DAMPER_LAG);
  if (s <= 0 || s > 0.08) return 0;
  return -DAMPER_SETTLE * (s / SETTLE_T) * Math.exp(1 - s / SETTLE_T);
}

/** all 88 dampers at t, with the damper lift rail at `rail` */
export function dampersAt(strokes: readonly (readonly KeyStroke[])[], t: number, rail: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = damperAt(LOWEST_MIDI + i, strokes[i], t, rail);
  return out;
}

// ---------------------------------------------------------------- the jack and the bridle

/** the key's depression at which the jack trips (let-off), and at which it is back under the butt as the key rises */
export const JACK_TRIP_AT = 0.9;
export const JACK_RESET_AT = 0.6;
/** how long the jack takes to slip out from under the butt, and to spring back under it */
const TRIP_T = 0.005;
const RESET_T = 0.018;

/** how long after its release a key has risen past JACK_RESET_AT */
export const RELEASE_TO_JACK = (() => {
  let lo = 0;
  let hi = 0.085;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (releaseCurve(1, m) > JACK_RESET_AT) lo = m;
    else hi = m;
  }
  return hi;
})();

const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** when stroke j's key reaches let-off depth (KeyMechanics presses as u^1.5 from where the key was) */
function tripTime(strokes: readonly KeyStroke[], j: number): number {
  const s = strokes[j];
  const d0 = j > 0 ? Math.max(0, depthBefore(strokes, j - 1, s.contact)) : 0;
  if (d0 >= JACK_TRIP_AT) return s.contact;
  const u = Math.pow((JACK_TRIP_AT - d0) / (1 - d0), 1 / 1.5);
  return s.contact + u * (s.bottom - s.contact);
}

/**
 * How far a key's jack has slipped out from under its hammer butt, 0..1: it
 * trips as the key passes let-off depth, stays out while the key is down, and
 * springs back under the butt as the key rises again (or when the next stroke
 * begins, whichever is first).
 */
export function jackAt(strokes: readonly KeyStroke[], t: number): number {
  const j = strokeIndexAt(strokes, t);
  if (j < 0) return 0;
  const out = (k: number) => {
    const s = strokes[k];
    const on = tripTime(strokes, k);
    const next = k + 1 < strokes.length ? strokes[k + 1].contact : Infinity;
    const off = Math.min(s.release + RELEASE_TO_JACK, next);
    if (t < on) return 0;
    return Math.min(ramp((t - on) / TRIP_T), 1 - ramp((t - off) / RESET_T));
  };
  return Math.max(out(j), j > 0 ? out(j - 1) : 0);
}

/** all 88 jacks at t */
export function jacksAt(strokes: readonly (readonly KeyStroke[])[], t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = jackAt(strokes[i], t);
  return out;
}

/**
 * The bridle tape's sideways sway (m, at the middle of its slack): set
 * fluttering by each strike, more by loud ones, and dying away over a few
 * tenths of a second, with a very slow drift of the air inside the case.
 */
export function bridleAt(i: number, strokes: readonly KeyStroke[], t: number): number {
  const drift = 0.00012 * Math.sin(0.9 * t + 2.3 * i) * Math.sin(0.37 * t + 1.1 * i);
  const j = strokeIndexAt(strokes, t);
  if (j < 0) return drift;
  const s = strokes[j];
  const dt = t - s.bottom;
  if (dt <= 0) return drift;
  const w = 2 * Math.PI * (3.5 + 1.5 * hash01(i, 31));
  return drift + 0.0011 * s.note.velocity * Math.exp(-dt / 0.28) * Math.sin(w * dt + hash01(i, 32) * 6.28) * Math.min(1, dt / 0.01);
}

/** all 88 bridles at t */
export function bridlesAt(strokes: readonly (readonly KeyStroke[])[], t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = bridleAt(i, strokes[i], t);
  return out;
}

// ---------------------------------------------------------------- not quite planar, and the check

/**
 * A hammer never swings in a perfect plane: each leans a little to one side as
 * it rises (a few tenths of a millimetre at the head over the whole blow) and
 * each strike a little differently again. Radians of sideways tilt at the full
 * blow; the renderer scales it by how far the hammer has come (none at rest).
 */
export function hammerLeanAt(i: number, strokes: readonly KeyStroke[], t: number): number {
  const fixed = 0.0026 * (2 * hash01(i, 51) - 1);
  const j = strokeIndexAt(strokes, t);
  if (j < 0) return fixed;
  const n = strokes[j].note;
  return fixed + 0.0008 * (2 * hash01(n.midi * 100003 + Math.round(n.start * 1000), 52) - 1);
}

/** all 88 hammers' lean at t */
export function hammerLeansAt(strokes: readonly (readonly KeyStroke[])[], t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = hammerLeanAt(i, strokes[i], t);
  return out;
}

/** where the backcheck holds key i's hammer for its current stroke (the check felt is set to meet it there) */
export function checkAt(strokes: readonly KeyStroke[], t: number): number {
  const j = strokeIndexAt(strokes, t);
  return j < 0 ? HAMMER_CHECK : hammerShape(strokes[j]).check;
}

/** all 88 checks at t */
export function checksAt(strokes: readonly (readonly KeyStroke[])[], t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = checkAt(strokes[i], t);
  return out;
}
