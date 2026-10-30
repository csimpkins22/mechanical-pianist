// Seeded randomness. Everything that looks organic (micro-variation in finger
// placement, breathing, dust) is a pure function of a seed and time, so the
// same timestamp always produces the same frame.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0, 1). */
export function hash01(n: number, seed = 0): number {
  let x = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [-1, 1], continuous in t. */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i, seed) * 2 - 1;
  const b = hash01(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/** A few octaves of noise1: slow, organic drift. */
export function drift(t: number, seed = 0): number {
  return noise1(t, seed) * 0.6 + noise1(t * 2.13 + 17.1, seed + 1) * 0.28 + noise1(t * 4.7 + 3.3, seed + 2) * 0.12;
}
