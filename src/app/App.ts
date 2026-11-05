// The application: loads a piece, runs the three layers, owns the master
// clock. Everything drawn is evaluated from the master time `t`; while audio
// plays, `t` is read from the audio clock so picture and sound cannot drift.
import { AudioEngine } from '../audio/AudioEngine';
import { readMidi, buildScore, defaultTrackSelection, type ParsedMidi } from '../interpretation/MidiEngine';
import { DEFAULT_PIECE, LIBRARY, entryById, type LibraryEntry } from './library';
import { Cancelled, PLAN_VERSION, Planner, idb, type PlanRequest } from './planner';
import { fingerprint } from './planCodec';
import { DEFAULT_SOUND, loadSettings, saveSettings, type SoundSettings } from './settings';
import { STYLES, styleSettings } from '../presentation/VisualStyles';
import { PerformanceTimeline, type FrameState } from '../performance/PerformanceTimeline';
import { CinematicCamera, DEFAULT_FRAMING, sameView, type CameraMode, type CameraState, type CameraView, type Framing } from '../presentation/CinematicCamera';
import { DebugOverlay } from '../presentation/DebugOverlay';
import { DEFAULT_LIGHTS, type LightSettings } from '../presentation/Environment';
import { DEFAULT_LOOK, SceneRenderer, shutterTime } from '../presentation/SceneRenderer';
import type { Quality } from '../presentation/PostPipeline';
import type { Override, Performance } from '../core/types';
import { DEFAULT_LIVE, LiveSession, type LiveSettings } from '../live/LiveSession';

export type PieceSource = { kind: 'library'; id: string } | { kind: 'file'; id: string; name: string };

export interface Piece {
  bytes: Uint8Array;
  parsed: ParsedMidi;
  perf: Performance;
  timeline: PerformanceTimeline;
  camera: CinematicCamera;
  overrides: Map<number, Override>;
  tracks: number[];
  source: PieceSource;
  /** for the title card */
  title: string;
  artist: string;
}

/** a piece being interpreted (the previous one keeps playing meanwhile) */
export interface Loading {
  source: PieceSource;
  title: string;
  fraction: number;
  label: string;
}

/** a MIDI file the viewer opened, kept in this browser */
export interface UserFile {
  id: string;
  name: string;
  title: string;
  bytes: Uint8Array;
  /** the parts chosen to perform (multi-track files) */
  tracks?: number[];
  added: number;
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
  loading: Loading | null = null;
  readonly planner = new Planner();
  private buildSeq = 0;
  private entryReqs = new Map<string, { req: PlanRequest; duration: number }>();
  /** plans prepared at build time for the library (plans/manifest.json), when they match this build */
  private prebuilt: Record<string, { file: string; midi: string; tracks: number[] }> = {};
  frame: FrameState | null = null;
  t = 0;
  playing = false;
  speed = 1;
  scrubbing = false;
  private resumeAfterScrub = false;
  /** what the camera shows: 'cinematic' (the director's edit), a continuous camera, or a shot held from the bar's arrows */
  camView: CameraView = 'cinematic';
  framing: Framing = { ...DEFAULT_FRAMING };
  lights: LightSettings = { ...DEFAULT_LIGHTS };
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
    // a recapture of the room's bounced light finished: show it on a paused frame too
    this.view.onRelit = () => {
      if (!this.playing) this.renderNow();
    };
    this.audio = new AudioEngine(import.meta.env.BASE_URL);
    this.audio.onStatus = () => this.emit('audio');
    // the viewer's own settings from last time (ignored with ?settings=default, for tools)
    if (this.params.get('settings') !== 'default') {
      const s = loadSettings();
      // the piano always starts open; closing it lasts for the visit
      this.view.look = { ...s.look, openPiano: DEFAULT_LOOK.openPiano };
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

  /** apply a visual style preset (light and grade together) */
  setStyle(id: string) {
    const style = STYLES.find((s) => s.id === id) ?? STYLES[0];
    const { look, lights } = styleSettings(style, this.view.look);
    Object.assign(this.view.look, look, { style: style.id });
    this.lights = lights;
    this.view.setLights(lights);
    this.settingsChanged();
    this.emit('style');
    return style;
  }

  get sound(): SoundSettings {
    return { reverb: this.audio.reverb, room: this.audio.room, volume: this.audio.volume, muted: this.audio.muted, syncMs: this.syncMs };
  }

  applySound(s: SoundSettings = DEFAULT_SOUND) {
    this.audio.setReverb(s.reverb, s.room);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.syncMs = s.syncMs;
  }

  /** the viewer's own picture timing correction (ms, positive = earlier) */
  syncMs = 0;
  /** the time between frames, smoothed: about how long a frame takes to reach the screen */
  private frameDt = 1 / 60;

  /**
   * While playing, the picture is drawn for the moment it will be seen: a
   * frame drawn now reaches the screen about one frame later (longer when
   * frames are heavy), while the audio clock already allows for the sound's
   * own output delay. Paused frames, scrubbing and tools draw the exact time.
   */
  private viewTime() {
    if (!this.playing) return this.t;
    const lead = Math.min(0.05, this.frameDt) + this.syncMs / 1000;
    return Math.max(0, Math.min(this.duration, this.t + lead * this.speed));
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what = 'state') {
    for (const fn of this.listeners) fn(what);
  }

  async start(onProgress?: (f: number, label: string) => void) {
    // phones and tablets start a step down (the realism passes are heavy); playback lowers it further if it stutters
    const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    const q = (this.params.get('quality') as Quality) || (touch ? 'medium' : 'high');
    this.view.setQuality(q);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    onProgress?.(0.05, 'Building the instrument');
    await this.view.load(import.meta.env.BASE_URL, (f) => onProgress?.(0.05 + f * 0.6, 'Building the instrument'));
    this.debug = new DebugOverlay(this.uiRoot);
    this.view.scene.add(this.debug.group);
    this.view.setLights(this.lights);
    onProgress?.(0.7, 'Interpreting the score');
    await this.loadPrebuilt();
    const id = this.params.get('demo') || this.params.get('piece') || DEFAULT_PIECE;
    await this.openEntry(entryById(id) ?? entryById(DEFAULT_PIECE)!, (f, label) => onProgress?.(0.7 + 0.3 * f, label));
    onProgress?.(1, '');
    const mode = this.params.get('camera') as CameraMode | null;
    if (mode && ['cinematic', 'follow', 'overhead', 'macro'].includes(mode)) this.camView = mode;
    const held = this.params.get('shot');
    if (held) this.camView = { shot: held, hand: this.params.get('hand') === 'L' ? 'L' : 'R' };
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

  /** a video export is drawing frames: the live loop and window resizes leave the view alone */
  exporting = false;

  /**
   * Set the view up for exporting frames of width x height (high quality,
   * one pixel per pixel, no letterbox bars since the frame is the shape, no
   * debug drawing, normal speed); the returned function puts everything back.
   * The on-screen canvas shows the frames as they are drawn, fitted.
   */
  beginExport(width: number, height: number): () => void {
    if (this.playing) this.pause();
    const before = {
      t: this.t,
      speed: this.speed,
      quality: this.view.post.quality,
      autoQuality: this.autoQuality,
      letterbox: this.view.look.letterboxOn,
      debug: this.debug?.visible ?? false,
      pixelRatio: this.view.renderer.getPixelRatio(),
      fit: this.view.canvas.style.objectFit,
    };
    this.exporting = true;
    this.speed = 1;
    this.autoQuality = false;
    if (before.debug) this.setDebug(false);
    this.view.look.letterboxOn = false;
    this.view.setQuality('high');
    this.view.renderer.setPixelRatio(1);
    this.view.setSize(width, height);
    this.view.canvas.style.objectFit = 'contain';
    return () => {
      this.exporting = false;
      this.view.canvas.style.objectFit = before.fit;
      this.view.renderer.setPixelRatio(before.pixelRatio);
      this.view.look.letterboxOn = before.letterbox;
      this.view.setQuality(before.quality);
      this.autoQuality = before.autoQuality;
      this.speed = before.speed;
      if (before.debug) this.setDebug(true);
      this.t = before.t;
      this.resize();
      this.renderNow();
    };
  }

  resize() {
    if (this.exporting) return;
    this.view.setSize(window.innerWidth, window.innerHeight);
    this.dirty = true;
    if (this.ready) this.renderNow();
  }

  // ------------------------------------------------------------- pieces
  /** open a piece from the library */
  openEntry(e: LibraryEntry, progress?: (f: number, label: string) => void) {
    const { bytes } = this.entryInfo(e).req;
    return this.build(bytes, readMidi(bytes, `${e.id}.mid`), { kind: 'library', id: e.id }, new Map(), undefined, { title: e.title, artist: e.artist }, progress);
  }

  /** a user file: returns the parsed MIDI so the UI can offer track selection */
  readFile(bytes: ArrayBuffer, name: string): { bytes: Uint8Array; parsed: ParsedMidi } {
    const b = new Uint8Array(bytes);
    return { bytes: b, parsed: readMidi(b, name) };
  }

  async openFile(bytes: Uint8Array, parsed: ParsedMidi, name: string, tracks?: number[]) {
    const id = await this.rememberFile(bytes, name, parsed, tracks);
    return this.build(bytes, parsed, { kind: 'file', id, name }, new Map(), tracks, { title: titleOf(parsed, name), artist: name });
  }

  /**
   * (Re)interpret a score: new pieces, track changes and fingering overrides
   * all come through here. Planning runs in a worker (or comes from this
   * browser's cache); meanwhile the current piece stays on screen and
   * playable. A newer request supersedes an older one.
   */
  async build(
    bytes: Uint8Array,
    parsed: ParsedMidi,
    source: PieceSource,
    overrides: Map<number, Override>,
    tracks: number[] | undefined,
    meta: { title: string; artist: string },
    progress?: (f: number, label: string) => void,
  ) {
    const seq = ++this.buildSeq;
    const sel = tracks ?? defaultTrackSelection(parsed.tracks);
    // the library default (its usual parts, no overrides) was prepared at build time
    const entry = source.kind === 'library' ? entryById(source.id) : undefined;
    const def = entry && this.entryInfo(entry).req;
    const prebuilt = def && !overrides.size && def.tracks.join() === sel.join() ? def.prebuilt : undefined;
    const sameSource = !!this.piece && JSON.stringify(this.piece.source) === JSON.stringify(source);
    this.loading = { source, title: meta.title, fraction: 0, label: 'Reading the score' };
    this.emit('loading');
    try {
      const { perf, timeline } = await this.planner.plan({ bytes, name: parsed.name, tracks: sel, overrides, prebuilt }, (f, label) => {
        if (seq !== this.buildSeq) return;
        this.loading = { source, title: meta.title, fraction: f, label };
        progress?.(f, label);
        this.emit('loading');
      });
      if (seq !== this.buildSeq) return; // superseded
      const score = perf.score;
      const camera = new CinematicCamera(timeline.plan, score.duration, score.tempos, this.view.look.openPiano);
      const wasPlaying = this.playing;
      if (wasPlaying) this.pause();
      this.piece = { bytes, parsed, perf, timeline, camera, overrides, tracks: sel, source, title: meta.title, artist: meta.artist };
      this.t = sameSource ? Math.min(this.t, score.duration) : 0;
      this.loading = null;
      this.renderNow();
      this.emit('piece');
      if (wasPlaying) void this.play();
    } catch (err) {
      if (seq !== this.buildSeq || err instanceof Cancelled) return; // superseded: nothing to report
      this.loading = null;
      this.emit('loading');
      throw err;
    }
  }

  private rebuild(overrides: Map<number, Override>, tracks?: number[]) {
    const p = this.piece;
    if (!p) return Promise.resolve();
    return this.build(p.bytes, p.parsed, p.source, overrides, tracks ?? p.tracks, { title: p.title, artist: p.artist });
  }

  setOverride(noteId: number, o: Override | null) {
    if (!this.piece) return;
    const ov = new Map(this.piece.overrides);
    if (!o || (!o.hand && !o.finger)) ov.delete(noteId);
    else ov.set(noteId, { ...ov.get(noteId), ...o });
    return this.rebuild(ov);
  }

  clearOverrides() {
    return this.rebuild(new Map());
  }

  private async loadPrebuilt() {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}plans/manifest.json`);
      const m = r.ok ? await r.json() : null;
      if (m?.version === PLAN_VERSION) this.prebuilt = m.plans;
      else if (m) console.info(`prepared plans are from other planner code (${m.version}, this is ${PLAN_VERSION}): planning here`);
    } catch {
      /* none: plan in the browser */
    }
  }

  /** the planning request for a library piece as it opens (default parts, no overrides), and its length */
  entryInfo(e: LibraryEntry) {
    let info = this.entryReqs.get(e.id);
    if (!info) {
      const bytes = e.bytes();
      const parsed = readMidi(bytes, `${e.id}.mid`);
      const tracks = defaultTrackSelection(parsed.tracks);
      const pre = this.prebuilt[e.id];
      const prebuilt = pre && pre.midi === fingerprint(bytes) && pre.tracks.join() === tracks.join() ? `${import.meta.env.BASE_URL}plans/${pre.file}` : undefined;
      info = { req: { bytes, name: parsed.name, tracks, overrides: new Map(), prebuilt }, duration: parsed.midi.duration };
      this.entryReqs.set(e.id, info);
    }
    return info;
  }

  /** library pieces without a prepared plan, not yet planned in this browser: plan them quietly, one at a time */
  prepareLibrary() {
    this.planner.prepare(LIBRARY.map((e) => this.entryInfo(e).req).filter((r) => !r.prebuilt));
  }

  /** 1 when a library piece opens at once (planned already), else how far its preparation is (null: not started) */
  async entryStatus(e: LibraryEntry): Promise<number | null> {
    const { req } = this.entryInfo(e);
    if (await this.planner.cached(req)) return 1;
    return this.planner.status.get(await this.planner.key(req)) ?? null;
  }

  // ------------------------------------------------------------- the viewer's files
  private async rememberFile(bytes: Uint8Array, name: string, parsed: ParsedMidi, tracks?: number[]): Promise<string> {
    const id = `f${fingerprint(bytes)}`;
    const rec: UserFile = { id, name, title: titleOf(parsed, name), bytes, tracks, added: Date.now() };
    await idb('files', 'readwrite', (s) => s.put(rec));
    this.emit('files');
    return id;
  }

  async userFiles(): Promise<UserFile[]> {
    const all = ((await idb('files', 'readonly', (s) => s.getAll())) ?? []) as UserFile[];
    return all.sort((a, b) => b.added - a.added);
  }

  async forgetFile(id: string) {
    await idb('files', 'readwrite', (s) => s.delete(id));
    this.emit('files');
  }

  async openUserFile(f: UserFile) {
    const parsed = readMidi(f.bytes, f.name);
    return this.build(f.bytes, parsed, { kind: 'file', id: f.id, name: f.name }, new Map(), f.tracks, { title: f.title, artist: f.name });
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
    return this.rebuild(ov);
  }

  selectTracks(tracks: number[]) {
    const src = this.piece?.source;
    if (src?.kind === 'file')
      void idb<UserFile>('files', 'readonly', (s) => s.get(src.id)).then((f) => f && idb('files', 'readwrite', (s) => s.put({ ...f, tracks })));
    return this.rebuild(new Map(), tracks);
  }

  get duration() {
    return this.piece?.timeline.duration ?? 0;
  }

  // ------------------------------------------------------------- transport
  async play() {
    if (!this.piece || this.live) return;
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
  /** show a camera view: a clean cut, as the director's own cuts are (a glide between distant framings could pass through the case) */
  setCamera(v: CameraView) {
    if (sameView(v, this.camView) || !this.piece) return;
    this.camView = v;
    this.invalidate();
    this.emit('view');
  }

  /** hold the next (or previous) shot along the cycle, from whatever is on screen now */
  stepShot(dir: 1 | -1) {
    if (!this.piece) return;
    this.setCamera(this.piece.camera.step(this.camView, this.viewTime(), dir));
  }

  /** the name of the shot on screen, for the bar */
  shotName(): string {
    return this.piece ? this.piece.camera.nameOf(this.camView, this.viewTime()) : '';
  }

  setDebug(v: boolean) {
    this.debug.setVisible(v);
    this.renderNow();
    this.emit('view');
  }

  /** take the piano's upper front panel off, or put it back */
  setOpen(open: boolean) {
    this.view.look.openPiano = open;
    this.view.setOpen(open);
    this.piece?.camera.setOpen(open);
    this.live?.camera.setOpen(open);
    // a shot held inside the piano moves to the nearest one outside once it closes
    if (!open && this.piece) this.camView = this.piece.camera.whenClosed(this.camView);
    this.settingsChanged();
    this.invalidate();
    this.emit('view');
  }

  setLights(l: Partial<LightSettings>) {
    this.lights = { ...this.lights, ...l };
    this.view.setLights(this.lights);
    this.settingsChanged();
  }

  cameraAt(t: number): CameraState {
    const camera = this.live ? this.live.camera : this.piece!.camera;
    return camera.evaluate(this.camView, t, this.framing, this.view.camera.aspect);
  }

  renderNow() {
    if (!this.piece) return;
    if (this.live) return this.renderLive(this.live);
    const t = this.viewTime();
    const cam = this.cameraAt(t);
    // motion blur: where everything was as the shutter opened (in performance
    // time, so slow motion blurs less); a cut is never blurred across
    const open = shutterTime(this.view.look) * this.speed;
    if (open > 0 && this.view.post.quality !== 'low') {
      const t0 = Math.max(0, t - open);
      const cut = this.camView === 'cinematic' && this.piece.camera.director.shotAt(t).start > t0;
      this.view.setPrevious(this.piece.timeline.evaluate(t0), cut ? cam : this.cameraAt(t0));
    }
    const frame = this.piece.timeline.evaluate(t);
    this.frame = frame;
    this.view.update(frame);
    this.view.camera.position.copy(cam.position);
    this.view.camera.lookAt(cam.target);
    this.view.camera.updateMatrixWorld();
    if (this.debug?.visible)
      this.debug.update(frame, this.piece.timeline.plan.hands, this.view.hands, this.view.camera, window.innerWidth, window.innerHeight);
    this.view.render(cam, t);
    this.dirty = false;
  }

  // ------------------------------------------------------------- playing live
  /** a live session: the player plays, the robot follows (null when performing a piece) */
  live: LiveSession | null = null;
  liveSettings: LiveSettings = { ...DEFAULT_LIVE };
  private liveFrom: { t: number } | null = null;

  /** start playing live (from a click or a key: the sound starts here) */
  enterLive() {
    if (this.live || !this.ready) return;
    // the audio context must be made in the gesture itself
    void this.audio.init().catch((e) => console.warn('audio unavailable', e));
    if (this.playing) this.pause();
    this.liveFrom = { t: this.t };
    if (this.debug?.visible) this.setDebug(false);
    this.live = new LiveSession(this.audio, this.liveSettings);
    this.live.camera.setOpen(this.view.look.openPiano);
    this.live.onChange = () => this.emit('live');
    this.emit('live');
  }

  /** back to the piece, where it was */
  exitLive() {
    if (!this.live) return;
    this.live.dispose();
    this.live = null;
    if (this.liveFrom) this.t = this.liveFrom.t;
    this.liveFrom = null;
    this.renderNow();
    this.emit('live');
  }

  /** a live frame: the robot as it is now (drawn for when the frame is seen, like a playing piece) */
  private renderLive(L: LiveSession) {
    const t = L.now() + Math.min(0.05, this.frameDt) + this.syncMs / 1000;
    L.frame(t);
    const cam = this.cameraAt(t);
    const open = shutterTime(this.view.look);
    if (open > 0 && this.view.post.quality !== 'low') {
      const t0 = t - open;
      const cut = this.camView === 'cinematic' && L.camera.director.shotAt(t).start > t0;
      this.view.setPrevious(L.performer.evaluate(t0), cut ? cam : this.cameraAt(t0));
    }
    const frame = L.performer.evaluate(t);
    this.frame = frame;
    this.view.update(frame);
    this.view.camera.position.copy(cam.position);
    this.view.camera.lookAt(cam.target);
    this.view.camera.updateMatrixWorld();
    this.view.render(cam, t);
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
    if (this.exporting) return;
    const dt = Math.min(0.1, (now - this.lastWall) / 1000);
    this.lastWall = now;
    if (dt > 0) this.frameDt += (dt - this.frameDt) * 0.1;
    this.fpsAcc.n++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t > 0.5) {
      this.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc = { n: 0, t: 0 };
      // keep playback smooth on slower machines: step quality down once
      if ((this.playing || this.live) && this.autoQuality && document.visibilityState === 'visible') {
        this.slowFor = this.fps < 28 ? this.slowFor + 0.5 : 0;
        if (this.slowFor >= 3 && this.view.post.quality !== 'low') {
          this.view.setQuality(this.view.post.quality === 'high' ? 'medium' : 'low');
          this.slowFor = 0;
          this.emit('quality');
        }
      }
    }
    if (this.live) {
      this.renderNow();
      return;
    }
    if (this.playing && this.piece) {
      // the audio clock is the master while sound is running
      this.t = this.audio.isRunning ? this.audioTime() : this.t + dt * this.speed;
      this.audio.pump(this.piece.timeline);
      if (this.t >= this.duration) {
        this.t = this.duration;
        this.playing = false;
        this.audio.stop();
        this.emit('transport');
      }
      this.renderNow();
      this.emit('time');
    } else if (this.dirty) this.renderNow();
  };

  invalidate() {
    this.dirty = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}

/** a readable title for a MIDI file: its own name, else the file name tidied up */
export function titleOf(parsed: ParsedMidi, file: string): string {
  const own = parsed.name?.trim();
  if (own && !/^(untitled|track|pianoteq|sequence)/i.test(own)) return own;
  return file
    .replace(/\.(mid|midi)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+-\s+|-/g, ' – ')
    .trim();
}
