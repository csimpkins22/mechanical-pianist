// Piano sound, scheduled against the same master timeline as the picture.
//
// A multisampled upright (FreePats' "Upright Piano KW", converted from its
// SoundFont by tools/sf2-to-samples.py: two velocity layers, a sample every
// two or three semitones, pitch-shifted to the notes in between) with
// per-voice brightness from velocity, damper behaviour from the sustain pedal
// (via the timeline's release times), undamped top octaves, quiet key-release
// noises and an adjustable synthesized room (a convolution reverb whose
// impulse response is generated here). If the samples cannot be loaded a
// synthesized piano takes over. Nothing is ever started without a user gesture.
import type { PerformanceNote } from '../core/types';
import type { PerformanceTimeline } from '../performance/PerformanceTimeline';
import { synthesizePiano } from './synthPiano';

const SAMPLE_PCS = [0, 3, 6, 9]; // the synthesized fallback's notes
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

/** public/piano/manifest.json, written by tools/sf2-to-samples.py */
interface PianoManifest {
  name: string;
  gain: number;
  layers: { centre: number; samples: { root: number; file: string; cents: number; keys: [number, number] }[] }[];
}

interface Zone {
  root: number;
  cents: number;
  keys: [number, number];
  buf?: AudioBuffer;
}

interface Layer {
  vel: number; // the velocity it was recorded at (0..1)
  zones: Zone[];
}

export type AudioStatus = 'idle' | 'loading' | 'samples' | 'synth' | 'error';

/** rooms for the reverb: decay time (RT60, s), pre-delay (s), size of the early reflections (s), brightness (0..1) */
export const ROOMS = {
  studio: { label: 'Small room', rt60: 0.45, pre: 0.004, early: 0.02, bright: 0.45 },
  parlour: { label: 'Parlour', rt60: 1.1, pre: 0.009, early: 0.035, bright: 0.4 },
  hall: { label: 'Recital hall', rt60: 2.1, pre: 0.018, early: 0.06, bright: 0.35 },
  church: { label: 'Stone church', rt60: 4.2, pre: 0.03, early: 0.09, bright: 0.3 },
} as const;
export type RoomId = keyof typeof ROOMS;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private verb: { conv: ConvolverNode; out: GainNode } | null = null;
  private layers: Layer[] = [];
  private gain = 1;
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
  /** reverb amount, 0 (dry) .. 1 (very wet) */
  reverb = 0.3;
  room: RoomId = 'parlour';
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
    this.dry.connect(this.master);
    this.applyReverb(true);
    this.setStatus('loading');
    try {
      await this.loadSamples(ctx);
      this.setStatus('samples');
    } catch (e) {
      console.warn('piano samples unavailable, using the synthesized piano', e);
      const synth = synthesizePiano(ctx, sampleMidis());
      this.layers = [{ vel: 0.55, zones: [...synth].map(([root, buf]) => ({ root, cents: 0, keys: [root, root] as [number, number], buf })) }];
      this.gain = 1;
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
    const r = await fetch(`${this.base}piano/manifest.json`);
    if (!r.ok) throw new Error(`${r.status} piano manifest`);
    const man = (await r.json()) as PianoManifest;
    const files = new Map<Zone, string>();
    this.layers = man.layers.map((l) => ({
      vel: l.centre,
      zones: l.samples.map((s) => {
        const z: Zone = { root: s.root, cents: s.cents, keys: s.keys };
        files.set(z, s.file);
        return z;
      }),
    }));
    this.gain = man.gain;
    const loadLayer = (l: Layer) => Promise.all(l.zones.map(async (z) => (z.buf = await fetchBuf(`${this.base}piano/${files.get(z)}`))));
    // the layer nearest a moderate touch first, so playback can begin as soon as possible
    const order = [...this.layers].sort((a, b) => Math.abs(a.vel - 0.5) - Math.abs(b.vel - 0.5));
    await loadLayer(order[0]);
    // the rest load in the background
    void Promise.all(order.slice(1).map(loadLayer)).catch((e) => console.warn('velocity layer failed', e));
    void Promise.all(
      Array.from({ length: 88 }, async (_, i) => this.release.set(21 + i, await fetchBuf(`${this.base}samples/rel/rel${i + 1}.mp3`))),
    ).catch(() => undefined);
  }

  /**
   * A room's impulse response: a few discrete early reflections, then a
   * dense, decorrelated stereo tail that decays exponentially (to -60 dB at
   * RT60) and darkens as it goes, as air and soft furnishings take the highs
   * first. Normalised to the same energy for every room, so the amount
   * setting means the same thing whichever room is chosen.
   */
  private roomImpulse(ctx: AudioContext, id: RoomId): AudioBuffer {
    const room = ROOMS[id];
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * (room.pre + room.rt60 * 1.1 + 0.05));
    const buf = ctx.createBuffer(2, len, sr);
    let s = 1234;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
    const k = Math.log(1000) / room.rt60; // amplitude decay rate for -60 dB at rt60
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const pre = Math.floor(room.pre * sr);
      // early reflections: sparse taps, alternating sign, thinning out
      for (let r = 0; r < 14; r++) {
        const t = room.pre + room.early * Math.pow((r + 1 + 0.5 * rnd()) / 14, 1.4);
        const i = Math.floor(t * sr);
        if (i < len) d[i] += (rnd() > 0 ? 1 : -1) * 0.55 * Math.exp(-k * (t - room.pre)) * (1 - r / 18);
      }
      // the diffuse tail fades in over the early-reflection window
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const cut = room.bright * (0.45 + 0.55 * Math.exp(-t / (room.rt60 * 0.35)));
        lp += (rnd() - lp) * cut;
        const onset = Math.min(1, t / Math.max(0.005, room.early));
        d[i] += lp * Math.exp(-k * t) * onset * onset * 0.6;
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

  /** set the reverb amount (0..1) and/or room; a room change crossfades to the new impulse */
  setReverb(amount: number, room: RoomId = this.room) {
    const changed = room !== this.room;
    this.reverb = amount;
    this.room = room;
    if (this.ctx) this.applyReverb(changed);
  }

  private applyReverb(rebuild: boolean) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    // the samples already carry a little of their own living room, so even
    // "dry" keeps that; the dry level dips a touch as the room gets wetter
    this.dry.gain.setTargetAtTime(1 - 0.25 * this.reverb, now, 0.05);
    this.wet.gain.setTargetAtTime(0.55 * Math.pow(this.reverb, 1.3), now, 0.05);
    if (!rebuild && this.verb) return;
    const old = this.verb;
    const conv = ctx.createConvolver();
    conv.buffer = this.roomImpulse(ctx, this.room);
    const out = ctx.createGain();
    out.gain.value = old ? 0 : 1;
    this.wet.connect(conv).connect(out).connect(this.master);
    if (old) {
      out.gain.setTargetAtTime(1, now, 0.08);
      old.out.gain.setTargetAtTime(0, now, 0.08);
      setTimeout(() => {
        this.wet.disconnect(old.conv);
        old.out.disconnect();
      }, 600);
    }
    this.verb = { conv, out };
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
      .map((l) => ({ l, v: l.vel }))
      .filter((x) => x.l.zones.every((z) => z.buf))
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
      // the sample mapped to this key, else the nearest recorded note
      let best = x.l.zones.find((z) => midi >= z.keys[0] && midi <= z.keys[1]);
      if (!best) {
        let bd = 99;
        for (const z of x.l.zones) {
          if (Math.abs(z.root - midi) < bd) {
            bd = Math.abs(z.root - midi);
            best = z;
          }
        }
      }
      if (best?.buf && w > 0.02) out.push({ buf: best.buf, rate: Math.pow(2, (midi - best.root - best.cents / 100) / 12), gain: w });
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
    out.gain.value = loud * 0.9 * this.gain;
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
    g.gain.value = 0.045 + 0.055 * n.velocity; // the key-release thump: texture, not a feature
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
