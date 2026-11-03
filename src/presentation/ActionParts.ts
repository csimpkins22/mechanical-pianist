// The upright's action below the hammers: the mechanism that carries each key
// stroke to its hammer, built from the same layout as the hammers and strings
// (ActionLayout.ts) and posed every frame from the FrameState, so the chain
// can be followed part by part.
//
//   key        pivots on its balance pin on the balance rail; behind it the key
//              runs on under the action, cranked toward its hammer, and its
//              back rises as the front goes down
//   capstan    a brass button on the key's back, lifting the wippen's heel
//   wippen     a lever turning in its flange on the wippen rail, carrying
//   jack       which stands on the wippen under the hammer butt and pushes it
//              round; at let-off its toe meets the let-off button and it slips
//              forward from under the butt, to spring back as the key rises
//   bridle     a white tape from the hammer's catcher to the bridle wire on the
//              front of the wippen, slack, swaying a little after each blow
//   spoon      a brass wire on the wippen that pushes the damper lever's tail
//              toward the strings, taking the damper off them
//   backcheck  a felt-faced block on its wire at the front of the wippen, that
//              the hammer's catcher lands in as it comes back from the string:
//              the felt gives under it and springs it back (ActionMechanics'
//              settle), and holds it while the key is down. The wire leans in
//              as the key goes down and out of the catcher's way as it rises
//              (our keyboard's lever alone would not move it far enough)
//
// and the small parts: balance pins and their felt punchings, the back rail
// cloth, the main rail with a flange screw for every hammer, centre pins at
// every pivot, the let-off rail and its buttons, bolts in the action brackets.
//
// The key's back moves only as much as the keyboard's real lever allows (a
// millimetre or two at the capstan); the action takes it from there. Each jack
// keeps its foot on the wippen and its head under the butt while it drives it,
// so its length follows the two by a few percent rather than open a gap.
//
// New parts have plain placeholder materials (wood by vertex colour, brass,
// steel, white cloth); the shared wood and steel are the interior's own.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KEYS, KEY_COUNT, LOWEST_MIDI, PIVOT_Y, keyAngle } from '../core/keyboard';
import { hash01 } from '../core/random';
import { HAMMER_CHECK, HAMMER_LETOFF, JACK_TRIP_AT, UNDAMPED_FROM } from '../performance/ActionMechanics';
import type { FrameState } from '../performance/PerformanceTimeline';
import { BASS_N, CROWN, DAMPER_SWING, HAMMER_REST, HAMMER_SPAN, HAMMER_X, SHANK, STRIKE_Y, STRUT_X, stringRadius, stringZ } from './ActionLayout';
import { patch } from './shaderPatch';

type C3 = [number, number, number];
const N_DAMPED = UNDAMPED_FROM - LOWEST_MIDI;

// ---------------------------------------------------------------- colours (placeholders)
const KEYWOOD: C3 = [0.8, 0.72, 0.56];
const MAPLE: C3 = [0.86, 0.72, 0.52];
const WALNUT: C3 = [0.25, 0.16, 0.1];
const BEECH: C3 = [0.74, 0.58, 0.4];
const BUCKSKIN: C3 = [0.72, 0.6, 0.44];
const RED_FELT: C3 = [0.42, 0.07, 0.07];
const GREEN_FELT: C3 = [0.17, 0.32, 0.2];
const CLOTH: C3 = [0.12, 0.09, 0.08];
const STEEL: C3 = [0.62, 0.62, 0.64];

// ---------------------------------------------------------------- where things are
/** how the jack stands: its foot on the wippen (wippen-local), and where its head pushes the butt (hammer-local) */
const JACK_FOOT: C3 = [0, 0.012, 0.013];
const BUTT_HEEL: C3 = [0, -0.013, 0.012];
/** how far a tripped jack swings forward from under the butt (rad) */
const JACK_TRIP = 0.11;
/** the wippen: its centre pin above the wippen rail, a little in front of the strings */
const WIPPEN_Y = 0.04;
const wippenZ = (i: number) => hammerPivot(i)[2] - 0.006;
/** the capstan, on the key's back under the wippen's heel */
const capstanZ = (i: number) => hammerPivot(i)[2] + 0.028;
const CAPSTAN_TOP = 0.0095;
/** the key's back: it runs from under the nameboard to just short of the strings */
const KEYBACK_FRONT = -0.158;
const keyBackEnd = (i: number) => hammerPivot(i)[2] + 0.012;
/** the bridle wire's hook (wippen-local), and where the tape is fixed on the catcher (hammer-local) */
const BRIDLE_HOOK: C3 = [-0.0035, 0.058, 0.047];
const BRIDLE_ANCHOR: C3 = [-0.0035, 0.026, 0.028];
/** the spoon: its root on the wippen (wippen-local), reaching the damper lever's tail (damper-local) */
const SPOON_ROOT: C3 = [0.00575, 0.006, 0.006];
const DAMPER_TAIL: [C3, C3] = [
  [0.00575, -0.006, -0.004],
  [0.00575, -0.032, -0.004],
];
/** the main action rail, moved back to let the jacks up in front of it: its run in the bass and in the rest */
const MAIN_RAIL_Y: [number, number] = [0.104, 0.122];

/** the catcher's lower front edge (hammer-local), which lands in the backcheck */
const CATCHER_EDGE: C3 = [0, 0.024, 0.046];
/** the backcheck's wire rises from the front of the wippen (wippen-local); its felt, and how far it leans out of the way */
const CHECK_ROOT: C3 = [0.0015, 0.008, 0.046];
const CHECK_FELT = 0.0055;
const CHECK_AWAY = 0.22;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/**
 * A hammer's turn for blow fraction h, not quite in a plane: leaning `lean`
 * (rad at the full blow) to one side and twisting a hint about its shank, both
 * growing with the blow, so that nothing moves at rest.
 */
export function hammerQuaternion(i: number, h: number, lean: number, q: THREE.Quaternion): THREE.Quaternion {
  const k = Math.max(0, h);
  q.setFromAxisAngle(X_AXIS, HAMMER_REST * (1 - h));
  q.multiply(qa.setFromAxisAngle(Z_AXIS, lean * k));
  return q.multiply(qb.setFromAxisAngle(Y_AXIS, 0.004 * (2 * hash01(i, 53) - 1) * k));
}

/** a damper's turn off its strings (`lift`), leaning with its strings in the bass and a hint to one side as it lifts */
export function damperQuaternion(i: number, lift: number, lean: THREE.Quaternion, swing: number, q: THREE.Quaternion): THREE.Quaternion {
  q.setFromAxisAngle(X_AXIS, swing * lift);
  q.premultiply(lean);
  return q.multiply(qa.setFromAxisAngle(Z_AXIS, 0.0015 * (2 * hash01(i, 54) - 1) * Math.max(0, lift)));
}

/** a key's hammer centre pin (as PianoInterior) */
export function hammerPivot(i: number): C3 {
  return [HAMMER_X[i], STRIKE_Y - SHANK, stringZ(i) + CROWN + stringRadius(i)];
}

// ---------------------------------------------------------------- geometry helpers
function part(g: THREE.BufferGeometry, color: C3): THREE.BufferGeometry {
  const p = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'normal') p.deleteAttribute(k);
  const n = p.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(color, i * 3);
  p.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return p;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: C3) => part(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color);
/** a box from corner a to corner b */
const span = (a: C3, b: C3, color: C3) => box(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, color);
function rod(a: C3, b: C3, r: number, color: C3, seg = 8): THREE.BufferGeometry {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
  g.translate(a[0], a[1], a[2]);
  return part(g, color);
}
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  if (!g) throw new Error('could not merge the action parts');
  return g;
}
function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, shadows = true): THREE.InstancedMesh {
  const g = geo.clone();
  g.setAttribute('prevInstanceMatrix', new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16));
  const m = new THREE.InstancedMesh(g, mat, count);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = shadows;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}
function keepPrevious(m: THREE.InstancedMesh) {
  const prev = m.geometry.getAttribute('prevInstanceMatrix') as THREE.InstancedBufferAttribute;
  (prev.array as Float32Array).set(m.instanceMatrix.array as Float32Array);
  prev.needsUpdate = true;
}
function staticMesh(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(merged(parts), mat);
  m.castShadow = shadows;
  m.receiveShadow = true;
  m.name = name;
  return m;
}

// ---------------------------------------------------------------- small vector helpers (y-z plane rotations about x)
const rotX = (p: C3, a: number): C3 => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
const add = (a: C3, b: C3): C3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: C3, b: C3): C3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: C3, b: C3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface ActionPartsOptions {
  /** the interior's vertex-coloured wood, and its steel */
  wood: THREE.Material;
  steel: THREE.Material;
  /** the interior's cavity shading (afterAO), for the new materials */
  cavity: string;
  /** each damped key's damper pivot and lean (PianoInterior) */
  dampPivot: C3[];
  leans: THREE.Quaternion[];
}

export class ActionParts {
  readonly root = new THREE.Group();
  private keyBacks: THREE.InstancedMesh;
  private capstans: THREE.InstancedMesh;
  private wippens: THREE.InstancedMesh;
  private jacks: THREE.InstancedMesh;
  private heels: THREE.InstancedMesh;
  private tails: THREE.InstancedMesh;
  private spoons: THREE.InstancedMesh;
  private tape: THREE.Mesh;
  private checks: THREE.InstancedMesh;
  private checkFelts: THREE.InstancedMesh;
  /** the backcheck in its own frame (origin at its root, as set for a held key and an average check): where its felt meets the catcher, and which way it faces */
  private checkFace: C3 = [0, 0, 0];
  private checkNormal: C3 = [0, 0, 0];
  private checkPad: C3 = [0, 0, 0];
  private moving: THREE.InstancedMesh[];
  /** per key: the key back's rest transform (before the key turns), the wippen's heel (wippen-local) and jack rest length */
  private backRest: THREE.Matrix4[] = [];
  private capRest: C3[] = [];
  private heelLocal: C3[] = [];
  private jackLen0: number[] = [];
  private tapeLen: number[] = [];
  private spoonTip: C3[] = [];
  private opts: ActionPartsOptions;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private xAxis = new THREE.Vector3(1, 0, 0);
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  private turn = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  private tmp2 = new THREE.Matrix4();
  private scl = new THREE.Vector3();
  private unit = new THREE.Vector3(1, 1, 1);
  private feltScale = new THREE.Vector3();

  /** the instanced parts that stand in rows, instance i beside i ± 1 (for InteriorLighting's slot shading) */
  rows(): THREE.InstancedMesh[] {
    return [this.wippens, this.jacks];
  }

  constructor(opts: ActionPartsOptions) {
    this.opts = opts;
    this.root.name = 'ActionParts';
    const brass = patch(new THREE.MeshStandardMaterial({ color: 0xc9a24f, metalness: 1, roughness: 0.32 }), { afterAO: opts.cavity, bounce: 0.6 });
    const cloth = patch(new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.95, side: THREE.DoubleSide }), {
      afterMap: /* glsl */ `diffuseColor.rgb *= 0.92 + 0.1 * mpNoise(vWPos * 1800.0);`,
      afterAO: opts.cavity,
      bounce: 0.7,
    });
    const { wood, steel } = opts;

    // ---- per key constants
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYS[i];
      const P = hammerPivot(i);
      // the key's back: from under the nameboard (at the key) to just short of the strings (at its hammer)
      const z0 = KEYBACK_FRONT;
      const z1 = keyBackEnd(i);
      const dx = P[0] - k.x;
      const len = Math.hypot(dx, z0 - z1);
      const yaw = Math.atan2(dx, z1 - z0);
      const mid = new THREE.Vector3((k.x + P[0]) / 2, -0.0105, (z0 + z1) / 2);
      this.backRest.push(new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromAxisAngle(this.up, yaw), new THREE.Vector3(0.0095, 0.02, len)));
      // the capstan sits on the key's back where it passes under the wippen's heel
      const zc = capstanZ(i);
      const xc = k.x + (dx * (z0 - zc)) / (z0 - z1);
      this.capRest.push([xc, CAPSTAN_TOP - 0.0094, zc]);
      const W: C3 = [P[0], WIPPEN_Y, wippenZ(i)];
      this.heelLocal.push([0, CAPSTAN_TOP - WIPPEN_Y, zc - W[2]]);
      // the jack, standing from its foot on the wippen to the butt's heel
      const foot = add(W, JACK_FOOT);
      const heel = add(P, rotX(BUTT_HEEL, HAMMER_REST));
      this.jackLen0.push(dist(foot, heel));
      // the bridle tape: slack enough for the whole blow
      const hookAtStrike = add(W, rotX(BRIDLE_HOOK, this.wippenAngle(i, keyAngle(k, 1))));
      const anchorAtStrike = add(P, BRIDLE_ANCHOR);
      this.tapeLen.push(1.07 * Math.max(dist(add(W, BRIDLE_HOOK), add(P, rotX(BRIDLE_ANCHOR, HAMMER_REST))), dist(hookAtStrike, anchorAtStrike)));
      // the spoon reaches just in front of its damper lever's tail (the bass levers lean with their strings)
      if (i < N_DAMPED) {
        const tail = new THREE.Vector3(...DAMPER_TAIL[1]).applyQuaternion(opts.leans[i]).add(new THREE.Vector3(...opts.dampPivot[i]));
        this.spoonTip.push(sub([tail.x, tail.y, tail.z + 0.0016 + 0.0012], W));
      }
    }

    // ---- moving parts
    this.keyBacks = instanced(part(new THREE.BoxGeometry(1, 1, 1), KEYWOOD), wood, KEY_COUNT);
    this.capstans = instanced(
      merged([
        part(new THREE.CylinderGeometry(0.0035, 0.0035, 0.008, 12).translate(0, 0.004, 0), [1, 1, 1]),
        part(new THREE.SphereGeometry(0.0035, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1).translate(0, 0.008, 0), [1, 1, 1]),
      ]),
      brass,
      KEY_COUNT,
      false,
    );
    this.wippens = instanced(this.wippenGeometry(), wood, KEY_COUNT);
    this.jacks = instanced(this.jackGeometry(), wood, KEY_COUNT);
    // the butt's heel: buckskin where the jack pushes, and the centre pin's ends either side of the butt
    this.heels = instanced(
      merged([
        box(0.0104, 0.002, 0.014, 0, -0.012, 0.009, BUCKSKIN),
        rod([-0.0056, 0, 0], [0.0056, 0, 0], 0.0009, STEEL, 6),
      ]),
      wood,
      KEY_COUNT,
      false,
    );
    this.tails = instanced(
      merged([rod(DAMPER_TAIL[0], DAMPER_TAIL[1], 0.00055, STEEL, 5), box(0.0016, 0.004, 0.0024, DAMPER_TAIL[1][0], DAMPER_TAIL[1][1] + 0.001, DAMPER_TAIL[1][2] + 0.0004, RED_FELT)]),
      wood,
      N_DAMPED,
      false,
    );
    this.spoons = instanced(
      merged([
        part(new THREE.CylinderGeometry(0.00055, 0.00055, 1, 5, 1).translate(0, 0.5, 0), [1, 1, 1]),
      ]),
      brass,
      N_DAMPED,
      false,
    );
    // the backcheck: its wire and block (one rigid piece about its root), and the felt, squeezed by the catcher
    {
      const i = 40;
      const P = hammerPivot(i);
      const W: C3 = [P[0], WIPPEN_Y, wippenZ(i)];
      const phi = this.wippenAngle(i, keyAngle(KEYS[i], 1));
      const root = add(W, rotX(CHECK_ROOT, phi));
      const th = HAMMER_REST * (1 - HAMMER_CHECK);
      const K = add(P, rotX(CATCHER_EDGE, th));
      // the catcher's way as it comes back from the string; the felt faces it
      const e = CATCHER_EDGE;
      const my = -(e[1] * Math.sin(th) + e[2] * Math.cos(th));
      const mz = e[1] * Math.cos(th) - e[2] * Math.sin(th);
      const ml = Math.hypot(my, mz);
      this.checkNormal = [0, -my / ml, -mz / ml];
      this.checkFace = sub(K, root);
    }
    const n = this.checkNormal;
    // the felt is centred a little back under the catcher's head, which lands on it by its front edge
    const tang: C3 = [0, -n[2], n[1]];
    if (tang[2] > 0) (tang[1] = -tang[1]), (tang[2] = -tang[2]);
    this.checkPad = [0, 0.0025 * tang[1], 0.0025 * tang[2]];
    const F = add(this.checkFace, this.checkPad);
    const back = sub(F, [0, n[1] * (CHECK_FELT + 0.006), n[2] * (CHECK_FELT + 0.006)]);
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, n[1], n[2]));
    const block = new THREE.BoxGeometry(0.006, 0.006, 0.011).applyQuaternion(align);
    const mid = sub(F, [0, n[1] * (CHECK_FELT + 0.003), n[2] * (CHECK_FELT + 0.003)]);
    this.checks = instanced(
      merged([rod([0, 0, 0], [0, back[1], back[2]], 0.0007, STEEL, 6), part(block.translate(0, mid[1], mid[2]), BEECH)]),
      wood,
      KEY_COUNT,
      false,
    );
    // the felt: unit thickness along its own +y (scaled each frame), its back on the block
    this.checkFelts = instanced(part(new THREE.BoxGeometry(0.0062, 1, 0.0115).translate(0, 0.5, 0), [0.93, 0.9, 0.84]), wood, KEY_COUNT, false);
    this.moving = [this.keyBacks, this.capstans, this.wippens, this.jacks, this.heels, this.tails, this.spoons, this.checks, this.checkFelts];
    this.root.add(...this.moving);

    // ---- the bridle tapes: one mesh, its points laid out every frame
    const SEG = 10;
    const nV = KEY_COUNT * (SEG + 1) * 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < KEY_COUNT; i++)
      for (let s = 0; s < SEG; s++) {
        const a = (i * (SEG + 1) + s) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    geo.setIndex(idx);
    this.tape = new THREE.Mesh(geo, cloth);
    this.tape.name = 'BridleTapes';
    this.tape.frustumCulled = false;
    this.tape.castShadow = false;
    this.tape.receiveShadow = true;
    this.root.add(this.tape);

    // ---- what stays put
    this.root.add(this.buildStatic(wood, steel));
  }

  /** the wippen's turn (rad, about its centre pin; negative lifts its heel) for a key turned by `a` */
  private wippenAngle(i: number, a: number): number {
    const c = this.capstanTop(i, a);
    const [, Y, Z] = this.heelLocal[i];
    const R = Math.hypot(Y, Z);
    const beta = Math.atan2(Z, Y);
    return Math.acos(Math.max(-1, Math.min(1, (c[1] - WIPPEN_Y) / R))) - beta;
  }

  /** the capstan's top for a key turned by `a` (about its balance pin) */
  private capstanTop(i: number, a: number): C3 {
    const k = KEYS[i];
    const r = this.capRest[i];
    const p = rotX([0, CAPSTAN_TOP - PIVOT_Y, r[2] - k.pivotZ], a);
    return [r[0], PIVOT_Y + p[1], k.pivotZ + p[2]];
  }

  /** wippen-local: its body turning in the flange, the heel down to the capstan, the bridle wire at its front */
  private wippenGeometry(): THREE.BufferGeometry {
    // all keys share one shape; the heel is placed for a treble key (the bass is a few millimetres off, hidden under the body)
    const heel = this.heelLocal[40];
    return merged([
      span([-0.0035, -0.006, -0.004], [0.0035, 0.008, 0.048], BEECH), // body
      span([-0.0035, heel[1] + 0.003, heel[2] - 0.005], [0.0035, -0.006, heel[2] + 0.005], BEECH), // heel
      span([-0.0037, heel[1], heel[2] - 0.0045], [0.0037, heel[1] + 0.003, heel[2] + 0.0045], RED_FELT), // heel felt on the capstan
      rod([-0.0045, 0, 0], [0.0045, 0, 0], 0.0008, STEEL, 6), // centre pin
      rod([BRIDLE_HOOK[0], 0.008, 0.045], BRIDLE_HOOK, 0.0005, STEEL, 5), // bridle wire
      span([BRIDLE_HOOK[0] - 0.0006, BRIDLE_HOOK[1] - 0.001, BRIDLE_HOOK[2]], [BRIDLE_HOOK[0] + 0.0006, BRIDLE_HOOK[1] + 0.0012, BRIDLE_HOOK[2] + 0.003], STEEL), // its hook
      rod([-0.0025, JACK_FOOT[1], JACK_FOOT[2]], [0.0025, JACK_FOOT[1], JACK_FOOT[2]], 0.0007, STEEL, 6), // the jack's centre pin
      span([-0.002, 0.008, 0.026], [0.002, 0.011, 0.034], GREEN_FELT), // the jack spring's felt
    ]);
  }

  /** jack-local (its foot at the origin, standing along +y to the butt): the shaft and the toe that meets the let-off button */
  private jackGeometry(): THREE.BufferGeometry {
    const L = this.jackLen0[40];
    return merged([
      span([-0.002, -0.003, -0.0028], [0.002, L, 0.0028], MAPLE),
      span([-0.002, 0.001, 0.0028], [0.002, 0.006, 0.013], MAPLE), // toe
      span([-0.0021, L - 0.0025, -0.003], [0.0021, L, 0.003], BUCKSKIN), // head
    ]);
  }

  private buildStatic(wood: THREE.Material, steel: THREE.Material): THREE.Object3D {
    const g = new THREE.Group();
    g.name = 'ActionStatic';
    const W: THREE.BufferGeometry[] = [];
    const S: THREE.BufferGeometry[] = [];
    const [x0, x1] = HAMMER_SPAN;
    const kx0 = KEYS[0].x - 0.015;
    const kx1 = KEYS[KEY_COUNT - 1].x + 0.015;
    // the key frame under it all, and the balance rail with a pin and a felt punching for every key
    W.push(span([kx0 - 0.02, -0.052, -0.352], [kx1 + 0.02, -0.046, -0.16], CLOTH));
    W.push(span([kx0, -0.046, -0.284], [kx1, -0.0245, -0.242], MAPLE.map((c) => c * 0.85) as C3));
    for (const k of KEYS) {
      // where the key's (cranked) stick crosses the balance rail
      const x = k.x + ((HAMMER_X[k.index] - k.x) * (KEYBACK_FRONT - k.pivotZ)) / (KEYBACK_FRONT - keyBackEnd(k.index));
      W.push(part(new THREE.CylinderGeometry(0.0052, 0.0052, 0.003, 10).translate(x, -0.023, k.pivotZ), k.black ? RED_FELT : GREEN_FELT));
      S.push(rod([x, -0.03, k.pivotZ], [x, 0.0035, k.pivotZ], 0.0011, STEEL, 6));
    }
    // runs along the action: the bass, and from the first strut on (their hammers stand at different depths)
    const runs: [number, number, number][] = [
      [x0 - 0.006, HAMMER_X[BASS_N - 1] + 0.007, BASS_N - 1],
      [HAMMER_X[BASS_N] - 0.007, x1 + 0.006, BASS_N + 10],
    ];
    for (const [a, b, i] of runs) {
      const P = hammerPivot(i);
      // the back rail with its cloth, under the keys' ends
      W.push(span([a, -0.03, keyBackEnd(i) - 0.003], [b, -0.023, keyBackEnd(i) + 0.014], MAPLE.map((c) => c * 0.8) as C3));
      W.push(span([a, -0.023, keyBackEnd(i) - 0.003], [b, -0.0207, keyBackEnd(i) + 0.014], RED_FELT));
      // the wippen rail under the wippens' flanges
      W.push(span([a, 0.02, wippenZ(i) - 0.006], [b, 0.034, wippenZ(i) + 0.006], WALNUT));
      // the main rail, just in front of the strings, carrying the hammer flanges
      W.push(span([a, MAIN_RAIL_Y[0], P[2] - 0.016], [b, MAIN_RAIL_Y[1], P[2] - 0.002], MAPLE.map((c) => c * 0.8) as C3));
      // the let-off rail, in front of the jacks
      const lo = this.letOffButton(i);
      W.push(span([a, lo[1] + 0.016, lo[2] - 0.004], [b, lo[1] + 0.026, lo[2] + 0.006], WALNUT));
    }
    for (let i = 0; i < KEY_COUNT; i++) {
      const P = hammerPivot(i);
      const Wz = wippenZ(i);
      // the wippen's flange: two cheeks either side of it, on the wippen rail, with its screw
      for (const s of [-1, 1]) W.push(span([P[0] + s * 0.0036, 0.034, Wz - 0.005], [P[0] + s * 0.0049, WIPPEN_Y + 0.006, Wz + 0.005], MAPLE));
      S.push(rod([P[0], 0.028, Wz + 0.006], [P[0], 0.028, Wz + 0.0075], 0.0016, STEEL, 8));
      // a flange screw for each hammer, in the main rail's front face
      S.push(rod([P[0], (MAIN_RAIL_Y[0] + MAIN_RAIL_Y[1]) / 2, P[2] - 0.0025], [P[0], (MAIN_RAIL_Y[0] + MAIN_RAIL_Y[1]) / 2, P[2] - 0.001], 0.0018, STEEL, 8));
      // the let-off button, felt on its wire hanging from the let-off rail
      const lo = this.letOffButton(i);
      W.push(part(new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 10).translate(lo[0], lo[1] + 0.002, lo[2]), [0.88, 0.85, 0.78]));
      S.push(rod([lo[0], lo[1] + 0.004, lo[2]], [lo[0], lo[1] + 0.017, lo[2]], 0.0006, STEEL, 5));
      // the damper lever's centre pin
      if (i < N_DAMPED) {
        const d = this.opts.dampPivot[i];
        S.push(rod([d[0] + 0.0033, d[1], d[2] - 0.004], [d[0] + 0.0083, d[1], d[2] - 0.004], 0.0007, STEEL, 6));
        // and a screw in the damper rail for its flange
        S.push(rod([d[0] + 0.0058, 0.165, d[2] + 0.0035], [d[0] + 0.0058, 0.165, d[2] + 0.005], 0.0014, STEEL, 8));
      }
    }
    // bolts with washers through the action brackets, top, middle and foot
    const zp = (hammerPivot(30)[2] + hammerPivot(10)[2]) / 2;
    for (const x of [x0 - 0.012, ...STRUT_X, x1 + 0.012]) {
      for (const [y, z] of [
        [0.27, zp + 0.03],
        [0.124, zp + 0.018],
        [0.035, zp + 0.04],
      ] as [number, number][]) {
        S.push(rod([x - 0.0045, y, z], [x - 0.006, y, z], 0.0058, STEEL, 6), rod([x - 0.004, y, z], [x - 0.0045, y, z], 0.0075, STEEL, 12));
        S.push(rod([x + 0.004, y, z], [x + 0.0058, y, z], 0.0045, STEEL, 6));
      }
    }
    g.add(staticMesh(W, wood, 'ActionRailsAndFrame'), staticMesh(S, steel, 'ActionPinsAndScrews', false));
    return g;
  }

  /** where key i's let-off button sits: just above the jack's toe as the key reaches let-off depth */
  private letOffButton(i: number): C3 {
    const k = KEYS[i];
    const a = keyAngle(k, JACK_TRIP_AT);
    const phi = this.wippenAngle(i, a);
    const W: C3 = [HAMMER_X[i], WIPPEN_Y, wippenZ(i)];
    const foot = add(W, rotX(JACK_FOOT, phi));
    const heel = add(hammerPivot(i), rotX(BUTT_HEEL, HAMMER_REST * (1 - HAMMER_LETOFF)));
    const d = sub(heel, foot);
    const psi = Math.atan2(d[2], d[1]);
    const toe = add(foot, rotX([0, 0.0035, 0.012], psi));
    return [W[0], toe[1] + 0.0008, toe[2]];
  }

  /** pose the mechanism for a frame */
  update(f: FrameState) {
    const { m4, q, q2, p, s, xAxis, up, dir } = this;
    const one = s.set(1, 1, 1); // (unit scale; never changed below)
    const tapePos = this.tape.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tapeNrm = this.tape.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const tp = tapePos.array as Float32Array;
    const tn = tapeNrm.array as Float32Array;
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = KEYS[i];
      const a = keyAngle(k, Math.max(0, f.keys[i]));
      // the key's back turns with the key about its balance pin
      // turn = T(pivot) R(a) T(-pivot): a rotation about x, so the translation is the pivot less its rotated self
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const turn = this.turn.set(1, 0, 0, 0, 0, ca, -sa, PIVOT_Y - (ca * PIVOT_Y - sa * k.pivotZ), 0, sa, ca, k.pivotZ - (sa * PIVOT_Y + ca * k.pivotZ), 0, 0, 0, 1);
      this.keyBacks.setMatrixAt(i, this.tmp.multiplyMatrices(turn, this.backRest[i]));
      const cr = this.capRest[i];
      this.capstans.setMatrixAt(i, this.tmp.multiplyMatrices(turn, this.tmp2.makeTranslation(cr[0], cr[1], cr[2])));
      // the wippen, lifted at its heel by the capstan
      const phi = this.wippenAngle(i, a);
      const W: C3 = [HAMMER_X[i], WIPPEN_Y, wippenZ(i)];
      q.setFromAxisAngle(xAxis, phi);
      this.wippens.setMatrixAt(i, m4.compose(p.set(W[0], W[1], W[2]), q, one));
      // the hammer, as PianoInterior poses it
      const P = hammerPivot(i);
      const theta = HAMMER_REST * (1 - f.hammers[i]);
      hammerQuaternion(i, f.hammers[i], f.leans[i], q2);
      this.heels.setMatrixAt(i, m4.compose(p.set(P[0], P[1], P[2]), q2, one));
      this.poseBackcheck(i, W, phi, P, f.checks[i], theta, f.keys[i]);
      // the jack: from its foot on the wippen to the butt's heel; tripped, it swings forward from under it
      const foot = add(W, rotX(JACK_FOOT, phi));
      const heel = add(P, rotX(BUTT_HEEL, theta));
      const dEng = sub(heel, foot);
      const heelLo = add(P, rotX(BUTT_HEEL, HAMMER_REST * (1 - HAMMER_LETOFF)));
      const dLo = sub(heelLo, foot);
      const trip = f.jacks[i];
      const psi = (1 - trip) * Math.atan2(dEng[2], dEng[1]) + trip * (Math.atan2(dLo[2], dLo[1]) + JACK_TRIP);
      const len = (1 - trip) * Math.hypot(dEng[1], dEng[2]) + trip * Math.hypot(dLo[1], dLo[2]);
      q.setFromAxisAngle(xAxis, psi);
      this.jacks.setMatrixAt(i, m4.compose(p.set(foot[0], foot[1], foot[2]), q, this.scl.set(1, len / this.jackLen0[40], 1)));
      // the damper lever's tail, and the spoon reaching it
      if (i < N_DAMPED) {
        const dp = this.opts.dampPivot[i];
        damperQuaternion(i, f.dampers[i], this.opts.leans[i], DAMPER_SWING, q);
        this.tails.setMatrixAt(i, m4.compose(p.set(dp[0], dp[1], dp[2]), q, one));
        const root = add(W, rotX(SPOON_ROOT, phi));
        const tip = add(W, rotX(this.spoonTip[i], phi));
        dir.set(tip[0] - root[0], tip[1] - root[1], tip[2] - root[2]);
        const l = dir.length();
        q.setFromUnitVectors(up, dir.divideScalar(l));
        this.spoons.setMatrixAt(i, m4.compose(p.set(root[0], root[1], root[2]), q, this.scl.set(1, l, 1)));
      }
      // the bridle tape, hanging slack from the catcher to the hook, bowed toward the player
      const A = add(P, rotX(BRIDLE_ANCHOR, theta));
      const B = add(W, rotX(BRIDLE_HOOK, phi));
      const c = dist(A, B);
      const L = this.tapeLen[i];
      const sag = c < L ? Math.sqrt((3 * c * (L - c)) / 8) : 0;
      // the bow: perpendicular to the chord in the y-z plane, toward the strings (clear of the backcheck)
      let ny = -(A[2] - B[2]);
      let nz = A[1] - B[1];
      if (nz > 0) {
        ny = -ny;
        nz = -nz;
      }
      const nl = Math.hypot(ny, nz) || 1;
      ny /= nl;
      nz /= nl;
      const sway = f.bridles[i];
      const SEG = 10;
      for (let k2 = 0; k2 <= SEG; k2++) {
        const u = k2 / SEG;
        const b = 4 * u * (1 - u);
        const x = B[0] + (A[0] - B[0]) * u + sway * b;
        const y = B[1] + (A[1] - B[1]) * u + ny * sag * b;
        const z = B[2] + (A[2] - B[2]) * u + nz * sag * b;
        // the tape's face: across x, normal in the y-z plane perpendicular to its run
        const db = 4 - 8 * u;
        const ty = A[1] - B[1] + ny * sag * db;
        const tz = A[2] - B[2] + nz * sag * db;
        const tl = Math.hypot(ty, tz) || 1;
        const o = ((i * (SEG + 1) + k2) * 2) * 3;
        tp[o] = x - 0.0016;
        tp[o + 1] = y;
        tp[o + 2] = z;
        tp[o + 3] = x + 0.0016;
        tp[o + 4] = y;
        tp[o + 5] = z;
        tn[o] = tn[o + 3] = 0;
        tn[o + 1] = tn[o + 4] = -tz / tl;
        tn[o + 2] = tn[o + 5] = ty / tl;
      }
    }
    for (const m of this.moving) m.instanceMatrix.needsUpdate = true;
    tapePos.needsUpdate = true;
    tapeNrm.needsUpdate = true;
  }

  /**
   * The backcheck on key i's wippen: leaning so that its felt meets the
   * catcher where this stroke's check is (the felt at rest on the catcher's
   * way), out of the way while the key is up, and its felt squeezed by however
   * far the catcher has sunk into it.
   */
  private poseBackcheck(i: number, W: C3, phi: number, P: C3, check: number, theta: number, depth: number) {
    const root = add(W, rotX(CHECK_ROOT, phi));
    const K = add(P, rotX(CATCHER_EDGE, HAMMER_REST * (1 - check)));
    const F = this.checkFace;
    const n = this.checkNormal;
    // the lean that puts the felt's face through the catcher's edge at the check
    const miss = (psi: number) => {
      const f = rotX(F, psi);
      const nn = rotX(n, psi);
      return (K[1] - root[1] - f[1]) * nn[1] + (K[2] - root[2] - f[2]) * nn[2];
    };
    let psi = 0;
    for (let k = 0; k < 4; k++) {
      const m0 = miss(psi);
      const d = (miss(psi + 1e-4) - m0) / 1e-4;
      if (Math.abs(d) < 1e-9) break;
      psi -= m0 / d;
    }
    // out of the way as the key comes up
    const u = Math.min(1, Math.max(0, (depth - 0.5) / 0.4));
    psi += CHECK_AWAY * (1 - u * u * (3 - 2 * u));
    const { m4, q, p } = this;
    q.setFromAxisAngle(this.xAxis, psi);
    this.checks.setMatrixAt(i, m4.compose(p.set(root[0], root[1], root[2]), q, this.unit));
    // the felt: how far the catcher's edge is past its face
    const face = add(root, rotX(F, psi));
    const nn = rotX(n, psi);
    const edge = add(P, rotX(CATCHER_EDGE, theta));
    const into = -((edge[1] - face[1]) * nn[1] + (edge[2] - face[2]) * nn[2]);
    const thick = CHECK_FELT - Math.min(0.8 * CHECK_FELT, Math.max(0, into));
    const backC = add(root, rotX(sub(add(F, this.checkPad), [0, n[1] * CHECK_FELT, n[2] * CHECK_FELT]), psi));
    this.dir.set(0, nn[1], nn[2]);
    this.q2.setFromUnitVectors(this.up, this.dir);
    this.checkFelts.setMatrixAt(i, m4.compose(p.set(root[0], backC[1], backC[2]), this.q2, this.feltScale.set(1, thick, 1)));
  }

  /** remember the moving parts' transforms as the shutter opened */
  keepPrevious() {
    for (const m of this.moving) keepPrevious(m);
  }
}
