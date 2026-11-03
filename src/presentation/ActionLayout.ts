// Where everything inside the upright stands: hammers, strings, dampers,
// tuning and hitch pins, bridges, the plate's struts. Pure numbers (no
// three.js) so the camera's inside shots and the 3D build share them.
//
// World space as in core/keyboard.ts: metres, +Y up, the keyboard along X,
// the player at +Z; white key tops at y = 0, the upper panel's front at
// z = -0.212. Behind it the action stands on the key frame; the strings run
// almost vertically in a plane about 34 cm behind the key fronts, the bass
// overstrung in front of the tenor on a steep diagonal; the plate and the
// soundboard are behind them. The hammers strike along one line, about a
// quarter of a metre above the keys, an eighth of each string's speaking
// length below its upper end.
import { KEYS, KEY_COUNT } from '../core/keyboard';

export const STRIKE_Y = 0.255;
export const STRING_Z_TREBLE = -0.338;
export const STRING_Z_BASS = -0.326;
export const PLATE_Z = -0.351; // front face of the plate
export const SOUNDBOARD_Z = -0.375;
/** A0..E2 are copper-wound, on their own bridge, overstrung across the tenor */
export const BASS_N = 20;
/** hammer: pivot to head centre, and head centre to the striking crown */
export const SHANK = 0.115;
export const CROWN = 0.0175;
/** hammer angle at rest (rad, the head leaning back toward the player): the crown about 45 mm from the string */
export const HAMMER_REST = 0.39;
export const HEAD_W = 0.0104;
/** damper lever pivot height, and its swing off the strings (rad) */
export const DAMPER_PIVOT_Y = 0.17;
export const DAMPER_SWING = 0.055;

// hammers in four sections (bass, tenor, two treble), each its own spacing,
// with gaps where the plate's struts and the action brackets stand
const SECTIONS: [number, number][] = [
  [20, 0.0132],
  [24, 0.0124],
  [28, 0.0118],
  [16, 0.0115],
];
const GAPS = [0.045, 0.04, 0.035];
const X0 = -0.57;

export const HAMMER_X: number[] = [];
/** centres of the gaps between sections: struts and brackets */
export const STRUT_X: number[] = [];
{
  let x = X0;
  SECTIONS.forEach(([n, pitch], s) => {
    for (let i = 0; i < n; i++) HAMMER_X.push(x + pitch * (i + 0.5));
    x += n * pitch;
    if (s < GAPS.length) {
      STRUT_X.push(x + GAPS[s] / 2);
      x += GAPS[s];
    }
  });
}
export const HAMMER_SPAN = [HAMMER_X[0] - 0.0066, HAMMER_X[KEY_COUNT - 1] + 0.0058];

/** the hammer above (behind) a point on the keyboard: piecewise linear between the key centres */
export function hammerXAtKeyX(x: number): number {
  if (x <= KEYS[0].x) return HAMMER_X[0];
  const last = KEY_COUNT - 1;
  if (x >= KEYS[last].x) return HAMMER_X[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (KEYS[m].x <= x) lo = m;
    else hi = m;
  }
  const u = (x - KEYS[lo].x) / (KEYS[hi].x - KEYS[lo].x);
  return HAMMER_X[lo] + (HAMMER_X[hi] - HAMMER_X[lo]) * u;
}

export const unisons = (i: number) => (i < 8 ? 1 : i < BASS_N ? 2 : 3);
export const isWound = (i: number) => i < BASS_N;
export const stringZ = (i: number) => (isWound(i) ? STRING_Z_BASS : STRING_Z_TREBLE);
/** string radius (m): heavy copper-wound bass, thin steel in the treble */
export const stringRadius = (i: number) => (isWound(i) ? 0.0028 - (0.0012 * i) / (BASS_N - 1) : 0.00058 - (0.00016 * (i - BASS_N)) / (KEY_COUNT - 1 - BASS_N));
/** speaking length (m): halving about every octave in the treble, foreshortened in the bass as an upright's must be */
export const speakingLength = (i: number) => Math.min(isWound(i) ? 1.12 : 1.0, 0.052 * Math.pow(2, ((KEY_COUNT - 1 - i) * 0.95) / 12));
/** string slope dx/dy: the bass on a steep diagonal, the rest nearly upright */
export const stringSlope = (i: number) => (isWound(i) ? -0.42 : -0.05);

export interface StringLine {
  key: number;
  /** where the hammer strikes it */
  strike: [number, number, number];
  /** unit direction, upward */
  dir: [number, number, number];
  pin: [number, number, number];
  bridge: [number, number, number];
  hitch: [number, number, number];
  radius: number;
  wound: boolean;
}

/** every string of the piano (one to three per key), in key order */
export const STRINGS: StringLine[] = [];
for (let i = 0; i < KEY_COUNT; i++) {
  const n = unisons(i);
  const wound = isWound(i);
  const s = stringSlope(i);
  const len = Math.hypot(s, 1);
  const ux = s / len;
  const uy = 1 / len;
  const z = stringZ(i);
  const L = speakingLength(i);
  const spacing = wound ? 0.0034 : 0.0024;
  for (let k = 0; k < n; k++) {
    const x = HAMMER_X[i] + (k - (n - 1) / 2) * spacing;
    const at = (t: number): [number, number, number] => [x + ux * t, STRIKE_Y + uy * t, z];
    // tuning pins in staggered rows across the pin block
    const yPin = 0.434 + 0.017 * k + 0.007 * (i % 2);
    const tb = -(7 / 8) * L;
    STRINGS.push({
      key: i,
      strike: at(0),
      dir: [ux, uy, 0],
      pin: at((yPin - STRIKE_Y) / uy),
      bridge: at(tb),
      hitch: at(tb - 0.035),
      radius: stringRadius(i),
      wound,
    });
  }
}
/** first string of each key, and how many */
export const STRING_START: number[] = [];
{
  let j = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    STRING_START.push(j);
    j += unisons(i);
  }
}
