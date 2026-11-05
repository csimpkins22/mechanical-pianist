// A synthesized drum kit, for when the samples cannot load: every
// articulation the sampled kit has, at three velocity layers with two
// alternates each (different noise), rendered once into buffers.
//   kick:   a sine that drops in pitch, a felt click, a little shell resonance
//   snare:  two head modes and filtered noise for the wires
//   toms:   a pitched head mode that sags as it rings, and a little stick noise
//   hi-hat: six square waves at inharmonic ratios through a high band-pass
//           (the classic metallic recipe), decaying faster the more closed
//   crash/ride: many inharmonic partials and noise, long decays; the bell
//           purer and higher
import type { ArticId } from './DrumAudio';

type Kit = Partial<Record<ArticId, { velocity: number; files: { file: string; attack: number; buf?: AudioBuffer; offset?: number }[] }[]>>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
}

/** one-pole filters, in place */
function lowpass(x: Float32Array, sr: number, f: number) {
  const a = Math.exp((-2 * Math.PI * f) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) x[i] = y = (1 - a) * x[i] + a * y;
}
function highpass(x: Float32Array, sr: number, f: number) {
  const a = Math.exp((-2 * Math.PI * f) / sr);
  let y = 0;
  let px = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    y = a * (y + v - px);
    px = v;
    x[i] = y;
  }
}

interface Voice {
  len: number;
  render(i: number, t: number): number;
  post?: (x: Float32Array, sr: number) => void;
}

function voiceFor(id: ArticId, vel: number, seed: number, sr: number): Voice {
  const n = rng(seed);
  const metal = (t: number, base: number) => {
    // six square waves at the 808's inharmonic ratios
    let s = 0;
    for (const r of [1, 1.4471, 1.6170, 1.9265, 2.5028, 2.6637]) s += Math.sign(Math.sin(2 * Math.PI * base * r * t + seed));
    return s / 6;
  };
  const hat = (decay: number, len: number): Voice => ({
    len,
    render: (_i, t) => (metal(t, 330) * 0.6 + n() * 0.5) * Math.exp(-t / decay) * (0.4 + 0.6 * vel),
    post: (x, s) => {
      highpass(x, s, 6500);
      lowpass(x, s, 13000);
    },
  });
  const cym = (decay: number, len: number, bright: number, base: number): Voice => {
    const parts = Array.from({ length: 24 }, (_, k) => ({ f: base * (1 + k * 0.731 + 0.13 * Math.sin(k * 7.1 + seed)), p: k * 1.7 + seed, a: 1 / (1 + k * 0.15) }));
    return {
      len,
      render: (_i, t) => {
        let s = 0;
        for (const p of parts) s += p.a * Math.sin(2 * Math.PI * p.f * t + p.p);
        return (s * 0.05 + n() * bright) * Math.exp(-t / decay) * (1 - Math.exp(-t / 0.002)) * (0.35 + 0.65 * vel);
      },
      post: (x, s) => highpass(x, s, 900),
    };
  };
  const tom = (f0: number): Voice => ({
    len: 1.6,
    render: (_i, t) => {
      const f = f0 * (1 + 0.25 * vel * Math.exp(-t / 0.05));
      return (Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.45) + n() * 0.25 * Math.exp(-t / 0.01)) * (0.3 + 0.7 * vel);
    },
  });
  switch (id) {
    case 'kick':
      return {
        len: 0.7,
        render: (_i, t) => {
          const ph = 2 * Math.PI * (52 * t + (60 * (1 - Math.exp(-t / 0.035))) * 0.035);
          return (Math.sin(ph) * Math.exp(-t / 0.22) + n() * 0.35 * Math.exp(-t / 0.004)) * (0.3 + 0.7 * vel);
        },
      };
    case 'snare':
    case 'rimshot': {
      const rim = id === 'rimshot';
      return {
        len: 0.6,
        render: (_i, t) =>
          ((Math.sin(2 * Math.PI * 185 * t) * 0.5 + Math.sin(2 * Math.PI * 330 * t) * 0.3) * Math.exp(-t / 0.06) + n() * (rim ? 0.9 : 0.6) * Math.exp(-t / 0.13)) *
          (0.25 + 0.75 * vel),
        post: (x, s) => highpass(x, s, 120),
      };
    }
    case 'crossStick':
      return { len: 0.25, render: (_i, t) => (Math.sin(2 * Math.PI * 520 * t) * 0.6 + n() * 0.4) * Math.exp(-t / 0.025) * (0.4 + 0.6 * vel) };
    case 'tom1':
      return tom(165);
    case 'tom2':
      return tom(130);
    case 'floorTom':
      return tom(92);
    case 'hhTight':
      return hat(0.025, 0.25);
    case 'hhClosed':
    case 'hhEdge':
      return hat(0.045, 0.35);
    case 'hhPedal':
      return hat(0.03, 0.3);
    case 'hhLoose':
      return hat(0.12, 0.8);
    case 'hhQuarter':
      return hat(0.3, 1.4);
    case 'hhHalf':
      return hat(0.6, 2.2);
    case 'hhOpen':
    case 'hhSplash':
      return hat(1.0, 3);
    case 'crash':
      return cym(1.4, 4.5, 0.35, 410);
    case 'ride':
      return cym(1.8, 4.5, 0.12, 520);
    case 'rideEdge':
      return cym(1.6, 4.5, 0.3, 470);
    case 'rideBell':
      return cym(1.5, 4, 0.04, 980);
    case 'crashChoke':
    case 'rideChoke':
      return cym(0.06, 0.4, 0.3, 450);
  }
}

const ALL: ArticId[] = [
  'kick', 'snare', 'rimshot', 'crossStick', 'tom1', 'tom2', 'floorTom', 'hhTight', 'hhClosed', 'hhLoose', 'hhQuarter', 'hhHalf', 'hhOpen', 'hhEdge', 'hhPedal',
  'hhSplash', 'crash', 'crashChoke', 'ride', 'rideBell', 'rideEdge', 'rideChoke',
];

export function synthesizeKit(ctx: BaseAudioContext): Kit {
  const sr = ctx.sampleRate;
  const kit: Kit = {};
  let seed = 1;
  for (const id of ALL) {
    kit[id] = [0.3, 0.6, 0.95].map((velocity) => ({
      velocity,
      files: [0, 1].map(() => {
        const v = voiceFor(id, velocity, seed++, sr);
        const len = Math.floor(v.len * sr);
        const x = new Float32Array(len);
        for (let i = 0; i < len; i++) x[i] = v.render(i, i / sr);
        v.post?.(x, sr);
        // fade the tail
        const fl = Math.floor(len * 0.2);
        for (let i = 0; i < fl; i++) x[len - 1 - i] *= i / fl;
        let peak = 0;
        for (const s of x) peak = Math.max(peak, Math.abs(s));
        const norm = (0.6 * velocity + 0.2) / Math.max(1e-4, peak);
        const buf = ctx.createBuffer(2, len, sr);
        const l = buf.getChannelData(0);
        const r = buf.getChannelData(1);
        for (let i = 0; i < len; i++) l[i] = r[i] = x[i] * norm;
        return { file: `synth:${id}`, attack: 0, buf, offset: 0 };
      }),
    }));
  }
  return kit;
}
