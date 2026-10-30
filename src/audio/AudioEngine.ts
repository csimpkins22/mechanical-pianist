// Piano sound, scheduled against the same master timeline as the picture.
//
// Salamander Grand Piano samples (three velocity layers, every minor third,
// pitch-shifted to the notes in between) with per-voice brightness from
// velocity, damper behaviour from the sustain pedal (via the timeline's
// release times), undamped top octaves, quiet key-release noises and a small
// synthesized room. If the samples cannot be loaded a synthesized piano takes
// over. Nothing is ever started without a user gesture.
import type { PerformanceNote } from '../core/types';
import type { PerformanceTimeline } from '../performance/PerformanceTimeline';
import { synthesizePiano } from './synthPiano';

const LAYERS = [
  { dir: 'v4', suffix: 'v4', vel: 0.25 },
  { dir: 'v9', suffix: 'v9', vel: 0.55 },
  { dir: 'v15', suffix: 'v15', vel: 0.9 },
];
const SAMPLE_NAMES = ['C', 'Ds', 'Fs', 'A'];
const SAMPLE_PCS = [0, 3, 6, 9];
const LOOKAHEAD = 0.25; // seconds of performance scheduled ahead
const UNDAMPED_FROM = 89; // F6 and above have no dampers

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  end: number; // audio time it will stop
}

function sampleMidis(): number[] {
  const out: number[] = [];
  for (let m = 21; m <= 108; m++) if (SAMPLE_PCS.includes(m % 12)) out.push(m);
  return out;
}

function sampleName(m: number, suffix: string) {
  return `${SAMPLE_NAMES[SAMPLE_PCS.indexOf(m % 12)]}${Math.floor(m / 12) - 1}${suffix}.mp3`;
}

export type AudioStatus = 'idle' | 'loading' | 'samples' | 'synth' | 'error';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private layers: Map<number, AudioBuffer>[] = [];
  private release = new Map<number, AudioBuffer>();
  private voices: Voice[] = [];
  private scheduledUntil = 0; // performance time
  private scheduled = new Set<number>();
  private anchorAudio = 0;
  private anchorT = 0;
  private speed = 1;
  private running = false;
  status: AudioStatus = 'idle';
  volume = 0.8;
  muted = false;
  onStatus?: (s: AudioStatus) => void;

  constructor(private base: string) {}

  /** create the context (must be inside a user gesture) and start loading */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.2;
    const verb = ctx.createConvolver();
    verb.buffer = this.roomImpulse(ctx);
    this.dry.connect(this.master);
    this.wet.connect(verb).connect(this.master);
    this.setStatus('loading');
    try {
      await this.loadSamples(ctx);
      this.setStatus('samples');
    } catch (e) {
      console.warn('piano samples unavailable, using the synthesized piano', e);
      this.layers = [synthesizePiano(ctx, sampleMidis())];
      this.setStatus('synth');
    }
  }

  private setStatus(s: AudioStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  private async loadSamples(ctx: AudioContext) {
    const fetchBuf = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return ctx.decodeAudioData(await r.arrayBuffer());
    };
    // the middle layer first, so playback can begin as soon as possible
    const order = [1, 0, 2];
    this.layers = [new Map(), new Map(), new Map()];
    const mids = sampleMidis();
    const loadLayer = (li: number) =>
      Promise.all(mids.map(async (m) => this.layers[li].set(m, await fetchBuf(`${this.base}samples/${LAYERS[li].dir}/${sampleName(m, LAYERS[li].suffix)}`))));
    await loadLayer(order[0]);
    // the rest load in the background
    void Promise.all([loadLayer(order[1]), loadLayer(order[2])]).catch((e) => console.warn('velocity layer failed', e));
    void Promise.all(
      Array.from({ length: 88 }, async (_, i) => this.release.set(21 + i, await fetchBuf(`${this.base}samples/rel/rel${i + 1}.mp3`))),
    ).catch(() => undefined);
  }

  /** a small, dark wooden room: decaying stereo noise */
  private roomImpulse(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 1.6);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let s = 99;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        lp += (rnd() - lp) * (0.35 - 0.2 * Math.min(1, t / 1.2)); // darker as it decays
        d[i] = lp * Math.exp(-t * 3.4) * (t < 0.008 ? t / 0.008 : 1);
      }
    }
    return buf;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.03);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.setVolume(this.volume);
  }

  get isRunning() {
    return this.running && !!this.ctx;
  }

  get ready() {
    return this.status === 'samples' || this.status === 'synth';
  }

  /** current performance time from the audio clock (what the listener hears now) */
  clockTime(): number {
    if (!this.ctx || !this.running) return this.anchorT;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.anchorT + (this.ctx.currentTime - lat - this.anchorAudio) * this.speed;
  }

  /** begin playing from performance time t; resumes notes already sounding at t */
  start(tl: PerformanceTimeline, t: number, speed: number) {
    if (!this.ctx || !this.ready) return;
    this.stopAll(0.02);
    this.speed = speed;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    this.anchorAudio = this.ctx.currentTime + 0.05 - lat;
    this.anchorT = t;
    this.running = true;
    this.scheduled.clear();
    // notes struck before t that still sound: start their samples part-way through
    for (const n of tl.sounding(t)) {
      if (n.start < t - 0.005) this.voice(n, tl.releaseOf(n), t - n.start);
      this.scheduled.add(n.id);
    }
    this.scheduledUntil = t;
    this.pump(tl);
  }

  stop() {
    if (!this.ctx) return;
    this.anchorT = this.clockTime();
    this.running = false;
    this.stopAll(0.06);
  }

  /** schedule everything that begins within the lookahead window; call often */
  pump(tl: PerformanceTimeline) {
    if (!this.ctx || !this.running) return;
    const now = this.clockTime();
    const until = now + LOOKAHEAD * this.speed;
    if (until <= this.scheduledUntil) return;
    for (const n of tl.perf.notes) {
      if (n.start < this.scheduledUntil - 0.001 || n.start >= until) continue;
      if (this.scheduled.has(n.id)) continue;
      this.scheduled.add(n.id);
      this.voice(n, tl.releaseOf(n), 0);
    }
    this.scheduledUntil = until;
    // key-release noises
    for (const n of tl.perf.notes) {
      const r = n.keyEnd;
      if (r >= now && r < until && !this.scheduled.has(-1 - n.id)) {
        this.scheduled.add(-1 - n.id);
        this.releaseNoise(n);
      }
    }
    this.voices = this.voices.filter((v) => v.end > this.ctx!.currentTime);
  }

  private toAudio(t: number) {
    return this.anchorAudio + (t - this.anchorT) / this.speed;
  }

  private pick(midi: number, vel: number): { buf: AudioBuffer; rate: number; gain: number }[] {
    const out: { buf: AudioBuffer; rate: number; gain: number }[] = [];
    // the loaded velocity layers, softest first (the synthesized fallback is a single layer)
    const avail = this.layers
      .map((l, i) => ({ l, v: this.layers.length === 1 ? 0.55 : LAYERS[i].vel }))
      .filter((x) => x.l.size > 0)
      .sort((a, b) => a.v - b.v);
    if (!avail.length) return out;
    let lo = avail[0];
    let hi = avail[avail.length - 1];
    for (const x of avail) if (x.v <= vel) lo = x;
    for (let i = avail.length - 1; i >= 0; i--) if (avail[i].v >= vel) hi = avail[i];
    if (vel < avail[0].v) hi = lo = avail[0];
    if (vel > avail[avail.length - 1].v) lo = hi = avail[avail.length - 1];
    // equal-power crossfade between the two nearest layers
    const u = lo === hi ? 0 : (vel - lo.v) / (hi.v - lo.v);
    const pair = lo === hi ? [{ x: lo, w: 1 }] : [{ x: lo, w: Math.cos((u * Math.PI) / 2) }, { x: hi, w: Math.sin((u * Math.PI) / 2) }];
    for (const { x, w } of pair) {
      let best = -1;
      let bd = 99;
      for (const m of x.l.keys()) {
        const d = Math.abs(m - midi);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      const buf = x.l.get(best);
      if (buf && w > 0.02) out.push({ buf, rate: Math.pow(2, (midi - best) / 12), gain: w });
    }
    return out;
  }

  private voice(n: PerformanceNote, soundEnd: number, offset: number) {
    const ctx = this.ctx!;
    const when = Math.max(ctx.currentTime, this.toAudio(n.start + offset));
    const loud = 0.12 + 0.88 * Math.pow(n.velocity, 1.6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400 + 15000 * Math.pow(n.velocity, 1.7);
    filter.Q.value = 0.4;
    const out = ctx.createGain();
    out.gain.value = loud * 0.9;
    filter.connect(out);
    out.connect(this.dry);
    out.connect(this.wet);
    const damped = n.midi < UNDAMPED_FROM;
    // dampers fall back on the strings: low strings ring on a little longer
    const releaseTau = 0.06 + 0.22 * Math.max(0, (72 - n.midi) / 51);
    const tEnd = damped ? this.toAudio(soundEnd) : this.toAudio(soundEnd) + 1.5;
    for (const p of this.pick(n.midi, n.velocity)) {
      const src = ctx.createBufferSource();
      src.buffer = p.buf;
      src.playbackRate.value = p.rate;
      const g = ctx.createGain();
      g.gain.value = p.gain;
      src.connect(g).connect(filter);
      const off = (offset / this.speed) * p.rate;
      if (off >= p.buf.duration / p.rate) continue;
      src.start(when, off);
      g.gain.setValueAtTime(p.gain, Math.max(when, tEnd));
      g.gain.setTargetAtTime(0, Math.max(when, tEnd), damped ? releaseTau : 0.8);
      const stopAt = Math.max(when, tEnd) + (damped ? releaseTau * 8 : 4);
      src.stop(stopAt);
      this.voices.push({ src, gain: g, end: stopAt });
    }
  }

  private releaseNoise(n: PerformanceNote) {
    const buf = this.release.get(n.midi);
    if (!buf || !this.ctx) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.08 + 0.1 * n.velocity;
    src.connect(g).connect(this.dry);
    const when = Math.max(ctx.currentTime, this.toAudio(n.keyEnd));
    src.start(when);
    src.stop(when + Math.min(1.2, buf.duration));
    this.voices.push({ src, gain: g, end: when + 1.2 });
  }

  /** quickly fade out everything (seek, pause): no stuck notes */
  stopAll(fade: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + fade);
        v.src.stop(now + fade + 0.01);
      } catch {
        /* already stopped */
      }
    }
    this.voices = [];
    this.scheduled.clear();
  }
}
