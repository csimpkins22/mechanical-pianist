// A live session: the player's input, the robot (LivePerformer, its windows
// planned in a worker), the piano's sound and the camera, on one clock (live
// time: seconds since the session began). By default the piano sounds when
// the robot strikes, so picture and sound go together; or the player hears
// their own playing at once and the robot follows.
import type { AudioEngine } from '../audio/AudioEngine';
import { revive } from '../app/planner';
import type { Performance } from '../core/types';
import type { PerformanceTimeline } from '../performance/PerformanceTimeline';
import { LiveCamera } from './LiveCamera';
import { LiveInput } from './LiveInput';
import { LivePerformer, type Planner } from './LivePerformer';
import { planWindow, type WindowPlan } from './LivePlanner';

export interface LiveSettings {
  /** how long after the player the robot plays (s) */
  delay: number;
  /** the piano sounds as the player plays, not as the robot does */
  hearAtOnce: boolean;
}

export const DEFAULT_LIVE: LiveSettings = { delay: 0.35, hearAtOnce: false };

interface Sounding {
  voice: { damp(at: number): void } | null;
  midi: number;
  velocity: number;
  /** the sound runs this far behind the player (0 or the robot's delay) */
  lag: number;
}

export class LiveSession {
  readonly performer: LivePerformer;
  readonly camera: LiveCamera;
  readonly input: LiveInput;
  private worker: Worker | null = null;
  private began = performance.now();
  private sounding = new Map<number, Sounding>();
  /** notes let go while the pedal is down: they ring until it lifts */
  private pedalled = new Set<number>();
  private pedal = false;
  /** notes struck so far (for the panel) */
  played = 0;
  onChange?: () => void;

  constructor(
    private audio: AudioEngine,
    public settings: LiveSettings = { ...DEFAULT_LIVE },
  ) {
    this.performer = new LivePerformer(settings.delay, this.startWorker());
    this.performer.clock = () => this.now();
    this.camera = new LiveCamera(this.performer);
    this.input = new LiveInput({
      note: (on, midi, v) => (on ? this.noteOn(midi, v) : this.noteOff(midi)),
      pedal: (down) => this.setPedal(down),
      changed: () => this.onChange?.(),
    });
    void this.input.startMidi();
    // planning keeps up even when frames are slow or the tab is in the background
    this.timer = window.setInterval(() => this.performer.update(this.now()), 40);
  }

  private timer = 0;

  /** windows planned in a worker; on the main thread if a worker cannot start */
  private startWorker(): { planner: Planner; async: boolean } {
    try {
      const worker = new Worker(new URL('./live.worker.ts', import.meta.url), { type: 'module' });
      let pending: { resolve: (w: WindowPlan) => void; reject: (e: Error) => void } | null = null;
      let heard = false;
      worker.onmessage = (e: MessageEvent) => {
        heard = true;
        const m = e.data as { ok: boolean; g: number; origin: number; perf: Performance; timeline: PerformanceTimeline; message?: string };
        const p = pending;
        pending = null;
        if (!p) return;
        if (!m.ok) return p.reject(new Error(m.message));
        const { perf, timeline } = revive({ perf: m.perf, timeline: m.timeline });
        p.resolve({ g: m.g, origin: m.origin, perf, timeline });
      };
      worker.onerror = (e) => {
        e.preventDefault();
        if (heard) return;
        // it never started (blocked, or no module workers): plan here instead
        worker.terminate();
        this.worker = null;
        this.performer.usePlanner(planWindow, false);
        pending?.reject(new Error('no worker'));
        pending = null;
      };
      this.worker = worker;
      const planner: Planner = (req) =>
        new Promise<WindowPlan>((resolve, reject) => {
          pending = { resolve, reject };
          worker.postMessage(req);
        });
      return { planner, async: true };
    } catch {
      return { planner: planWindow, async: false };
    }
  }

  /** live time now */
  now(): number {
    return (performance.now() - this.began) / 1000;
  }

  /** a live moment on the audio context's clock (allowing for the output's own delay) */
  private ctxTime(t: number): number {
    const ctx = this.audio.ctx;
    if (!ctx) return 0;
    return ctx.currentTime + (t - this.now()) - this.audio.outputDelay;
  }

  setDelay(d: number) {
    this.settings.delay = d;
    this.performer.delay = d;
  }

  noteOn(midi: number, velocity: number) {
    const t = this.now();
    // the same key again while it still rings: the old sound gives way
    for (const [id, s] of this.sounding)
      if (s.midi === midi && this.pedalled.has(id)) {
        s.voice?.damp(this.ctxTime(t + s.lag));
        this.sounding.delete(id);
        this.pedalled.delete(id);
      }
    const n = this.performer.noteOn(t, midi, velocity);
    const lag = this.settings.hearAtOnce ? 0 : n.delay;
    this.sounding.set(n.id, { voice: this.audio.liveStrike(midi, n.velocity, this.ctxTime(t + lag)), midi, velocity: n.velocity, lag });
    this.played++;
    this.performer.update(t);
    this.onChange?.();
  }

  noteOff(midi: number) {
    const t = this.now();
    const n = this.performer.noteOff(t, midi);
    if (!n) return;
    const s = this.sounding.get(n.id);
    if (!s) return;
    const at = this.ctxTime(t + s.lag);
    this.audio.liveKeyUp(midi, s.velocity, at);
    if (this.pedal) this.pedalled.add(n.id);
    else {
      s.voice?.damp(at);
      this.sounding.delete(n.id);
    }
    this.performer.update(t);
  }

  setPedal(down: boolean) {
    if (down === this.pedal) return;
    const t = this.now();
    this.pedal = down;
    this.performer.setPedal(t, down);
    const lag = this.settings.hearAtOnce ? 0 : this.settings.delay;
    this.audio.livePedal(down, this.ctxTime(t + lag));
    if (!down) {
      for (const id of this.pedalled) {
        const s = this.sounding.get(id);
        s?.voice?.damp(this.ctxTime(t + s.lag));
        this.sounding.delete(id);
      }
      this.pedalled.clear();
    }
    this.performer.update(t);
    this.onChange?.();
  }

  /** before drawing a frame for live time t */
  frame(t: number) {
    this.performer.update(this.now());
    this.camera.advance(t);
  }

  dispose() {
    clearInterval(this.timer);
    this.input.stop();
    this.performer.releaseAll(this.now());
    this.worker?.terminate();
    this.worker = null;
    this.audio.stopAll(0.15);
    this.audio.livePedal(false, 0);
  }
}
