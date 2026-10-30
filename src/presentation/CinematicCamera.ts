// The cinematographer. Shots are composed from what the music is doing: the
// performance is analysed ahead of time into a slowly varying "region of
// interest" (where the hands are, how far apart, how busy), smoothed without
// regard to causality so the camera eases toward a register before the hands
// get there. "Camera drama" adds what a camera operator would: slow push-ins
// toward the peaks of a phrase, focus racked to whichever hand leads, and
// longer lenses from further back. A camera state is a pure function of
// (mode, t), because every curve it reads is computed once, ahead of time.
import * as THREE from 'three';
import { clamp, gaussianBlur, Signal } from '../core/math';
import { drift } from '../core/random';
import type { MotionPlan } from '../performance/MotionPlanner';

export type CameraMode = 'cinematic' | 'overhead' | 'macro';

export interface CameraState {
  position: THREE.Vector3;
  target: THREE.Vector3;
  focalLength: number; // mm, 36 mm sensor
  fstop: number;
  focus: number; // metres from the camera
  roll: number;
}

export interface Framing {
  /** user nudges from the advanced panel */
  distance: number; // multiplier
  height: number; // metres
  angle: number; // radians around the hands
  focalScale: number;
  /** push-ins at phrase peaks, rack focus between the hands, longer lenses */
  dramaOn: boolean;
  drama: number; // 0..1
}

export const DEFAULT_FRAMING: Framing = { distance: 1, height: 0, angle: 0, focalScale: 1, dramaOn: true, drama: 0.6 };

const RATE = 30;

export class CinematicCamera {
  private center: Signal;
  private span: Signal;
  private rightX: Signal;
  private leftX: Signal;
  private activity: Signal;
  /** the right wrist's planned path, smoothed (x, y, z) */
  private rightWrist: Signal[];
  /** 0..1: how close the music is to the peak of a phrase (slow) */
  private peak: Signal;
  /** 0 = the left hand leads, 1 = the right */
  private lead: Signal;

  constructor(plan: MotionPlan, duration: number) {
    const t0 = -1;
    const n = Math.ceil((duration + 2) * RATE) + 1;
    const c = new Float32Array(n);
    const sp = new Float32Array(n);
    const rx = new Float32Array(n);
    const lx = new Float32Array(n);
    const act = new Float32Array(n);
    const L = plan.hands.L;
    const R = plan.hands.R;
    // activity per hand: how many notes are engaged around t
    const busy = (notes: typeof L.notes, t: number) => {
      let a = 0;
      for (const pn of notes) if (pn.note.start - 0.6 < t && pn.note.keyEnd + 0.4 > t) a += 1;
      return Math.min(1, a / 2);
    };
    let iL = 0;
    let iR = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / RATE;
      // the hand currently heard matters more
      while (iL < L.notes.length && L.notes[iL].note.keyEnd < t - 2) iL++;
      while (iR < R.notes.length && R.notes[iR].note.keyEnd < t - 2) iR++;
      const aL = 0.35 + busy(L.notes.slice(iL, iL + 40), t);
      const aR = 0.5 + busy(R.notes.slice(iR, iR + 40), t);
      const xl = L.x.at(t);
      const xr = R.x.at(t);
      c[i] = (xl * aL + xr * aR) / (aL + aR);
      sp[i] = Math.abs(xr - xl);
      rx[i] = xr;
      lx[i] = xl;
      act[i] = (aL + aR) / 3;
    }
    // heavy, zero-phase smoothing: anticipation and calm
    this.center = new Signal(t0, RATE, gaussianBlur(c, 1.6 * RATE));
    this.span = new Signal(t0, RATE, gaussianBlur(sp, 1.6 * RATE));
    this.rightX = new Signal(t0, RATE, gaussianBlur(rx, 0.9 * RATE));
    this.leftX = new Signal(t0, RATE, gaussianBlur(lx, 0.9 * RATE));
    this.activity = new Signal(t0, RATE, gaussianBlur(act, 2 * RATE));
    const wr = (sig: Signal) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = sig.at(t0 + i / RATE);
      return new Signal(t0, RATE, gaussianBlur(a, 0.5 * RATE));
    };
    this.rightWrist = [wr(R.x), wr(R.y), wr(R.z)];

    // phrase peaks: attack density weighted by loudness, smoothed over a
    // phrase, normalised to the piece's loud moments
    const loud = new Float32Array(n);
    const handAct = [new Float32Array(n), new Float32Array(n)];
    [L, R].forEach((track, hi) => {
      for (const pn of track.notes) {
        const v = pn.note.velocity;
        const i0 = Math.max(0, Math.floor((pn.note.start - t0 - 1.5) * RATE));
        const i1 = Math.min(n - 1, Math.ceil((pn.note.start - t0 + 1.5) * RATE));
        for (let i = i0; i <= i1; i++) {
          const d = (t0 + i / RATE - pn.note.start) / 0.5;
          const w = Math.exp(-d * d);
          loud[i] += v * v * w;
          handAct[hi][i] += (0.3 + v) * w;
        }
      }
    });
    const ls = gaussianBlur(loud, 2.2 * RATE);
    const sorted = Array.from(ls).sort((a, b) => a - b);
    const ref = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.95)]);
    const pk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = clamp((ls[i] / ref - 0.55) / 0.45, 0, 1);
      pk[i] = u * u * (3 - 2 * u);
    }
    this.peak = new Signal(t0, RATE, gaussianBlur(pk, 1.4 * RATE));
    // which hand leads: decisive (a rack, not a drift), then eased over ~1 s
    const aL = gaussianBlur(handAct[0], 0.6 * RATE);
    const aR = gaussianBlur(handAct[1], 0.6 * RATE);
    const ld = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const raw = (aR[i] - aL[i]) / (aR[i] + aL[i] + 0.25);
      const u = clamp((raw + 0.2) / 0.4, 0, 1);
      ld[i] = u * u * (3 - 2 * u);
    }
    this.lead = new Signal(t0, RATE, gaussianBlur(ld, 0.35 * RATE));
  }

  evaluate(mode: CameraMode, t: number, f: Framing = DEFAULT_FRAMING): CameraState {
    const cx = this.center.at(t);
    const k = f.dramaOn ? clamp(f.drama, 0, 1) : 0;
    const peak = this.peak.at(t) * k;
    // longer lenses, from proportionally further back; pushed in at the peaks
    const lens = (amount: number) => 1 + amount * k;
    const push = (amount: number) => 1 - amount * peak;
    const span = clamp(this.span.at(t), 0.15, 1.1);
    const breathe = (s: number, amp: number) => drift(t * 0.045 + s, 31 + s) * amp;
    if (mode === 'overhead') {
      // above the player's shoulder, looking down across both hands
      const target = new THREE.Vector3(cx + breathe(1, 0.008), 0.0, 0.0);
      const d = (0.74 + span * 0.78) * f.distance * lens(0.3) * push(0.15);
      const pos = new THREE.Vector3(cx + 0.06 + breathe(2, 0.015), 0.66 * d + f.height, 0.46 * d);
      pos.sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.angle).add(target);
      return { position: pos, target, focalLength: 38 * f.focalScale * lens(0.3) * (1 + 0.05 * peak), fstop: 6 / lens(0.4), focus: this.rackFocus(pos, t, k, pos.distanceTo(target)), roll: 0 };
    }
    if (mode === 'macro') {
      // close and low at the right hand's fingertips: contact and mechanism
      const w = this.rightWrist.map((s) => s.at(t));
      const target = new THREE.Vector3(w[0] - 0.012 + breathe(3, 0.004), 0.014, w[2] - 0.13 + breathe(4, 0.004));
      const az = 1.05 + f.angle + breathe(5, 0.04);
      const dist = 0.46 * f.distance * lens(0.25) * push(0.12);
      const pos = new THREE.Vector3(target.x + Math.sin(az) * dist, 0.06 + f.height + breathe(6, 0.005), target.z + Math.cos(az) * dist);
      return { position: pos, target, focalLength: 75 * f.focalScale * lens(0.25), fstop: 8, focus: pos.distanceTo(target), roll: -0.02 };
    }
    // cinematic: from beyond the treble end, low over the keys, looking
    // diagonally down the keyboard toward the bass
    const lookX = cx - 0.02 - span * 0.1;
    const target = new THREE.Vector3(lookX + breathe(6, 0.015), 0.012 + breathe(7, 0.004), -0.05);
    const az = 1.36 + f.angle + breathe(8, 0.035); // radians from +z toward +x
    const dist = (0.7 + span * 0.5) * f.distance * lens(0.5) * push(0.22);
    const pos = new THREE.Vector3(
      target.x + Math.sin(az) * dist,
      0.2 + span * 0.06 + f.height + breathe(9, 0.008),
      target.z + Math.cos(az) * dist,
    );
    // focus where the music is: the right hand's fingertips, mostly
    const xr = this.rightX.at(t);
    const fp = new THREE.Vector3(xr - 0.05, 0.0, -0.06);
    const focus = this.rackFocus(pos, t, k, pos.distanceTo(fp));
    return { position: pos, target, focalLength: 66 * f.focalScale * lens(0.5) * (1 + 0.08 * peak), fstop: 5 / lens(0.5), focus, roll: -0.012 };
  }

  /** focus distance racked toward whichever hand leads, by `k` (0 = the given focus) */
  private rackFocus(pos: THREE.Vector3, t: number, k: number, base: number): number {
    if (k <= 0) return base;
    const w = this.lead.at(t);
    const right = pos.distanceTo(new THREE.Vector3(this.rightX.at(t) - 0.05, 0.0, -0.06));
    const left = pos.distanceTo(new THREE.Vector3(this.leftX.at(t) + 0.05, 0.0, -0.06));
    const racked = left + (right - left) * w;
    return base + (racked - base) * Math.min(1, k * 1.6);
  }

  /** for the debug overlay */
  regionAt(t: number) {
    return { center: this.center.at(t), span: this.span.at(t), activity: this.activity.at(t), left: this.leftX.at(t), right: this.rightX.at(t) };
  }
}

export function blendCamera(a: CameraState, b: CameraState, u: number): CameraState {
  const e = u * u * (3 - 2 * u);
  return {
    position: a.position.clone().lerp(b.position, e),
    target: a.target.clone().lerp(b.target, e),
    focalLength: a.focalLength + (b.focalLength - a.focalLength) * e,
    fstop: a.fstop + (b.fstop - a.fstop) * e,
    focus: a.focus + (b.focus - a.focus) * e,
    roll: a.roll + (b.roll - a.roll) * e,
  };
}
