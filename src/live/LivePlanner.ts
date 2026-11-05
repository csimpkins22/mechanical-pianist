// Live playing, planned a little at a time. The player's notes arrive as they
// are played; the robot plays each one a fixed delay later, so the planner
// always knows that much of what is coming. A window of the performance (the
// last second of what the robot has played, everything it has yet to play)
// is planned exactly as a piece is (hands, fingering, motion: the same
// layers), with the hand and finger of every note the robot is already
// playing held fixed, and a hand with nothing to play left where it is.
// Windows are planned on a fixed time grid and taken over smoothly by
// LivePerformer. Everything here is a pure function of its request, so it
// runs as well in a worker as in a test.
import { REST_TIPS } from '../core/handGeometry';
import type { Hand, Override, PedalEvent, Performance, Score, ScoreNote } from '../core/types';
import { planPerformance } from '../interpretation/PerformancePlanner';
import { PerformanceTimeline, type TimelineOptions } from '../performance/PerformanceTimeline';

/** a key the player pressed, in live time (seconds since playing began) */
export interface LiveNote {
  id: number;
  midi: number;
  velocity: number; // 0..1
  on: number;
  /** when it was let go; null while it is still held */
  off: number | null;
  /** how long after the player the robot plays it (the delay when it was pressed) */
  delay: number;
}

export interface PedalChange {
  /** robot time (live time plus the delay) */
  t: number;
  down: boolean;
}

export interface WindowRequest {
  /** the grid moment: everything the player did up to g is known */
  g: number;
  /** the notes the window needs (see selectNotes), as known at g */
  notes: LiveNote[];
  /** sustain pedal changes in robot time, as known at g */
  pedal: PedalChange[];
  /** notes whose hand and finger are already shown: these stay */
  commits: [number, Override][];
  /** where each hand's wrist is now (a hand with nothing to play stays there) */
  home: Record<Hand, number>;
}

export interface WindowPlan {
  g: number;
  /** the window's time zero, in live time (its plan runs in window time) */
  origin: number;
  perf: Performance;
  timeline: PerformanceTimeline;
}

/** robot time kept in a window before its grid moment */
export const HISTORY = 1.0;
/** a key still held is assumed held at least this much past what is known */
export const HOLD_AHEAD = 0.5;
/** window time before the earliest moment kept (the motion planner's own lead-in) */
const MARGIN = 1.2;

/** live planning: one round of contact checks, which keeps a window to a few tens of milliseconds */
export const LIVE_TIMELINE: TimelineOptions = { rounds: 1, refinePasses: 2, settle: false };

/** the notes a window planned at g needs: pressed by g, and not let go long before */
export function selectNotes(all: LiveNote[], g: number): LiveNote[] {
  const from = g - HISTORY;
  const known = g + 1e-9; // grid moments are sums of steps: allow their rounding
  return all
    .filter((n) => n.on <= known && (n.off === null || n.off > known || n.off + n.delay > from))
    .map((n) => (n.off !== null && n.off > known ? { ...n, off: null } : n));
}

/** pedal changes known at g (robot time = live time + delay, so known ones may lie ahead) */
export function selectPedal(all: PedalChange[], g: number, delay: number): PedalChange[] {
  return all.filter((p) => p.t - delay <= g + 1e-9);
}

export function planWindow(req: WindowRequest): WindowPlan {
  const { g } = req;
  const origin = g - HISTORY - MARGIN;
  const local = (t: number) => t - origin;
  let horizon = g + HOLD_AHEAD;
  const notes: ScoreNote[] = req.notes.map((n) => {
    const robotOn = n.on + n.delay;
    // a key held from long before the window starts (in window time) just inside it
    const start = Math.max(local(robotOn), 0.3);
    const robotOff = n.off !== null ? n.off + n.delay : Math.max(robotOn + 0.25, g + n.delay + HOLD_AHEAD);
    const end = Math.max(start + 0.05, local(robotOff));
    horizon = Math.max(horizon, origin + end);
    return { id: n.id, midi: n.midi, start, end, velocity: n.velocity, track: 0 };
  });
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  // the pedal as it stands at the window's start, then its changes
  const pedal: PedalEvent[] = [];
  let down = false;
  for (const p of req.pedal) {
    if (p.t <= origin) down = p.down;
    else pedal.push({ time: local(p.t), down: p.down });
  }
  if (down) pedal.unshift({ time: 0, down: true });
  const score: Score = {
    name: 'Live',
    notes,
    pedal,
    tempos: [],
    tracks: [],
    selectedTracks: [0],
    duration: local(horizon) + 0.6,
    outOfRange: 0,
  };
  // the hands' centres: the middle finger's key from each wrist
  const handsAt = { L: req.home.L - REST_TIPS[3][0], R: req.home.R + REST_TIPS[3][0] };
  const perf = planPerformance(score, new Map(req.commits), new Map(), { handsAt });
  const timeline = new PerformanceTimeline(perf, undefined, { ...LIVE_TIMELINE, home: req.home });
  return { g, origin, perf, timeline };
}
