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
import { ELBOW_Z, SHOULDER_X, type HandTrack, type MotionPlan } from '../performance/MotionPlanner';
import { HAND_SPEC } from '../core/handGeometry';
import type { Hand } from '../core/types';
import { ShotDirector } from './ShotDirector';

/**
 * cinematic: the director, cutting between designed shots (ShotDirector.ts)
 * follow: one continuous camera from the treble end, following the music
 * overhead, macro: as named
 */
export type CameraMode = 'cinematic' | 'follow' | 'overhead' | 'macro';

/** average offset from a planned wrist to the centre of fingertips 2-4 (measured on the demos) */
const TIP_OFFSET: Record<Hand, [number, number, number]> = { R: [-0.007, -0.047, -0.153], L: [-0.009, -0.042, -0.153] };

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
  /** each wrist's planned path, smoothed (x, y, z) */
  private rightWrist: Signal[];
  private leftWrist: Signal[];
  readonly director: ShotDirector;
  private tracks: Record<Hand, HandTrack>;
  /** 0..1: how close the music is to the peak of a phrase (slow) */
  private peak: Signal;
  /** 0 = the left hand leads, 1 = the right */
  private lead: Signal;

  constructor(plan: MotionPlan, duration: number, tempos: { time: number; bpm: number }[] = []) {
    const t0 = -1;
    const n = Math.ceil((duration + 2) * RATE) + 1;
    const c = new Float32Array(n);
    const sp = new Float32Array(n);
    const rx = new Float32Array(n);
    const lx = new Float32Array(n);
    const act = new Float32Array(n);
    const L = plan.hands.L;
    const R = plan.hands.R;
    this.tracks = { L, R };
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
    this.leftWrist = [wr(L.x), wr(L.y), wr(L.z)];

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
    // which hand leads: a focus puller commits to one hand and racks to the
    // other only when it clearly takes over, holding each choice a while;
    // the rack itself takes about half a second
    const aL = gaussianBlur(handAct[0], 0.6 * RATE);
    const aR = gaussianBlur(handAct[1], 0.6 * RATE);
    const ld = new Float32Array(n);
    let cur = 1;
    let since = 0;
    for (let i = 0; i < n; i++) {
      const raw = (aR[i] - aL[i]) / (aR[i] + aL[i] + 0.25);
      since++;
      const other = cur === 1 ? raw < -0.18 : raw > 0.18;
      if (other && since > 2.5 * RATE) {
        cur = 1 - cur;
        since = 0;
      }
      ld[i] = cur;
    }
    this.lead = new Signal(t0, RATE, gaussianBlur(ld, 0.18 * RATE));

    const notes = (['L', 'R'] as Hand[]).flatMap((h) =>
      plan.hands[h].notes.map((pn) => ({ hand: h, midi: pn.note.midi, start: pn.note.start, end: pn.note.keyEnd, velocity: pn.note.velocity })),
    );
    this.director = new ShotDirector(
      {
        duration,
        center: (t) => this.center.at(t),
        span: (t) => this.span.at(t),
        tip: (h, t) => this.tip(h, t),
        wrist: (h, t) => this.wrist(h, t),
        peak: (t) => this.peak.at(t),
        lead: (t) => this.lead.at(t),
      },
      notes,
      tempos,
    );
  }

  wrist(h: Hand, t: number): THREE.Vector3 {
    const w = h === 'R' ? this.rightWrist : this.leftWrist;
    return new THREE.Vector3(w[0].at(t), w[1].at(t), w[2].at(t));
  }

  /** the centre of a hand's fingertips, where the music happens */
  tip(h: Hand, t: number): THREE.Vector3 {
    const o = TIP_OFFSET[h];
    return this.wrist(h, t).add(new THREE.Vector3(o[0], o[1], o[2]));
  }

  evaluate(mode: CameraMode, t: number, f: Framing = DEFAULT_FRAMING, aspect = 16 / 9): CameraState {
    return this.guard(this.compose(mode, t, f), t, aspect);
  }

  /** where each robot forearm ends (the arms are only forearms: their ends must never be seen) */
  armEnds(t: number): THREE.Vector3[] {
    return (['L', 'R'] as Hand[]).map((h) => {
      const tr = this.tracks[h];
      const w = new THREE.Vector3(tr.x.at(t), tr.y.at(t), tr.z.at(t));
      // as HandPoser aims the forearm: back toward an elbow that trails the hand
      const ex = tr.sx * SHOULDER_X + 0.5 * (w.x - tr.sx * SHOULDER_X);
      const dir = new THREE.Vector3(ex - w.x, 0.02, ELBOW_Z - w.z).normalize();
      return w.addScaledVector(dir, HAND_SPEC.forearm.length);
    });
  }

  /**
   * Keep both forearm ends out of the picture on a screen of this aspect
   * (width / height). The frame's half-slopes follow three.js with a 36 mm
   * film gauge: 18 mm / focal length across the longer side. If an end (with
   * a margin for its radius) could show, tighten the lens until it cannot; if
   * that would take more than a modest zoom, turn the camera away from it.
   */
  guard(s: CameraState, t: number, aspect = 16 / 9): CameraState {
    const cx = Math.min(aspect, 1); // horizontal half-slope = 18 cx / f
    const cy = 1 / Math.max(aspect, 1); // vertical half-slope = 18 cy / f
    const ends = this.armEnds(t);
    const R = 0.07;
    const basis = () => {
      const fw = s.target.clone().sub(s.position).normalize();
      const upRef = new THREE.Vector3(Math.sin(s.roll), Math.cos(s.roll), 0);
      const rt = fw.clone().cross(upRef).normalize();
      const up = rt.clone().cross(fw);
      return { fw, rt, up };
    };
    for (let pass = 0; pass < 4; pass++) {
      const { fw, rt, up } = basis();
      let need = s.focalLength;
      let worst: { x: number; y: number; m: number } | null = null;
      for (const e of ends) {
        const v = e.clone().sub(s.position);
        const z = v.dot(fw);
        if (z < -R) continue; // behind the camera
        const zz = Math.max(z, 0.02);
        const x = v.dot(rt) / zz;
        const y = v.dot(up) / zz;
        // out of frame once past either edge: the cheaper of the two zooms
        const mx = Math.abs(x) - R / zz;
        const my = Math.abs(y) - R / zz;
        const f = Math.min(mx > 0.02 ? (18 * cx) / mx : Infinity, my > 0.02 ? (18 * cy) / my : Infinity) * 1.05;
        const m = Math.max(mx / cx, my / cy);
        if (f > need) {
          need = f;
          worst = { x, y, m };
        }
      }
      if (!worst) return s;
      if (need <= s.focalLength * 1.6 && need < 220) return { ...s, focalLength: need };
      // turn away: aim past the far side of the frame from the arm end
      const S = (18 * Math.max(cx, cy)) / s.focalLength;
      const len = Math.hypot(worst.x, worst.y) || 1;
      const shift = (S + R / 0.3 - worst.m) * 0.6 + 0.02;
      const dist = s.target.distanceTo(s.position);
      const target = s.target
        .clone()
        .addScaledVector(rt, (-worst.x / len) * shift * dist)
        .addScaledVector(up, (-worst.y / len) * shift * dist);
      s = { ...s, target };
    }
    return { ...s, focalLength: Math.min(260, s.focalLength * 1.6) };
  }

  private compose(mode: CameraMode, t: number, f: Framing): CameraState {
    const cx = this.center.at(t);
    const k = f.dramaOn ? clamp(f.drama, 0, 1) : 0;
    const peak = this.peak.at(t) * k;
    // longer lenses, from proportionally further back (the depth of field stays
    // about the same: it goes with distance over focal length); pushed in at the peaks
    const lens = (amount: number) => 1 + amount * k;
    const push = (amount: number) => 1 - amount * peak;
    const span = clamp(this.span.at(t), 0.15, 1.1);
    const breathe = (s: number, amp: number) => drift(t * 0.045 + s, 31 + s) * amp;
    if (mode === 'cinematic') return this.director.evaluate(t);
    if (mode === 'overhead') {
      // above the player's shoulder, looking down across both hands
      const target = new THREE.Vector3(cx + breathe(1, 0.008), 0.0, 0.0);
      const d = (0.74 + span * 0.78) * f.distance * lens(0.3) * push(0.15);
      // above the forearms and in front of where they end, looking down past the hands
      const pos = new THREE.Vector3(cx + 0.06 + breathe(2, 0.015), 0.74 * d + f.height, 0.3 + 0.08 * (d - 1));
      pos.sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.angle).add(target);
      return { position: pos, target, focalLength: 38 * f.focalScale * lens(0.3) * (1 + 0.05 * peak), fstop: 6, focus: this.rackFocus(pos, t, k, pos.distanceTo(target)), roll: 0 };
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
    // follow: from beyond the treble end, low over the keys, looking
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
    return { position: pos, target, focalLength: 66 * f.focalScale * lens(0.5) * (1 + 0.08 * peak), fstop: 5, focus, roll: -0.012 };
  }

  /** focus distance racked toward whichever hand leads, by `k` (0 = the given focus) */
  private rackFocus(pos: THREE.Vector3, t: number, k: number, base: number): number {
    if (k <= 0) return base;
    const w = this.lead.at(t);
    const right = pos.distanceTo(this.tip('R', t));
    const left = pos.distanceTo(this.tip('L', t));
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
