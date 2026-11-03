// Owns the three.js scene: renderer, room, piano, hands, lights, reflections
// and post-processing. It only ever draws a FrameState and a CameraState; it
// knows nothing about music.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TIP_RADIUS } from '../core/handGeometry';
import type { Hand } from '../core/types';
import type { FrameState } from '../performance/PerformanceTimeline';
import type { CameraState } from './CinematicCamera';
import { Environment, DEFAULT_LIGHTS, WINDOW, WINDOW_BARS, type LightSettings } from './Environment';
import { HandRig } from './HandRig';
import { MIRROR_UNIFORMS, applyPalette, createPalette, type Palette } from './materials';
import { SHARED_UNIFORMS as SHARED } from './shaderPatch';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { PianoModel } from './PianoModel';
import { PianoInterior } from './PianoInterior';
import { PostPipeline, type PostParams, type Quality } from './PostPipeline';
import { createSheetMusic } from './SheetMusic';
import { SHARED_UNIFORMS } from './shaderPatch';

export interface Look {
  /** the visual style preset last chosen (see VisualStyles.ts) */
  style: string;
  exposure: number;
  dof: boolean;
  dofScale: number;
  bloom: number;
  glow: number;
  grain: number;
  vignette: number;
  /** grade */
  contrast: number;
  saturation: number;
  warmth: number; // -1 cool .. 1 warm
  rolloff: number; // highlight roll-off
  fade: number; // lifted, faded blacks (old film)
  accent: number; // keep the cyan of the joints when the rest is desaturated
  /** anamorphic streaks on glints and the cyan rings */
  streaksOn: boolean;
  streaks: number;
  /** letterbox bars */
  letterboxOn: boolean;
  letterbox: number; // aspect, e.g. 2.39
  /** motion blur, as a film camera's shutter angle at 24 fps (180 = 1/48 s) */
  motionBlurOn: boolean;
  shutter: number;
  /** live reflections of the keys and hands in the lacquer behind them */
  reflectionsOn: boolean;
  /** the upper front panel off: the hammers, dampers, strings and plate in view */
  openPiano: boolean;
  /** ambient occlusion: darkening where surfaces crowd each other */
  aoOn: boolean;
  ao: number;
}

export const DEFAULT_LOOK: Look = {
  style: 'golden',
  exposure: 1.0,
  dof: true,
  dofScale: 1,
  bloom: 1,
  glow: 1,
  grain: 1,
  vignette: 1,
  contrast: 1.26,
  saturation: 0.82,
  warmth: 0.5,
  rolloff: 0.7,
  fade: 0,
  accent: 0,
  streaksOn: true,
  streaks: 0.5,
  letterboxOn: false,
  letterbox: 2.39,
  motionBlurOn: true,
  shutter: 180,
  reflectionsOn: true,
  openPiano: false,
  aoOn: true,
  ao: 0.6,
};

/** exposure time of the shutter (s) */
export function shutterTime(look: Look) {
  return look.motionBlurOn ? look.shutter / 360 / 24 : 0;
}

/** Pack glTF JSON and its binary buffer into a GLB container. */
function packGlb(json: object, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(enc.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(enc, 20);
  for (let i = enc.length; i < jsonLen; i++) u8[20 + i] = 0x20;
  const o = 20 + jsonLen;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN'
  u8.set(bin, o + 8);
  return out;
}

/** bounced light, balanced against the flat fill it replaces so the room keeps its overall level */
const BOUNCE_GAIN = 0.6;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.02, 30);
  readonly palette: Palette;
  readonly env: Environment;
  piano!: PianoModel;
  hands!: Record<Hand, HandRig>;
  private effort: Record<Hand, number[]> = { L: [0, 0, 0, 0, 0, 0], R: [0, 0, 0, 0, 0, 0] };
  readonly post: PostPipeline;
  look: Look = { ...DEFAULT_LOOK };
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private handEnv: THREE.Texture | null = null;
  /** everything that moves (keys, hand parts): their transforms at the start of the shutter go in userData.prevMW */
  private moving: THREE.Object3D[] = [];
  private prevViewProj = new THREE.Matrix4();
  private hasPrev = false;
  private prevCam = new THREE.PerspectiveCamera();
  // the live mirror image in the lacquer behind the keys (see MIRROR_UNIFORMS)
  private mirrorRT = new THREE.WebGLRenderTarget(2, 2, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private mirrorCam = new THREE.PerspectiveCamera();
  private mirrorBlank = MIRROR_UNIFORMS.uMirror.value;
  /** the board's own panels, left out of their reflection */
  private mirrorHidden: THREE.Object3D[] = [];
  private mirrorShown: boolean[] = [];
  // bounced light: small cube captures of the lit room, reduced to irradiance
  private bounceRT = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType });
  private bounceCam = new THREE.CubeCamera(0.01, 20, this.bounceRT);
  private bounceBusy = false;
  private bounceAgain = false;
  private bounceTimer = 0;
  readonly debugLayer = new THREE.Group();
  private sheet: THREE.Object3D;
  /** inside the piano, and what comes off to show it (the upper panel with its music desk, the sconces on it, the score) */
  interior: PianoInterior | null = null;
  private panelParts: THREE.Object3D[] = [];
  private open = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // the grade pass tone-maps
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the grade pass encodes sRGB
    this.camera.filmGauge = 36;
    this.palette = createPalette();
    this.env = new Environment();
    this.scene.add(this.env.root);
    this.sheet = createSheetMusic();
    this.scene.add(this.sheet);
    this.scene.background = new THREE.Color(0x020202);
    this.scene.fog = new THREE.FogExp2(0x060403, 0.12);
    this.post = new PostPipeline(this.renderer);
    this.debugLayer.name = 'Debug';
    this.debugLayer.visible = false;
    this.scene.add(this.debugLayer);
    // environment reflections: a small studio of the room
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(Environment.envScene(), 0.03).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  async load(base: string, onProgress?: (f: number) => void) {
    const loader = new GLTFLoader();
    const get = (url: string) =>
      new Promise<THREE.Group>((resolve, reject) =>
        loader.load(url, (g) => resolve(g.scene), (e) => e.total && onProgress?.(e.loaded / e.total), reject),
      );
    // Binary glTF where the host serves it; otherwise self-contained glTF JSON,
    // whose embedded buffer is decoded here and handed over as a GLB, so the
    // loader never has to fetch a data: URL (some hosts forbid that).
    const fromJson = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const json = await r.json();
      const uri: string = json.buffers[0].uri;
      const b64 = uri.slice(uri.indexOf(',') + 1);
      const raw = atob(b64);
      const bin = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
      delete json.buffers[0].uri;
      const gltf = await loader.parseAsync(packGlb(json, bin), '');
      return gltf.scene;
    };
    const model = (name: string) => get(`${base}assets/${name}.glb`).catch(() => fromJson(`${base}assets/${name}.json`));
    const [hand, pianoCase] = await Promise.all([model('robot_hand'), model('piano_case')]);
    applyPalette(hand, this.palette);
    applyPalette(pianoCase, this.palette);
    this.piano = new PianoModel(pianoCase, this.palette);
    this.scene.add(this.piano.root);
    this.hands = { L: new HandRig(hand, 'L', this.palette.glow), R: new HandRig(hand, 'R', this.palette.glow) };
    this.scene.add(this.hands.L.root, this.hands.R.root);
    this.moving = [];
    for (const root of [this.hands.L.root, this.hands.R.root, ...this.piano.pivots])
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) this.moving.push(o);
      });
    this.post.prepassHidden = [this.env.dust];
    this.mirrorHidden = ['Nameboard', 'UpperPanel'].map((n) => this.piano.root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
    this.interior = new PianoInterior();
    this.piano.root.add(this.interior.root);
    const upper = this.piano.root.getObjectByName('UpperPanel');
    this.panelParts = [upper, this.piano.sconces, this.sheet].filter((o): o is THREE.Object3D => !!o);
    this.applyOpen(this.look.openPiano);
    MIRROR_UNIFORMS.uMirror.value = this.mirrorRT.texture;
    this.captureHandReflections();
    await this.captureBounce();
    // a second pass lets the first bounce light the room the probes see: two bounces
    await this.captureBounce();
  }

  /**
   * The chrome and porcelain should reflect the keyboard they play: capture
   * the room with the piano (hands hidden) once from above the keys and use it
   * as the hands' environment.
   */
  private captureHandReflections() {
    this.cubeRT?.dispose();
    const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.01, 20, rt);
    cam.position.set(0, 0.07, 0.04);
    this.hands.L.root.visible = false;
    this.hands.R.root.visible = false;
    const mirrorOn = MIRROR_UNIFORMS.uMirrorOn.value;
    MIRROR_UNIFORMS.uMirrorOn.value = 0;
    this.scene.add(cam);
    cam.update(this.renderer, this.scene);
    this.scene.remove(cam);
    MIRROR_UNIFORMS.uMirrorOn.value = mirrorOn;
    this.hands.L.root.visible = true;
    this.hands.R.root.visible = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const tex = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    rt.dispose();
    this.handEnv?.dispose();
    this.handEnv = tex;
    for (const m of [this.palette.shell, this.palette.chrome, this.palette.steel, this.palette.graphite, this.palette.rubber, this.palette.shellInner]) {
      (m as THREE.MeshStandardMaterial).envMap = tex;
      (m as THREE.MeshStandardMaterial).envMapIntensity = 1.6;
      m.needsUpdate = true;
    }
  }

  /**
   * Bounced light: the room as it is lit now, captured at three heights in
   * front of the piano (by the floor, at the keys, above them) with the hands
   * left out, each reduced to spherical-harmonic irradiance that every
   * surface then takes by height (see shaderPatch BOUNCE_GLSL). Redone when
   * the lights change; each capture includes the previous bounce.
   */
  async captureBounce() {
    if (this.bounceBusy) {
      this.bounceAgain = true;
      return;
    }
    this.bounceBusy = true;
    try {
      const ys = SHARED.uBounceY.value;
      const spots = [new THREE.Vector3(0, ys.x, 0.45), new THREE.Vector3(0, ys.y, 0.1), new THREE.Vector3(0, ys.z, 0.35)];
      const sh = SHARED.uBounceSH.value;
      for (let i = 0; i < 3; i++) {
        const hidden = [this.hands.L.root, this.hands.R.root, this.env.dust, this.debugLayer].filter((o) => o.visible);
        for (const o of hidden) o.visible = false;
        const mirrorOn = MIRROR_UNIFORMS.uMirrorOn.value;
        MIRROR_UNIFORMS.uMirrorOn.value = 0;
        this.bounceCam.position.copy(spots[i]);
        this.scene.add(this.bounceCam);
        this.bounceCam.update(this.renderer, this.scene);
        this.scene.remove(this.bounceCam);
        MIRROR_UNIFORMS.uMirrorOn.value = mirrorOn;
        for (const o of hidden) o.visible = true;
        const probe = await LightProbeGenerator.fromCubeRenderTarget(this.renderer, this.bounceRT);
        for (let k = 0; k < 9; k++) sh[i * 9 + k].copy(probe.sh.coefficients[k]);
      }
      const ls = this.lightSettings;
      SHARED.uBounce.value = ls.bounceOn ? BOUNCE_GAIN * ls.bounce : 0;
    } finally {
      this.bounceBusy = false;
    }
    if (this.bounceAgain) {
      this.bounceAgain = false;
      await this.captureBounce();
    }
  }

  private lightSettings: LightSettings = DEFAULT_LIGHTS;

  setLights(s: LightSettings = DEFAULT_LIGHTS) {
    this.lightSettings = s;
    this.env.applySettings(s);
    SHARED.uBounce.value = s.bounceOn ? BOUNCE_GAIN * s.bounce : 0;
    // the room's light changed: recapture what it bounces (once the sliders settle)
    if (this.hands) {
      clearTimeout(this.bounceTimer);
      this.bounceTimer = window.setTimeout(() => {
        this.captureHandReflections();
        void this.captureBounce().then(() => this.onRelit?.());
      }, 300);
    }
  }

  /** take the upper front panel off (or put it back): the action, strings and plate come into view */
  setOpen(open: boolean) {
    if (open === this.open) return;
    this.applyOpen(open);
    // the room's light and the hands' reflections now include the inside
    clearTimeout(this.bounceTimer);
    this.bounceTimer = window.setTimeout(() => {
      this.captureHandReflections();
      void this.captureBounce().then(() => this.onRelit?.());
    }, 120);
  }

  private applyOpen(open: boolean) {
    this.open = open;
    if (this.interior) this.interior.root.visible = open;
    for (const o of this.panelParts) o.visible = !open;
    this.env.setInteriorOpen(open);
  }

  /** called when a recapture of the room's light has finished (to redraw a paused frame) */
  onRelit?: () => void;

  setQuality(q: Quality) {
    this.post.setQuality(q);
    this.sizeMirror();
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.env.lights.sun.shadow.mapSize.set(q === 'high' ? 4096 : 2048, q === 'high' ? 4096 : 2048);
    this.env.lights.sun.shadow.map?.dispose();
    this.env.lights.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    const rake = this.env.lights.rake.shadow;
    rake.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    rake.map?.dispose();
    rake.map = null as unknown as THREE.WebGLRenderTarget;
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.post.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.sizeMirror();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * For motion blur: the performance and camera as the shutter opened (a
   * moment before the frame drawn next). Records where everything was;
   * update() then poses the instant itself.
   */
  setPrevious(frame: FrameState, cam: CameraState) {
    this.piano.setKeys(frame.keys);
    this.hands.L.apply(frame.hands.L);
    this.hands.R.apply(frame.hands.R);
    if (this.open && this.interior) {
      this.interior.update(frame);
      this.interior.keepPrevious();
    }
    this.scene.updateMatrixWorld();
    for (const o of this.moving) ((o.userData.prevMW ??= new THREE.Matrix4()) as THREE.Matrix4).copy(o.matrixWorld);
    const c = this.prevCam;
    c.copy(this.camera, false);
    c.position.copy(cam.position);
    c.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0);
    c.lookAt(cam.target);
    c.setFocalLength(cam.focalLength);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    this.prevViewProj.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.hasPrev = true;
  }

  private sizeMirror() {
    const k = this.post.quality === 'high' ? 0.5 : 0.25;
    this.mirrorRT.setSize(Math.max(2, Math.round(this.post.width * k)), Math.max(2, Math.round(this.post.height * k)));
  }

  /**
   * The scene mirrored in the plane of the lacquer behind the keys (z =
   * MIRROR_UNIFORMS.uMirrorZ, facing the player), drawn from the reflected
   * camera with its near plane on the mirror (Lengyel's oblique clipping), so
   * nothing behind the board can show.
   */
  private renderMirror() {
    const z0 = MIRROR_UNIFORMS.uMirrorZ.value;
    const cam = this.camera;
    const mc = this.mirrorCam;
    if (cam.position.z < z0 + 0.01) return false;
    const reflect = (v: THREE.Vector3) => v.set(v.x, v.y, 2 * z0 - v.z);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    mc.position.copy(cam.position);
    reflect(mc.position);
    const target = reflect(cam.position.clone().add(dir));
    mc.up.set(up.x, up.y, -up.z);
    mc.lookAt(target);
    mc.near = cam.near;
    mc.far = cam.far;
    mc.updateMatrixWorld();
    mc.projectionMatrix.copy(cam.projectionMatrix);
    mc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    // oblique near plane on the mirror
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, z0));
    plane.applyMatrix4(mc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = mc.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x;
    e[6] = clip.y;
    e[10] = clip.z + 1 - 0.0005;
    e[14] = clip.w;
    // world -> mirror texture
    MIRROR_UNIFORMS.uMirrorMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix)
      .multiply(mc.matrixWorldInverse);
    const r = this.renderer;
    // hidden for the mirror, then as they were (the upper panel stays off while the piano is open)
    const shown = this.mirrorShown;
    this.mirrorHidden.forEach((o, i) => {
      shown[i] = o.visible;
      o.visible = false;
    });
    const dbg = this.debugLayer.visible;
    this.debugLayer.visible = false;
    // the rest of the lacquer, seen in the mirror, must not read the image being drawn
    MIRROR_UNIFORMS.uMirrorOn.value = 0;
    MIRROR_UNIFORMS.uMirror.value = this.mirrorBlank;
    r.setRenderTarget(this.mirrorRT);
    r.clear();
    r.render(this.scene, mc);
    MIRROR_UNIFORMS.uMirror.value = this.mirrorRT.texture;
    this.mirrorHidden.forEach((o, i) => (o.visible = shown[i]));
    this.debugLayer.visible = dbg;
    return true;
  }

  /** draw the performance at one instant */
  update(frame: FrameState) {
    this.piano.setKeys(frame.keys);
    this.hands.L.apply(frame.hands.L);
    this.hands.R.apply(frame.hands.R);
    this.effort = frame.effort;
    // fingertips feed the contact shadows on the keys
    const tips = SHARED_UNIFORMS.uFingertips.value;
    let k = 0;
    for (const h of ['L', 'R'] as Hand[]) {
      const p = frame.hands[h];
      for (let f = 1; f <= 5; f++) {
        const tip = p.states[f].tip;
        tips[k++].set(tip[0], tip[1], tip[2], TIP_RADIUS[f]);
      }
    }
    this.env.update(frame.t, this.post.height * 0.9);
    if (this.open) this.interior?.update(frame);
  }

  /** t (performance time) seeds the film grain, so a paused frame is a still image */
  render(cam: CameraState, t: number) {
    this.camera.position.copy(cam.position);
    this.camera.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0);
    this.camera.lookAt(cam.target);
    this.camera.setFocalLength(cam.focalLength);
    this.camera.updateProjectionMatrix();
    this.palette.glow.emissiveIntensity = 2.4 * this.look.glow;
    this.hands.L.setGlow(2.4 * this.look.glow, this.effort.L);
    this.hands.R.setGlow(2.4 * this.look.glow, this.effort.R);
    const L = this.look;
    const ls = this.lightSettings;
    // warmth moves white balance, highlights, mid-tones and blacks together
    const w = L.warmth;
    const sun = this.env.lights.sun;
    const sunShadow = sun.shadow.map?.depthTexture;
    const params: PostParams = {
      focalLength: cam.focalLength,
      fstop: cam.fstop / Math.max(0.05, L.dofScale),
      focus: cam.focus,
      dof: L.dof,
      // with bounced light the room is a little brighter: stop down to keep its level
      exposure: L.exposure * 0.82 * (ls.bounceOn ? 1 - 0.05 * Math.min(1, ls.bounce) : 1),
      bloomStrength: 0.3 * L.bloom,
      bloomRadius: 0.5,
      bloomThreshold: 1.6,
      // a dark, warm, sepia-leaning grade: deep, warm blacks, rolled-off amber
      // highlights, shadows left nearly neutral so the cyan joints still read
      saturation: L.saturation,
      contrast: L.contrast,
      lift: [0.0, -0.001, -0.002],
      gamma: [1 - 0.04 * w, 1 - 0.08 * w, 1 - 0.16 * w],
      gain: [1 + 0.1 * w, 1.0, 1 - 0.2 * w],
      shadowTint: [0.97, 0.97, 1.0],
      highlightTint: [1 + 0.14 * w, 1.0, 1 - 0.28 * w],
      temperature: 0.24 * w,
      vignette: 0.55 * L.vignette,
      grain: 0.028 * L.grain,
      aberration: 0.0018,
      frame: Math.floor(t * 24) % 997,
      rolloff: L.rolloff,
      fade: L.fade,
      accent: L.accent,
      blackTint: w >= 0 ? [0.03 * w, 0.015 * w, 0] : [0, 0.008 * -w, 0.028 * -w],
      streaks: L.streaksOn ? 0.18 * L.streaks : 0,
      letterbox: L.letterboxOn ? L.letterbox : 0,
      motion: this.hasPrev && shutterTime(L) > 0 ? { prevViewProj: this.prevViewProj } : null,
      ao: L.aoOn ? L.ao : 0,
      shafts:
        ls.shaftsOn && ls.shafts > 0.001
          ? {
              strength: ls.shafts * ls.sun * this.env.clouds,
              color: this.env.shaftColor,
              sunDir: this.env.sunDir,
              window: WINDOW,
              bars: WINDOW_BARS,
              shadow: sunShadow ? { map: sunShadow, matrix: sun.shadow.matrix } : null,
              time: t,
            }
          : null,
    };
    // the mirror first: it draws the shadow maps, which the main passes then reuse
    const r = this.renderer;
    const shadows = r.shadowMap.autoUpdate;
    this.camera.updateMatrixWorld();
    const mirrored = this.post.quality !== 'low' && L.reflectionsOn && this.renderMirror();
    MIRROR_UNIFORMS.uMirrorOn.value = mirrored ? 1 : 0;
    if (mirrored) r.shadowMap.autoUpdate = false;
    this.post.render(this.scene, this.camera, params);
    r.shadowMap.autoUpdate = shadows;
    this.hasPrev = false;
  }
}
