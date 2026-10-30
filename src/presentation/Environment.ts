// The music room and its light: a window off to the bass side lets low, warm
// late-afternoon sun rake across the keyboard; the room falls away into
// shadow. Dust drifts through the beam. Everything that moves is a pure
// function of the performance time.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { NOISE_GLSL, patch } from './shaderPatch';

export const FLOOR_Y = -0.72;
const WINDOW = { x: -2.0, y: 0.75, z: 0.55, w: 1.1, h: 1.5 };

export interface LightRig {
  sun: THREE.DirectionalLight;
  window: THREE.RectAreaLight;
  fill: THREE.HemisphereLight;
  rim: THREE.DirectionalLight;
}

export interface LightSettings {
  sun: number;
  warmth: number; // 0 = neutral, 1 = deep amber
  fill: number;
  rim: number;
}

export const DEFAULT_LIGHTS: LightSettings = { sun: 1, warmth: 0.65, fill: 0.7, rim: 1 };

export class Environment {
  readonly root = new THREE.Group();
  readonly lights: LightRig;
  readonly sunDir = new THREE.Vector3();
  private dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private beam: THREE.Mesh;
  private soft!: THREE.DirectionalLight;

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
    sc.near = 1.2;
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
    this.lights = { sun, window: win, fill, rim };

    this.beam = this.buildBeam(target);
    this.root.add(this.beam);
    const d = this.buildDust();
    this.dust = d.points;
    this.dustMat = d.mat;
    this.root.add(this.dust);
  }

  applySettings(s: LightSettings) {
    const warm = new THREE.Color(0xfff1e0).lerp(new THREE.Color(0xffb46a), s.warmth);
    this.lights.sun.color.copy(warm);
    this.lights.sun.intensity = 3.6 * s.sun;
    this.lights.window.intensity = 2.6 * s.sun;
    this.lights.window.color.copy(warm).lerp(new THREE.Color(0xffffff), 0.35);
    this.lights.fill.intensity = 0.45 * s.fill;
    this.soft.intensity = 1.35 * s.fill;
    this.lights.rim.intensity = 0.7 * s.rim;
    (this.beam.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(warm);
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
    bar(0.04, WINDOW.h, WINDOW.y, WINDOW.z);
    bar(WINDOW.w, 0.04, WINDOW.y + 0.2, WINDOW.z);
    bar(WINDOW.w, 0.04, WINDOW.y - 0.35, WINDOW.z);
  }

  /** a faint shaft of sunlight through the dusty air, aimed at the keys */
  private buildBeam(target: THREE.Vector3): THREE.Mesh {
    const len = 3.2;
    const geo = new THREE.CylinderGeometry(0.42, 0.62, len, 32, 1, true);
    geo.translate(0, -len / 2, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffd2a0) }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vP; varying vec3 vN; varying vec3 vW;
        void main() { vP = position; vN = normalize(normalMatrix * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime;
        varying vec3 vP; varying vec3 vN; varying vec3 vW;
        ${NOISE_GLSL}
        void main() {
          float along = clamp(-vP.y / 3.2, 0.0, 1.0);
          float edge = pow(abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0))), 1.6);
          float n = mpFbm(vW * 2.2 + vec3(uTime * 0.03, 0.0, uTime * 0.02));
          float a = edge * (0.5 + 0.8 * n) * smoothstep(0.0, 0.35, along) * (1.0 - smoothstep(0.75, 1.0, along));
          gl_FragColor = vec4(uColor * a * 0.008, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(target).addScaledVector(this.sunDir, -2.9);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.sunDir);
    m.renderOrder = 10;
    m.frustumCulled = false;
    return m;
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
        uBeamOrigin: { value: new THREE.Vector3(0.05, -0.02, -0.06) },
        uPixel: { value: 600 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float uTime; uniform vec3 uSunDir; uniform vec3 uBeamOrigin; uniform float uPixel;
        varying float vLit; varying float vTw;
        void main() {
          vec3 box = vec3(2.2, 1.3, 1.6);
          vec3 p = (seed.xyz - 0.5) * box + vec3(-0.4, 0.45, 0.15);
          float t = uTime;
          p += vec3(sin(t * 0.11 + seed.w * 40.0), sin(t * 0.07 + seed.x * 30.0), cos(t * 0.09 + seed.y * 50.0)) * 0.05;
          p.y = mod(p.y - t * 0.004 * (0.5 + seed.w) - 0.0, 1.3) - 0.2;
          // inside the sunbeam?
          vec3 rel = p - uBeamOrigin;
          float along = dot(rel, uSunDir);
          float dist = length(rel - along * uSunDir);
          vLit = smoothstep(0.55, 0.2, dist) * smoothstep(-3.0, -0.6, along);
          vTw = 0.6 + 0.4 * sin(t * (1.0 + seed.z * 3.0) + seed.w * 100.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uPixel * (0.0007 + 0.0009 * seed.z) / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vLit; varying float vTw;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(uColor * a * vLit * vTw * 0.9, 1.0);
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
    (this.beam.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
  }

  /** a small environment for reflections: dark room, bright window, dim ceiling */
  static envScene(): THREE.Scene {
    const s = new THREE.Scene();
    const room = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.BackSide }));
    room.position.y = 1.2;
    s.add(room);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe0b8).multiplyScalar(14) }));
    win.position.set(-2.9, 0.8, 0.6);
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
