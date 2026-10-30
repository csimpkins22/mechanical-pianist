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
import { applyPalette, createPalette, type Palette } from './materials';
import { PianoModel } from './PianoModel';
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
};

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

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.02, 30);
  readonly palette: Palette;
  readonly env: Environment;
  piano!: PianoModel;
  hands!: Record<Hand, HandRig>;
  readonly post: PostPipeline;
  look: Look = { ...DEFAULT_LOOK };
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  readonly debugLayer = new THREE.Group();

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
    this.scene.add(createSheetMusic());
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
    this.hands = { L: new HandRig(hand, 'L'), R: new HandRig(hand, 'R') };
    this.scene.add(this.hands.L.root, this.hands.R.root);
    this.captureHandReflections();
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
    this.scene.add(cam);
    cam.update(this.renderer, this.scene);
    this.scene.remove(cam);
    this.hands.L.root.visible = true;
    this.hands.R.root.visible = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const tex = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    rt.dispose();
    for (const m of [this.palette.shell, this.palette.chrome, this.palette.steel, this.palette.graphite, this.palette.rubber, this.palette.shellInner]) {
      (m as THREE.MeshStandardMaterial).envMap = tex;
      (m as THREE.MeshStandardMaterial).envMapIntensity = 1.6;
      m.needsUpdate = true;
    }
  }

  private lightSettings: LightSettings = DEFAULT_LIGHTS;

  setLights(s: LightSettings = DEFAULT_LIGHTS) {
    this.lightSettings = s;
    this.env.applySettings(s);
  }

  setQuality(q: Quality) {
    this.post.setQuality(q);
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** draw the performance at one instant */
  update(frame: FrameState) {
    this.piano.setKeys(frame.keys);
    this.hands.L.apply(frame.hands.L);
    this.hands.R.apply(frame.hands.R);
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
  }

  /** t (performance time) seeds the film grain, so a paused frame is a still image */
  render(cam: CameraState, t: number) {
    this.camera.position.copy(cam.position);
    this.camera.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0);
    this.camera.lookAt(cam.target);
    this.camera.setFocalLength(cam.focalLength);
    this.camera.updateProjectionMatrix();
    this.palette.glow.emissiveIntensity = 2.4 * this.look.glow;
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
      exposure: L.exposure * 0.82,
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
      shafts:
        ls.shaftsOn && ls.shafts > 0.001
          ? {
              strength: ls.shafts * ls.sun,
              color: this.env.shaftColor,
              sunDir: this.env.sunDir,
              window: WINDOW,
              bars: WINDOW_BARS,
              shadow: sunShadow ? { map: sunShadow, matrix: sun.shadow.matrix } : null,
              time: t,
            }
          : null,
    };
    this.post.render(this.scene, this.camera, params);
  }
}
