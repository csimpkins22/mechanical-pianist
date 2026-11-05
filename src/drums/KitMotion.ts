// How the kit moves when it is played, as a pure function of the time t and
// the hits (nothing is integrated from frame to frame, so a paused, scrubbed
// or exported frame is exact).
//
// Cymbals: every hit sets the cymbal rocking on its felt like a damped
// oscillator, struck side down, by an amount set by the velocity and by how
// far out it was struck (the torque arm). The numbers were measured from
// slow-motion footage of struck cymbals (the user's reference clips 2 and 3,
// tracked frame by frame; the slow-motion factor is unknown, so only ratios
// and shapes are taken from it):
//   - a crash on a tilter: damping ratio about 0.17 (the swing peaks about a
//     fifth of a period after the hit, and is back through rest at half a
//     period); a firm edge hit tips it about 10 degrees;
//   - a cymbal clamped in a hi-hat clutch: damping ratio about 0.4 (each swing
//     is about a quarter of the one before);
//   - on top of the swing, a fast, small wobble at about 17 to 20 times its
//     frequency and 5 to 10 percent of its size, that dies away slowly;
//   - the swing's axis stays almost fixed: a little rocking about the other
//     axis, at a slightly different rate, makes it precess slowly.
// The real periods are set from how kits behave at normal speed (a crash
// rocks at about 1.6 Hz). The wobble is faster than a film frame, so it is
// drawn as a camera sees it: averaged over the exposure.
//
// The hi-hat opens and closes with the pedal; its top cymbal rocks when hit
// open and is stopped by the bottom one as it closes. The kick's beater
// swings to the head, dwells, rebounds and settles past rest on its spring;
// the footboard follows it. Drum heads shimmer for a moment (an exposure
// blur of their vibration, drawn in their shader), the snare wires buzz
// (and buzz in sympathy with the kick and toms), toms rock a little on their
// mounts and the stands give a little with their cymbals.
import { DRUMS, HIHAT_OPEN_GAP, type DrumId } from './KitLayout';
import { pedalAt, type DrumHit, type DrumPerformance } from './DrumScore';
import { hash01 } from '../core/random';

export type CymbalId = 'crash' | 'ride' | 'hihat';
export type ShellId = 'kick' | 'snare' | 'tom1' | 'tom2' | 'floorTom';
export const SHELLS: ShellId[] = ['kick', 'snare', 'tom1', 'tom2', 'floorTom'];
export const CYMBALS: CymbalId[] = ['crash', 'ride', 'hihat'];

/** a small rotation in a part's own frame (y along its axis, z toward the drummer): about its x and z axes, radians */
export interface Tilt {
  x: number;
  z: number;
}

export interface KitState {
  t: number;
  /** each cymbal's rocking on its felt (the hi-hat's: the top cymbal), and how far it has sunk into the felt (m) */
  cymbals: Record<CymbalId, Tilt & { drop: number }>;
  /** the stands' give: their top tube tilts a little with the cymbal (radians) */
  stands: Record<CymbalId, Tilt>;
  /** the hi-hat pedal: 0 = foot up (open) .. 1 = pressed (closed), and the gap between the cymbals (m) */
  hihatClosed: number;
  hihatGap: number;
  /** the kick beater and its footboard: 0 = at rest .. 1 = on the head (a little below 0 = past rest on its spring) */
  beater: number;
  /** each drum head's vibration envelope for the exposure shimmer, 0..1 */
  heads: Record<ShellId, number>;
  /** the snare wires' buzz, 0..1 */
  buzz: number;
  /** the toms rocking on their mounts (and the floor tom on its legs) */
  toms: Record<'tom1' | 'tom2' | 'floorTom', Tilt>;
}

// ---------------------------------------------------------------- measured constants
export interface SwingSpec {
  /** natural period of the main rocking (s) */
  period: number;
  zeta: number;
  /** tilt for the softest and the hardest hit at the edge (radians) */
  amp: [number, number];
  /** the other axis: its share of the swing and its period relative to the main one */
  ortho: number;
  orthoRatio: number;
}

export const SWING: Record<CymbalId, SwingSpec> = {
  // a crash on a tilter: zeta from clip 2; a firm edge hit about 10 degrees
  crash: { period: 0.62, zeta: 0.17, amp: [0.02, 0.17], ortho: 0.14, orthoRatio: 1.08 },
  // the ride is heavier and played on the bow: it rocks less and more slowly
  ride: { period: 0.8, zeta: 0.14, amp: [0.006, 0.06], ortho: 0.12, orthoRatio: 1.06 },
  // the hi-hat's top cymbal, clamped in its clutch: zeta from clip 3 (each swing about a fifth to a quarter of the last)
  hihat: { period: 0.34, zeta: 0.42, amp: [0.012, 0.075], ortho: 0.1, orthoRatio: 1.1 },
};
/** the fast wobble riding on the swing (clips 2 and 3): frequency ratio, share of the swing, damping */
export const WOBBLE = { ratio: 18, share: 0.07, zeta: 0.025 };
/** the shutter the wobble is averaged over (s): a 180 degree shutter at 24 fps */
const EXPOSURE = 1 / 48;
/** how long a hit still moves anything (s) */
const WINDOW = 4.5;
/** the stands' give: a share of their cymbal's tilt (clip 3: the clutch moved about 3.5% as far as the rim) */
const STAND_GIVE = 0.035;

/** a damped oscillator struck from rest: x(0) = 0, peak about A */
function ring(tau: number, w: number, zeta: number, phase = 0): number {
  if (tau < 0) return 0;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return Math.exp(-zeta * w * tau) * Math.sin(wd * tau + phase);
}

/** sin(x)/x */
const sinc = (x: number) => (Math.abs(x) < 1e-4 ? 1 : Math.sin(x) / x);

/** the hits of each piece, in time order, for quick look-up of the recent ones */
export class KitMotion {
  private by = new Map<DrumId, DrumHit[]>();
  private chokes = new Map<DrumId, number[]>();
  constructor(readonly perf: DrumPerformance) {
    for (const h of perf.hits) {
      const l = this.by.get(h.piece) ?? [];
      l.push(h);
      this.by.set(h.piece, l);
    }
    for (const c of perf.chokes) {
      const l = this.chokes.get(c.piece) ?? [];
      l.push(c.t);
      this.chokes.set(c.piece, l);
    }
  }

  /** the hits of a piece from t - window up to t */
  recent(piece: DrumId, t: number, window = WINDOW): DrumHit[] {
    const l = this.by.get(piece);
    if (!l?.length) return [];
    // last index with h.t <= t
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    const out: DrumHit[] = [];
    for (let i = lo - 1; i >= 0 && l[i].t >= t - window; i--) out.push(l[i]);
    return out;
  }

  /** the last hit of a piece at or before t, no more than `window` before it, or null (allocates nothing) */
  lastAtOrBefore(piece: DrumId, t: number, window: number): DrumHit | null {
    const l = this.by.get(piece);
    if (!l) return null;
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    const h = l[lo - 1];
    return h && h.t >= t - window ? h : null;
  }

  /** the next hit of a piece after t (strictly), or null */
  next(piece: DrumId, t: number): DrumHit | null {
    const l = this.by.get(piece);
    if (!l) return null;
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return l[lo] ?? null;
  }

  /** how much of a cymbal's motion from a hit at th survives a hand grabbing it (1 = no choke) */
  private choked(piece: DrumId, th: number, t: number): number {
    const l = this.chokes.get(piece);
    if (!l) return 1;
    for (const tc of l) if (tc >= th && tc <= t) return Math.exp(-(t - tc) / 0.06);
    return 1;
  }

  hihatClosed(t: number): number {
    return pedalAt(this.perf.hihat, t);
  }

  /** a cymbal's rocking at t: the sum of every recent hit's swing, wobble and precession */
  cymbal(id: CymbalId, t: number): Tilt & { drop: number } {
    const s = SWING[id];
    const w = (2 * Math.PI) / s.period;
    const ww = w * WOBBLE.ratio;
    // the wobble as the camera sees it: its average over the exposure
    const wobbleSeen = WOBBLE.share * sinc((ww * EXPOSURE) / 2);
    let x = 0;
    let z = 0;
    let drop = 0;
    const open = id === 'hihat' ? 1 - this.hihatClosed(t) : 1;
    for (const h of this.recent(id, t)) {
      if (h.zone === 'pedal') continue;
      const tau = t - h.t;
      // how far the hit tips it: velocity, and the torque arm (an edge hit more than the bell)
      let a = (s.amp[0] + (s.amp[1] - s.amp[0]) * Math.pow(h.velocity, 1.4)) * (0.15 + 0.85 * h.r);
      if (id === 'hihat') {
        // only an open top cymbal can rock (closed, the pair just gives a little with the stand)
        const openAtHit = 1 - this.hihatClosed(h.t);
        a *= 0.08 + 0.92 * smooth(0.04, 0.5, openAtHit);
      }
      a *= this.choked(id, h.t, t);
      // every hit settles a little differently (fixed per hit)
      const k = 1 + (hash01(h.i, 31) - 0.5) * 0.3;
      const main = a * k * ring(tau, w, s.zeta);
      const ortho = a * s.ortho * ring(tau, w * s.orthoRatio, s.zeta, (hash01(h.i, 32) - 0.5) * 1.2);
      const wob = a * wobbleSeen * ring(tau, ww, WOBBLE.zeta, hash01(h.i, 33) * 6.283);
      // struck at angle (from the drummer's side): that side goes down, about the axis across it
      const ca = Math.cos(h.angle);
      const sa = Math.sin(h.angle);
      // rotation vector u = y x d, d = (sin a, 0, cos a) -> (cos a, 0, -sin a); the other axis is d itself
      const m = main + wob;
      x += m * ca + ortho * sa;
      z += -m * sa + ortho * ca;
      // it sinks into its felt on the blow and comes back up
      drop += -0.0011 * h.velocity * Math.exp(-tau / 0.035) * (1 - Math.exp(-tau / 0.003));
    }
    if (id === 'hihat') {
      // closing stops the top cymbal against the bottom one
      const stop = 0.12 + 0.88 * smooth(0.0, 0.35, open);
      x *= stop;
      z *= stop;
    }
    const mag = Math.hypot(x, z);
    const MAX = 0.26;
    if (mag > MAX) {
      x *= MAX / mag;
      z *= MAX / mag;
    }
    return { x, z, drop };
  }

  /**
   * The beater (0 rest .. 1 on the head). Each stroke eases out of rest and
   * accelerates into the head (most of its travel in the second half),
   * reaching it exactly at the hit, dwells there for about a fifth of the
   * approach, then springs back, through rest by about 8% and settles. A
   * stroke that starts before the last has settled starts from where the
   * beater is.
   */
  beater(t: number): number {
    const next = this.next('kick', t);
    const last = this.lastAtOrBefore('kick', t, 1.5);
    if (next) {
      const ta = this.approach(next, last);
      if (t >= next.t - ta) {
        const from = last ? this.stroke(last, next.t - ta) : 0;
        const u = (t - (next.t - ta)) / ta;
        return from + (1 - from) * Math.pow(u, 2.2);
      }
    }
    return last ? this.stroke(last, t) : 0;
  }

  private approach(h: DrumHit, prev: DrumHit | null): number {
    const ta = 0.085 - 0.035 * h.velocity;
    return prev ? Math.max(0.02, Math.min(ta, (h.t - prev.t) * 0.6)) : ta;
  }

  /** a stroke's curve after its hit: dwell, rebound, settle */
  private stroke(h: DrumHit, t: number): number {
    const tau = t - h.t;
    if (tau < 0) return 0;
    const ta = 0.085 - 0.035 * h.velocity;
    const dwell = ta * 0.2;
    if (tau < dwell) return 1;
    // back through rest after tr, overshooting it by about 8% (more for a hard stroke), then still
    const tr = ta * (0.8 + 0.2 * hash01(h.i, 41));
    const w = Math.PI / (2 * tr);
    const over = 0.06 + 0.04 * h.velocity;
    const sigma = (-Math.log(over) * w) / Math.PI;
    const r = tau - dwell;
    return Math.exp(-sigma * r) * Math.cos(w * r);
  }

  /** a drum head's vibration envelope (for the shimmer), 0..1 */
  head(id: ShellId, t: number): number {
    const decay = { kick: 0.09, snare: 0.12, tom1: 0.25, tom2: 0.3, floorTom: 0.4 }[id];
    let e = 0;
    for (const h of this.recent(id, t, decay * 6)) {
      const tau = t - h.t;
      const z = h.zone === 'crossStick' ? 0.25 : h.zone === 'rim' ? 1.1 : 1;
      e += z * Math.pow(h.velocity, 1.3) * Math.exp(-tau / decay) * (1 - Math.exp(-tau / 0.004));
    }
    return Math.min(1, e);
  }

  /** the snare wires: buzzing with the snare, and in sympathy with the kick and the toms */
  buzz(t: number): number {
    let b = 0;
    const add = (id: DrumId, share: number, decay: number) => {
      for (const h of this.recent(id, t, decay * 6)) {
        const tau = t - h.t;
        if (h.zone === 'crossStick' && id === 'snare') share *= 0.3;
        b += share * h.velocity * Math.exp(-tau / decay) * (1 - Math.exp(-tau / 0.003));
      }
    };
    add('snare', 1, 0.16);
    add('kick', 0.22, 0.08);
    add('tom1', 0.18, 0.12);
    add('tom2', 0.18, 0.12);
    add('floorTom', 0.25, 0.15);
    return Math.min(1, b);
  }

  /** a tom rocking on its arm (the floor tom on its legs): struck near side down */
  tom(id: 'tom1' | 'tom2' | 'floorTom', t: number): Tilt {
    const floor = id === 'floorTom';
    const w = 2 * Math.PI * (floor ? 9 : 5);
    const zeta = floor ? 0.2 : 0.12;
    const amp = floor ? 0.0016 : 0.006;
    let x = 0;
    let z = 0;
    for (const h of this.recent(id, t, 2)) {
      const a = amp * h.velocity * (h.zone === 'rim' ? 1.3 : 1) * ring(t - h.t, w, zeta);
      x += a * Math.cos(h.angle);
      z += -a * Math.sin(h.angle);
    }
    // the rack toms sit on the kick: they tremble a little when it is struck
    if (!floor)
      for (const h of this.recent('kick', t, 1)) {
        const a = 0.0012 * h.velocity * ring(t - h.t, w * 1.3, 0.2, hash01(h.i, 51) * 3);
        x += a;
      }
    return { x, z };
  }

  evaluate(t: number): KitState {
    const closed = this.hihatClosed(t);
    const cymbals = { crash: this.cymbal('crash', t), ride: this.cymbal('ride', t), hihat: this.cymbal('hihat', t) };
    const give = (c: Tilt): Tilt => ({ x: c.x * STAND_GIVE, z: c.z * STAND_GIVE });
    return {
      t,
      cymbals,
      stands: { crash: give(cymbals.crash), ride: give(cymbals.ride), hihat: give({ x: cymbals.hihat.x * 0.5, z: cymbals.hihat.z * 0.5 }) },
      hihatClosed: closed,
      hihatGap: HIHAT_OPEN_GAP * (1 - closed),
      beater: this.beater(t),
      heads: { kick: this.head('kick', t), snare: this.head('snare', t), tom1: this.head('tom1', t), tom2: this.head('tom2', t), floorTom: this.head('floorTom', t) },
      buzz: this.buzz(t),
      toms: { tom1: this.tom('tom1', t), tom2: this.tom('tom2', t), floorTom: this.tom('floorTom', t) },
    };
  }

  /** a hash of the whole state at t (determinism checks) */
  stateHash(t: number): string {
    const s = this.evaluate(t);
    const nums: number[] = [s.hihatClosed, s.hihatGap, s.beater, s.buzz];
    for (const c of CYMBALS) nums.push(s.cymbals[c].x, s.cymbals[c].z, s.cymbals[c].drop, s.stands[c].x, s.stands[c].z);
    for (const d of SHELLS) nums.push(s.heads[d]);
    for (const k of ['tom1', 'tom2', 'floorTom'] as const) nums.push(s.toms[k].x, s.toms[k].z);
    let h = 2166136261 >>> 0;
    for (const n of nums) {
      const v = Math.round(n * 1e7);
      h = Math.imul(h ^ (v & 0xffff), 16777619) >>> 0;
      h = Math.imul(h ^ ((v >>> 16) & 0xffff), 16777619) >>> 0;
    }
    return h.toString(16);
  }
}

function smooth(a: number, b: number, x: number) {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** the shells that a hit's piece belongs to (for the drums' own reactions) */
export const isShell = (id: DrumId): id is ShellId => DRUMS[id].kind === 'drum';
