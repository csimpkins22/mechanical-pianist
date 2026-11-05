// The drum stage: a second scene in the same house as the piano, drawn by the
// same renderer and post pipeline, in the same visual language: a room with
// old oak boards and dark plaster, a tall window on the drummer's left behind
// him, late sun through drawn curtains crossing the kit in shafts with dust
// in them, a cool fill, a lamp in the corner for a warm rim, light bounced
// off the room (captured from the lit scene at three heights, two bounces),
// reflections of the room itself in the chrome and bronze, and the piano's
// grade, bloom, grain and motion blur.
//
// The kit stands in the room with its floor at the piano room's floor height
// and the kit's middle where the piano's middle is, so the shared height
// bands of the bounced light and the volumetric pass's dusty air fit it too.
// While this stage is drawn its own bounced light is swapped into the shared
// uniforms and the piano's put back straight after, so the piano stage is
// left exactly as it was.
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { DEFAULT_LIGHTS, FLOOR_Y, type LightSettings } from './Environment';
import { patch, SHARED_UNIFORMS as SHARED } from './shaderPatch';
import type { PostParams, PostPipeline } from './PostPipeline';
import { shutterTime, type Look } from './SceneRenderer';
import { DrumKitModel } from './DrumKitModel';
import type { DrumCameraState } from './DrumCamera';
import type { KitState } from '../drums/KitMotion';
import { DrummerRig, loadDrummer } from '../drums/DrummerRig';
import { createDrummerPalette } from '../drums/drummerMaterials';
import type { DrummerPose } from '../drums/DrummerIK';
import { drift } from '../core/random';

/** where the kit's frame (KitLayout: the floor under the stool) stands in the room */
export const KIT_ORIGIN = new THREE.Vector3(-0.35, FLOOR_Y, 0.47);
/** the window, on the drummer's left behind him (in the room's frame) */
export const DRUM_WINDOW = { x: -2.3, y: 1.52, z: 1.05, w: 1.2, h: 1.7 };
const BARS = { vertical: [DRUM_WINDOW.z - 0.2, DRUM_WINDOW.z + 0.2], horizontal: [DRUM_WINDOW.y + 0.28, DRUM_WINDOW.y - 0.28], half: 0.035 };
/** the room's walls */
const ROOM = { back: 1.75, front: -3.4, left: DRUM_WINDOW.x, right: 2.7, height: 3.4 };
const BOUNCE_GAIN = 0.6;

/**
 * The sun reaches a surface only through the window: follow the light back to
 * the window's plane and test the opening and its bars, with a penumbra that
 * widens with the distance (the sun is half a degree across). For the room's
 * surfaces beyond the sun's shadow map; inside it the wall itself casts the
 * shadow.
 */
function windowCookie<T extends THREE.Material>(mat: T, sunDir: THREE.Vector3): T {
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    inner.call(mat, shader, r);
    const w = DRUM_WINDOW;
    const glsl = /* glsl */ `
    float mpCookie(vec3 p) {
      vec3 d = vec3(${sunDir.x.toFixed(5)}, ${sunDir.y.toFixed(5)}, ${sunDir.z.toFixed(5)});
      float s = (p.x - (${w.x.toFixed(4)})) / d.x;
      if (s <= 0.0) return 0.0;
      vec3 q = p - d * s;
      float pen = 0.004 + s * 0.0045;
      vec2 o = vec2(q.z - (${w.z.toFixed(4)}), q.y - (${w.y.toFixed(4)}));
      float m = (1.0 - smoothstep(${(w.w / 2).toFixed(4)} - pen, ${(w.w / 2).toFixed(4)} + pen, abs(o.x))) * (1.0 - smoothstep(${(w.h / 2).toFixed(4)} - pen, ${(w.h / 2).toFixed(4)} + pen, abs(o.y)));
      for (int i = 0; i < 2; i++) {
        float bz = i == 0 ? ${BARS.vertical[0].toFixed(4)} : ${BARS.vertical[1].toFixed(4)};
        float by = i == 0 ? ${BARS.horizontal[0].toFixed(4)} : ${BARS.horizontal[1].toFixed(4)};
        m *= smoothstep(${BARS.half.toFixed(4)} - pen, ${BARS.half.toFixed(4)} + pen, abs(q.z - bz));
        m *= smoothstep(${BARS.half.toFixed(4)} - pen, ${BARS.half.toFixed(4)} + pen, abs(q.y - by));
      }
      return m;
    }`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>\n${glsl}`)
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\t#if ( UNROLLED_LOOP_INDEX == 0 )\n\t\tdirectLight.color *= mpCookie( vWPos );\n\t\t#endif',
        ),
      );
  };
  return mat;
}

export class DrumStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.02, 30);
  readonly kit: DrumKitModel;
  /** the robot drummer on the stool (loaded by prepare(); null until then, or if its model could not load) */
  drummer: DrummerRig | null = null;
  private drummerMeshes: THREE.Object3D[] = [];
  readonly sunDir = new THREE.Vector3(1.75, -1.2, -1.05).normalize();
  private sun: THREE.DirectionalLight;
  private win: THREE.RectAreaLight;
  private fill: THREE.HemisphereLight;
  private soft: THREE.DirectionalLight;
  private lamp: THREE.PointLight;
  private dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private shaftColor = new THREE.Color(0xffd2a0);
  private clouds = 1;
  private base = { sun: 3.6, window: 2.6, dust: 1 };
  private lights: LightSettings = DEFAULT_LIGHTS;
  /** this stage's bounced light (three probes of nine coefficients), and the piano's while this one draws */
  private sh = Array.from({ length: 27 }, () => new THREE.Vector3());
  private keep = Array.from({ length: 27 }, () => new THREE.Vector3());
  private prevViewProj = new THREE.Matrix4();
  private hasPrev = false;
  private prevCam = new THREE.PerspectiveCamera();
  private mapSize = 0;
  ready = false;
  private relightTimer = 0;
  /** called when the room's light has been captured again (redraw a paused frame) */
  onRelit?: () => void;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private post: PostPipeline,
  ) {
    RectAreaLightUniformsLib.init();
    this.camera.filmGauge = 36;
    this.scene.background = new THREE.Color(0x020202);
    this.scene.fog = new THREE.FogExp2(0x060403, 0.11);
    this.buildRoom();
    this.kit = new DrumKitModel();
    this.kit.root.position.copy(KIT_ORIGIN);
    this.scene.add(this.kit.root);

    // the sun through the window: warm, low, from behind the drummer's left
    const sun = new THREE.DirectionalLight(0xffd2a0, 3.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.0015;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.fitSun();
    const win = new THREE.RectAreaLight(0xffe2bf, 2.6, DRUM_WINDOW.w, DRUM_WINDOW.h);
    win.position.set(DRUM_WINDOW.x + 0.02, DRUM_WINDOW.y, DRUM_WINDOW.z);
    win.lookAt(KIT_ORIGIN.x, 0, KIT_ORIGIN.z - 0.4);
    this.scene.add(win);
    this.win = win;
    this.fill = new THREE.HemisphereLight(0x7f95b8, 0x2a1810, 0.45);
    this.scene.add(this.fill);
    // the room's light bounced back from the front, so the drums' fronts are not lost
    this.soft = new THREE.DirectionalLight(0xffe6cc, 1.4);
    this.soft.position.set(-1.4, 1.6, -2.8);
    this.scene.add(this.soft);
    // a practical: an old standard lamp in the corner behind the floor tom, its shade glowing warm
    this.lamp = new THREE.PointLight(0xffb36b, 2.2, 0, 2);
    const lampAt = new THREE.Vector3(1.95, FLOOR_Y + 1.45, 1.25);
    this.lamp.position.copy(lampAt);
    this.scene.add(this.lamp);
    this.scene.add(buildLamp(lampAt));
    // the lamp is also the rim light: a directional rim casts no shadow here and, however faint, glints
    // white off the chrome tom holder and lugs that should be in the drums' own shadow
    const d = buildDust(this.sunDir);
    this.dust = d.points;
    this.dustMat = d.mat;
    this.scene.add(this.dust);
  }

  /** the sun's shadow camera, fitted tightly around the kit as the sun sees it */
  private fitSun() {
    const sun = this.sun;
    const centre = KIT_ORIGIN.clone().add(new THREE.Vector3(0.1, 0.6, -0.57));
    sun.position.copy(centre).addScaledVector(this.sunDir, -4);
    sun.target.position.copy(centre);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(sun.position, centre, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [-1.15, 1.35])
      for (const y of [0, 1.45])
        for (const z of [-1.5, 0.45]) {
          const p = new THREE.Vector3(x, y, z).add(KIT_ORIGIN).applyMatrix4(inv);
          lo.min(p);
          hi.max(p);
        }
    const cam = sun.shadow.camera;
    cam.left = lo.x - 0.03;
    cam.right = hi.x + 0.03;
    cam.bottom = lo.y - 0.03;
    cam.top = hi.y + 0.03;
    // from close to the light, so the window's wall and bars are in the map too
    cam.near = 0.05;
    cam.far = -lo.z + 0.3;
    cam.updateProjectionMatrix();
  }

  private buildRoom() {
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
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.right - ROOM.left, ROOM.back - ROOM.front), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((ROOM.left + ROOM.right) / 2, FLOOR_Y, (ROOM.back + ROOM.front) / 2);
    floor.receiveShadow = true;
    windowCookie(floorMat, this.sunDir);
    this.scene.add(floor);
    // aged plaster in a deep olive-grey, as in the piano's room; a dado rail of dark wood
    const wallMat = patch(new THREE.MeshStandardMaterial({ color: 0x35322a, roughness: 0.95 }), {
      afterMap: /* glsl */ `diffuseColor.rgb *= (0.7 + 0.5 * mpFbm(vWPos * vec3(3.0, 3.0, 3.0)) + 0.1 * mpNoise(vWPos * 60.0)) * (vWPos.y < ${(FLOOR_Y + 0.92).toFixed(3)} ? 0.55 : 1.0);`,
    });
    windowCookie(wallMat, this.sunDir);
    const H = ROOM.height;
    const wall = (w: number, h: number, pos: THREE.Vector3, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.copy(pos);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.scene.add(m);
    };
    const W = ROOM.right - ROOM.left;
    const cx = (ROOM.left + ROOM.right) / 2;
    wall(W, H, new THREE.Vector3(cx, FLOOR_Y + H / 2, ROOM.back), Math.PI);
    wall(W, H, new THREE.Vector3(cx, FLOOR_Y + H / 2, ROOM.front), 0);
    wall(ROOM.back - ROOM.front, H, new THREE.Vector3(ROOM.right, FLOOR_Y + H / 2, (ROOM.back + ROOM.front) / 2), -Math.PI / 2);
    // the left wall, around the window
    const wz0 = DRUM_WINDOW.z - DRUM_WINDOW.w / 2;
    const wz1 = DRUM_WINDOW.z + DRUM_WINDOW.w / 2;
    const wy0 = DRUM_WINDOW.y - DRUM_WINDOW.h / 2;
    const wy1 = DRUM_WINDOW.y + DRUM_WINDOW.h / 2;
    const lw = (w: number, h: number, y: number, z: number) => {
      wall(w, h, new THREE.Vector3(ROOM.left, y, z), Math.PI / 2);
      // the window's wall stops the sun everywhere but through the window
      const last = this.scene.children[this.scene.children.length - 1] as THREE.Mesh;
      last.castShadow = true;
    };
    lw(wz0 - ROOM.front, H, FLOOR_Y + H / 2, (wz0 + ROOM.front) / 2);
    lw(ROOM.back - wz1, H, FLOOR_Y + H / 2, (wz1 + ROOM.back) / 2);
    lw(DRUM_WINDOW.w, wy0 - FLOOR_Y, (wy0 + FLOOR_Y) / 2, DRUM_WINDOW.z);
    lw(DRUM_WINDOW.w, FLOOR_Y + H - wy1, (wy1 + FLOOR_Y + H) / 2, DRUM_WINDOW.z);
    // a dado rail and skirting in dark wood along the walls
    const rail = new THREE.MeshStandardMaterial({ color: 0x140d08, roughness: 0.55 });
    const strip = (len: number, pos: THREE.Vector3, ry: number, h: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, h, d), rail);
      m.position.copy(pos);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.scene.add(m);
    };
    for (const [y, h, d] of [
      [FLOOR_Y + 0.06, 0.12, 0.02],
      [FLOOR_Y + 0.92, 0.05, 0.025],
    ] as const) {
      strip(W, new THREE.Vector3(cx, y, ROOM.back - d / 2), 0, h, d);
      strip(ROOM.back - ROOM.front, new THREE.Vector3(ROOM.right - d / 2, y, (ROOM.back + ROOM.front) / 2), Math.PI / 2, h, d);
      if (y < wy0) strip(ROOM.back - ROOM.front, new THREE.Vector3(ROOM.left + d / 2, y, (ROOM.back + ROOM.front) / 2), Math.PI / 2, h, d);
    }
    // the bright window and its heavy glazing bars
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(DRUM_WINDOW.w, DRUM_WINDOW.h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d8).multiplyScalar(6), toneMapped: false }),
    );
    glass.rotation.y = Math.PI / 2;
    glass.position.set(DRUM_WINDOW.x - 0.03, DRUM_WINDOW.y, DRUM_WINDOW.z);
    this.scene.add(glass);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.7 });
    const bar = (w: number, h: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, w), frameMat);
      b.position.set(DRUM_WINDOW.x - 0.01, y, z);
      b.castShadow = true;
      this.scene.add(b);
    };
    const bw = BARS.half * 2;
    for (const z of BARS.vertical) bar(bw, DRUM_WINDOW.h, DRUM_WINDOW.y, z);
    for (const y of BARS.horizontal) bar(DRUM_WINDOW.w, bw, y, DRUM_WINDOW.z);
    // the window's deep reveal (the wall's thickness), catching the sun
    const reveal = new THREE.MeshStandardMaterial({ color: 0x4a443a, roughness: 0.9 });
    for (const [w, h, y, z] of [
      [0.25, DRUM_WINDOW.h, DRUM_WINDOW.y, wz0],
      [0.25, DRUM_WINDOW.h, DRUM_WINDOW.y, wz1],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), reveal);
      m.position.set(DRUM_WINDOW.x - w / 2, y, z);
      this.scene.add(m);
    }
  }

  /** the light settings (the visual style's), as the piano's room takes them */
  setLights(s: LightSettings = DEFAULT_LIGHTS) {
    this.lights = s;
    const warm = s.warmth >= 0 ? new THREE.Color(0xfff1e0).lerp(new THREE.Color(0xffb46a), s.warmth) : new THREE.Color(0xfff1e0).lerp(new THREE.Color(0x8fb0ff), -s.warmth);
    this.sun.color.copy(warm);
    this.base = { sun: 3.6 * s.sun, window: 2.6 * s.sun, dust: s.shaftsOn ? s.shafts / 0.6 : 0 };
    this.sun.intensity = this.base.sun * this.clouds;
    this.win.intensity = this.base.window * this.clouds;
    this.win.color.copy(warm).lerp(new THREE.Color(0xffffff), 0.35);
    this.dustMat.uniforms.uStrength.value = this.base.dust * this.clouds;
    this.dustMat.uniforms.uColor.value.copy(warm);
    this.dust.visible = s.shaftsOn && s.shafts > 0.001;
    this.fill.intensity = 0.45 * s.fill * (s.bounceOn ? 1 - 0.85 * Math.min(1, s.bounce) : 1);
    this.soft.intensity = 1.4 * s.fill;
    this.lamp.intensity = 2.2 * Math.max(0.3, s.fill) * (0.7 + 0.3 * s.rim);
    this.shaftColor.copy(warm);
    if (this.ready) {
      clearTimeout(this.relightTimer);
      this.relightTimer = window.setTimeout(() => void this.capture(1).then(() => this.onRelit?.()), 300);
    }
  }

  /** load the robot drummer and seat it at the kit (in the kit's frame: KitLayout's, as the IK poses it) */
  private async loadDrummer() {
    try {
      const palette = createDrummerPalette();
      const model = await loadDrummer('./assets/robot_drummer.glb', palette);
      const rig = new DrummerRig(model, palette);
      rig.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        this.drummerMeshes.push(m);
      });
      this.kit.root.add(rig.root);
      this.drummer = rig;
    } catch (e) {
      console.warn('the robot drummer could not be loaded; the kit plays alone', e);
    }
  }

  /** pose the drummer */
  setDrummer(pose: DrummerPose) {
    this.drummer?.apply(pose);
  }

  /** compile, capture the room's reflections and its bounced light (twice: two bounces) */
  async prepare() {
    await this.loadDrummer();
    this.setLights(this.lights);
    this.kit.update(restState());
    this.scene.updateMatrixWorld();
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    this.captureReflections();
    await this.capture(2);
    this.ready = true;
  }

  /** the room as the chrome and bronze see it: captured from the middle of the kit, the kit itself left out */
  private captureReflections() {
    const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.05, 20, rt);
    cam.position.copy(KIT_ORIGIN).add(new THREE.Vector3(0.1, 0.95, -0.57));
    this.kit.root.visible = false;
    this.dust.visible = false;
    this.scene.add(cam);
    this.withOwnBounce(() => cam.update(this.renderer, this.scene));
    this.scene.remove(cam);
    this.kit.root.visible = true;
    this.dust.visible = this.lights.shaftsOn && this.lights.shafts > 0.001;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const old = this.scene.environment;
    this.scene.environment = pmrem.fromCubemap(rt.texture).texture;
    this.scene.environmentIntensity = 0.9;
    old?.dispose();
    pmrem.dispose();
    rt.dispose();
  }

  /**
   * Bounced light: the lit room captured at three heights in front of the
   * kit (by the floor, at the drums, at the cymbals; the same height bands as
   * the piano's) and reduced to irradiance. Each pass includes the last bounce.
   */
  private capturing = false;
  async capture(passes: number) {
    if (this.capturing) return;
    this.capturing = true;
    try {
      const rt = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType });
      const cam = new THREE.CubeCamera(0.01, 20, rt);
      const ys = SHARED.uBounceY.value;
      const spots = [new THREE.Vector3(-0.2, ys.x, -0.75), new THREE.Vector3(-0.25, ys.y, -0.55), new THREE.Vector3(-0.2, ys.z, -0.6)];
      for (let pass = 0; pass < passes; pass++) {
        const next: THREE.Vector3[] = [];
        for (let i = 0; i < 3; i++) {
          cam.position.copy(spots[i]);
          this.scene.add(cam);
          const dust = this.dust.visible;
          this.dust.visible = false;
          this.withOwnBounce(() => cam.update(this.renderer, this.scene));
          this.dust.visible = dust;
          this.scene.remove(cam);
          const probe = await LightProbeGenerator.fromCubeRenderTarget(this.renderer, rt);
          for (let k = 0; k < 9; k++) next.push(probe.sh.coefficients[k].clone());
        }
        for (let k = 0; k < 27; k++) this.sh[k].copy(next[k]);
      }
      rt.dispose();
    } finally {
      this.capturing = false;
    }
  }

  /** draw with this stage's bounced light in the shared uniforms, then put the piano's back */
  private withOwnBounce(fn: () => void) {
    const shared = SHARED.uBounceSH.value;
    const gain = SHARED.uBounce.value;
    for (let k = 0; k < 27; k++) {
      this.keep[k].copy(shared[k]);
      shared[k].copy(this.sh[k]);
    }
    const ls = this.lights;
    SHARED.uBounce.value = ls.bounceOn ? BOUNCE_GAIN * ls.bounce : 0;
    try {
      fn();
    } finally {
      for (let k = 0; k < 27; k++) shared[k].copy(this.keep[k]);
      SHARED.uBounce.value = gain;
    }
  }

  private applyCamera(c: THREE.PerspectiveCamera, cam: DrumCameraState, aspect: number) {
    c.aspect = aspect;
    c.filmGauge = 36;
    c.near = 0.02;
    c.far = 30;
    c.position.copy(cam.position);
    if (cam.up) c.up.copy(cam.up);
    else c.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0);
    c.lookAt(cam.target);
    c.setFocalLength(cam.focalLength);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  /** for motion blur: the kit, the drummer and the camera as the shutter opened */
  setPrevious(state: KitState, cam: DrumCameraState, aspect: number, pose?: DrummerPose) {
    this.kit.update(state);
    if (pose) this.drummer?.apply(pose);
    this.scene.updateMatrixWorld();
    for (const o of this.kit.moving) ((o.userData.prevMW ??= new THREE.Matrix4()) as THREE.Matrix4).copy(o.matrixWorld);
    // every part of the drummer moves (the sticks fastest): each mesh's own transform as the shutter opened
    for (const o of this.drummerMeshes) ((o.userData.prevMW ??= new THREE.Matrix4()) as THREE.Matrix4).copy(o.matrixWorld);
    this.kit.keepPrevious();
    this.applyCamera(this.prevCam, cam, aspect);
    this.prevViewProj.multiplyMatrices(this.prevCam.projectionMatrix, this.prevCam.matrixWorldInverse);
    this.hasPrev = true;
  }

  update(state: KitState, t: number) {
    this.kit.update(state);
    // thin clouds over the sun, as in the piano's room
    this.clouds = 1 + 0.085 * drift(t * 0.035, 71) + 0.03 * drift(t * 0.12, 72);
    this.sun.intensity = this.base.sun * this.clouds;
    this.win.intensity = this.base.window * this.clouds;
    this.dustMat.uniforms.uStrength.value = this.base.dust * this.clouds;
    this.dustMat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uPixel.value = this.post.height * 0.9;
  }

  render(cam: DrumCameraState, t: number, look: Look, aspect: number) {
    // the sun's shadow map: as large as the quality allows
    const size = this.post.quality === 'high' ? 4096 : 2048;
    if (size !== this.mapSize) {
      this.mapSize = size;
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.applyCamera(this.camera, cam, aspect);
    const L = look;
    const ls = this.lights;
    const w = L.warmth;
    const sunShadow = this.sun.shadow.map?.depthTexture;
    const params: PostParams = {
      focalLength: cam.focalLength,
      fstop: cam.fstop / Math.max(0.05, L.dofScale),
      focus: cam.focus,
      dof: L.dof,
      // (the drum room is larger and darker than the piano's corner: half a stop more)
      exposure: L.exposure * 0.82 * 1.4 * (ls.bounceOn ? 1 - 0.05 * Math.min(1, ls.bounce) : 1),
      bloomStrength: 0.3 * L.bloom,
      bloomRadius: 0.5,
      bloomThreshold: 1.6,
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
      // the kit has far more chrome catching the window than the piano: gentler streaks
      streaks: L.streaksOn ? 0.18 * 0.55 * L.streaks : 0,
      letterbox: L.letterboxOn ? L.letterbox : 0,
      motion: this.hasPrev && shutterTime(L) > 0 ? { prevViewProj: this.prevViewProj } : null,
      ao: L.aoOn ? L.ao : 0,
      shafts:
        ls.shaftsOn && ls.shafts > 0.001
          ? {
              strength: ls.shafts * ls.sun * this.clouds,
              color: this.shaftColor,
              sunDir: this.sunDir,
              window: DRUM_WINDOW,
              bars: BARS,
              shadow: sunShadow ? { map: sunShadow, matrix: this.sun.shadow.matrix } : null,
              time: t,
            }
          : null,
    };
    const hidden = this.post.prepassHidden;
    this.post.prepassHidden = [this.dust];
    this.withOwnBounce(() => this.post.render(this.scene, this.camera, params));
    this.post.prepassHidden = hidden;
    this.hasPrev = false;
  }
}

/** a standard lamp: a fabric shade lit from inside, a brass stem on a round base */
function buildLamp(at: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.22, 0.26, 40, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a, emissive: new THREE.Color(0xffb060), emissiveIntensity: 1.6, side: THREE.DoubleSide, roughness: 1 }),
  );
  shade.position.copy(at).add(new THREE.Vector3(0, 0.02, 0));
  g.add(shade);
  const brass = new THREE.MeshStandardMaterial({ color: 0x9a7a40, metalness: 1, roughness: 0.35 });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, at.y - FLOOR_Y, 12), brass);
  stem.position.set(at.x, (at.y + FLOOR_Y) / 2, at.z);
  stem.castShadow = true;
  g.add(stem);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.03, 32), brass);
  base.position.set(at.x, FLOOR_Y + 0.015, at.z);
  g.add(base);
  return g;
}

/** the kit at rest */
export function restState(): KitState {
  const z = { x: 0, z: 0 };
  return {
    t: 0,
    cymbals: { crash: { ...z, drop: 0 }, ride: { ...z, drop: 0 }, hihat: { ...z, drop: 0 } },
    stands: { crash: z, ride: z, hihat: z },
    hihatClosed: 1,
    hihatGap: 0,
    beater: 0,
    heads: { kick: 0, snare: 0, tom1: 0, tom2: 0, floorTom: 0 },
    buzz: 0,
    toms: { tom1: z, tom2: z, floorTom: z },
  };
}

/** dust drifting in the air around the kit, lit only inside the sun's shafts (as in the piano's room) */
function buildDust(sunDir: THREE.Vector3): { points: THREE.Points; mat: THREE.ShaderMaterial } {
  const N = 900;
  const seeds = new Float32Array(N * 4);
  let s = 7654321;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < N * 4; i++) seeds[i] = rnd();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xffd2a0) },
      uSunDir: { value: sunDir },
      uWindow: { value: new THREE.Vector4(DRUM_WINDOW.x, DRUM_WINDOW.y, DRUM_WINDOW.z, 0) },
      uWindowSize: { value: new THREE.Vector2(DRUM_WINDOW.w, DRUM_WINDOW.h) },
      uPixel: { value: 600 },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed;
      uniform float uTime; uniform vec3 uSunDir; uniform vec4 uWindow; uniform vec2 uWindowSize; uniform float uPixel;
      varying float vLit; varying float vTw;
      void main() {
        vec3 box = vec3(2.4, 1.5, 1.8);
        vec3 p = (seed.xyz - 0.5) * box + vec3(-0.3, 0.45, -0.05);
        float t = uTime;
        p += vec3(sin(t * 0.11 + seed.w * 40.0), sin(t * 0.07 + seed.x * 30.0), cos(t * 0.09 + seed.y * 50.0)) * 0.05;
        p.y = mod(p.y - t * 0.004 * (0.5 + seed.w), 1.5) - 0.3;
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
