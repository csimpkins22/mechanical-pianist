// The cinematographer. Shots are composed from what the music is doing: the
// performance is analysed ahead of time into a slowly varying "region of
// interest" (where the hands are, how far apart, how busy), smoothed without
// regard to causality so the camera eases toward a register before the hands
// get there. A camera state is a pure function of (mode, t).
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
}

export const DEFAULT_FRAMING: Framing = { distance: 1, height: 0, angle: 0, focalScale: 1 };

const RATE = 30;

export class CinematicCamera {
  private center: Signal;
  private span: Signal;
  private rightX: Signal;
  private leftX: Signal;
  private activity: Signal;
  /** the right wrist's planned path, smoothed (x, y, z) */
  private rightWrist: Signal[];

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
  }

  evaluate(mode: CameraMode, t: number, f: Framing = DEFAULT_FRAMING): CameraState {
    const cx = this.center.at(t);
    const span = clamp(this.span.at(t), 0.15, 1.1);
    const breathe = (s: number, amp: number) => drift(t * 0.045 + s, 31 + s) * amp;
    if (mode === 'overhead') {
      // above the player's shoulder, looking down across both hands
      const target = new THREE.Vector3(cx + breathe(1, 0.008), 0.0, 0.0);
      const d = (0.74 + span * 0.78) * f.distance;
      const pos = new THREE.Vector3(cx + 0.06 + breathe(2, 0.015), 0.66 * d + f.height, 0.46 * d);
      pos.sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.angle).add(target);
      return { position: pos, target, focalLength: 38 * f.focalScale, fstop: 6, focus: pos.distanceTo(target), roll: 0 };
    }
    if (mode === 'macro') {
      // close and low at the right hand's fingertips: contact and mechanism
      const w = this.rightWrist.map((s) => s.at(t));
      const target = new THREE.Vector3(w[0] - 0.012 + breathe(3, 0.004), 0.014, w[2] - 0.13 + breathe(4, 0.004));
      const az = 1.05 + f.angle + breathe(5, 0.04);
      const dist = 0.46 * f.distance;
      const pos = new THREE.Vector3(target.x + Math.sin(az) * dist, 0.06 + f.height + breathe(6, 0.005), target.z + Math.cos(az) * dist);
      return { position: pos, target, focalLength: 75 * f.focalScale, fstop: 8, focus: pos.distanceTo(target), roll: -0.02 };
    }
    // cinematic: from beyond the treble end, low over the keys, looking
    // diagonally down the keyboard toward the bass
    const lookX = cx - 0.02 - span * 0.1;
    const target = new THREE.Vector3(lookX + breathe(6, 0.015), 0.012 + breathe(7, 0.004), -0.05);
    const az = 1.36 + f.angle + breathe(8, 0.035); // radians from +z toward +x
    const dist = (0.7 + span * 0.5) * f.distance;
    const pos = new THREE.Vector3(
      target.x + Math.sin(az) * dist,
      0.2 + span * 0.06 + f.height + breathe(9, 0.008),
      target.z + Math.cos(az) * dist,
    );
    // focus where the music is: the right hand's fingertips, mostly
    const xr = this.rightX.at(t);
    const fp = new THREE.Vector3(xr - 0.05, 0.0, -0.06);
    const focus = pos.distanceTo(fp);
    return { position: pos, target, focalLength: 66 * f.focalScale, fstop: 5, focus, roll: -0.012 };
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
