// The master timeline: everything physical at an absolute time t.
//
// evaluate(t) is a pure function. It reads only data computed once when the
// performance is planned, so visiting times in any order (scrubbing back,
// jumping, stepping) always gives the same keys, hands and fingers for the
// same t. No state is carried from frame to frame.
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { add, scale, sub, len, type V3 } from '../core/handGeometry';
import { clamp, gaussianBlur, lastAtOrBefore } from '../core/math';
import { pedalDownAt } from '../interpretation/MidiEngine';
import type { Hand, Performance, PerformanceNote } from '../core/types';
import { poseHand, type HandPose } from './HandPoser';

/** spacing of the moments refine checks through a held note (s) */
const HOLD_PROBE = 0.2;
import { KeyMechanics, restrikeRepeats } from './KeyMechanics';
import { dampersAt, hammersAt } from './ActionMechanics';
import { StringMechanics } from './StringMechanics';
import { handOverlap, liftToClear } from './HandCollision';
import { RATE, leaveInTime, planMotion, type HandTrack, type MotionPlan } from './MotionPlanner';

const STRINGS = new WeakMap<KeyMechanics, StringMechanics>();

export interface FrameState {
  t: number;
  keys: Float32Array; // depression 0..1 per key (index = midi - 21)
  hands: Record<Hand, HandPose>;
  /** sustain pedal position 0..1 (eased) */
  pedal: number;
  /** inside the piano, per key: hammer 0 (rest) .. 1 (at the string), damper 0 (on) .. 1 (off) */
  hammers: Float32Array;
  dampers: Float32Array;
  /** per key, the swing of its strings (m, peak at mid-span): [2i] toward the soundboard, [2i+1] across */
  strings: Float32Array;
  /** per hand, per finger (1..5): how hard and how recently it struck, 0..1 (lights the servo rings) */
  effort: Record<Hand, number[]>;
  /** notes whose keys are down or still sounding (pedal) */
  sounding: PerformanceNote[];
}

export class PerformanceTimeline {
  keys: KeyMechanics;
  plan: MotionPlan;
  readonly duration: number;
  /** notes sorted by start, and the running maximum of end times, for fast "what sounds now" queries */
  private byStart: PerformanceNote[];
  private soundEnd: Float64Array;
  /** worst fingertip contact error per note after refinement (m), for diagnostics */
  readonly contactError = new Map<number, number>();
  /** onset of the next note on the same key, which cuts the earlier one's sound */
  private restrike = new Map<number, number>();

  constructor(
    readonly perf: Performance,
    progress?: (fraction: number) => void,
  ) {
    this.duration = perf.score.duration;
    // let go of keys in time to strike them again, and in time to leap
    restrikeRepeats(perf.notes);
    leaveInTime(perf);
    const lastOnKey = new Map<number, PerformanceNote>();
    for (const n of perf.notes.slice().sort((a, b) => a.start - b.start)) {
      const p = lastOnKey.get(n.midi);
      if (p && n.start > p.start) this.restrike.set(p.id, n.start);
      lastOnKey.set(n.midi, n);
    }
    this.byStart = perf.notes.slice().sort((a, b) => a.start - b.start);
    this.soundEnd = new Float64Array(this.byStart.length);
    let m = -Infinity;
    this.byStart.forEach((n, i) => {
      m = Math.max(m, this.releaseOf(n));
      this.soundEnd[i] = m;
    });
    this.keys = new KeyMechanics(perf.notes);
    this.plan = planMotion(perf);
    this.clearHands();
    // Plan, check every held key against the hand that holds it, and where the
    // hand must leave before the notated release, let that key come up as it
    // goes (the sound still lasts the full note); then plan again.
    // (Progress assumes two rounds, which is what most pieces take.)
    progress?.(0.05);
    for (let round = 0; round < 4; round++) {
      for (const hand of ['L', 'R'] as Hand[])
        this.refine(this.plan.hands[hand], progress && ((u) => progress(Math.min(0.98, 0.05 + 0.47 * (round + (hand === 'L' ? 0 : 0.5) + 0.5 * u)))));
      if (round === 3 || !this.releaseUnheldKeys()) break;
      this.keys = new KeyMechanics(perf.notes);
      this.plan = planMotion(perf);
      this.clearHands();
    }
    // the contact corrections can pull a lifted hand back into the other:
    // alternate the two so they settle on a pose that keeps both
    for (let i = 0; i < 1; i++) {
      if (!this.clearHands()) break;
      for (const hand of ['L', 'R'] as Hand[]) this.refine(this.plan.hands[hand]);
    }
  }

  /**
   * Keep the hands out of each other. Where, posed, they would pass through
   * one another (HandCollision; in practice a thumb against the other thumb,
   * index finger or palm when the hands play close together and a tucked
   * thumb is not enough), one hand rides over the other: the one already a
   * little higher where they meet. It rises by the height it needs to clear
   * by a few millimetres (side by side, more than their overlap) and moves a
   * little further in toward the fallboard, easing in a little before and out
   * after. Up to three passes, since a lifted hand can bring another part close.
   */
  private clearHands(): boolean {
    const { L, R } = this.plan.hands;
    const n = L.y.data.length;
    const t0 = L.y.t0;
    const step = Math.round(RATE / 30);
    let moved = false;
    // only where the wrists come within reach of each other (the thumbs meet below about 16 cm)
    let todo: number[] = [];
    for (let k = 0; k < n; k += step) if (Math.abs(L.x.data[k] - R.x.data[k]) < 0.19) todo.push(k);
    for (let pass = 0; pass < 3 && todo.length; pass++) {
      const lift = { L: new Float32Array(n), R: new Float32Array(n) };
      let any = false;
      const hits: number[] = [];
      for (const k of todo) {
        const t = t0 + k / RATE;
        const pl = poseHand(L, this.keys, t, false);
        const pr = poseHand(R, this.keys, t, false);
        const o = handOverlap(pl, pr);
        if (o.depth < -0.003) continue;
        const up: Hand = o.pa[1] > o.pb[1] ? 'L' : 'R';
        const need = Math.min(0.045, liftToClear(o, up === 'L', 0.004));
        if (need <= 0) continue;
        for (let j = Math.max(0, k - step); j <= Math.min(n - 1, k + step); j++) lift[up][j] = Math.max(lift[up][j], need);
        hits.push(k);
        any = true;
      }
      // the next pass looks again only around what was found
      const near = new Set<number>();
      const w = Math.round(0.3 * RATE);
      for (const k of hits) for (let j = Math.max(0, k - w); j <= Math.min(n - 1, k + w); j += step) near.add(j - (j % step));
      todo = [...near].sort((a, b) => a - b);
      if (!any) break;
      moved = true;
      const hold = Math.round(0.12 * RATE);
      for (const h of ['L', 'R'] as Hand[]) {
        const a = lift[h];
        const held = new Float32Array(n);
        for (let k = 0; k < n; k++) {
          if (!a[k]) continue;
          for (let j = Math.max(0, k - hold); j <= Math.min(n - 1, k + hold); j++) held[j] = Math.max(held[j], a[k]);
        }
        const s = gaussianBlur(held, 0.06 * RATE);
        const y = this.plan.hands[h].y.data as Float32Array;
        // the upper hand also plays a little further in on the keys, as a pianist's does: its thumb passes behind the other's
        const z = this.plan.hands[h].z.data as Float32Array;
        for (let k = 0; k < n; k++) {
          y[k] += s[k];
          z[k] -= Math.min(0.015, 0.4 * s[k]);
        }
      }
    }
    return moved;
  }

  /** shorten key holds the hand cannot keep; returns whether anything changed */
  private releaseUnheldKeys(): boolean {
    let changed = false;
    for (const hand of ['L', 'R'] as Hand[]) {
      const track = this.plan.hands[hand];
      for (const pn of track.notes) {
        const n = pn.note;
        if (n.keyEnd - n.start < 0.12) continue;
        let bad = -1;
        const lost = (t: number) => {
          const st = poseHand(track, this.keys, t, false).states[pn.finger];
          return st.note === pn && len(sub(st.tip, st.target)) > 0.0015;
        };
        // most holds are fine: check a few instants first, scan only when one fails
        const probes = [n.start + 0.06, (n.start + n.keyEnd) / 2, n.keyEnd];
        if (probes.some(lost)) {
          const times: number[] = [];
          for (let t = n.start + 0.06; t < n.keyEnd; t += 1 / 30) times.push(t);
          times.push(n.keyEnd);
          for (const t of times) {
            if (lost(t)) {
              bad = t;
              break;
            }
          }
        }
        if (bad < 0) continue;
        if (bad < n.start + Math.max(0.25, 0.35 * (n.keyEnd - n.start))) {
          // lost from the start: shortening would not honestly help; report it
          if (!n.flags.includes('unreachable')) n.flags.push('unreachable');
          continue;
        }
        const keyEnd = Math.max(n.start + 0.05, bad - 0.05);
        if (keyEnd < n.keyEnd - 0.005) {
          n.keyEnd = keyEnd;
          if (!n.flags.includes('early-release')) n.flags.push('early-release');
          changed = true;
        }
      }
    }
    return changed;
  }

  /** when a note stops sounding: at key release, or when the pedal lifts after it, and at the latest when its key is struck again */
  releaseOf(n: PerformanceNote): number {
    return Math.min(this.restrike.get(n.id) ?? Infinity, this.dampedAt(n));
  }

  private dampedAt(n: PerformanceNote): number {
    const ped = this.perf.score.pedal;
    if (!pedalDownAt(ped, n.end)) return n.end;
    const i = lastAtOrBefore(ped, n.end, (e) => e.time);
    for (let j = i + 1; j < ped.length; j++) if (!ped[j].down) return Math.max(n.end, ped[j].time);
    return this.perf.score.duration;
  }

  /**
   * Make sure every finger can actually reach its key: evaluate the pose at
   * each note's landing, onset, through its hold and at its release, and
   * wherever a fingertip would fall short, or the hand had to give way to keep
   * contact (the compliance in poseHand), move the planned wrist there with a
   * smooth local correction, so that the hand is carried by the plan rather
   * than snapping back when the contact lets go. Up to three passes.
   */
  private refine(track: HandTrack, progress?: (fraction: number) => void) {
    for (let pass = 0; pass < 3; pass++) {
      const n = track.x.data.length;
      const cx = new Float32Array(n);
      const cy = new Float32Array(n);
      const cz = new Float32Array(n);
      const cw = new Float32Array(n);
      let worst = 0;
      // the notes of a chord share their moments through the hold
      const poses = new Map<number, HandPose>();
      const poseAt = (t: number) => {
        let p = poses.get(t);
        if (!p) poses.set(t, (p = poseHand(track, this.keys, t, false)));
        return p;
      };
      let done = 0;
      for (const pn of track.notes) {
        if (progress && ++done % 64 === 0) progress((pass + done / track.notes.length) / 3);
        // the landing, the onset, every 0.2 s of the hold (on a common grid),
        // the release, and once while the fingertip rides the key back up
        const rel = pn.stroke.release;
        const times = [pn.stroke.contact, pn.note.start];
        if (pass < 2) for (let i = Math.ceil((pn.note.start + 0.1) / HOLD_PROBE); i * HOLD_PROBE < rel - 0.05; i++) times.push(i * HOLD_PROBE);
        else times.push((pn.note.start + rel) / 2); // the last pass only measures
        times.push(rel);
        if (pn.leave - rel > 0.02) times.push((rel + pn.leave) / 2);
        let e = 0;
        for (const t of times) {
          const pose = poseAt(t);
          const st = pose.states[pn.finger];
          if (st.note !== pn) continue;
          const miss = sub(st.target, st.tip);
          const riding = t > rel;
          if (!riding) e = Math.max(e, len(miss));
          // where the fingertip falls short, and where the hand had to give
          // way to keep it on the key (a riding finger does not pull the plan)
          const g = add(riding ? [0, 0, 0] : miss, sub(pose.wrist, [track.x.at(t), track.y.at(t), track.z.at(t)]));
          const gl = len(g);
          worst = Math.max(worst, gl);
          if (gl < 0.0008) continue;
          // a local correction around this moment
          const a = Math.max(0, Math.floor((t - 0.24 - this.plan.t0) * RATE));
          const b = Math.min(n - 1, Math.ceil((t + 0.24 - this.plan.t0) * RATE));
          for (let k = a; k <= b; k++) {
            const u = (this.plan.t0 + k / RATE - t) / 0.08;
            const w = Math.exp(-0.5 * u * u);
            cx[k] += g[0] * w;
            cy[k] += g[1] * w;
            cz[k] += g[2] * w;
            cw[k] += w;
          }
        }
        this.contactError.set(pn.note.id, e);
      }
      if (pass === 2 || worst < 0.0008) break;
      const avg = (arr: Float32Array) => {
        const o = new Float32Array(n);
        for (let k = 0; k < n; k++) o[k] = cw[k] > 0 ? arr[k] / Math.max(1, cw[k]) : 0;
        return gaussianBlur(o, 0.05 * RATE);
      };
      const ax = avg(cx);
      const ay = avg(cy);
      const az = avg(cz);
      const X = track.x.data as Float32Array;
      const Y = track.y.data as Float32Array;
      const Z = track.z.data as Float32Array;
      for (let k = 0; k < n; k++) {
        X[k] += clamp(ax[k], -0.03, 0.03);
        Y[k] += clamp(ay[k], -0.03, 0.03);
        Z[k] += clamp(az[k], -0.03, 0.03);
      }
    }
  }

  /** each finger's last strikes, by velocity, fading over a quarter of a second */
  effort(hand: Hand, t: number): number[] {
    const out = [0, 0, 0, 0, 0, 0];
    const fingers = this.plan.hands[hand].fingers;
    for (let f = 1; f <= 5; f++) {
      const list = fingers[f];
      const i = lastAtOrBefore(list, t, (pn) => pn.stroke.bottom);
      for (let k = i; k >= 0 && k > i - 3; k--) {
        const dt = t - list[k].stroke.bottom;
        if (dt > 1) break;
        out[f] = Math.max(out[f], list[k].note.velocity * Math.exp(-dt / 0.25));
      }
    }
    return out;
  }

  /** the strings' swing, built on first use for the final key strokes (and kept out of the plan's data) */
  stringMechanics(): StringMechanics {
    let s = STRINGS.get(this.keys);
    if (!s) STRINGS.set(this.keys, (s = new StringMechanics(this.keys.strokes, this.perf.score.pedal)));
    return s;
  }

  pedalAt(t: number): number {
    // the foot takes ~60 ms to press or lift the pedal
    const ped = this.perf.score.pedal;
    const i = lastAtOrBefore(ped, t, (e) => e.time);
    if (i < 0) return 0;
    const e = ped[i];
    const u = clamp((t - e.time) / 0.06, 0, 1);
    const from = i > 0 ? (ped[i - 1].down ? 1 : 0) : 0;
    return from + ((e.down ? 1 : 0) - from) * u;
  }

  sounding(t: number): PerformanceNote[] {
    const out: PerformanceNote[] = [];
    const last = lastAtOrBefore(this.byStart, t, (n) => n.start);
    for (let i = last; i >= 0; i--) {
      if (this.soundEnd[i] < t) break;
      const n = this.byStart[i];
      if (this.releaseOf(n) >= t) out.push(n);
    }
    return out;
  }

  evaluate(t: number): FrameState {
    const keys = this.keys.evaluate(t, new Float32Array(KEY_COUNT));
    const pedal = this.pedalAt(t);
    return {
      t,
      keys,
      hands: { L: poseHand(this.plan.hands.L, this.keys, t), R: poseHand(this.plan.hands.R, this.keys, t) },
      pedal,
      hammers: hammersAt(this.keys.strokes, t),
      dampers: dampersAt(keys, pedal),
      strings: this.stringMechanics().evaluate(t),
      effort: { L: this.effort('L', t), R: this.effort('R', t) },
      sounding: this.sounding(t),
    };
  }

  /** A stable fingerprint of the full state at t (keys, every joint), for determinism tests. */
  stateHash(t: number): string {
    const s = this.evaluate(t);
    let h = 2166136261 >>> 0;
    const mix = (v: number) => {
      const q = Math.round(v * 1e6) | 0;
      h = Math.imul(h ^ q, 16777619) >>> 0;
    };
    s.keys.forEach(mix);
    s.hammers.forEach(mix);
    for (const hand of ['L', 'R'] as Hand[]) {
      const p = s.hands[hand];
      p.wrist.forEach(mix);
      p.rot.forEach(mix);
      p.forearm.forEach(mix);
      for (const f of p.fingers) {
        mix(f.abduction);
        f.angles.forEach(mix);
      }
      mix(p.thumb.swing);
      p.thumb.angles.forEach(mix);
    }
    mix(s.pedal);
    return h.toString(16);
  }

  noteKeyIndex(n: PerformanceNote) {
    return n.midi - LOWEST_MIDI;
  }
}

export { add };
