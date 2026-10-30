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
import { KeyMechanics } from './KeyMechanics';
import { RATE, planMotion, type HandTrack, type MotionPlan } from './MotionPlanner';

export interface FrameState {
  t: number;
  keys: Float32Array; // depression 0..1 per key (index = midi - 21)
  hands: Record<Hand, HandPose>;
  /** sustain pedal position 0..1 (eased) */
  pedal: number;
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

  constructor(readonly perf: Performance) {
    this.duration = perf.score.duration;
    this.byStart = perf.notes.slice().sort((a, b) => a.start - b.start);
    this.soundEnd = new Float64Array(this.byStart.length);
    let m = -Infinity;
    this.byStart.forEach((n, i) => {
      m = Math.max(m, this.releaseOf(n));
      this.soundEnd[i] = m;
    });
    this.keys = new KeyMechanics(perf.notes);
    this.plan = planMotion(perf);
    // Plan, check every held key against the hand that holds it, and where the
    // hand must leave before the notated release, let that key come up as it
    // goes (the sound still lasts the full note); then plan again.
    for (let round = 0; round < 4; round++) {
      for (const hand of ['L', 'R'] as Hand[]) this.refine(this.plan.hands[hand]);
      if (round === 3 || !this.releaseUnheldKeys()) break;
      this.keys = new KeyMechanics(perf.notes);
      this.plan = planMotion(perf);
    }
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
          const st = poseHand(track, this.keys, t).states[pn.finger];
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

  /** when a note stops sounding: at key release, or when the pedal lifts after it */
  releaseOf(n: PerformanceNote): number {
    const ped = this.perf.score.pedal;
    if (!pedalDownAt(ped, n.end)) return n.end;
    const i = lastAtOrBefore(ped, n.end, (e) => e.time);
    for (let j = i + 1; j < ped.length; j++) if (!ped[j].down) return Math.max(n.end, ped[j].time);
    return this.perf.score.duration;
  }

  /**
   * Make sure every finger can actually reach its key: evaluate the IK at each
   * note's onset and middle, and where a fingertip would fall short, move the
   * wrist toward it with a smooth local correction. Two passes.
   */
  private refine(track: HandTrack) {
    for (let pass = 0; pass < 3; pass++) {
      const n = track.x.data.length;
      const cx = new Float32Array(n);
      const cy = new Float32Array(n);
      const cz = new Float32Array(n);
      const cw = new Float32Array(n);
      let worst = 0;
      for (const pn of track.notes) {
        const times = [pn.stroke.contact, pn.note.start, (pn.note.start + pn.stroke.release) / 2, pn.stroke.release];
        let corr: V3 = [0, 0, 0];
        let e = 0;
        for (const t of times) {
          const pose = poseHand(track, this.keys, t);
          const st = pose.states[pn.finger];
          if (st.note !== pn) continue;
          const d = sub(st.target, st.tip);
          const dl = len(d);
          e = Math.max(e, dl);
          if (dl > len(corr)) corr = d;
        }
        this.contactError.set(pn.note.id, e);
        worst = Math.max(worst, e);
        if (e < 0.0008) continue;
        // spread the correction over the note, peaking while it is held
        const a = Math.max(0, Math.floor((pn.stroke.contact - 0.12 - this.plan.t0) * RATE));
        const b = Math.min(n - 1, Math.ceil((pn.stroke.release + 0.12 - this.plan.t0) * RATE));
        const c = scale(corr, 1.0);
        for (let k = a; k <= b; k++) {
          cx[k] += c[0];
          cy[k] += c[1];
          cz[k] += c[2];
          cw[k] += 1;
        }
      }
      if (pass === 2 || worst < 0.0008) break;
      const avg = (arr: Float32Array) => {
        const o = new Float32Array(n);
        for (let k = 0; k < n; k++) o[k] = cw[k] > 0 ? arr[k] / cw[k] : 0;
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
    return {
      t,
      keys,
      hands: { L: poseHand(this.plan.hands.L, this.keys, t), R: poseHand(this.plan.hands.R, this.keys, t) },
      pedal: this.pedalAt(t),
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
