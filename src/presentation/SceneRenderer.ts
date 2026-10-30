// Owns the three.js scene: renderer, room, piano, hands, lights, reflections
// and post-processing. It only ever draws a FrameState and a CameraState; it
// knows nothing about music.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TIP_RADIUS } from '../core/handGeometry';
import type { Hand } from '../core/types';
import type { FrameState } from '../performance/PerformanceTimeline';
import type { CameraState } from './CinematicCamera';
import { Environment, DEFAULT_LIGHTS, type LightSettings } from './Environment';
import { HandRig } from './HandRig';
import { applyPalette, createPalette, type Palette } from './materials';
import { PianoModel } from './PianoModel';
import { PostPipeline, type PostParams, type Quality } from './PostPipeline';
import { SHARED_UNIFORMS } from './shaderPatch';

export interface Look {
  exposure: number;
  dof: boolean;
  dofScale: number;
  bloom: number;
  glow: number;
  grain: number;
  vignette: number;
}

export const DEFAULT_LOOK: Look = { exposure: 1.0, dof: true, dofScale: 1, bloom: 1, glow: 1, grain: 1, vignette: 1 };

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
    // binary glTF where the host serves it, self-contained glTF JSON otherwise
    const model = (name: string) => get(`${base}assets/${name}.glb`).catch(() => get(`${base}assets/${name}.json`));
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

  setLights(s: LightSettings = DEFAULT_LIGHTS) {
    this.env.applySettings(s);
  }

  setQuality(q: Quality) {
    this.post.setQuality(q);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.env.lights.sun.shadow.mapSize.set(q === 'high' ? 4096 : 2048, q === 'high' ? 4096 : 2048);
    this.env.lights.sun.shadow.map?.dispose();
    this.env.lights.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
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
    const params: PostParams = {
      focalLength: cam.focalLength,
      fstop: cam.fstop / Math.max(0.05, L.dofScale),
      focus: cam.focus,
      dof: L.dof,
      exposure: L.exposure * 0.82,
      bloomStrength: 0.3 * L.bloom,
      bloomRadius: 0.5,
      bloomThreshold: 1.6,
      saturation: 0.96,
      contrast: 1.1,
      lift: [0.004, 0.003, 0.006],
      gamma: [1.0, 0.99, 0.97],
      gain: [1.03, 1.0, 0.95],
      shadowTint: [0.93, 0.98, 1.06],
      highlightTint: [1.05, 1.0, 0.93],
      temperature: 0.12,
      vignette: 0.55 * L.vignette,
      grain: 0.028 * L.grain,
      aberration: 0.0018,
      frame: Math.floor(t * 24) % 997,
    };
    this.post.render(this.scene, this.camera, params);
  }
}
