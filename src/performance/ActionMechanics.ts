// Inside the piano: where each key's hammer and damper are at time t, as pure
// functions of the same key strokes that move the keys (KeyMechanics), so the
// open piano is exactly as deterministic as everything else.
//
// The hammer (0 = at rest against its rail, 1 = touching the string) is lifted
// by the jack in step with the key; near the bottom of the key's travel the
// jack lets it go and it flies the last few millimetres on its own, reaching
// the string exactly at the note onset (when the key bottoms out). It rebounds
// at once and the backcheck catches it part-way back, holding it there while
// the key stays down; as the key rises the hammer falls back to its rail. A
// repeated note strikes again from wherever the half-risen key has left it.
//
// The damper (0 = on its strings, 1 = fully off) is lifted by the key in the
// second half of its travel, or for every key at once by the sustain pedal.
// The top keys, from F6 up, have no dampers, as in the sound.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { clamp } from '../core/math';
import { releaseCurve, strokeDepth, strokeIndexAt, type KeyStroke } from './KeyMechanics';

/** where the backcheck holds the hammer while its key is down (fraction of the blow) */
export const HAMMER_CHECK = 0.52;
/** F6 and above have no dampers (matches the audio) */
export const UNDAMPED_FROM = 89;
/** a key starts to lift its damper off the strings this far down (and the damper is back on them when it rises past it) */
export const DAMPER_LIFT_FROM = 0.35;

/** the hammer's rebound from the string, `dt` after it struck: caught by the check with a little give */
export function rebound(dt: number): number {
  if (dt <= 0) return 1;
  const c = HAMMER_CHECK;
  // off the string at once, then the check's felt gives a little and settles
  const fall = c + (1 - c) * Math.exp(-dt / 0.0065);
  const give = 0.055 * Math.sin(Math.PI * clamp((dt - 0.008) / 0.06, 0, 1)) * Math.exp(-dt / 0.05);
  return fall - give;
}

/** where stroke j's hammer is at t (t at or after its fingertip landed) */
function strokeHammer(strokes: readonly KeyStroke[], j: number, t: number): number {
  const s = strokes[j];
  if (t >= s.release) return rebound(s.release - s.bottom) * Math.max(0, releaseCurve(1, t - s.release));
  if (t >= s.bottom) return rebound(t - s.bottom);
  // lifted with the key from wherever the previous stroke left both
  const d0 = j > 0 ? strokeDepth(strokes, j - 1, s.contact) : 0;
  const h0 = j > 0 ? strokeHammer(strokes, j - 1, s.contact) : 0;
  const d = strokeDepth(strokes, j, t);
  const e = clamp((d - d0) / Math.max(1e-6, 1 - d0), 0, 1);
  return h0 + (1 - h0) * e;
}

/** a key's hammer at t: 0 at rest, 1 at the string */
export function hammerAt(strokes: readonly KeyStroke[], t: number): number {
  const i = strokeIndexAt(strokes, t);
  return i < 0 ? 0 : clamp(strokeHammer(strokes, i, t), 0, 1);
}

/** how far a key's damper is off its strings, from the key's depression and the sustain pedal */
export function damperAt(midi: number, depression: number, pedal: number): number {
  if (midi >= UNDAMPED_FROM) return 0;
  const d = clamp((depression - DAMPER_LIFT_FROM) / 0.4, 0, 1);
  return Math.max(d * d * (3 - 2 * d), clamp(pedal, 0, 1));
}

/** all 88 hammers at t */
export function hammersAt(strokes: readonly (readonly KeyStroke[])[], t: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = hammerAt(strokes[i], t);
  return out;
}

/** all 88 dampers from the keys' depressions and the pedal */
export function dampersAt(keys: Float32Array, pedal: number, out = new Float32Array(KEY_COUNT)): Float32Array {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = damperAt(LOWEST_MIDI + i, keys[i], pedal);
  return out;
}
