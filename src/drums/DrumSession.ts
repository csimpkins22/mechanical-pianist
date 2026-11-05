// A drum performance on the drum stage: the piece, the kit's motion, the
// camera and the sound, evaluated at the app's master time. The app hands its
// transport here while a drum piece is open (App.ts keeps its own changes to
// a few lines that route to this).
import type * as THREE from 'three';
import { readDrumMidi, type DrumPerformance } from './DrumScore';
import { KitMotion } from './KitMotion';
import { assignLimbs, type Sticking } from './Sticking';
import { DrummerMotion, blankTargets } from './DrummerMotion';
import { createPose, type DrummerPose, type DrummerTargets } from './DrummerIK';
import type { DrumAudio } from './DrumAudio';
import { DrumCamera, type DrumView } from '../presentation/DrumCamera';
import { KIT_ORIGIN, type DrumStage } from '../presentation/DrumStage';
import { shutterTime, type Look } from '../presentation/SceneRenderer';

export interface DrumSource {
  kind: 'library';
  id: string;
}

export class DrumSession {
  readonly perf: DrumPerformance;
  readonly motion: KitMotion;
  /** which limb plays each hit, and the drummer's performance planned from it */
  readonly sticking: Sticking;
  readonly drummer: DrummerMotion;
  private targets: DrummerTargets = blankTargets();
  private pose: DrummerPose = createPose();
  private prevPose: DrummerPose = createPose();
  private idle = 0;
  readonly camera: DrumCamera;
  view: DrumView = 'cinematic';
  /** for tools and inspection: a camera (kit frame: position, target, focal length, f-stop) that replaces the shots */
  inspect: { pos: [number, number, number]; target: [number, number, number]; focal: number; fstop?: number } | null = null;

  constructor(
    bytes: Uint8Array,
    readonly source: DrumSource,
    readonly title: string,
    readonly artist: string,
    readonly year: string | undefined,
    readonly audio: DrumAudio,
    readonly stage: DrumStage,
  ) {
    this.perf = readDrumMidi(bytes, title);
    this.motion = new KitMotion(this.perf);
    this.sticking = assignLimbs(this.perf);
    this.drummer = new DrummerMotion(this.perf, this.sticking, this.motion);
    // plan the arms' keys ahead in idle moments (a frame plans any it needs itself, in the same order)
    const ahead = () => {
      if (this.disposed || this.drummer.prepare(6)) return;
      this.idle = window.setTimeout(ahead, 16);
    };
    if (typeof window !== 'undefined') this.idle = window.setTimeout(ahead, 50);
    this.camera = new DrumCamera(this.perf, KIT_ORIGIN.clone());
    audio.setPerformance(this.perf);
  }

  get duration() {
    return this.perf.duration;
  }

  private disposed = false;
  /** stop planning ahead (the session is being replaced) */
  dispose() {
    this.disposed = true;
    if (typeof window !== 'undefined') clearTimeout(this.idle);
  }

  /** the drummer's pose at t (the planned performance through the IK) */
  poseAt(t: number, into: DrummerPose = this.pose): DrummerPose {
    return this.drummer.pose(t, this.targets, into);
  }

  /** draw the instant t (and, for motion blur, the kit and camera as the shutter opened) */
  render(t: number, look: Look, aspect: number, speed: number, lowQuality: boolean) {
    const cam = this.camera.evaluate(this.view, t);
    if (this.inspect) {
      const i = this.inspect;
      cam.position.set(...i.pos).add(KIT_ORIGIN);
      cam.target.set(...i.target).add(KIT_ORIGIN);
      cam.up = undefined;
      cam.roll = 0;
      cam.focalLength = i.focal;
      cam.fstop = i.fstop ?? 8;
      cam.focus = cam.position.distanceTo(cam.target);
    }
    const open = shutterTime(look) * speed;
    if (open > 0 && !lowQuality) {
      const t0 = Math.max(0, t - open);
      const cut = this.camera.cutBetween(this.view, t0, t);
      this.stage.setPrevious(this.motion.evaluate(t0), cut || this.inspect ? cam : this.camera.evaluate(this.view, t0), aspect, this.stage.drummer ? this.poseAt(t0, this.prevPose) : undefined);
    }
    this.stage.update(this.motion.evaluate(t), t);
    if (this.stage.drummer) {
      this.stage.setDrummer(this.poseAt(t));
      // the servo lights flare a little with each arm's effort (its shoulder's rise), and fade
      const b = this.targets.body;
      this.stage.drummer.setGlow(2.4, b ? b.shrugR / 0.06 : 0, b ? b.shrugL / 0.06 : 0);
    }
    this.stage.render(cam, t, look, aspect);
  }

  /** the next or previous shot to hold */
  stepShot(t: number, dir: 1 | -1) {
    this.view = this.camera.step(this.view, t, dir);
  }

  shotName(t: number) {
    return this.camera.nameOf(this.view, t);
  }

  /** the kit's and the drummer's state at t, hashed (determinism checks) */
  stateHash(t: number) {
    const p = this.poseAt(t);
    let h = 2166136261 >>> 0;
    const mix = (n: number) => {
      const v = Math.round(n * 1e7);
      h = Math.imul(h ^ (v & 0xffff), 16777619) >>> 0;
      h = Math.imul(h ^ ((v >>> 16) & 0xffff), 16777619) >>> 0;
    };
    for (let i = 0; i < p.angles.length; i++) mix(p.angles[i]);
    for (const s of ['R', 'L'] as const) for (let k = 0; k < 3; k++) mix(p.stick[s].tip[k]);
    return `${this.motion.stateHash(t)}-${h.toString(16)}`;
  }

  /** where the camera is at t (for tools) */
  cameraAt(t: number): { position: THREE.Vector3; target: THREE.Vector3 } {
    return this.camera.evaluate(this.view, t);
  }
}
