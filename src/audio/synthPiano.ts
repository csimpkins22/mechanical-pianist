// The fallback piano: physically inspired additive synthesis, rendered once
// into buffers (one per minor third, like the sample set) so playback works
// identically. Stiff-string inharmonicity, three slightly detuned strings per
// note (beating), a two-stage decay (prompt sound and aftersound), partials
// that die faster the higher they are, and a short felt-hammer thump.

export function synthesizePiano(ctx: BaseAudioContext, midis: number[]): Map<number, AudioBuffer> {
  const out = new Map<number, AudioBuffer>();
  const sr = ctx.sampleRate;
  for (const m of midis) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    const dur = Math.min(4.5, 1.4 + 3.5 * Math.pow(Math.max(0, (96 - m) / 75), 1.3));
    const n = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const B = 0.00008 * Math.pow(2, (m - 21) / 22); // inharmonicity grows up the keyboard
    const tau0 = 0.35 + 3.8 * Math.pow(Math.max(0, (108 - m) / 87), 1.6);
    const strings = m < 34 ? 1 : 2;
    let seed = m * 9301 + 49297;
    const rnd = () => ((seed = (seed * 233280 + 49297) % 233280) / 233280) * 2 - 1;
    for (let k = 1; k <= 20; k++) {
      const fk = k * f0 * Math.sqrt(1 + B * k * k);
      if (fk > sr * 0.45) break;
      const amp = (1 / Math.pow(k, 1.05)) * Math.exp(-0.06 * k * (f0 / 440 + 0.6)) * (k === 1 ? 0.8 : 1);
      const tauFast = (tau0 * 0.18) / (1 + 0.08 * k);
      const tauSlow = tau0 / (1 + 0.035 * k * k);
      for (let s = 0; s < strings; s++) {
        const det = 1 + (s - (strings - 1) / 2) * 0.0007;
        const ph = rnd() * Math.PI;
        const w = (2 * Math.PI * fk * det) / sr;
        const a = amp / strings;
        // recursive oscillator and multiplicative envelopes: no per-sample transcendental calls
        const c = Math.cos(w);
        const sn = Math.sin(w);
        let x = Math.cos(ph);
        let y = Math.sin(ph);
        let ef = 0.65 * a;
        let es = 0.35 * a;
        const kf = Math.exp(-1 / (sr * tauFast));
        const ks = Math.exp(-1 / (sr * tauSlow));
        for (let i = 0; i < n; i++) {
          d[i] += (ef + es) * y;
          const nx = x * c - y * sn;
          y = x * sn + y * c;
          x = nx;
          ef *= kf;
          es *= ks;
        }
      }
    }
    // hammer: a brief, soft knock
    let lp = 0;
    for (let i = 0; i < Math.min(n, sr * 0.03); i++) {
      lp += (rnd() - lp) * 0.2;
      d[i] += lp * 0.12 * Math.exp(-i / (sr * 0.006));
    }
    // attack ramp and normalisation
    let peak = 0;
    for (let i = 0; i < n; i++) {
      if (i < 48) d[i] *= i / 48;
      peak = Math.max(peak, Math.abs(d[i]));
    }
    const norm = 0.5 / (peak || 1);
    for (let i = 0; i < n; i++) d[i] *= norm;
    out.set(m, buf);
  }
  return out;
}
