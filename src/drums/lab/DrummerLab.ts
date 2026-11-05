// The drummer lab (development only, not part of the app): the robot drummer
// at the kit (the app's own model, or the plain solids from KitLayout that
// the clearance checks use), in a lit studio with the app's post pipeline,
// posed by the IK at every strike spot, in the special poses, or in a slow
// sweep between spots.
//
//   npx vite --host 127.0.0.1 --port 5193 --strictPort, then /drummer-lab.html
//   query: pose=<name>|sweep  t=<s>  view=front|left|right|top|hands|feet|back|close|...
//          kit=model|solids  fast=1 (no post)  figure=skeleton|robot|both  ui=0 (no panel)
//   window.lab: setPose(name), setTime(t), setView(name), setKit(kind), renderNow()
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PostPipeline, type PostParams } from '../../presentation/PostPipeline';
import { createPose, limitViolations, solveDrummer, type DrummerPose, type DrummerTargets } from '../DrummerIK';
import { forwardKinematics } from '../DrummerSpec';
import { HIHAT_OPEN_GAP, PEDAL_TRAVEL } from '../KitLayout';
import type { KitState } from '../KitMotion';
import { DrumKitModel } from '../../presentation/DrumKitModel';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
import { SWEEP, blendTargets, emptyTargets, namedPoses, type NamedPose } from '../DrummerPoses';
import { clearance, describe } from '../DrummerClearance';
import { SkeletonFigure } from './SkeletonFigure';
import { PlaceholderKit } from './PlaceholderKit';
import { DrummerRig, loadDrummer } from '../DrummerRig';
import { createDrummerPalette } from '../drummerMaterials';

const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1';
const SEGMENT = 2.4; // seconds per sweep step

interface View {
  pos: [number, number, number];
  target: [number, number, number];
  focal: number;
}
const VIEWS: Record<string, View> = {
  front: { pos: [1.05, 1.75, -3.1], target: [0.02, 0.78, -0.28], focal: 38 },
  left: { pos: [-2.9, 1.45, -0.85], target: [-0.05, 0.8, -0.25], focal: 40 },
  right: { pos: [2.25, 1.4, -0.35], target: [0.05, 0.82, -0.22], focal: 42 },
  top: { pos: [0.05, 3.1, -0.42], target: [0.02, 0.6, -0.3], focal: 30 },
  back: { pos: [0.9, 1.75, 1.7], target: [-0.05, 0.85, -0.3], focal: 38 },
  hands: { pos: [0.65, 1.32, -1.05], target: [-0.12, 0.8, -0.2], focal: 50 },
  close: { pos: [0.32, 1.02, -0.72], target: [-0.18, 0.78, -0.12], focal: 70 },
  feet: { pos: [1.15, 0.5, -1.05], target: [-0.05, 0.22, -0.18], focal: 45 },
  side: { pos: [-1.85, 1.0, -0.2], target: [-0.1, 0.78, -0.2], focal: 55 },
  backClose: { pos: [0.35, 1.25, 0.85], target: [0.0, 1.05, 0.05], focal: 60 },
  label: { pos: [0.06, 1.12, 0.55], target: [0.0, 1.08, 0.06], focal: 70 },
  // the waist and lower back: from the drummer's left, from behind on the left, from the front on the right
  waistSide: { pos: [-1.35, 0.92, 0.1], target: [0.0, 0.78, 0.06], focal: 50 },
  waistBack: { pos: [-0.95, 1.05, 0.95], target: [0.0, 0.78, 0.05], focal: 50 },
  waistFront: { pos: [0.95, 1.0, -0.9], target: [0.0, 0.8, 0.0], focal: 50 },
  // side-on from the drummer's right, as the concert footage (clip 8)
  sideR: { pos: [1.75, 1.12, 0.02], target: [0.0, 0.86, -0.02], focal: 50 },
  portrait: { pos: [0.75, 1.3, -1.45], target: [-0.02, 0.98, -0.08], focal: 55 },
  // the whole drummer side-on from his right (as clip 8), and three-quarters from the front on his right
  sideFull: { pos: [2.6, 1.25, -0.12], target: [0.0, 0.88, -0.25], focal: 40 },
  front34: { pos: [1.35, 1.5, -1.95], target: [-0.06, 0.86, -0.16], focal: 40 },
  grip: { pos: [-0.62, 0.98, -0.78], target: [-0.2, 0.8, -0.16], focal: 85 },
  // as the reference footage (clip 4): above the drummer's right, looking down across the kit
  clip4: { pos: [1.05, 1.7, -0.32], target: [-0.3, 0.78, -0.42], focal: 20 },
};

class Lab {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 40);
  readonly post: PostPipeline | null;
  readonly controls: OrbitControls;
  /** the plain solids (KitProxy), and the app's own kit model */
  readonly solids = new PlaceholderKit();
  readonly model = new DrumKitModel();
  kitKind: 'model' | 'solids' = 'model';
  private kitState: KitState = restKit();
  readonly skeleton = new SkeletonFigure();
  rig: DrummerRig | null = null;
  readonly pose: DrummerPose = createPose();
  poses: NamedPose[] = namedPoses();
  private blend: DrummerTargets = emptyTargets();
  current = 'groove';
  sweeping = false;
  t = 0;
  focal = 40;
  private last = performance.now();
  private info: HTMLElement | null = null;
  key!: THREE.SpotLight;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: FAST, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    if (FAST) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.post = null;
    } else {
      // the grade pass tone-maps and encodes, as in the app
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      this.post = new PostPipeline(this.renderer);
    }
    this.camera.filmGauge = 36;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.studio();
    this.scene.add(this.solids.root, this.model.root);
    this.model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.setKit('model');
    this.scene.add(this.skeleton.root);
  }

  /** a dark studio: a warm key overhead in front, a cool rim behind, a low fill; the room falls away */
  private studio() {
    const s = this.scene;
    s.background = new THREE.Color(0x050506);
    s.fog = new THREE.FogExp2(0x060607, 0.05);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.05;
    pmrem.dispose();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.78 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 6, 64, 1, true, Math.PI * 0.5, Math.PI), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.95, side: THREE.BackSide }));
    wall.position.set(0, 3, 0.4);
    s.add(wall);
    // key: a warm, soft spot from above and in front, a little to the drummer's left
    const key = new THREE.SpotLight(0xffd9b0, 24, 9, 0.62, 0.55, 1.6);
    key.position.set(-1.25, 3.1, -2.1);
    key.target.position.set(0, 0.75, -0.25);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 3;
    key.shadow.camera.near = 1.2;
    key.shadow.camera.far = 6;
    s.add(key, key.target);
    this.key = key;
    // rim: cool, behind and to the right, picking out the shells' edges
    const rim = new THREE.SpotLight(0x9fc4ff, 11, 8, 0.7, 0.6, 1.5);
    rim.position.set(1.6, 2.6, 2.2);
    rim.target.position.set(0, 0.9, -0.1);
    s.add(rim, rim.target);
    // fill: low and cool from the camera side
    const fill = new THREE.HemisphereLight(0x8a9bb0, 0x1a1410, 0.12);
    s.add(fill);
    const bounce = new THREE.PointLight(0xffc49a, 0.35, 3, 2);
    bounce.position.set(0.1, 0.25, -0.9);
    s.add(bounce);
  }

  async loadRobot() {
    try {
      const palette = createDrummerPalette();
      const model = await loadDrummer('./assets/robot_drummer.glb', palette);
      this.rig = new DrummerRig(model, palette);
      this.scene.add(this.rig.root);
    } catch (e) {
      console.warn('robot drummer model not loaded; showing the skeleton', e);
    }
    this.setFigure(params.get('figure') ?? (this.rig ? 'robot' : 'skeleton'));
  }

  setFigure(f: string) {
    this.skeleton.root.visible = f === 'skeleton' || f === 'both' || !this.rig;
    if (this.rig) this.rig.root.visible = f === 'robot' || f === 'both';
  }

  /** the app's kit model, or the solids the clearance checks see */
  setKit(kind: string) {
    this.kitKind = kind === 'solids' ? 'solids' : 'model';
    this.solids.root.visible = this.kitKind === 'solids';
    this.model.root.visible = this.kitKind === 'model';
  }

  setView(name: string) {
    const v = VIEWS[name] ?? VIEWS.front;
    this.camera.position.set(...v.pos);
    this.controls.target.set(...v.target);
    this.focal = v.focal;
    this.camera.setFocalLength(v.focal);
    this.controls.update();
  }

  setPose(name: string) {
    this.sweeping = name === 'sweep';
    if (!this.sweeping) this.current = name;
    this.solve();
  }

  setTime(t: number) {
    this.t = t;
    this.solve();
  }

  private targets(): { targets: DrummerTargets; name: string; open: number } {
    if (!this.sweeping) {
      const p = this.poses.find((x) => x.name === this.current) ?? this.poses[0];
      return { targets: p.targets, name: p.name, open: p.targets.feet.L.pedal === 'hihatPedal' ? 1 - p.targets.feet.L.press : 0 };
    }
    const n = SWEEP.length;
    const u = this.t / SEGMENT;
    const k = Math.floor(u);
    const f = u - k;
    const a = this.poses.find((x) => x.name === SWEEP[((k % n) + n) % n])!;
    const b = this.poses.find((x) => x.name === SWEEP[(((k + 1) % n) + n) % n])!;
    // hold each pose a moment, then move
    const g = Math.min(1, Math.max(0, (f - 0.3) / 0.7));
    blendTargets(a.targets, b.targets, g, this.blend);
    return { targets: this.blend, name: g < 0.5 ? a.name : b.name, open: 1 - this.blend.feet.L.press };
  }

  solve() {
    const { targets, name, open } = this.targets();
    solveDrummer(targets, this.pose);
    if (this.current === 'rest' && !this.sweeping) {
      // the model as built: every joint at its identity rest rotation (seated upright, arms hanging)
      for (let j = 0; j < this.pose.local.length; j += 9) this.pose.local.set(IDENTITY, j);
      forwardKinematics(this.pose.local, this.pose.root, this.pose.world, this.pose.pos);
    }
    this.skeleton.update(this.pose);
    this.rig?.apply(this.pose);
    this.solids.update(this.pose.pedal, open);
    // the kit model: the hi-hat open as far as the left foot lets it, the beater as the right foot presses
    const ks = this.kitState;
    ks.hihatClosed = 1 - open;
    ks.hihatGap = open * HIHAT_OPEN_GAP;
    ks.beater = Math.min(1, Math.max(0, -this.pose.pedal.kickPedal / PEDAL_TRAVEL));
    this.model.update(ks);
    if (this.info && (!this.sweeping || Math.floor(this.t * 4) !== Math.floor((this.t - 1 / 60) * 4))) this.report(targets, name);
  }

  private report(targets: DrummerTargets, name: string) {
    if (!this.info) return;
    const p = this.pose;
    const deg = (r: number) => `${((r * 180) / Math.PI).toFixed(0)}°`;
    const lim = limitViolations(p);
    const clr = clearance(p, targets, { margin: 0.003 });
    const st = (s: 'R' | 'L') => `${s}: ${(p.error[s] * 1000).toFixed(1)} mm, stick ${deg(p.stickAngle[s])}${targets[s].lift > 0 ? `, lifted ${(targets[s].lift * 100).toFixed(1)} cm` : ''}`;
    this.info.innerHTML = `<b>${name}</b><br>${st('R')}<br>${st('L')}<br>torso turn ${deg(p.torso[0])}, lean ${deg(-p.torso[1])}, bend ${deg(p.torso[2])}<br>shoulders ${p.pos[3 * 7 + 1].toFixed(3)} m` +
      `<br><span class="${lim.length ? 'bad' : 'ok'}">limits: ${lim.length ? lim.map((x) => `${x.name} ${deg(x.value)}`).join(', ') : 'all within'}</span>` +
      `<br><span class="${clr.some((c) => c.distance < 0) ? 'bad' : 'ok'}">clearance: ${clr.length ? clr.slice(0, 6).map(describe).join('<br>') : 'clear'}</span>`;
  }

  buildUI(panel: HTMLElement) {
    const add = (label: string, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.onclick = fn;
      panel.appendChild(b);
      return b;
    };
    const h = (t: string) => {
      const e = document.createElement('div');
      e.className = 'h';
      e.textContent = t;
      panel.appendChild(e);
    };
    h('Poses');
    for (const p of this.poses) add(p.label, () => this.setPose(p.name));
    add('Rest (the model as built)', () => this.setPose('rest'));
    add('Slow sweep between spots', () => this.setPose('sweep'), 'accent');
    h('View');
    for (const v of Object.keys(VIEWS)) add(v, () => this.setView(v), 'small');
    h('Kit');
    add('model', () => this.setKit('model'), 'small');
    add('solids (clearance)', () => this.setKit('solids'), 'small');
    h('Figure');
    for (const f of ['robot', 'skeleton', 'both']) add(f, () => this.setFigure(f), 'small');
    this.info = document.createElement('div');
    this.info.className = 'info';
    panel.appendChild(this.info);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.post?.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  renderNow() {
    this.camera.setFocalLength(this.focal);
    this.camera.updateMatrixWorld();
    if (!this.post) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const focus = this.camera.position.distanceTo(this.controls.target);
    const p: PostParams = {
      focalLength: this.focal,
      fstop: 5.6,
      focus,
      dof: true,
      exposure: 1.2,
      bloomStrength: 0.25,
      bloomRadius: 0.5,
      bloomThreshold: 1.6,
      saturation: 0.86,
      contrast: 1.18,
      lift: [0.0, -0.001, -0.002],
      gamma: [0.99, 0.97, 0.94],
      gain: [1.04, 1.0, 0.95],
      shadowTint: [0.96, 0.98, 1.02],
      highlightTint: [1.05, 1.0, 0.93],
      temperature: 0.08,
      vignette: 0.5,
      grain: 0.022,
      aberration: 0.0012,
      frame: Math.floor(this.t * 24) % 997,
      rolloff: 0.7,
      fade: 0,
      accent: 0,
      blackTint: [0.008, 0.004, 0],
      streaks: 0.06,
      letterbox: 0,
      shafts: null,
      motion: null,
      ao: 0.5,
    };
    this.post.render(this.scene, this.camera, p);
  }

  tick = () => {
    const now = performance.now();
    if (this.sweeping) {
      this.t += Math.min(0.05, (now - this.last) / 1000);
      this.solve();
    }
    this.last = now;
    this.controls.update();
    this.renderNow();
    requestAnimationFrame(this.tick);
  };
}

/** the kit at rest */
function restKit(): KitState {
  const z = () => ({ x: 0, z: 0 });
  return {
    t: 0,
    cymbals: { crash: { ...z(), drop: 0 }, ride: { ...z(), drop: 0 }, hihat: { ...z(), drop: 0 } },
    stands: { crash: z(), ride: z(), hihat: z() },
    hihatClosed: 1,
    hihatGap: 0,
    beater: 0,
    heads: { kick: 0, snare: 0, tom1: 0, tom2: 0, floorTom: 0 },
    buzz: 0,
    toms: { tom1: z(), tom2: z(), floorTom: z() },
  };
}

async function main() {
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  const lab = new Lab(canvas);
  (window as unknown as { lab: Lab }).lab = lab;
  const panel = document.getElementById('panel') as HTMLElement;
  if (params.get('ui') === '0') panel.remove();
  else lab.buildUI(panel);
  lab.resize();
  window.addEventListener('resize', () => lab.resize());
  await lab.loadRobot();
  lab.setKit(params.get('kit') ?? 'model');
  lab.setView(params.get('view') ?? 'front');
  lab.t = parseFloat(params.get('t') ?? '0');
  lab.setPose(params.get('pose') ?? 'groove');
  lab.renderNow();
  (window as unknown as { __ready: boolean }).__ready = true;
  if (params.get('still') !== '1') requestAnimationFrame(lab.tick);
}

void main();
