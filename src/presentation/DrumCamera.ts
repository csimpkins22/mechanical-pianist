// A temporary camera for the drum stage (the full director comes later): a
// few composed views, each fixed or moving slowly as a crew would move it,
// and a simple edit that cuts between them on bar lines, preferring a bar
// that opens with a crash, about every 6 to 9 seconds, 50 ms ahead of the
// downbeat so the new shot sees it land. Everything is a pure function of t.
//
// The views are given in the kit's own frame (KitLayout: the stool at the
// origin, the drummer facing -z) and placed in the room by `origin`.
import * as THREE from 'three';
import type { CameraState } from './CinematicCamera';
import type { DrumPerformance } from '../drums/DrumScore';
import { drift } from '../core/random';
import { DRUMS, type DrumId } from '../drums/KitLayout';

type V3 = [number, number, number];

export interface DrumShot {
  id: string;
  name: string;
  /** where the camera is and looks at the start and end of a shot (kit frame); focus on `focus` */
  from: { pos: V3; target: V3 };
  to: { pos: V3; target: V3 };
  focal: [number, number];
  fstop: number;
  focus: V3;
  /** the overhead's slow turn (radians over a shot) */
  turn?: number;
}

/** a drum's or cymbal's centre (KitLayout), for the views' focus */
const at = (id: DrumId, dy = 0, dz = 0): V3 => [DRUMS[id].centre[0], DRUMS[id].centre[1] + dy, DRUMS[id].centre[2] + dz];

export const DRUM_SHOTS: DrumShot[] = [
  {
    id: 'front',
    name: 'Three-quarter, from the front',
    from: { pos: [-1.3, 1.78, -2.52], target: [0.1, 0.69, -0.62] },
    to: { pos: [-1.18, 1.72, -2.34], target: [0.1, 0.69, -0.62] },
    focal: [36, 38],
    fstop: 4,
    focus: at('snare', 0, -0.05),
  },
  {
    id: 'overhead',
    name: 'Overhead, turning',
    from: { pos: [0.12, 2.6, -0.55], target: [0.12, 0.55, -0.57] },
    to: { pos: [0.12, 2.55, -0.55], target: [0.12, 0.55, -0.57] },
    focal: [26, 27],
    fstop: 5.6,
    focus: [0.1, 0.72, -0.57],
    turn: 0.22,
  },
  {
    id: 'kick',
    name: 'Low, by the kick',
    from: { pos: [0.62, 0.17, -1.85], target: [0.02, 0.5, -0.66] },
    to: { pos: [0.52, 0.18, -1.75], target: [0.03, 0.52, -0.66] },
    focal: [24, 25],
    fstop: 4,
    focus: at('kick', 0, -DRUMS.kick.depth),
  },
  {
    id: 'snare',
    name: 'Close on the snare',
    from: { pos: [-0.54, 1.24, -1.04], target: at('snare') },
    to: { pos: [-0.51, 1.21, -1.0], target: at('snare') },
    focal: [50, 52],
    fstop: 5.6,
    focus: at('snare', 0, -0.04),
  },
  {
    id: 'cymbals',
    name: 'Along the cymbals',
    from: { pos: [1.89, 1.4, -1.16], target: [-0.32, 1.08, -0.66] },
    to: { pos: [1.89, 1.4, -1.26], target: [-0.32, 1.08, -0.68] },
    focal: [50, 50],
    fstop: 4.5,
    focus: at('ride'),
  },
  {
    id: 'stool',
    name: "From the drummer's stool",
    from: { pos: [0.02, 1.34, 0.34], target: [0.05, 0.74, -0.67] },
    to: { pos: [0.0, 1.35, 0.28], target: [0.05, 0.74, -0.67] },
    focal: [28, 29],
    fstop: 4,
    focus: at('snare'),
  },
];

/** the edit's order of shots: wide, close, low, along, overhead, front again... never the same twice running */
const ORDER = ['front', 'snare', 'overhead', 'cymbals', 'kick', 'stool'];

export interface Cut {
  start: number;
  end: number;
  shot: DrumShot;
  index: number;
}

export type DrumView = 'cinematic' | { shot: string };

/** a camera state with, for views straight down, an explicit up direction (roll is meaningless there) */
export type DrumCameraState = CameraState & { up?: THREE.Vector3 };

export class DrumCamera {
  readonly cuts: Cut[];
  constructor(
    readonly perf: DrumPerformance,
    /** the kit's origin in the room */
    readonly origin: THREE.Vector3,
  ) {
    this.cuts = edit(perf);
  }

  cutAt(t: number): Cut {
    let lo = 0;
    let hi = this.cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cuts[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.cuts[lo];
  }

  /** the shot on screen at t for a view */
  shotOf(view: DrumView, t: number): { shot: DrumShot; start: number; end: number } {
    if (view === 'cinematic') return this.cutAt(t);
    const shot = DRUM_SHOTS.find((s) => s.id === view.shot) ?? DRUM_SHOTS[0];
    // a held shot moves on a slow loop instead of once through
    const period = 24;
    const start = Math.floor(t / period) * period;
    return { shot, start, end: start + period };
  }

  /** a cut falls between t0 and t1 (never blur across one) */
  cutBetween(view: DrumView, t0: number, t1: number): boolean {
    return view === 'cinematic' && this.cutAt(t1).start > t0;
  }

  nameOf(view: DrumView, t: number): string {
    return this.shotOf(view, t).shot.name;
  }

  /** the next (or previous) shot to hold, from whatever is on screen */
  step(view: DrumView, t: number, dir: 1 | -1): DrumView {
    const cur = this.shotOf(view, t).shot.id;
    const i = DRUM_SHOTS.findIndex((s) => s.id === cur);
    return { shot: DRUM_SHOTS[(i + dir + DRUM_SHOTS.length) % DRUM_SHOTS.length].id };
  }

  evaluate(view: DrumView, t: number): DrumCameraState {
    const { shot, start, end } = this.shotOf(view, t);
    const len = Math.max(0.5, end - start);
    // a slow move, eased at both ends (a crew starts and stops a dolly gently)
    const u0 = Math.min(1, Math.max(0, (t - start) / len));
    const u = u0 * u0 * (3 - 2 * u0);
    const lerp = (a: V3, b: V3) => new THREE.Vector3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    const pos = lerp(shot.from.pos, shot.to.pos);
    const target = lerp(shot.from.target, shot.to.target);
    // the camera breathes: a few millimetres and a fraction of a degree, slowly
    pos.x += 0.004 * drift(t * 0.31, 81);
    pos.y += 0.003 * drift(t * 0.27, 82);
    pos.z += 0.004 * drift(t * 0.23, 83);
    target.x += 0.002 * drift(t * 0.19, 84);
    target.y += 0.002 * drift(t * 0.21, 85);
    const roll = 0.002 * drift(t * 0.17, 86);
    // the overhead turns slowly about its axis (the kit's front at the top of the frame, turning)
    const up = shot.turn ? new THREE.Vector3(Math.sin(-0.35 + shot.turn * u), 0, -Math.cos(-0.35 + shot.turn * u)) : undefined;
    pos.add(this.origin);
    target.add(this.origin);
    const focusPt = new THREE.Vector3(...shot.focus).add(this.origin);
    // focus by depth along the view axis, not by distance
    const axis = target.clone().sub(pos).normalize();
    const focus = Math.max(0.1, focusPt.clone().sub(pos).dot(axis));
    return { position: pos, target, focalLength: shot.focal[0] + (shot.focal[1] - shot.focal[0]) * u, fstop: shot.fstop, focus, roll, up };
  }
}

/**
 * The edit: candidate cuts on every bar line; a cut is taken once a shot has
 * run 6 s at a bar that opens with a crash (or a strong accent), and always by
 * 9 s; 50 ms before the downbeat. The first shot is the front three-quarter.
 */
export function edit(perf: DrumPerformance): Cut[] {
  const bars = perf.bars.length ? perf.bars : [0];
  const strong = (t: number) => perf.hits.some((h) => Math.abs(h.t - t) < 0.08 && (h.piece === 'crash' || (h.piece === 'kick' && h.velocity > 0.85) || h.zone === 'edge'));
  const cuts: Cut[] = [];
  let start = 0;
  let k = 0;
  for (const b of bars) {
    const at = Math.max(0, b - 0.05);
    const long = at - start;
    if (long >= 9 || (long >= 6 && strong(b))) {
      if (perf.duration - at < 4) break;
      cuts.push({ start, end: at, shot: shotById(ORDER[k % ORDER.length]), index: k });
      k++;
      start = at;
    }
  }
  cuts.push({ start, end: perf.duration + 30, shot: shotById(ORDER[k % ORDER.length]), index: k });
  return cuts;
}

function shotById(id: string): DrumShot {
  return DRUM_SHOTS.find((s) => s.id === id)!;
}
