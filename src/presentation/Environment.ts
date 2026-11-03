// The music room and its light: a window off to the bass side lets low, warm
// late-afternoon sun fall across the keyboard; the room falls away into
// shadow. Dust drifts through the shafts of light (the shafts themselves are
// a volumetric pass in PostPipeline). An optional hard, very low "raking"
// source throws long shadows across the keys. Everything that moves is a pure
// function of the performance time.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { NOISE_GLSL, patch } from './shaderPatch';
import { drift } from '../core/random';

export const FLOOR_Y = -0.72;
// tall and high in the wall, so the sun through it falls on the keys and the shafts cross the air above them
export const WINDOW = { x: -2.0, y: 1.38, z: 0.55, w: 1.1, h: 1.6 };
/** the window's glazing bars (old, heavy mullions: they cut the sunlight into separate blades) */
export const WINDOW_BARS = { vertical: [WINDOW.z - 0.19, WINDOW.z + 0.19], horizontal: [WINDOW.y + 0.27, WINDOW.y - 0.27], half: 0.035 };

export interface LightRig {
  sun: THREE.DirectionalLight;
  window: THREE.RectAreaLight;
  fill: THREE.HemisphereLight;
  rim: THREE.DirectionalLight;
  rake: THREE.DirectionalLight;
}

export interface LightSettings {
  sun: number;
  warmth: number; // -1 = cold moonlight, 0 = neutral, 1 = deep amber
  fill: number;
  rim: number;
  /** visible shafts of window light, with dust drifting in them */
  shaftsOn: boolean;
  shafts: number;
  /** a hard, very low source raking across the keys */
  rakeOn: boolean;
  rake: number;
  rakeAngle: number; // degrees above the keys
  rakeDir: number; // degrees: 0 = along the keyboard from the bass end, positive = more from the player's side
  /** light bounced off the room itself (captured from the lit scene) in place of most of the flat ambient fill */
  bounceOn: boolean;
  bounce: number;
}

export const DEFAULT_LIGHTS: LightSettings = {
  sun: 1,
  warmth: 0.65,
  fill: 0.7,
  rim: 1,
  shaftsOn: true,
  shafts: 0.6,
  rakeOn: true,
  rake: 0.8,
  rakeAngle: 9,
  rakeDir: 25,
  bounceOn: true,
  bounce: 1,
};

export class Environment {
  readonly root = new THREE.Group();
  readonly lights: LightRig;
  readonly sunDir = new THREE.Vector3();
  readonly dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private soft!: THREE.DirectionalLight;
  private rakeKey = '';
  /** colour of the sunlight in the shafts */
  readonly shaftColor = new THREE.Color(0xffd2a0);
  /** the window light now, relative to its setting: clouds pass slowly over the sun */
  clouds = 1;
  private sunBase = { sun: 3.6, window: 2.6, dust: 1 };

  constructor() {
    RectAreaLightUniformsLib.init();
    this.root.name = 'Room';
    this.buildRoom();

    // sun through the window: low, warm, from the bass side and the player's side
    const sun = new THREE.DirectionalLight(0xffd2a0, 3.6);
    const target = new THREE.Vector3(0.05, -0.02, -0.06);
    this.sunDir.set(1.7, -1.25, -0.75).normalize();
    sun.position.copy(target).addScaledVector(this.sunDir, -3);
    sun.target.position.copy(target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = -0.95;
    sc.right = 0.95;
    sc.top = 0.62;
    sc.bottom = -0.62;
    sc.near = 0.05; // from the window on: its bars throw their shadows across the keys
    sc.far = 5.5;
    sun.shadow.bias = -0.00012;
    sun.shadow.normalBias = 0.0012;
    sun.shadow.radius = 3;
    this.root.add(sun, sun.target);

    // the window itself as a soft source: long reflections in lacquer and chrome
    const win = new THREE.RectAreaLight(0xffe2bf, 2.6, WINDOW.w, WINDOW.h);
    win.position.set(WINDOW.x + 0.02, WINDOW.y, WINDOW.z);
    win.lookAt(0, 0, -0.1);
    this.root.add(win);

    // cool sky fill from the room, warm floor bounce
    const fill = new THREE.HemisphereLight(0x7f95b8, 0x2a1810, 0.45);
    this.root.add(fill);
    // soft key from the camera side: light bounced off the room, so the
    // porcelain reads white rather than grey
    const soft = new THREE.DirectionalLight(0xffe6cc, 1.35);
    soft.position.set(1.6, 1.1, 1.3);
    this.root.add(soft);
    this.soft = soft;
    const rim = new THREE.DirectionalLight(0x9ab4ff, 0.7);
    rim.position.set(1.4, 1.2, -1.6);
    this.root.add(rim);
    // the raking light: hard, a few degrees above the keys, its shadow map
    // fitted tightly around the keyboard and the hands over it
    const rake = new THREE.DirectionalLight(0xffdcb2, 2.2);
    rake.castShadow = true;
    rake.shadow.mapSize.set(2048, 2048);
    rake.shadow.bias = -0.00025;
    rake.shadow.normalBias = 0.0008;
    rake.shadow.radius = 1;
    this.root.add(rake, rake.target);
    this.lights = { sun, window: win, fill, rim, rake };

    const d = this.buildDust();
    this.dust = d.points;
    this.dustMat = d.mat;
    this.root.add(this.dust);
  }

  applySettings(s: LightSettings) {
    const warm =
      s.warmth >= 0 ? new THREE.Color(0xfff1e0).lerp(new THREE.Color(0xffb46a), s.warmth) : new THREE.Color(0xfff1e0).lerp(new THREE.Color(0x8fb0ff), -s.warmth);
    this.lights.sun.color.copy(warm);
    this.sunBase = { sun: 3.6 * s.sun, window: 2.6 * s.sun, dust: s.shaftsOn ? s.shafts / 0.6 : 0 };
    this.lights.sun.intensity = this.sunBase.sun * this.clouds;
    this.lights.window.intensity = this.sunBase.window * this.clouds;
    this.lights.window.color.copy(warm).lerp(new THREE.Color(0xffffff), 0.35);
    this.dustMat.uniforms.uStrength.value = this.sunBase.dust * this.clouds;
    this.dust.visible = s.shaftsOn && s.shafts > 0.001;
    const rake = this.lights.rake;
    rake.visible = s.rakeOn && s.rake > 0.001;
    rake.intensity = 2.2 * s.rake;
    rake.color.copy(
      s.warmth >= 0 ? new THREE.Color(0xfff0dc).lerp(new THREE.Color(0xffc488), s.warmth) : new THREE.Color(0xfff0dc).lerp(new THREE.Color(0xa4bcff), -s.warmth),
    );
    this.aimRake(s.rakeAngle, s.rakeDir);
    // with bounced light on, the flat sky/ground fill gives way to light from the room itself
    this.lights.fill.intensity = 0.45 * s.fill * (s.bounceOn ? 1 - 0.85 * Math.min(1, s.bounce) : 1);
    this.soft.intensity = 1.35 * s.fill;
    this.lights.rim.intensity = 0.7 * s.rim;
    this.shaftColor.copy(warm);
    this.dustMat.uniforms.uColor.value.copy(warm);
  }

  private buildRoom() {
    // floor: old oak boards
    const floorMat = patch(new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.62 }), {
      afterMap: /* glsl */ `
      {
        float board = floor(vWPos.x / 0.14);
        float seam = smoothstep(0.0, 0.004, abs(fract(vWPos.x / 0.14) - 0.5) * 0.14 - 0.0685);
        float off = fract(sin(board * 12.9898) * 43758.5453);
        float grain = mpFbm(vec3(vWPos.x * 40.0, 0.0, vWPos.z * 2.0 + off * 7.0));
        vec3 c = mix(vec3(0.07, 0.042, 0.024), vec3(0.16, 0.1, 0.055), grain * 0.9 + off * 0.25);
        diffuseColor.rgb = c * (0.55 + 0.45 * (1.0 - seam));
      }`,
      afterRough: /* glsl */ `roughnessFactor = clamp(0.45 + mpFbm(vWPos * 6.0) * 0.4, 0.2, 1.0);`,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.root.add(floor);

    // walls: aged plaster in a deep olive-grey
    const wallMat = patch(new THREE.MeshStandardMaterial({ color: 0x35322a, roughness: 0.95 }), {
      afterMap: /* glsl */ `diffuseColor.rgb *= 0.7 + 0.5 * mpFbm(vWPos * vec3(3.0, 3.0, 3.0)) + 0.1 * mpNoise(vWPos * 60.0);`,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), wallMat);
    back.position.set(0, FLOOR_Y + 2, -0.7);
    back.receiveShadow = true;
    this.root.add(back);
    // left wall with a window opening (four panels around it)
    const lw = new THREE.Group();
    const H = 4;
    const D = 5;
    const addPanel = (w: number, h: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.rotation.y = Math.PI / 2;
      m.position.set(WINDOW.x, y, z);
      m.receiveShadow = true;
      lw.add(m);
    };
    const wz0 = WINDOW.z - WINDOW.w / 2;
    const wz1 = WINDOW.z + WINDOW.w / 2;
    const wy0 = WINDOW.y - WINDOW.h / 2;
    const wy1 = WINDOW.y + WINDOW.h / 2;
    addPanel(wz0 + 0.7, H, FLOOR_Y + H / 2, (wz0 - 0.7) / 2);
    addPanel(D / 2 - wz1, H, FLOOR_Y + H / 2, (wz1 + D / 2) / 2);
    addPanel(WINDOW.w, wy0 - FLOOR_Y, (wy0 + FLOOR_Y) / 2, WINDOW.z);
    addPanel(WINDOW.w, FLOOR_Y + H - wy1, (wy1 + FLOOR_Y + H) / 2, WINDOW.z);
    this.root.add(lw);
    // the bright window (seen only in reflections and at the edge of frame)
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(WINDOW.w, WINDOW.h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d8).multiplyScalar(6), toneMapped: false }),
    );
    glass.rotation.y = Math.PI / 2;
    glass.position.set(WINDOW.x - 0.03, WINDOW.y, WINDOW.z);
    this.root.add(glass);
    // window frame bars
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.7 });
    const bar = (w: number, h: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, w), frameMat);
      b.position.set(WINDOW.x - 0.01, y, z);
      b.castShadow = true;
      this.root.add(b);
    };
    const bw = WINDOW_BARS.half * 2;
    for (const z of WINDOW_BARS.vertical) bar(bw, WINDOW.h, WINDOW.y, z);
    for (const y of WINDOW_BARS.horizontal) bar(WINDOW.w, bw, y, WINDOW.z);
  }

  /** the direction light travels from the raking source (unit) */
  static rakeDirection(angleDeg: number, dirDeg: number): THREE.Vector3 {
    const el = THREE.MathUtils.degToRad(angleDeg);
    const az = THREE.MathUtils.degToRad(dirDeg);
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), -Math.sin(el), -Math.cos(el) * Math.sin(az)).normalize();
  }

  /** point the raking light and fit its shadow camera around the keyboard and the hands above it */
  private interiorOpen = false;
  private rakeAim: [number, number] = [0, 0];

  /** with the piano open, the raking light's shadow also has to cover the action and strings inside */
  setInteriorOpen(open: boolean) {
    if (open === this.interiorOpen) return;
    this.interiorOpen = open;
    this.aimRake(...this.rakeAim);
  }

  private aimRake(angleDeg: number, dirDeg: number) {
    this.rakeAim = [angleDeg, dirDeg];
    const key = `${angleDeg.toFixed(2)}:${dirDeg.toFixed(2)}:${this.interiorOpen}`;
    if (key === this.rakeKey) return;
    this.rakeKey = key;
    const rake = this.lights.rake;
    const dir = Environment.rakeDirection(angleDeg, dirDeg);
    const target = new THREE.Vector3(0, 0, -0.04);
    rake.target.position.copy(target);
    rake.position.copy(target).addScaledVector(dir, -4);
    rake.updateMatrixWorld();
    rake.target.updateMatrixWorld();
    // the region whose shadows matter: keys, fallboard edge, hands and forearms
    const view = new THREE.Matrix4().lookAt(rake.position, target, Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const open = this.interiorOpen;
    for (const x of [-0.72, 0.72])
      for (const y of [-0.03, open ? 0.52 : 0.24])
        for (const z of [open ? -0.4 : -0.2, 0.5]) {
          const p = new THREE.Vector3(x, y, z).applyMatrix4(inv);
          lo.min(p);
          hi.max(p);
        }
    const cam = rake.shadow.camera;
    cam.left = lo.x - 0.02;
    cam.right = hi.x + 0.02;
    cam.bottom = lo.y - 0.02;
    cam.top = hi.y + 0.02;
    cam.near = Math.max(0.05, -hi.z - 0.1);
    cam.far = -lo.z + 0.1;
    cam.updateProjectionMatrix();
    rake.shadow.needsUpdate = true;
  }

  private buildDust(): { points: THREE.Points; mat: THREE.ShaderMaterial } {
    const N = 900;
    const seeds = new Float32Array(N * 4);
    let s = 1234567;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) {
      seeds[i * 4] = rnd();
      seeds[i * 4 + 1] = rnd();
      seeds[i * 4 + 2] = rnd();
      seeds[i * 4 + 3] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xffd2a0) },
        uSunDir: { value: this.sunDir },
        uWindow: { value: new THREE.Vector4(WINDOW.x, WINDOW.y, WINDOW.z, 0) },
        uWindowSize: { value: new THREE.Vector2(WINDOW.w, WINDOW.h) },
        uPixel: { value: 600 },
        uStrength: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float uTime; uniform vec3 uSunDir; uniform vec4 uWindow; uniform vec2 uWindowSize; uniform float uPixel;
        varying float vLit; varying float vTw;
        void main() {
          vec3 box = vec3(2.2, 1.3, 1.6);
          vec3 p = (seed.xyz - 0.5) * box + vec3(-0.4, 0.45, 0.15);
          float t = uTime;
          p += vec3(sin(t * 0.11 + seed.w * 40.0), sin(t * 0.07 + seed.x * 30.0), cos(t * 0.09 + seed.y * 50.0)) * 0.05;
          p.y = mod(p.y - t * 0.004 * (0.5 + seed.w) - 0.0, 1.3) - 0.2;
          // inside a shaft? follow the sun back to the window's plane
          float s = (p.x - uWindow.x) / uSunDir.x;
          vec3 q = p - uSunDir * s;
          vec2 off = abs(vec2(q.z - uWindow.z, q.y - uWindow.y)) / (0.5 * uWindowSize);
          float inside = (1.0 - smoothstep(0.85, 1.0, off.x)) * (1.0 - smoothstep(0.85, 1.0, off.y));
          vLit = s > 0.0 ? inside : 0.0;
          vTw = 0.6 + 0.4 * sin(t * (1.0 + seed.z * 3.0) + seed.w * 100.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uPixel * (0.0007 + 0.0009 * seed.z) / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uStrength; varying float vLit; varying float vTw;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(uColor * a * vLit * vTw * 0.9 * uStrength, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 11;
    return { points: pts, mat };
  }

  update(t: number, pixelScale: number) {
    this.dustMat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uPixel.value = pixelScale;
    // thin clouds drifting past the sun: the light breathes by about a tenth over tens of seconds
    this.clouds = 1 + 0.085 * drift(t * 0.035, 71) + 0.03 * drift(t * 0.12, 72);
    this.lights.sun.intensity = this.sunBase.sun * this.clouds;
    this.lights.window.intensity = this.sunBase.window * this.clouds;
    this.dustMat.uniforms.uStrength.value = this.sunBase.dust * this.clouds;
  }

  /** a small environment for reflections: dark room, bright window, dim ceiling */
  static envScene(): THREE.Scene {
    const s = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.BackSide }));
    room.position.y = 1.2;
    s.add(room);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe0b8).multiplyScalar(14) }));
    win.position.set(-2.9, WINDOW.y + 0.05, 0.6);
    win.rotation.y = Math.PI / 2;
    s.add(win);
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6f86a8).multiplyScalar(0.25) }));
    sky.position.set(0, 3.15, 0);
    sky.rotation.x = Math.PI / 2;
    s.add(sky);
    const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8a5a30).multiplyScalar(0.5) }));
    floorGlow.position.set(-0.8, -0.79, 0.7);
    floorGlow.rotation.x = -Math.PI / 2;
    s.add(floorGlow);
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(0.6) }));
    softbox.position.set(1.5, 1.6, 1.8);
    softbox.lookAt(0, 0, 0);
    s.add(softbox);
    return s;
  }
}
