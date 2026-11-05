// The drum kit's sound, scheduled against the same master timeline as the
// picture (the clock works as the piano's does: notes are scheduled a quarter
// of a second ahead, and while sound plays the picture reads its time from
// here, so a hit lands on its frame).
//
// Samples: Karoryfer's Big Rusty Drums (CC0), converted by
// tools/drum-samples.py into public/drums: several velocity layers for every
// articulation, with two or three round-robin alternates each, the close and
// overhead microphones mixed. The hi-hat has six openness levels from tight
// to open, the pedal's "chick" and splash; the cymbals have their chokes; the
// toms are tuned up a little to this kit's smaller drums. A synthesized room
// adds a little air. If the samples cannot load, a synthesized kit
// (drumSynth.ts) plays instead.
//
// Every choice (which layer, which alternate, where an open hi-hat is cut off
// by the pedal, where a hand chokes a cymbal) is made once for the whole
// performance, from the hits alone, so the sound is as deterministic as the
// picture.
import type { DrumId } from './KitLayout';
import { pedalAt, type DrumHit, type DrumPerformance, type Zone } from './DrumScore';
import { hash01 } from '../core/random';
import { synthesizeKit } from './drumSynth';

export type ArticId =
  | 'kick'
  | 'snare'
  | 'rimshot'
  | 'crossStick'
  | 'tom1'
  | 'tom2'
  | 'floorTom'
  | 'hhTight'
  | 'hhClosed'
  | 'hhLoose'
  | 'hhQuarter'
  | 'hhHalf'
  | 'hhOpen'
  | 'hhEdge'
  | 'hhPedal'
  | 'hhSplash'
  | 'crash'
  | 'crashChoke'
  | 'ride'
  | 'rideBell'
  | 'rideEdge'
  | 'rideChoke';

/** which sample set a hit plays, from where it lands and (for the hi-hat) how closed the pedal holds it */
export function articulationFor(piece: DrumId, zone: Zone, closed: number, velocity: number): ArticId {
  switch (piece) {
    case 'kick':
      return 'kick';
    case 'snare':
      return zone === 'rim' ? 'rimshot' : zone === 'crossStick' ? 'crossStick' : 'snare';
    case 'tom1':
    case 'tom2':
    case 'floorTom':
      return piece;
    case 'crash':
      return 'crash';
    case 'ride':
      return zone === 'bell' ? 'rideBell' : zone === 'edge' ? 'rideEdge' : 'ride';
    case 'hihat':
      if (zone === 'pedal') return 'hhPedal';
      if (closed >= 0.97) return zone === 'edge' ? 'hhEdge' : velocity < 0.25 ? 'hhTight' : 'hhClosed';
      if (closed >= 0.85) return zone === 'edge' ? 'hhEdge' : 'hhLoose';
      if (closed >= 0.6) return 'hhQuarter';
      if (closed >= 0.3) return 'hhHalf';
      return 'hhOpen';
  }
}

/** the mix: each articulation's level (the library's recorded balance, then trimmed by ear) */
const LEVEL: Partial<Record<ArticId, number>> = {
  kick: 1.25,
  snare: 1.0,
  rimshot: 0.9,
  crossStick: 1.3,
  tom1: 1.0,
  tom2: 1.0,
  floorTom: 1.05,
  hhTight: 0.85,
  hhClosed: 0.8,
  hhLoose: 0.8,
  hhQuarter: 0.75,
  hhHalf: 0.72,
  hhOpen: 0.7,
  hhEdge: 0.8,
  hhPedal: 0.9,
  hhSplash: 0.75,
  crash: 0.75,
  crashChoke: 0.75,
  ride: 0.85,
  rideBell: 0.75,
  rideEdge: 0.7,
  rideChoke: 0.7,
};

/** the toms are tuned up a little toward this kit's smaller drums (the library's are 14, 15 and 18 inches) */
const TUNE: Partial<Record<ArticId, number>> = { tom1: 3, tom2: 2, floorTom: 1.5 };

interface SampleRef {
  file: string;
  attack: number;
  buf?: AudioBuffer;
  /** where the attack is in the decoded buffer, minus where it was in the source (the decoder's padding) */
  offset?: number;
}
interface Layer {
  velocity: number;
  files: SampleRef[];
}
type Kit = Partial<Record<ArticId, Layer[]>>;

interface Manifest {
  name: string;
  articulations: Record<string, { layers: { velocity: number; files: { file: string; attack: number }[] }[] }>;
}

/** one sound to start: from the hits, decided once for the whole performance */
export interface Voice {
  t: number;
  artic: ArticId;
  layer: number;
  rr: number;
  gain: number;
  /** cut off here (the pedal closing an open hi-hat, a hand choking a cymbal) */
  cut?: number;
  /** the piece, so a new hit on a drum can damp the last */
  piece: DrumId;
  id: number;
}

/** the first sample at a tenth of the peak (tools/drum-samples.py measures the same) */
export function attackOf(buf: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const th = peak * 0.1;
  let first = buf.length;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < Math.min(d.length, first); i++)
      if (Math.abs(d[i]) >= th) {
        first = i;
        break;
      }
  }
  return first / buf.sampleRate;
}

/** layers per articulation and their nominal velocities (for planning without the audio loaded, e.g. in tests) */
export type LayerTable = Partial<Record<ArticId, { velocity: number; rr: number }[]>>;

/** decide every voice of a performance */
export function planVoices(perf: DrumPerformance, layers: LayerTable): Voice[] {
  const out: Voice[] = [];
  const counts = new Map<ArticId, number>();
  const closedAt = (t: number) => pedalAt(perf.hihat, t);
  let id = 0;
  const add = (h: DrumHit | null, t: number, piece: DrumId, artic: ArticId, velocity: number) => {
    const ls = layers[artic];
    if (!ls?.length) return null;
    // the nearest layers by velocity; between two, a fixed choice per hit leaning to the nearer
    let a = 0;
    for (let k = 0; k < ls.length; k++) if (ls[k].velocity <= velocity) a = k;
    const b = Math.min(ls.length - 1, a + 1);
    let layer = a;
    if (b !== a && velocity > ls[a].velocity) {
      const u = (velocity - ls[a].velocity) / (ls[b].velocity - ls[a].velocity);
      layer = hash01(h ? h.i : id, 61) < u ? b : a;
    }
    const n = counts.get(artic) ?? 0;
    counts.set(artic, n + 1);
    const nRR = ls[layer].rr;
    // round robin: the next alternate each time, starting from a fixed offset per articulation
    const rr = (n + Math.floor(hash01(artic.length * 7 + artic.charCodeAt(0), 62) * nRR)) % nRR;
    const lv = ls[layer].velocity;
    const gain = (LEVEL[artic] ?? 1) * Math.min(1.6, Math.max(0.45, Math.pow(velocity / Math.max(0.05, lv), 0.65)));
    const v: Voice = { t, artic, layer, rr, gain, piece, id: id++ };
    out.push(v);
    return v;
  };
  for (const h of perf.hits) {
    const closed = closedAt(h.t);
    let artic = articulationFor(h.piece, h.zone, closed, h.velocity);
    // a pedal close that opens straight away again is a foot splash
    if (artic === 'hhPedal' && closedAt(h.t + 0.12) < 0.6) artic = 'hhSplash';
    const v = add(h, h.t, h.piece, artic, h.velocity);
    if (!v) continue;
    // an open hi-hat rings until the pedal closes it
    if (h.piece === 'hihat' && artic !== 'hhClosed' && artic !== 'hhTight' && artic !== 'hhEdge' && artic !== 'hhPedal') {
      for (let t = h.t + 0.02; t < h.t + 4; t += 0.005)
        if (closedAt(t) >= 0.95) {
          v.cut = t;
          break;
        }
    }
  }
  // a hand choking a cymbal: its ringing stops, with the choke's own short sound
  for (const c of perf.chokes) {
    for (const v of out) if (v.piece === c.piece && v.t <= c.t && (v.cut === undefined || v.cut > c.t)) v.cut = c.t;
    add(null, c.t, c.piece, c.piece === 'ride' ? 'rideChoke' : 'crashChoke', 0.7);
  }
  return out.sort((a, b) => a.t - b.t || a.id - b.id);
}

export type DrumAudioStatus = 'idle' | 'loading' | 'samples' | 'synth';

const LOOKAHEAD = 0.25;
/** the output compressor looks 6 ms ahead (Web Audio's DynamicsCompressorNode): start everything that much earlier */
const COMPRESSOR_DELAY = 0.006;

export class DrumAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private kit: Kit = {};
  status: DrumAudioStatus = 'idle';
  onStatus?: (s: DrumAudioStatus) => void;
  private voices: Voice[] = [];
  private playing: { v: Voice; src: AudioBufferSourceNode; gain: GainNode; end: number }[] = [];
  private next = 0;
  private anchorAudio = 0;
  private anchorT = 0;
  private speed = 1;
  private running = false;
  private level = 0.8;
  private loading: Promise<void> | null = null;

  constructor(private base: string) {}

  /** make the context (inside a user gesture) and load the kit */
  async init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
      return this.loading ?? undefined;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => {});
    this.buildGraph(ctx);
    this.setStatus('loading');
    this.loading = (async () => {
      await resumed;
      try {
        await this.loadSamples(ctx);
        this.setStatus('samples');
      } catch (e) {
        console.warn('drum samples unavailable, using the synthesized kit', e);
        this.kit = synthesizeKit(ctx);
        this.setStatus('synth');
      }
    })();
    return this.loading;
  }

  private setStatus(s: DrumAudioStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  get ready() {
    return this.status === 'samples' || this.status === 'synth';
  }

  get isRunning() {
    return this.running && !!this.ctx;
  }

  /** voices -> dry and a small room -> master -> a gentle compressor -> out */
  private buildGraph(ctx: BaseAudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = this.level;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.16;
    const conv = ctx.createConvolver();
    conv.buffer = roomImpulse(ctx);
    this.wet.connect(conv).connect(this.master);
  }

  /** the app's volume and mute (the piano's settings, shared) */
  setLevel(volume: number, muted: boolean) {
    const v = muted ? 0 : volume;
    if (v === this.level) return;
    this.level = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  private async loadSamples(ctx: AudioContext) {
    const r = await fetch(`${this.base}drums/manifest.json`);
    if (!r.ok) throw new Error(`${r.status} drum manifest`);
    const man = (await r.json()) as Manifest;
    const kit: Kit = {};
    const jobs: Promise<void>[] = [];
    for (const [aid, a] of Object.entries(man.articulations)) {
      const layers: Layer[] = a.layers.map((l) => ({ velocity: l.velocity, files: l.files.map((f) => ({ file: f.file, attack: f.attack })) }));
      kit[aid as ArticId] = layers;
      for (const l of layers)
        for (const s of l.files)
          jobs.push(
            (async () => {
              const res = await fetch(`${this.base}drums/${s.file}`);
              if (!res.ok) throw new Error(`${res.status} ${s.file}`);
              const buf = await ctx.decodeAudioData(await res.arrayBuffer());
              s.buf = buf;
              // the decoder's padding: start where the attack really is
              s.offset = Math.max(0, Math.min(0.1, attackOf(buf) - s.attack));
            })(),
          );
    }
    await Promise.all(jobs);
    this.kit = kit;
  }

  /** the layer table of the loaded kit */
  layers(): LayerTable {
    const out: LayerTable = {};
    for (const [k, ls] of Object.entries(this.kit)) out[k as ArticId] = ls!.map((l) => ({ velocity: l.velocity, rr: l.files.length }));
    return out;
  }

  /** the performance to play (its voices are planned against the loaded kit) */
  setPerformance(perf: DrumPerformance) {
    this.perf = perf;
    this.voices = this.ready ? planVoices(perf, this.layers()) : [];
  }
  private perf: DrumPerformance | null = null;

  clockTime(): number {
    if (!this.ctx || !this.running) return this.anchorT;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.anchorT + (this.ctx.currentTime - lat - this.anchorAudio) * this.speed;
  }

  private toAudio(t: number) {
    return this.anchorAudio + (t - this.anchorT) / this.speed;
  }

  /** play from t; whatever is still ringing at t (cymbals, an open hi-hat, a tom) comes in part-way through */
  start(t: number, speed: number) {
    if (!this.ctx || !this.ready) return;
    if (this.perf && !this.voices.length) this.voices = planVoices(this.perf, this.layers());
    this.stopAll(0.02);
    this.speed = speed;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    this.anchorAudio = this.ctx.currentTime + 0.05 - lat;
    this.anchorT = t;
    this.running = true;
    // the first voice at or after t; earlier ones that still ring start part-way through
    let i = 0;
    while (i < this.voices.length && this.voices[i].t < t - 0.002) {
      const v = this.voices[i];
      const len = this.lengthOf(v);
      if (v.t + len > t && (v.cut === undefined || v.cut > t)) this.voice(v, t - v.t);
      i++;
    }
    this.next = i;
    this.pump();
  }

  stop() {
    if (!this.ctx) return;
    this.anchorT = this.clockTime();
    this.running = false;
    this.stopAll(0.06);
  }

  /** schedule everything within the lookahead; call often */
  pump() {
    if (!this.ctx || !this.running) return;
    const until = this.clockTime() + LOOKAHEAD * this.speed;
    while (this.next < this.voices.length && this.voices[this.next].t < until) this.voice(this.voices[this.next++], 0);
    const now = this.ctx.currentTime;
    this.playing = this.playing.filter((p) => p.end > now);
  }

  private sample(v: Voice): SampleRef | null {
    const l = this.kit[v.artic]?.[v.layer];
    return l?.files[v.rr % l.files.length] ?? null;
  }

  private lengthOf(v: Voice) {
    const s = this.sample(v);
    return s?.buf ? s.buf.duration / Math.pow(2, (TUNE[v.artic] ?? 0) / 12) : 0;
  }

  private voice(v: Voice, offset: number) {
    const ctx = this.ctx!;
    const s = this.sample(v);
    if (!s?.buf) return;
    const rate = Math.pow(2, (TUNE[v.artic] ?? 0) / 12) * this.speed;
    // the sample's attack (not its first sample, a millisecond and a half before) lands on the hit
    const lead = offset > 0 ? 0 : s.attack / rate;
    const when = Math.max(ctx.currentTime, this.toAudio(v.t + offset) - lead - COMPRESSOR_DELAY);
    const at = (s.offset ?? 0) + (offset > 0 ? s.attack + offset * rate : 0);
    if (at >= s.buf.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = v.gain;
    src.connect(g);
    g.connect(this.dry);
    g.connect(this.wet);
    src.start(when, at);
    let end = when + (s.buf.duration - at) / rate;
    // cut off by the pedal or a hand
    if (v.cut !== undefined) {
      const c = Math.max(when, this.toAudio(v.cut) - COMPRESSOR_DELAY);
      g.gain.setValueAtTime(v.gain, c);
      g.gain.setTargetAtTime(0, c, v.piece === 'hihat' ? 0.025 : 0.05);
      end = Math.min(end, c + 0.4);
    }
    // a new stroke on a drum damps the one before it a little (the stick on the head)
    if (v.piece !== 'hihat' && v.piece !== 'crash' && v.piece !== 'ride')
      for (const p of this.playing)
        if (p.v.piece === v.piece && p.end > when) {
          try {
            p.gain.gain.setTargetAtTime(p.v.gain * 0.35, when, 0.04);
          } catch {
            /* already stopped */
          }
        }
    // a closed hi-hat stroke stops the ringing of the last open one (the cymbals are together)
    if (v.piece === 'hihat')
      for (const p of this.playing)
        if (p.v.piece === 'hihat' && p.end > when && (p.v.cut === undefined || this.toAudio(p.v.cut) > when)) {
          try {
            p.gain.gain.setTargetAtTime(0, when, 0.02);
          } catch {
            /* already stopped */
          }
        }
    src.stop(end + 0.05);
    this.playing.push({ v, src, gain: g, end: end + 0.05 });
  }

  stopAll(fade: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const p of this.playing) {
      try {
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.setValueAtTime(p.gain.gain.value, now);
        p.gain.gain.linearRampToValueAtTime(0, now + fade);
        p.src.stop(now + fade + 0.01);
      } catch {
        /* already stopped */
      }
    }
    this.playing = [];
  }

  /** the whole performance from t0 to t1 rendered offline (a video export), stereo 48 kHz */
  async renderOffline(t0: number, t1: number): Promise<AudioBuffer> {
    if (!this.ready || !this.perf) throw new Error('the drum sound is not loaded');
    const rate = 48000;
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil((t1 - t0) * rate)), rate);
    const live = { ctx: this.ctx, master: this.master, dry: this.dry, wet: this.wet, playing: this.playing, anchorAudio: this.anchorAudio, anchorT: this.anchorT, speed: this.speed, running: this.running, next: this.next, level: this.level };
    try {
      this.ctx = off as unknown as AudioContext;
      this.level = 0.85;
      this.buildGraph(off);
      this.playing = [];
      this.anchorAudio = 0;
      this.anchorT = t0;
      this.speed = 1;
      if (!this.voices.length) this.voices = planVoices(this.perf, this.layers());
      for (const v of this.voices) {
        if (v.t >= t1) break;
        if (v.t >= t0 - 0.002) this.voice(v, 0);
        else if (v.t + this.lengthOf(v) > t0 && (v.cut === undefined || v.cut > t0)) this.voice(v, t0 - v.t);
      }
      return await off.startRendering();
    } finally {
      Object.assign(this, live);
    }
  }

  dispose() {
    this.stopAll(0.05);
    this.running = false;
    void this.ctx?.suspend().catch(() => {});
  }

  /** wake the context again after dispose (a return to the drum stage) */
  resume() {
    void this.ctx?.resume().catch(() => {});
  }
}

/**
 * A small, live room for the drums: early reflections from nearby walls and a
 * short, darkening tail (RT60 about half a second). The overhead microphones
 * already carry the recording room; this only adds a little of ours.
 */
function roomImpulse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const rt60 = 0.55;
  const len = Math.floor(sr * (rt60 * 1.2 + 0.05));
  const buf = ctx.createBuffer(2, len, sr);
  let s = 7771;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
  const k = Math.log(1000) / rt60;
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let r = 0; r < 18; r++) {
      const t = 0.003 + 0.04 * Math.pow((r + 1 + 0.5 * rnd()) / 18, 1.3);
      const i = Math.floor(t * sr);
      if (i < len) d[i] += (rnd() > 0 ? 1 : -1) * 0.5 * Math.exp(-k * t) * (1 - r / 22);
    }
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const cut = 0.5 * (0.4 + 0.6 * Math.exp(-t / (rt60 * 0.3)));
      lp += (rnd() - lp) * cut;
      const onset = Math.min(1, t / 0.025);
      d[i] += lp * Math.exp(-k * t) * onset * onset * 0.55;
    }
    for (let i = 0; i < len; i++) energy += d[i] * d[i];
  }
  const norm = 1 / Math.sqrt(energy / 2);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}
