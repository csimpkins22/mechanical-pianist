// A drum performance on the drum stage: the piece, the kit's motion, the
// camera and the sound, evaluated at the app's master time. The app hands its
// transport here while a drum piece is open (App.ts keeps its own changes to
// a few lines that route to this).
import type * as THREE from 'three';
import { readDrumMidi, type DrumPerformance } from './DrumScore';
import { KitMotion } from './KitMotion';
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
    this.camera = new DrumCamera(this.perf, KIT_ORIGIN.clone());
    audio.setPerformance(this.perf);
  }

  get duration() {
    return this.perf.duration;
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
      this.stage.setPrevious(this.motion.evaluate(t0), cut || this.inspect ? cam : this.camera.evaluate(this.view, t0), aspect);
    }
    this.stage.update(this.motion.evaluate(t), t);
    this.stage.render(cam, t, look, aspect);
  }

  /** the next or previous shot to hold */
  stepShot(t: number, dir: 1 | -1) {
    this.view = this.camera.step(this.view, t, dir);
  }

  shotName(t: number) {
    return this.camera.nameOf(this.view, t);
  }

  stateHash(t: number) {
    return this.motion.stateHash(t);
  }

  /** where the camera is at t (for tools) */
  cameraAt(t: number): { position: THREE.Vector3; target: THREE.Vector3 } {
    return this.camera.evaluate(this.view, t);
  }
}
