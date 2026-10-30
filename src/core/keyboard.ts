// The keyboard as a physical object: the single source of truth for key
// geometry, shared by the fingering cost model, the motion planner, the IK
// targets and the piano model, so a fingertip target and the key it presses
// can never disagree.
//
// World space: metres, +Y up, keyboard along X (bass at -X), the player sits
// at +Z. White key tops at rest are at y = 0; their front edges are at z = 0.

export const LOWEST_MIDI = 21; // A0
export const HIGHEST_MIDI = 108; // C8
export const KEY_COUNT = HIGHEST_MIDI - LOWEST_MIDI + 1; // 88

export const WHITE_PITCH = 0.02350; // centre-to-centre spacing of white keys
export const WHITE_GAP = 0.00110; // gap between neighbouring white keys
export const WHITE_LENGTH = 0.1500; // visible length, front edge to fallboard
export const WHITE_FRONT_HEIGHT = 0.0215; // height of the key front face
export const BLACK_WIDTH_BOTTOM = 0.0128;
export const BLACK_WIDTH_TOP = 0.0098;
export const BLACK_LENGTH = 0.0950;
export const BLACK_HEIGHT = 0.0122; // black key top above the white key surface
export const BLACK_FRONT_Z = -(WHITE_LENGTH - BLACK_LENGTH); // -0.055

// Key action: keys pivot on a balance rail hidden inside the piano.
export const WHITE_PIVOT_Z = -0.255;
export const BLACK_PIVOT_Z = -0.27;
export const PIVOT_Y = -0.03;
export const KEY_DIP = 0.0100; // white key front travel, m
export const BLACK_DIP = 0.0095; // black key travel at its front edge

/** Pitch classes that are black keys. */
const BLACK_PC = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function isBlack(midi: number): boolean {
  return BLACK_PC.has(((midi % 12) + 12) % 12);
}

export function noteName(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function parseNoteName(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`bad note name ${name}`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}

/** Number of white keys strictly below `midi` on an 88-key keyboard. */
function whiteIndexOf(midi: number): number {
  let n = 0;
  for (let p = LOWEST_MIDI; p < midi; p++) if (!isBlack(p)) n++;
  return n;
}

export const WHITE_COUNT = whiteIndexOf(HIGHEST_MIDI + 1); // 52
const KEYBOARD_WIDTH = WHITE_COUNT * WHITE_PITCH;
const LEFT_EDGE = -KEYBOARD_WIDTH / 2;

// Black keys in each group sit so that the white key "tails" between them are
// equal, which is how real keyboards are laid out (C#/D# in the C-E group,
// F#/G#/A# in the F-B group).
function blackCenterX(midi: number): number {
  const pc = midi % 12;
  const octaveC = midi - pc; // the C at or below
  const cx = whiteLeftEdge(octaveC);
  const B = BLACK_WIDTH_BOTTOM;
  if (pc === 1 || pc === 3) {
    const tail = (3 * WHITE_PITCH - 2 * B) / 3;
    const left = pc === 1 ? tail : 2 * tail + B;
    return cx + left + B / 2;
  }
  const fx = cx + 3 * WHITE_PITCH;
  const tail = (4 * WHITE_PITCH - 3 * B) / 4;
  const k = pc === 6 ? 0 : pc === 8 ? 1 : 2;
  return fx + (k + 1) * tail + k * B + B / 2;
}

function whiteCountFromC0(midi: number): number {
  let n = 0;
  for (let p = 12; p < midi; p++) if (!isBlack(p)) n++;
  return n;
}
const A0_FROM_C0 = whiteCountFromC0(LOWEST_MIDI);

/** Left edge of the white key `midi` (also valid for the virtual C0 below A0). */
function whiteLeftEdge(midi: number): number {
  return LEFT_EDGE + (whiteCountFromC0(midi) - A0_FROM_C0) * WHITE_PITCH;
}

export interface KeyInfo {
  midi: number;
  index: number; // 0..87
  black: boolean;
  /** key centre x (for white keys: centre of the full-width front part) */
  x: number;
  /** for white keys: x range of the full-width front, and of the narrow tail between black keys */
  frontLeft: number;
  frontRight: number;
  tailLeft: number;
  tailRight: number;
  /** resting top surface height */
  topY: number;
  frontZ: number;
  backZ: number;
  pivotZ: number;
  /** travel at the front edge */
  dip: number;
  /** where a finger naturally plays this key (z) */
  playZ: number;
  /** min/max z a fingertip may contact on this key */
  playZMin: number;
  playZMax: number;
}

function buildKeys(): KeyInfo[] {
  const keys: KeyInfo[] = [];
  for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
    const black = isBlack(midi);
    if (black) {
      const x = blackCenterX(midi);
      keys.push({
        midi,
        index: midi - LOWEST_MIDI,
        black,
        x,
        frontLeft: x - BLACK_WIDTH_BOTTOM / 2,
        frontRight: x + BLACK_WIDTH_BOTTOM / 2,
        tailLeft: x - BLACK_WIDTH_BOTTOM / 2,
        tailRight: x + BLACK_WIDTH_BOTTOM / 2,
        topY: BLACK_HEIGHT,
        frontZ: BLACK_FRONT_Z,
        backZ: -WHITE_LENGTH,
        pivotZ: BLACK_PIVOT_Z,
        dip: BLACK_DIP,
        playZ: BLACK_FRONT_Z - 0.022,
        playZMin: BLACK_FRONT_Z - 0.06,
        playZMax: BLACK_FRONT_Z - 0.008,
      });
    } else {
      const left = whiteLeftEdge(midi);
      const right = left + WHITE_PITCH;
      keys.push({
        midi,
        index: midi - LOWEST_MIDI,
        black,
        x: (left + right) / 2,
        frontLeft: left + WHITE_GAP / 2,
        frontRight: right - WHITE_GAP / 2,
        tailLeft: left + WHITE_GAP / 2,
        tailRight: right - WHITE_GAP / 2,
        topY: 0,
        frontZ: 0,
        backZ: -WHITE_LENGTH,
        pivotZ: WHITE_PIVOT_Z,
        dip: KEY_DIP,
        playZ: -0.03,
        // behind the black keys a finger can still play the narrow tail
        playZMin: -0.105,
        playZMax: -0.010,
      });
    }
  }
  // narrow tails of white keys: cut by neighbouring black keys
  for (const k of keys) {
    if (k.black) continue;
    const below = keys[k.index - 1];
    const above = keys[k.index + 1];
    if (below && below.black) k.tailLeft = below.x + BLACK_WIDTH_BOTTOM / 2 + WHITE_GAP * 0.6;
    if (above && above.black) k.tailRight = above.x - BLACK_WIDTH_BOTTOM / 2 - WHITE_GAP * 0.6;
  }
  return keys;
}

export const KEYS: readonly KeyInfo[] = buildKeys();

/** Where a fingertip touches key k at depth z: centred on the narrow tail when it plays between black keys. */
export function contactX(k: KeyInfo, z: number): number {
  if (k.black || z > BLACK_FRONT_Z + 0.004) return k.x;
  return (k.tailLeft + k.tailRight) / 2;
}

export function keyOf(midi: number): KeyInfo {
  const k = KEYS[midi - LOWEST_MIDI];
  if (!k) throw new Error(`midi ${midi} is outside the 88-key range`);
  return k;
}

export function inRange(midi: number): boolean {
  return midi >= LOWEST_MIDI && midi <= HIGHEST_MIDI;
}

/** Lateral distance between two keys' playing positions, metres. */
export function keyDistance(a: number, b: number): number {
  return keyOf(b).x - keyOf(a).x;
}

/** Rotation of a key (radians, positive = front goes down) for depression d in [0,1]. */
export function keyAngle(k: KeyInfo, d: number): number {
  return Math.asin(Math.min(1, (d * k.dip) / (k.frontZ - k.pivotZ)));
}

/**
 * World-space point on the top surface of key `k` at depth z (rest-pose z) when
 * the key is depressed by fraction d. Writes into out [x, y, z].
 */
export function keySurfacePoint(k: KeyInfo, z: number, d: number, out: number[], x = k.x): number[] {
  const a = keyAngle(k, d);
  const ry = k.topY - PIVOT_Y;
  const rz = z - k.pivotZ;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = x;
  out[1] = PIVOT_Y + ry * c - rz * s;
  out[2] = k.pivotZ + ry * s + rz * c;
  return out;
}

/**
 * Highest resting key surface within `radius` of (x, z): what a hovering
 * fingertip must clear.
 */
export function keyTopNear(x: number, z: number, radius: number): number {
  let top = -1;
  // binary search for the first key whose right edge is beyond x - radius
  let lo = 0;
  let hi = KEYS.length - 1;
  const xl = x - radius;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (KEYS[mid].frontRight < xl) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i < KEYS.length; i++) {
    const k = KEYS[i];
    if (k.frontLeft > x + radius) break;
    if (k.frontRight < x - radius) continue;
    if (z - radius > k.frontZ + 0.004 || z + radius < k.backZ) continue;
    if (k.topY > top) top = k.topY;
  }
  return top < -0.5 ? 0 : top;
}
