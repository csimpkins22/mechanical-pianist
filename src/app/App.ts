// The application: loads a piece, runs the three layers, owns the master
// clock. Everything drawn is evaluated from the master time `t`; while audio
// plays, `t` is read from the audio clock so picture and sound cannot drift.
import { AudioEngine } from '../audio/AudioEngine';
import { readMidi, buildScore, defaultTrackSelection, type ParsedMidi } from '../interpretation/MidiEngine';
import { composeEtudes, composeNocturne, composePhrase, midiBytes } from '../interpretation/demoPiece';
import { planChecked } from './plan';
import { DEFAULT_SOUND, loadSettings, saveSettings, type SoundSettings } from './settings';
import { PerformanceTimeline, type FrameState } from '../performance/PerformanceTimeline';
import { CinematicCamera, DEFAULT_FRAMING, blendCamera, type CameraMode, type CameraState, type Framing } from '../presentation/CinematicCamera';
import { DebugOverlay } from '../presentation/DebugOverlay';
import { DEFAULT_LIGHTS, type LightSettings } from '../presentation/Environment';
import { SceneRenderer } from '../presentation/SceneRenderer';
import type { Quality } from '../presentation/PostPipeline';
import type { Override, Performance } from '../core/types';

export type DemoId = 'nocturne' | 'phrase' | 'etudes';

export interface Piece {
  parsed: ParsedMidi;
  perf: Performance;
  timeline: PerformanceTimeline;
  camera: CinematicCamera;
  overrides: Map<number, Override>;
  tracks: number[];
  source: { kind: 'demo'; id: DemoId } | { kind: 'file'; name: string };
}

type Listener = (what: string) => void;

export const FRAME_STEP = 1 / 30;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];

export class App {
  readonly params = new URLSearchParams(location.search);
  readonly view: SceneRenderer;
  readonly audio: AudioEngine;
  debug!: DebugOverlay;
  piece: Piece | null = null;
  frame: FrameState | null = null;
  t = 0;
  playing = false;
  speed = 1;
  loop = false;
  scrubbing = false;
  private resumeAfterScrub = false;
  mode: CameraMode = 'cinematic';
  framing: Framing = { ...DEFAULT_FRAMING };
  lights: LightSettings = { ...DEFAULT_LIGHTS };
  private modeFrom: { state: CameraState; start: number } | null = null;
  private lastWall = 0;
  private listeners = new Set<Listener>();
  private raf = 0;
  private dirty = true;
  ready = false;
  fps = 0;
  private fpsAcc = { n: 0, t: 0 };
  private slowFor = 0;
  autoQuality = true;

  constructor(readonly canvas: HTMLCanvasElement, readonly uiRoot: HTMLElement) {
    this.view = new SceneRenderer(canvas);
    this.audio = new AudioEngine(import.meta.env.BASE_URL);
    this.audio.onStatus = () => this.emit('audio');
    // the viewer's own settings from last time (ignored with ?settings=default, for tools)
    if (this.params.get('settings') !== 'default') {
      const s = loadSettings();
      this.view.look = s.look;
      this.lights = s.lights;
      this.framing = s.framing;
      this.applySound(s.sound);
    }
  }

  private saveTimer = 0;

  /** something in the settings panel changed: redraw now, remember it shortly */
  settingsChanged() {
    this.renderNow();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => saveSettings({ look: this.view.look, lights: this.lights, framing: this.framing, sound: this.sound }), 250);
  }

  get sound(): SoundSettings {
    return { reverb: this.audio.reverb, room: this.audio.room, volume: this.audio.volume, muted: this.audio.muted };
  }

  applySound(s: SoundSettings = DEFAULT_SOUND) {
    this.audio.setReverb(s.reverb, s.room);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what = 'state') {
    for (const fn of this.listeners) fn(what);
  }

  async start(onProgress?: (f: number, label: string) => void) {
    const q = (this.params.get('quality') as Quality) || 'high';
    this.view.setQuality(q);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    onProgress?.(0.05, 'Building the instrument');
    await this.view.load(import.meta.env.BASE_URL, (f) => onProgress?.(0.05 + f * 0.6, 'Building the instrument'));
    this.debug = new DebugOverlay(this.uiRoot);
    this.view.scene.add(this.debug.group);
    this.view.setLights(this.lights);
    onProgress?.(0.7, 'Reading the score');
    await new Promise((r) => setTimeout(r, 0));
    const demo = (this.params.get('demo') as DemoId) || 'nocturne';
    this.loadDemo(demo);
    onProgress?.(1, '');
    const mode = this.params.get('camera') as CameraMode | null;
    if (mode) this.mode = mode;
    const t = parseFloat(this.params.get('t') ?? '');
    if (!Number.isNaN(t)) this.t = t;
    if (this.params.get('debug') === '1') this.setDebug(true);
    this.ready = true;
    (window as unknown as { __ready: boolean }).__ready = true;
    this.renderNow();
    this.lastWall = performance.now();
    this.loopFrame(performance.now());
    // keep audio scheduled even when the tab is in the background
    setInterval(() => {
      if (this.playing && this.piece) this.audio.pump(this.piece.timeline);
    }, 40);
    this.emit('piece');
  }

  fail(e: unknown) {
    const div = document.createElement('div');
    div.className = 'fatal';
    div.textContent = `Could not start: ${e instanceof Error ? e.message : String(e)}`;
    document.body.appendChild(div);
  }

  resize() {
    this.view.setSize(window.innerWidth, window.innerHeight);
    this.dirty = true;
    if (this.ready) this.renderNow();
  }

  // ------------------------------------------------------------- pieces
  loadDemo(id: DemoId) {
    const midi = id === 'phrase' ? composePhrase() : id === 'etudes' ? composeEtudes() : composeNocturne();
    const parsed = readMidi(midiBytes(midi), `${id}.mid`);
    this.build(parsed, { kind: 'demo', id }, new Map(), undefined);
  }

  /** a user file: returns the parsed MIDI so the UI can offer track selection */
  readFile(bytes: ArrayBuffer, name: string): ParsedMidi {
    return readMidi(bytes, name);
  }

  loadParsed(parsed: ParsedMidi, name: string, tracks?: number[]) {
    this.build(parsed, { kind: 'file', name }, new Map(), tracks);
  }

  /** (re)interpret the score: new files, track changes and fingering overrides all come through here */
  build(parsed: ParsedMidi, source: Piece['source'], overrides: Map<number, Override>, tracks?: number[]) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    const sel = tracks ?? defaultTrackSelection(parsed.tracks);
    const score = buildScore(parsed, sel);
    const { perf, timeline } = planChecked(score, overrides);
    const camera = new CinematicCamera(timeline.plan, score.duration);
    const sameSource = this.piece && JSON.stringify(this.piece.source) === JSON.stringify(source);
    this.piece = { parsed, perf, timeline, camera, overrides, tracks: sel, source };
    this.t = sameSource ? Math.min(this.t, score.duration) : 0;
    this.renderNow();
    this.emit('piece');
    if (wasPlaying && sameSource) void this.play();
  }

  setOverride(noteId: number, o: Override | null) {
    if (!this.piece) return;
    const ov = new Map(this.piece.overrides);
    if (!o || (!o.hand && !o.finger)) ov.delete(noteId);
    else ov.set(noteId, { ...ov.get(noteId), ...o });
    this.build(this.piece.parsed, this.piece.source, ov, this.piece.tracks);
  }

  clearOverrides() {
    if (!this.piece) return;
    this.build(this.piece.parsed, this.piece.source, new Map(), this.piece.tracks);
  }

  exportOverrides(): string {
    const p = this.piece!;
    const notes = new Map(p.perf.notes.map((n) => [n.id, n]));
    const list = [...p.overrides.entries()].map(([id, o]) => {
      const n = notes.get(id)!;
      return { midi: n.midi, start: +n.start.toFixed(4), ...o };
    });
    return JSON.stringify({ piece: p.perf.score.name, overrides: list }, null, 2);
  }

  importOverrides(json: string) {
    const p = this.piece!;
    const data = JSON.parse(json) as { overrides: { midi: number; start: number; hand?: 'L' | 'R'; finger?: 1 | 2 | 3 | 4 | 5 }[] };
    const ov = new Map<number, Override>();
    for (const o of data.overrides ?? []) {
      const n = p.perf.notes.find((m) => m.midi === o.midi && Math.abs(m.start - o.start) < 0.01);
      if (n) ov.set(n.id, { hand: o.hand, finger: o.finger });
    }
    this.build(p.parsed, p.source, ov, p.tracks);
  }

  selectTracks(tracks: number[]) {
    if (!this.piece) return;
    this.build(this.piece.parsed, this.piece.source, new Map(), tracks);
  }

  get duration() {
    return this.piece?.timeline.duration ?? 0;
  }

  // ------------------------------------------------------------- transport
  async play() {
    if (!this.piece) return;
    if (this.t >= this.duration - 0.02) this.t = 0;
    this.playing = true;
    this.lastWall = performance.now();
    this.emit('transport');
    try {
      await this.audio.init();
    } catch (e) {
      console.warn('audio unavailable', e);
    }
    if (this.playing && this.audio.ready) this.audio.start(this.piece.timeline, this.t, this.speed);
  }

  pause() {
    if (!this.playing) return;
    if (this.audio.isRunning) this.t = Math.max(0, this.audioTime());
    this.playing = false;
    this.audio.stop();
    this.renderNow();
    this.emit('transport');
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  restart() {
    this.seek(0);
    if (!this.playing) void this.play();
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(this.duration, t));
    if (this.playing && this.audio.ready && !this.scrubbing) this.audio.start(this.piece!.timeline, this.t, this.speed);
    this.lastWall = performance.now();
    this.renderNow();
    this.emit('time');
  }

  /** dragging the timeline: silence while dragging, resume where released */
  beginScrub() {
    if (this.scrubbing) return;
    this.scrubbing = true;
    this.resumeAfterScrub = this.playing;
    if (this.playing) {
      this.playing = false;
      this.audio.stop();
    }
  }

  endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.resumeAfterScrub) void this.play();
  }

  step(frames: number) {
    if (this.playing) this.pause();
    this.seek(Math.round(this.t / FRAME_STEP + frames) * FRAME_STEP);
  }

  setSpeed(s: number) {
    if (this.playing && this.audio.isRunning) this.t = this.audioTime();
    this.speed = s;
    if (this.playing && this.audio.ready) this.audio.start(this.piece!.timeline, this.t, s);
    this.emit('transport');
  }

  private audioTime() {
    return this.audio.clockTime();
  }

  // ------------------------------------------------------------- view
  setMode(m: CameraMode) {
    if (m === this.mode || !this.piece) return;
    this.modeFrom = { state: this.cameraAt(this.t), start: performance.now() };
    this.mode = m;
    this.emit('view');
  }

  setDebug(v: boolean) {
    this.debug.setVisible(v);
    this.renderNow();
    this.emit('view');
  }

  setLights(l: Partial<LightSettings>) {
    this.lights = { ...this.lights, ...l };
    this.view.setLights(this.lights);
    this.settingsChanged();
  }

  cameraAt(t: number): CameraState {
    const target = this.piece!.camera.evaluate(this.mode, t, this.framing);
    if (!this.modeFrom) return target;
    const u = Math.min(1, (performance.now() - this.modeFrom.start) / 1800);
    if (u >= 1) {
      this.modeFrom = null;
      return target;
    }
    return blendCamera(this.modeFrom.state, target, u);
  }

  renderNow() {
    if (!this.piece) return;
    const frame = this.piece.timeline.evaluate(this.t);
    this.frame = frame;
    this.view.update(frame);
    const cam = this.cameraAt(this.t);
    this.view.camera.position.copy(cam.position);
    this.view.camera.lookAt(cam.target);
    this.view.camera.updateMatrixWorld();
    if (this.debug?.visible)
      this.debug.update(frame, this.piece.timeline.plan.hands, this.view.hands, this.view.camera, window.innerWidth, window.innerHeight);
    this.view.render(cam, this.t);
    this.dirty = false;
  }

  /** for tests and tools: draw an exact time, synchronously */
  renderAt(t: number) {
    this.t = t;
    this.renderNow();
  }

  stateHash(t: number) {
    return this.piece!.timeline.stateHash(t);
  }

  private loopFrame = (now: number) => {
    this.raf = requestAnimationFrame(this.loopFrame);
    const dt = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    this.fpsAcc.n++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t > 0.5) {
      this.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc = { n: 0, t: 0 };
      // keep playback smooth on slower machines: step quality down once
      if (this.playing && this.autoQuality && document.visibilityState === 'visible') {
        this.slowFor = this.fps < 28 ? this.slowFor + 0.5 : 0;
        if (this.slowFor >= 3 && this.view.post.quality !== 'low') {
          this.view.setQuality(this.view.post.quality === 'high' ? 'medium' : 'low');
          this.slowFor = 0;
          this.emit('quality');
        }
      }
    }
    if (this.playing && this.piece) {
      // the audio clock is the master while sound is running
      this.t = this.audio.isRunning ? this.audioTime() : this.t + dt * this.speed;
      this.audio.pump(this.piece.timeline);
      if (this.t >= this.duration) {
        if (this.loop) {
          this.t = 0;
          if (this.audio.ready) this.audio.start(this.piece.timeline, 0, this.speed);
        } else {
          this.t = this.duration;
          this.playing = false;
          this.audio.stop();
          this.emit('transport');
        }
      }
      this.renderNow();
      this.emit('time');
    } else if (this.modeFrom || this.dirty) this.renderNow();
  };

  invalidate() {
    this.dirty = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}
