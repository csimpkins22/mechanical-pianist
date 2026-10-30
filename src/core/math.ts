export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const saturate = (x: number) => clamp(x, 0, 1);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const easeInQuad = (t: number) => t * t;
export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Index of the last element with key(el) <= x, or -1. */
export function lastAtOrBefore<T>(arr: readonly T[], x: number, key: (el: T) => number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * A uniformly sampled signal: precomputed once by the planners, then read
 * at any time with linear interpolation. Reading never mutates anything.
 */
export class Signal {
  constructor(public readonly t0: number, public readonly rate: number, public readonly data: Float32Array) {}

  static constant(v: number) {
    return new Signal(0, 1, new Float32Array([v, v]));
  }

  at(t: number): number {
    const d = this.data;
    const x = (t - this.t0) * this.rate;
    if (x <= 0) return d[0];
    const n = d.length - 1;
    if (x >= n) return d[n];
    const i = Math.floor(x);
    const f = x - i;
    return d[i] + (d[i + 1] - d[i]) * f;
  }

  /** time derivative (per second) */
  slope(t: number): number {
    const h = 1 / this.rate;
    return (this.at(t + h) - this.at(t - h)) / (2 * h);
  }
}

/** Zero-phase (non-causal) Gaussian blur of a sampled signal, sigma in samples. */
export function gaussianBlur(src: Float32Array, sigma: number, out = new Float32Array(src.length)): Float32Array {
  if (sigma < 0.5) {
    out.set(src);
    return out;
  }
  const r = Math.ceil(sigma * 3);
  const w = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += w[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
      acc += src[j] * w[k + r];
    }
    out[i] = acc;
  }
  return out;
}
