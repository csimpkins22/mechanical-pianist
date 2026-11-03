// The robot playing live: what the player has done, the windows planned from
// it (LivePlanner), and the robot as it is at any moment.
//
// Windows are planned on a fixed grid (STEP): at a grid moment g, if anything
// was played since the last window (or a key is still held and the window
// needs extending), a window is planned from everything known at g and takes
// over at g + TAKEOVER. Nothing before a takeover is ever planned again, so
// what has been shown stays as it was. At a takeover the new window's wrist
// path is joined to the one on screen: the difference in position and speed
// fades out along a quintic, over longer when the hand has further to go, so
// the hands never jump; fingers and keys cross-fade over a moment too. The
// hand and finger of every note about to be struck are committed, and every
// later window keeps them.
//
// Planned synchronously (tests, tools), the robot is a pure function of the
// events. Planned in a worker (the app), a window that is not back by its
// takeover takes over when it arrives.
import { KEY_COUNT, keyOf } from '../core/keyboard';
import { REST_TIPS, type M3, type V3 } from '../core/handGeometry';
import { Signal, clamp } from '../core/math';
import type { Hand, Override } from '../core/types';
import type { HandTrack } from '../performance/MotionPlanner';
import { poseHand, type HandPose } from '../performance/HandPoser';
import type { FrameState } from '../performance/PerformanceTimeline';
import { planWindow, selectNotes, selectPedal, type LiveNote, type PedalChange, type WindowPlan, type WindowRequest } from './LivePlanner';

/** the planning grid (s) */
export const STEP = 1 / 30;
/** a window takes over this long after its grid moment (the time it has to be planned) */
export const TAKEOVER = 0.11;
/** while a key is held, a window at least this often (it extends the hold) */
const REFRESH = 0.25;
/** notes struck before this long after a takeover are committed (hand and finger fixed) */
const COMMIT = 0.15;
/** fingers and keys cross-fade over this long after a takeover */
const FADE = 0.09;

export type Planner = (req: WindowRequest) => WindowPlan | Promise<WindowPlan>;

const CHANNELS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'thumbTuck'] as const;
type Channel = (typeof CHANNELS)[number];

/** quintic from (p0, v0) to (0, 0) over u in 0..1, no acceleration at either end (v0 per unit u) */
function fadeOut(p0: number, v0: number, u: number): number {
  if (u >= 1) return 0;
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  return p0 * (1 - 10 * u3 + 15 * u4 - 6 * u5) + v0 * (u - 6 * u3 + 8 * u4 - 3 * u5);
}

/** a window's signal (window time) seen in live time, with the joining correction added */
class Joined extends Signal {
  constructor(
    base: Signal,
    private origin: number,
    private at0: number,
    private span: number,
    private p0: number,
    private v0: number,
  ) {
    super(base.t0, base.rate, base.data);
  }
  override at(t: number): number {
    const live = t + this.origin;
    const u = (live - this.at0) / this.span;
    return super.at(t) + (u < 0 ? this.p0 : fadeOut(this.p0, this.v0 * this.span, u));
  }
}

interface Taken {
  plan: WindowPlan;
  /** live time it took over */
  at: number;
  tracks: Record<Hand, HandTrack>;
}

/** where the hands wait before anything is played: around the middle of the keyboard */
export function restingWrists(): Record<Hand, number> {
  return { L: keyOf(50).x + REST_TIPS[3][0], R: keyOf(67).x - REST_TIPS[3][0] };
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpV = (a: V3, b: V3, u: number): V3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const lerpM = (a: M3, b: M3, u: number) => a.map((v, i) => lerp(v, b[i], u)) as M3;

/** fingers and thumb of two poses mixed (the wrist and palm come from b: they are already joined) */
function mixFingers(a: HandPose, b: HandPose, u: number): HandPose {
  return {
    ...b,
    fingers: b.fingers.map((f, i) => ({ ...f, abduction: lerp(a.fingers[i].abduction, f.abduction, u), angles: lerpV(a.fingers[i].angles, f.angles, u) })),
    thumb: { ...b.thumb, swing: lerp(a.thumb.swing, b.thumb.swing, u), twist: lerp(a.thumb.twist, b.thumb.twist, u), angles: lerpV(a.thumb.angles, b.thumb.angles, u) },
    states: b.states.map((s, i) => (i === 0 ? s : { ...s, tip: lerpV(a.states[i].tip, s.tip, u), target: lerpV(a.states[i].target, s.target, u) })),
    forearm: lerpM(a.forearm, b.forearm, u),
  };
}

export class LivePerformer {
  readonly notes: LiveNote[] = [];
  readonly pedal: PedalChange[] = [];
  /** hand and finger of notes already being played */
  readonly commits = new Map<number, Override>();
  private held = new Map<number, LiveNote>();
  private nextId = 1;
  private pedalDown = false;
  private taken: Taken[] = [];
  /** the last grid moment planned (or asked for) */
  private lastG = 0;
  /** when each thing the player did happened, in order; and how many of them are planned */
  private events: number[] = [];
  private planned = 0;
  private busy = false;
  /** windows planned so far, and how long each took (ms), for the panel */
  stats = { windows: 0, late: 0, lastMs: 0 };

  private planner: Planner;
  private async: boolean;
  private keep: number;

  constructor(
    public delay = 0.35,
    opts: {
      planner?: Planner;
      /** the planner answers later (a worker): plan the latest grid moment whenever it is free */
      async?: boolean;
      /** how long a window that has been taken over is kept (s): the screen only looks back a frame */
      keep?: number;
    } = {},
  ) {
    this.planner = opts.planner ?? planWindow;
    this.async = opts.async ?? false;
    this.keep = opts.keep ?? 1.5;
    // the hands wait over the middle of the keyboard
    this.adopt(planWindow({ g: 0, notes: [], pedal: [], commits: [], home: restingWrists() }), 0);
  }

  /** plan with another planner from now on (the worker could not start) */
  usePlanner(planner: Planner, async: boolean) {
    this.planner = planner;
    this.async = async;
    this.busy = false;
  }

  // ------------------------------------------------------------ the player
  noteOn(t: number, midi: number, velocity: number): LiveNote {
    if (this.held.has(midi)) this.noteOff(t, midi);
    const n: LiveNote = { id: this.nextId++, midi, velocity: clamp(velocity, 0.05, 1), on: t, off: null, delay: this.delay };
    this.notes.push(n);
    this.held.set(midi, n);
    this.events.push(t);
    return n;
  }

  noteOff(t: number, midi: number): LiveNote | null {
    const n = this.held.get(midi);
    if (!n) return null;
    n.off = Math.max(t, n.on + 0.03);
    this.held.delete(midi);
    this.events.push(t);
    return n;
  }

  setPedal(t: number, down: boolean) {
    if (down === this.pedalDown) return;
    this.pedalDown = down;
    this.pedal.push({ t: t + this.delay, down });
    this.events.push(t);
  }

  /** let go of everything (leaving live mode, a lost device) */
  releaseAll(t: number) {
    for (const midi of [...this.held.keys()]) this.noteOff(t, midi);
    this.setPedal(t, false);
  }

  get holding() {
    return this.held.size > 0;
  }

  /** the keys the player is holding now */
  heldKeys(): Set<number> {
    return new Set(this.held.keys());
  }

  // ------------------------------------------------------------ planning
  /** the request for a window at g */
  request(g: number): WindowRequest {
    const prev = this.taken[this.taken.length - 1];
    const home = {
      L: prev.tracks.L.x.at(g + 0.1 - prev.plan.origin),
      R: prev.tracks.R.x.at(g + 0.1 - prev.plan.origin),
    };
    const notes = selectNotes(this.notes, g);
    const ids = new Set(notes.map((n) => n.id));
    return {
      g,
      notes,
      pedal: selectPedal(this.pedal, g, this.delay),
      commits: [...this.commits].filter(([id]) => ids.has(id)),
      home,
    };
  }

  /** whether grid moment g is due a window: something was played since the last, or a held key needs extending */
  private due(g: number): boolean {
    if (g <= this.lastG + 1e-9) return false;
    const played = this.planned < this.events.length && this.events[this.planned] <= g + 1e-9;
    if (played) return true;
    // a key held at g: extend the hold now and then
    if (g - this.lastG < REFRESH - 1e-9) return false;
    for (const n of this.held.values()) if (n.on <= g + 1e-9) return true;
    return false;
  }

  /**
   * Plan what is due up to `now` (call every frame, and after input). A
   * synchronous planner plans every due grid moment in turn, so the robot
   * depends on the events alone; a worker gets the latest one whenever it is
   * free.
   */
  update(now: number) {
    if (this.busy) return;
    const last = Math.floor(now / STEP + 1e-9);
    const first = this.async ? last : Math.floor(Math.max(this.lastG + STEP, now - 2) / STEP + 1e-9);
    for (let k = first; k <= last; k++) {
      const g = k * STEP;
      if (!this.due(g)) continue;
      this.lastG = g;
      while (this.planned < this.events.length && this.events[this.planned] <= g + 1e-9) this.planned++;
      const req = this.request(g);
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const res = this.planner(req);
      if (res instanceof Promise) {
        this.busy = true;
        res
          .then((plan) => {
            this.stats.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            if (this.clock && this.clock() > plan.g + TAKEOVER) this.stats.late++;
            this.adopt(plan, plan.g + TAKEOVER);
          })
          .catch((e) => console.warn('live planning failed', e))
          .finally(() => {
            this.busy = false;
            // whatever was played meanwhile is due now
            if (this.clock) this.update(this.clock());
          });
        return;
      }
      this.adopt(res, g + TAKEOVER);
    }
  }

  /** take a planned window on: joined to what is on screen at `at`, its imminent notes committed */
  private adopt(plan: WindowPlan, at: number) {
    const prev = this.taken[this.taken.length - 1];
    // a window back from the worker after its moment takes over now (the screen has moved on)
    if (prev && at < prev.at) at = prev.at;
    if (this.clock !== null) at = Math.max(at, this.clock() + 1 / 120);
    const raw = plan.timeline.plan.hands;
    const tracks = { L: raw.L, R: raw.R } as Record<Hand, HandTrack>;
    if (prev) {
      for (const h of ['L', 'R'] as Hand[]) {
        const a = prev.tracks[h];
        const b = raw[h];
        const ta = at - prev.plan.origin;
        const tb = at - plan.origin;
        const diff = (c: Channel) => {
          const sa = a[c];
          const sb = b[c];
          if (!sa || !sb) return { p: 0, v: 0 };
          return { p: sa.at(ta) - sb.at(tb), v: sa.slope(ta) - sb.slope(tb) };
        };
        const dx = diff('x');
        const dy = diff('y');
        const dz = diff('z');
        // further to go, longer to get there (about the motion planner's travel time)
        const span = clamp(0.1 + 0.9 * Math.hypot(dx.p, dy.p, dz.p), 0.1, 0.45);
        const joined = { ...b } as HandTrack;
        for (const c of CHANNELS) {
          const sb = b[c];
          if (!sb) continue;
          const { p, v } = diff(c);
          (joined as unknown as Record<Channel, Signal>)[c] = new Joined(sb, plan.origin, at, span, p, v);
        }
        tracks[h] = joined;
      }
    }
    this.taken.push({ plan, at, tracks });
    for (const n of plan.perf.notes) if (n.start + plan.origin < at + COMMIT && !this.commits.has(n.id)) this.commits.set(n.id, { hand: n.hand, finger: n.finger });
    this.stats.windows++;
    // keep what the screen (and motion blur, a frame back) can still ask for
    while (this.taken.length > 3 && this.taken[1].at < at - this.keep) this.taken.shift();
  }

  /** the live clock, when there is one (the app): a late window never takes over in the past */
  clock: (() => number) | null = null;

  // ------------------------------------------------------------ the robot
  private takenAt(t: number): number {
    let i = this.taken.length - 1;
    while (i > 0 && this.taken[i].at > t) i--;
    return i;
  }

  evaluate(t: number): FrameState {
    const i = this.takenAt(t);
    const cur = this.taken[i];
    const tl = cur.plan.timeline;
    const lt = t - cur.plan.origin;
    const keys = tl.keys.evaluate(lt, new Float32Array(KEY_COUNT));
    const hands = { L: poseHand(cur.tracks.L, tl.keys, lt), R: poseHand(cur.tracks.R, tl.keys, lt) };
    const u = i > 0 ? (t - cur.at) / FADE : 1;
    if (u < 1) {
      const prev = this.taken[i - 1];
      const pt = t - prev.plan.origin;
      const e = u * u * (3 - 2 * u);
      const pk = prev.plan.timeline.keys.evaluate(pt, new Float32Array(KEY_COUNT));
      for (let k = 0; k < KEY_COUNT; k++) keys[k] = lerp(pk[k], keys[k], e);
      for (const h of ['L', 'R'] as Hand[]) hands[h] = mixFingers(poseHand(prev.tracks[h], prev.plan.timeline.keys, pt), hands[h], e);
    }
    return {
      t,
      keys,
      hands,
      pedal: tl.pedalAt(lt),
      effort: { L: tl.effort('L', lt), R: tl.effort('R', lt) },
      sounding: [],
    };
  }

  /** a fingerprint of the robot at t (keys, every joint), for tests */
  stateHash(t: number): string {
    const s = this.evaluate(t);
    let h = 2166136261 >>> 0;
    const mix = (v: number) => {
      h = Math.imul(h ^ (Math.round(v * 1e6) | 0), 16777619) >>> 0;
    };
    s.keys.forEach(mix);
    for (const hand of ['L', 'R'] as Hand[]) {
      const p = s.hands[hand];
      p.wrist.forEach(mix);
      p.rot.forEach(mix);
      for (const f of p.fingers) f.angles.forEach(mix);
      p.thumb.angles.forEach(mix);
    }
    mix(s.pedal);
    return h.toString(16);
  }

  /** the plan in force at t (for the camera's look at the hands to come) */
  windowAt(t: number): { plan: WindowPlan; tracks: Record<Hand, HandTrack> } {
    const c = this.taken[this.takenAt(t)];
    return { plan: c.plan, tracks: c.tracks };
  }
}
