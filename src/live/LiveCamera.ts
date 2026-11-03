// The camera for live playing. The cinematographer (CinematicCamera) reads a
// handful of curves computed ahead of time from the whole performance: where
// the hands are, how far apart, which one leads, how close the music is to a
// peak. Live, there is no whole performance: the same curves are built as
// the music happens, from the hands as planned a moment ahead (the robot
// already knows the next fraction of a second), smoothed causally, sampled on
// a fixed grid as time passes. Every framing, focus pull and the forearm
// guard are then the cinematographer's own, and the director cuts between
// calm shots on a steady cadence instead of to a score it cannot see.
import { DEFAULT_FRAMING, CinematicCamera, type CameraMode, type CameraState, type Framing } from '../presentation/CinematicCamera';
import { ShotDirector } from '../presentation/ShotDirector';
import type { Hand } from '../core/types';
import type { LivePerformer } from './LivePerformer';

const DT = 1 / 30;
/** the camera looks this far ahead: the robot's plan already covers it */
const LOOK = 0.15;

/** a live curve: smoothed samples on the DT grid, read back with interpolation */
class Curve {
  private v: number[] = [];
  constructor(
    private tau: number,
    private first: number,
  ) {}
  push(raw: number) {
    const prev = this.v.length ? this.v[this.v.length - 1] : this.first;
    this.v.push(prev + (raw - prev) * (1 - Math.exp(-DT / this.tau)));
  }
  at(t: number): number {
    const n = this.v.length;
    if (!n) return this.first;
    const x = t / DT;
    if (x <= 0) return this.v[0];
    if (x >= n - 1) return this.v[n - 1];
    const i = Math.floor(x);
    return this.v[i] + (this.v[i + 1] - this.v[i]) * (x - i);
  }
}

export class LiveCamera extends CinematicCamera {
  private k = -1;
  private live: Record<string, Curve> = {};
  private leadHand: 0 | 1 = 1;
  private leadSince = 0;

  constructor(private performer: LivePerformer) {
    const w = performer.windowAt(0);
    // a stand-in for the curves a piece would have; replaced below
    super(w.plan.timeline.plan, 1);
    const at = (h: Hand, c: 'x' | 'y' | 'z') => w.tracks[h][c].at(-w.plan.origin);
    const xl = at('L', 'x');
    const xr = at('R', 'x');
    const c = (tau: number, v: number) => new Curve(tau, v);
    this.live = {
      center: c(1.1, (xl + xr) / 2),
      span: c(1.1, Math.abs(xr - xl)),
      rightX: c(0.6, xr),
      leftX: c(0.6, xl),
      activity: c(1.5, 0.3),
      peak: c(1.2, 0),
      lead: c(0.18, 1),
      Rx: c(0.3, xr),
      Ry: c(0.3, at('R', 'y')),
      Rz: c(0.3, at('R', 'z')),
      Lx: c(0.3, xl),
      Ly: c(0.3, at('L', 'y')),
      Lz: c(0.3, at('L', 'z')),
    };
    const L = this.live;
    const self = this as unknown as Record<string, unknown>;
    for (const k of ['center', 'span', 'rightX', 'leftX', 'activity', 'peak', 'lead']) self[k] = L[k];
    self.rightWrist = [L.Rx, L.Ry, L.Rz];
    self.leftWrist = [L.Lx, L.Ly, L.Lz];
    // the forearm guard reads the wrists through the tracks
    self.tracks = { L: { sx: -1, x: L.Lx, y: L.Ly, z: L.Lz }, R: { sx: 1, x: L.Rx, y: L.Ry, z: L.Rz } };
    self.director = new ShotDirector(
      {
        duration: 4 * 3600,
        center: (t) => L.center.at(t),
        span: (t) => L.span.at(t),
        tip: (h, t) => this.tip(h, t),
        wrist: (h, t) => this.wrist(h, t),
        peak: (t) => L.peak.at(t),
        lead: (t) => L.lead.at(t),
      },
      [],
      [],
      { cadence: 9, handAt: (t) => (L.lead.at(t) >= 0.5 ? 'R' : 'L') },
    );
  }

  /** sample the hands up to live time `now` (call every frame, before evaluate) */
  advance(now: number) {
    const last = Math.floor(now / DT);
    // a long pause in the frames (a hidden tab): only the recent past matters
    if (last - this.k > 300) this.k = last - 300;
    for (let k = this.k + 1; k <= last; k++) this.sample(k * DT);
    this.k = Math.max(this.k, last);
  }

  private sample(t: number) {
    const L = this.live;
    const w = this.performer.windowAt(t + LOOK);
    const lt = t + LOOK - w.plan.origin;
    const x = (h: Hand) => w.tracks[h].x.at(lt);
    // activity per hand: notes engaged around now, and how loud the playing is
    let aL = 0;
    let aR = 0;
    let loud = 0;
    for (const n of w.plan.perf.notes) {
      if (n.start - 0.6 < lt && n.keyEnd + 0.4 > lt) n.hand === 'L' ? aL++ : aR++;
      const d = lt - n.start;
      if (d > -0.1 && d < 1.2) loud += n.velocity * n.velocity * Math.exp(-d / 0.6);
    }
    const wl = 0.35 + Math.min(1, aL / 2);
    const wr = 0.5 + Math.min(1, aR / 2);
    const xl = x('L');
    const xr = x('R');
    L.center.push((xl * wl + xr * wr) / (wl + wr));
    L.span.push(Math.abs(xr - xl));
    L.rightX.push(xr);
    L.leftX.push(xl);
    L.activity.push((wl + wr) / 3);
    const u = Math.min(1, Math.max(0, (loud - 0.6) / 1.6));
    L.peak.push(u * u * (3 - 2 * u));
    // which hand leads: commit, and change only when the other clearly takes over for a while
    const raw = (aR - aL) / (aR + aL + 0.25);
    const other = this.leadHand === 1 ? raw < -0.18 : raw > 0.18;
    if (other && t - this.leadSince > 2.5) {
      this.leadHand = this.leadHand === 1 ? 0 : 1;
      this.leadSince = t;
    }
    L.lead.push(this.leadHand);
    for (const h of ['L', 'R'] as Hand[]) for (const c of ['x', 'y', 'z'] as const) L[`${h}${c}`].push(w.tracks[h][c].at(lt));
  }

  /** the shot and the hands as they are: no look ahead at a zoom the guard may need later (it cannot be known) */
  override evaluate(mode: CameraMode, t: number, f: Framing = DEFAULT_FRAMING, aspect = 16 / 9): CameraState {
    const raw = (this as unknown as { compose(m: CameraMode, t: number, f: Framing): CameraState }).compose(mode, t, f);
    return this.guard(raw, t, aspect);
  }
}
