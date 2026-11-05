// The drum kit, built in three.js from the shared layout (src/drums/KitLayout.ts):
// every drum, cymbal and pedal stands where the layout says, so the robot's
// targets and the kit always agree.
//
// Drums: maple shells with real wall thickness and 45-degree bearing edges,
// in a sparkle lacquer; coated batter heads seated over the edges in their
// flesh hoops; triple-flanged chrome hoops (wooden hoops on the kick);
// lugs, tension rods and washers (instanced); a maker's badge. The snare has
// tube lugs, its wires under the bottom head, a throw-off strainer and a butt
// plate; the kick its claws and T-rods, spurs, a ported black front head with
// the maker's emblem and the tom holder; the floor tom its legs.
//
// Hardware: tripod stands with memory locks and wing bolts; boom arms with
// ratchet tilters and counterweights; cymbal tilters with nylon sleeves,
// felts and wing nuts. The hi-hat stand with its pedal, pull rod, clutch and
// felts; the kick pedal with its footboard, heel plate, chain, cam, axle,
// spring and felt beater; the stool; the rug.
//
// Everything that moves (cymbals, the hi-hat's top, the beater and both
// footboards, the toms, the stands' tops) sits in its own group, posed every
// frame from a KitState (src/drums/KitMotion.ts), and keeps its transform
// from the start of the shutter for motion blur.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CYMBAL_HOLE, CYMBAL_PROFILES, DRUMS, PEDALS, PEDAL_BOARDS, SEAT, cymbalTop, footboardAngle, hihatMount, surfaceNormal, type CymbalProfile, type DrumId, type DrumSpec } from '../drums/KitLayout';
import type { CymbalId, KitState, ShellId, Tilt } from '../drums/KitMotion';
import { hash01 } from '../core/random';
import { Parts, along, arc, instanced, revolve, ring, tag, tube, type P2, type V3 } from './drumGeometry';
import { createDrumPalette, type DrumPalette } from './DrumMaterials';

const HEAD_INDEX: Record<ShellId, number> = { kick: 0, snare: 1, tom1: 2, tom2: 3, floorTom: 4 };
/** the stool's legs: one straight back, two forward either side (angles from +z, toward +x) */
const STOOL_LEGS = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
const STOOL_REACH = 0.28;
const RESO = 5;
/** how far up the rug lifts the kit (m) */
export const RUG_TOP = 0.008;

/** a drum or cymbal's orientation: its playing surface's normal from +y, turned toward the stool (KitLayout's tilt and yaw) */
export function orientation(d: DrumSpec): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(d.tilt, d.yaw, 0, 'YXZ'));
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];

/** a small rotation (radians about a frame's x and z) as a quaternion */
function tiltQ(t: Tilt, out = new THREE.Quaternion()): THREE.Quaternion {
  const a = Math.hypot(t.x, t.z);
  if (a < 1e-9) return out.identity();
  return out.setFromAxisAngle(new THREE.Vector3(t.x / a, 0, t.z / a), a);
}

// ---------------------------------------------------------------- profiles
/** a cymbal's cross-section (KitLayout's profile): bell, bow and edge; y = 0 at the top of the bow where it meets the bell */
interface CymbalShape {
  R: number;
  bellR: number;
  bellH: number;
  drop: number;
  /** thickness at the bell, the bow, the edge */
  t: [number, number, number];
  profile: CymbalProfile;
}
const shapeOf = (id: 'crash' | 'ride' | 'hihat'): CymbalShape => {
  const p = CYMBAL_PROFILES[id];
  return { R: DRUMS[id].diameter / 2, bellR: p.bellRadius, bellH: p.bellHeight, drop: p.drop, t: p.thickness, profile: p };
};
const CYMBAL_SHAPES = { crash: shapeOf('crash'), ride: shapeOf('ride'), hats: shapeOf('hihat') };
const HOLE_R = CYMBAL_HOLE;

function cymbalProfile(s: CymbalShape): P2[] {
  // the top surface (KitLayout's, where the strike spots lie) from the edge inward over the bow and up over the bell, then back out underneath
  const top: P2[] = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const r = s.R - (i / N) * (s.R - s.bellR);
    top.push([r, cymbalTop(s.profile, s.R, r)]);
  }
  const B = 16;
  for (let i = 1; i <= B; i++) {
    const r = s.bellR - (i / B) * (s.bellR - HOLE_R - 0.004);
    top.push([r, cymbalTop(s.profile, s.R, r)]);
  }
  top.push([HOLE_R, s.bellH]);
  // the underside: the same, offset by the thickness (thicker at the bell), back out to the edge
  const bottom: P2[] = [];
  for (let i = top.length - 1; i >= 0; i--) {
    const [r, y] = top[i];
    const u = Math.min(1, Math.max(0, (r - s.bellR) / (s.R - s.bellR)));
    const th = r < s.bellR ? s.t[0] : s.t[1] + (s.t[2] - s.t[1]) * u * u;
    bottom.push([r, y - th]);
  }
  bottom[0] = [HOLE_R, bottom[0][1]];
  // round the edge: from the underside's last point up over the top's first
  const [er, ey] = top[0];
  const edgeT = s.t[2];
  const tip: P2[] = arc(er, ey - edgeT / 2, edgeT / 2, -Math.PI / 2, Math.PI / 2, 4).slice(1, -1);
  // and the hole's wall from the top back down to the underside (facing the axis)
  return [...bottom, ...tip, ...top, bottom[0]];
}

/** a coated head over a bearing edge, from its flesh hoop inward (y = 0 at the membrane) */
function headProfile(R: number): P2[] {
  return [
    [R + 0.0042, -0.0125],
    [R + 0.0042, -0.0062],
    [R + 0.0022, -0.0052],
    [R + 0.0004, -0.0034],
    [R - 0.0008, -0.0014],
    [R - 0.003, -0.0003],
    [R - 0.007, 0.0],
    [R * 0.5, 0.0],
    [0.0, 0.0],
  ];
}

/** a triple-flanged hoop around a head of radius R (y = 0 at the membrane) */
function hoopProfile(R: number): P2[] {
  const ri = R + 0.0052;
  const p: P2[] = [
    [ri + 0.0138, -0.0176],
    [ri + 0.014, -0.0196],
    [ri + 0.0162, -0.0194],
    [ri + 0.016, -0.0158],
    [ri + 0.0146, -0.015],
    [ri + 0.0023, -0.015],
    [ri + 0.0023, 0.001],
    [ri + 0.0056, 0.0016],
    ...arc(ri + 0.0028, 0.0058, 0.0028, -0.1, Math.PI, 7).slice(1),
    [ri, -0.0176],
  ];
  // traced with the outside on the right; closed
  return [...p, p[0]];
}

/** the shell: the finished outer wall, and the wood (bearing edges and inside) */
function shellProfiles(R: number, depth: number, t: number): { outer: P2[]; wood: P2[] } {
  const yt = -0.0006;
  const yb = -depth + 0.0006;
  const outer: P2[] = [
    [R, yb + 0.003],
    [R, yt - 0.003],
  ];
  const wood: P2[] = [
    [R, yt - 0.003],
    [R - 0.0006, yt - 0.0009],
    [R - 0.0016, yt],
    [R - t, yt - (t - 0.0016)],
    [R - t, yb + (t - 0.0016)],
    [R - 0.0016, yb],
    [R - 0.0006, yb + 0.0009],
    [R, yb + 0.003],
  ];
  return { outer, wood };
}

/** mirror a profile across y = -depth/2 (the bottom of a drum), keeping its outside on the right */
function mirror(p: P2[], depth: number): P2[] {
  return p.map(([r, y]) => [r, -depth - y] as P2).reverse();
}

// ---------------------------------------------------------------- the model
interface DrumParts {
  spec: DrumSpec;
  group: THREE.Group;
  base: THREE.Quaternion;
  R: number;
}

interface CymbalParts {
  /** the stand's top (boom arm, tilter, felts): turns a little with the cymbal (the stand's give) */
  top: THREE.Group;
  /** the cymbal itself, rocking on its felt */
  rock: THREE.Group;
  /** the cymbal's orientation in the kit frame, and the top's pivot */
  q: THREE.Quaternion;
}

export class DrumKitModel {
  readonly root = new THREE.Group();
  readonly palette: DrumPalette;
  /** every mesh whose transform changes as the kit moves (motion blur keeps their previous transforms) */
  readonly moving: THREE.Object3D[] = [];
  private drums = {} as Record<ShellId, DrumParts>;
  private cym = {} as Record<CymbalId, CymbalParts>;
  private hhTop!: THREE.Group;
  private hhFoot!: THREE.Group;
  private kickFoot!: THREE.Group;
  private beater!: THREE.Group;
  private cam!: THREE.Group;
  private spring!: THREE.Mesh;
  private chain!: THREE.InstancedMesh;
  private chainGeo = { axle: new THREE.Vector3(), toe: new THREE.Vector3() };
  private kickPedal = { axle: new THREE.Vector3(), heel: new THREE.Vector3(), restAngle: 0, hitAngle: 0, springBase: new THREE.Vector3(), crank: 0 };
  /** the obstacles on the floor so far (for placing tripods' legs): circles and capsules in xz */
  private floor: { a: [number, number]; b: [number, number]; r: number }[] = [];
  /** how far each set of legs stays clear of everything already on the floor (m; for checks) */
  readonly legClearance: { at: [number, number]; clear: number }[] = [];

  constructor() {
    this.root.name = 'DrumKit';
    this.palette = createDrumPalette(DRUMS.kick.diameter / 2);
    const P = this.palette;
    // the floor's obstacles before any tripod is placed: the kick, the pedals, the stool's legs
    const kp = PEDALS.kickPedal;
    const hp = PEDALS.hihatPedal;
    // the kick rests on its hoops: 15 cm to either side of its middle its shell is already 3 cm off the floor, room for a foot
    // (a capsule whose rounded ends stop at the hoops)
    const kr = 0.15;
    this.floor.push({ a: [DRUMS.kick.centre[0], DRUMS.kick.centre[2] + 0.02 - kr], b: [DRUMS.kick.centre[0], DRUMS.kick.centre[2] - DRUMS.kick.depth - 0.02 + kr], r: kr });
    this.floor.push({ a: [kp.heel[0], kp.heel[2] + 0.04], b: [kp.ball[0], DRUMS.kick.centre[2]], r: 0.075 });
    this.floor.push({ a: [hp.heel[0], hp.heel[2] + 0.04], b: [DRUMS.hihat.centre[0], DRUMS.hihat.centre[2]], r: 0.07 });
    // the stool: its column and three legs (one straight back, the front two either side of the pedals' heels)
    this.floor.push({ a: [SEAT.centre[0], SEAT.centre[2]], b: [SEAT.centre[0], SEAT.centre[2]], r: 0.05 });
    for (const a of STOOL_LEGS) this.floor.push({ a: [SEAT.centre[0], SEAT.centre[2]], b: [SEAT.centre[0] + Math.sin(a) * STOOL_REACH, SEAT.centre[2] + Math.cos(a) * STOOL_REACH], r: 0.035 });

    for (const id of ['kick', 'snare', 'tom1', 'tom2', 'floorTom'] as ShellId[]) this.buildDrum(id);
    this.buildKickExtras();
    this.buildTomHolder();
    this.buildFloorTomLegs();
    this.buildSnareStand();
    this.buildKickPedal();
    this.buildHiHat();
    // the boom stands' bases: behind and outside their cymbals
    this.buildCymbalStand('crash', [DRUMS.crash.centre[0] - 0.3, DRUMS.crash.centre[2] - 0.28]);
    this.buildCymbalStand('ride', [DRUMS.ride.centre[0] + 0.34, DRUMS.ride.centre[2] - 0.3]);
    this.buildStool();
    this.buildRug();
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
    });
    void P;
  }

  // ---------------------------------------------------------------- drums
  private buildDrum(id: ShellId) {
    const spec = DRUMS[id];
    const P = this.palette;
    const R = spec.diameter / 2;
    const depth = spec.depth;
    const group = new THREE.Group();
    group.name = id;
    group.position.set(...spec.centre);
    const base = orientation(spec);
    group.quaternion.copy(base);
    this.root.add(group);
    this.drums[id] = { spec, group, base, R };
    const kick = id === 'kick';
    const parts = new Parts();
    // the shell
    const t = kick ? 0.0075 : id === 'snare' ? 0.0068 : 0.0058;
    const sh = shellProfiles(R, depth, t);
    const seg = kick ? 112 : 96;
    parts.add(P.shell, revolve(sh.outer, seg, 35));
    parts.add(P.wood, revolve(sh.wood, seg, 35));
    // heads: the batter on top, the resonant underneath (the kick's front head is its own)
    parts.add(P.head, tag(revolve(headProfile(R), seg, 30), 'aHead', HEAD_INDEX[id], R));
    if (!kick) parts.add(P.head, tag(revolve(mirror(headProfile(R), depth), seg, 30), 'aHead', RESO, R));
    // hoops: triple-flanged steel, or the kick's wooden hoops in the shell's finish
    if (kick) {
      const wh = (y0: number, y1: number): P2[] => {
        const ri = R + 0.0045;
        const ro = R + 0.0205;
        return [
          [ro, y0 + 0.003],
          [ro, y1 - 0.003],
          [ro - 0.003, y1],
          [ri + 0.002, y1],
          [ri, y1 - 0.002],
          [ri, y0 + 0.002],
          [ri + 0.002, y0],
          [ro - 0.003, y0],
          [ro, y0 + 0.003],
        ];
      };
      parts.add(P.shell, revolve(wh(-0.012, 0.013), seg, 35));
      parts.add(P.shell, revolve(wh(-depth - 0.013, -depth + 0.012), seg, 35));
    } else {
      parts.add(P.hoop, tag(revolve(hoopProfile(R), seg, 40), 'aHead', HEAD_INDEX[id], R));
      parts.add(P.hoop, tag(revolve(mirror(hoopProfile(R), depth), seg, 40), 'aHead', RESO, R));
    }
    parts.build(group, id);
    // lugs, rods and washers, instanced
    const n = { kick: 10, snare: 10, tom1: 6, tom2: 6, floorTom: 8 }[id];
    const offset = Math.PI / n;
    const lugs: THREE.Matrix4[] = [];
    const rods: THREE.Matrix4[] = [];
    for (let k = 0; k < n; k++) {
      const a = offset + (k * 2 * Math.PI) / n;
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      // the same part turned over for the bottom head (half a turn about the radial axis; never mirrored)
      const qb = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
      const big = new THREE.Vector3(kick ? 1.3 : 1, 1, kick ? 1.9 : 1);
      if (id === 'snare') {
        lugs.push(new THREE.Matrix4().compose(dir.clone().multiplyScalar(R).setY(-depth / 2), q, new THREE.Vector3(1, 1, 1)));
      } else {
        for (const y of [-0.036, -depth + 0.036]) lugs.push(new THREE.Matrix4().compose(dir.clone().multiplyScalar(R).setY(y), y < -depth / 2 ? qb : q, big));
      }
      // a rod at each hoop: down from the hoop into the lug, its head above the flange
      const rr = kick ? R + 0.026 : R + 0.0052 + 0.0095;
      for (const bottom of [false, true]) {
        const m = new THREE.Matrix4().compose(dir.clone().multiplyScalar(rr).setY(bottom ? -depth : 0), bottom ? qb : q, new THREE.Vector3(1, 1, 1));
        rods.push(m);
      }
    }
    const lugGeo = id === 'snare' ? snareLug(depth - 0.05) : lugBody();
    const lugMesh = instanced(lugGeo, P.chrome, lugs);
    group.add(lugMesh);
    const rodMesh = instanced(kick ? kickRod(R) : tensionRod(), P.chrome, rods);
    group.add(rodMesh);
    if (kick) {
      // the claws over the wooden hoops
      group.add(instanced(claw(R), P.chrome, rods));
    } else {
      // nylon washers under the rods' heads
      const washer = new THREE.CylinderGeometry(0.0056, 0.0056, 0.001, 16).translate(0, -0.0145, 0);
      group.add(instanced(washer, P.nylon, rods));
    }
    // the maker's badge, on the front (away from the drummer), half way down the shell
    const badge = new THREE.PlaneGeometry(0.038, 0.026);
    badge.translate(0, 0, 0.0012);
    const bg = new THREE.Mesh(badge, P.badge);
    const ba = id === 'kick' ? Math.PI * 0.75 : Math.PI + 0.35;
    bg.position.set(Math.sin(ba) * R, kick ? -depth * 0.62 : -depth / 2, Math.cos(ba) * R);
    bg.lookAt(bg.position.clone().multiply(new THREE.Vector3(2, 1, 2)));
    if (kick) bg.rotateZ(-Math.PI / 2);
    group.add(bg);
    // the toms rock: everything in the group moves with them
    if (id !== 'kick' && id !== 'snare') group.traverse((o) => (o as THREE.Mesh).isMesh && this.moving.push(o));
    if (id === 'snare') this.buildSnareWires(group, R, depth);
  }

  /** the snare's wires under the bottom head, the throw-off strainer and the butt plate */
  private buildSnareWires(group: THREE.Group, R: number, depth: number) {
    const P = this.palette;
    const a = -1.9; // the strainer at the drummer's left front, as the left hand reaches it
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const across = new THREE.Vector3(dir.z, 0, -dir.x);
    const y = -depth - 0.0022;
    const half = R * 0.92;
    const wires: THREE.Matrix4[] = [];
    const N = 20;
    for (let k = 0; k < N; k++) {
      const o = (k - (N - 1) / 2) * 0.0046;
      const c = across.clone().multiplyScalar(o).setY(y - 0.0003 * Math.sin(k));
      wires.push(new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), new THREE.Vector3(1, 1, 1)));
    }
    // a coiled wire: a thin rod (its coil is far finer than a pixel at any distance a camera goes)
    const w = new THREE.CylinderGeometry(0.00045, 0.00045, half * 2 * 0.86, 5, 1, true);
    group.add(instanced(w, P.wire, wires));
    // end plates holding the wires, and the straps up to the strainer and the butt
    const parts = new Parts();
    for (const s of [-1, 1]) {
      const end = dir.clone().multiplyScalar(s * half * 0.88).setY(y - 0.0005);
      parts.add(P.chrome, new THREE.BoxGeometry(0.1, 0.0015, 0.008).applyMatrix4(new THREE.Matrix4().compose(end, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), across), new THREE.Vector3(1, 1, 1))));
      const lip = dir.clone().multiplyScalar(s * (R + 0.012));
      parts.add(P.strap, tube(arr(end), arr(lip.clone().setY(-depth + 0.03)), 0.003, 6));
    }
    // the strainer (throw-off): a block on the shell with its lever, and the butt plate opposite
    const strainer = dir.clone().multiplyScalar(-(R + 0.012)).setY(-depth + 0.045);
    const sq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate());
    parts.add(P.chrome, new RoundedBoxGeometry(0.03, 0.06, 0.018, 2, 0.004).applyMatrix4(new THREE.Matrix4().compose(strainer, sq, new THREE.Vector3(1, 1, 1))));
    const lever = strainer.clone().add(dir.clone().multiplyScalar(-0.012)).setY(-depth + 0.075);
    parts.add(P.chrome, tube(arr(strainer.clone().setY(-depth + 0.05).add(dir.clone().multiplyScalar(-0.01))), arr(lever), 0.0035, 8));
    parts.add(P.darkMetal, new THREE.SphereGeometry(0.006, 10, 8).translate(lever.x, lever.y, lever.z));
    // the tension knob on top of the strainer
    const knob = strainer.clone().setY(-depth + 0.083);
    parts.add(P.chrome, new THREE.CylinderGeometry(0.0075, 0.0075, 0.012, 16).translate(knob.x, knob.y, knob.z));
    const butt = dir.clone().multiplyScalar(R + 0.011).setY(-depth + 0.03);
    parts.add(P.chrome, new RoundedBoxGeometry(0.026, 0.035, 0.014, 2, 0.004).applyMatrix4(new THREE.Matrix4().compose(butt, sq, new THREE.Vector3(1, 1, 1))));
    parts.build(group, 'snare-strainer');
  }

  /** the kick's front head (ported, with the emblem), spurs */
  private buildKickExtras() {
    const P = this.palette;
    const d = this.drums.kick;
    const R = d.R;
    const depth = d.spec.depth;
    // the front head: a black film with a port low on the drummer's right (seen from the front: low left)
    const shape = new THREE.Shape();
    shape.absarc(0, 0, R + 0.002, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    const pr = 0.058;
    const px = 0.1;
    const pz = 0.11;
    hole.absarc(px, pz, pr, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const fg = new THREE.ShapeGeometry(shape, 64);
    // ShapeGeometry is in xy: lay it in the head's plane (xz), facing out of the drum (-y)
    fg.rotateX(Math.PI / 2);
    fg.translate(0, -depth - 0.001, 0);
    const parts = new Parts();
    parts.add(P.front, fg);
    // the port's reinforcing ring
    parts.add(P.chrome, ring(pr + 0.002, 0.0018, 0, 40, 6).translate(px, -depth - 0.002, pz));
    // the front head's collar into the hoop (a short black skirt)
    parts.add(P.front, revolve([[R + 0.0042, -depth + 0.0062], [R + 0.0042, -depth + 0.0125]], 112, 30));
    parts.build(d.group, 'kick-front');
    // spurs: from brackets on the shell near the batter side, out and down to the floor
    const sp = new Parts();
    for (const s of [-1, 1]) {
      const bracketLocal = new THREE.Vector3(s * Math.sin(1.0) * (R + 0.012), -0.12, Math.cos(1.0) * (R + 0.012));
      const bracket = bracketLocal.clone().applyQuaternion(d.base).add(d.group.position);
      const foot = new THREE.Vector3(d.spec.centre[0] + s * (R + 0.16), RUG_TOP + 0.004, d.spec.centre[2] - 0.12);
      sp.add(P.chrome, new RoundedBoxGeometry(0.03, 0.05, 0.03, 2, 0.006).translate(bracket.x, bracket.y, bracket.z));
      sp.add(P.chrome, tube(arr(bracket), arr(foot.clone().setY(foot.y + 0.03)), 0.0055, 10));
      sp.add(P.rubber, new THREE.CylinderGeometry(0.009, 0.011, 0.03, 12).translate(foot.x, foot.y + 0.015, foot.z));
      this.floor.push({ a: [foot.x, foot.z], b: [foot.x, foot.z], r: 0.04 });
    }
    sp.build(this.root, 'kick-spurs');
  }

  /** the tom holder on the kick: a block on the shell, a post, an L-arm to each tom's bracket */
  private buildTomHolder() {
    const P = this.palette;
    const kick = this.drums.kick;
    const top = new THREE.Vector3(kick.spec.centre[0], kick.spec.centre[1] + kick.R, kick.spec.centre[2] - kick.spec.depth * 0.45);
    const parts = new Parts();
    parts.add(P.chrome, new RoundedBoxGeometry(0.06, 0.03, 0.08, 2, 0.006).translate(top.x, top.y + 0.01, top.z));
    const post = top.clone().setY(top.y + 0.11);
    parts.add(P.chrome, tube(arr(top), arr(post), 0.011, 16));
    parts.add(P.chrome, new THREE.CylinderGeometry(0.02, 0.02, 0.035, 18).translate(post.x, post.y, post.z));
    parts.build(this.root, 'tom-holder');
    // each tom's arm: from the holder's clamp to the bracket on its shell; it moves with its tom
    for (const id of ['tom1', 'tom2'] as const) {
      const d = this.drums[id];
      const local = new THREE.Vector3();
      // the bracket on the side of the shell facing the holder, a little down the shell
      const toPost = post.clone().sub(d.group.position).applyQuaternion(d.base.clone().invert());
      const ang = Math.atan2(toPost.x, toPost.z);
      local.set(Math.sin(ang) * (d.R + 0.016), -d.spec.depth * 0.45, Math.cos(ang) * (d.R + 0.016));
      const ap = new Parts();
      const bq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)));
      ap.add(P.chrome, new RoundedBoxGeometry(0.04, 0.065, 0.026, 2, 0.006).applyMatrix4(new THREE.Matrix4().compose(local, bq, new THREE.Vector3(1, 1, 1))));
      // the arm, in the tom's frame: out of the bracket, then down to the holder
      const out = local.clone().add(new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)).multiplyScalar(0.05));
      const postLocal = post.clone().setY(post.y + 0.02).sub(d.group.position).applyQuaternion(d.base.clone().invert());
      ap.add(P.chrome, tube(arr(local), arr(out), 0.0085, 14));
      ap.add(P.chrome, new THREE.SphereGeometry(0.014, 14, 10).translate(out.x, out.y, out.z));
      ap.add(P.chrome, tube(arr(out), arr(postLocal), 0.0085, 14));
      const meshes = ap.build(d.group, `${id}-arm`);
      this.moving.push(...meshes);
    }
  }

  private buildFloorTomLegs() {
    const P = this.palette;
    const d = this.drums.floorTom;
    const c = d.spec.centre;
    const legs = this.placeLegs([c[0], c[2]], d.R + 0.13, 3, 0.05, Math.PI / 6);
    const parts = new Parts();
    for (const a of legs) {
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const bracket = new THREE.Vector3(c[0], c[1] - 0.11, c[2]).add(dir.clone().multiplyScalar(d.R + 0.018));
      const foot = new THREE.Vector3(c[0], RUG_TOP, c[2]).add(dir.clone().multiplyScalar(d.R + 0.13));
      parts.add(P.chrome, new RoundedBoxGeometry(0.035, 0.055, 0.03, 2, 0.006).applyMatrix4(new THREE.Matrix4().compose(bracket, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), new THREE.Vector3(1, 1, 1))));
      parts.add(P.chrome, tube(arr(bracket.clone().setY(bracket.y + 0.03)), arr(foot.clone().setY(foot.y + 0.025)), 0.0058, 12));
      parts.add(P.rubber, new THREE.CylinderGeometry(0.008, 0.012, 0.028, 14).translate(foot.x, foot.y + 0.014, foot.z));
      // the leg's wing bolt on the bracket
      const wb = bracket.clone().add(dir.clone().multiplyScalar(0.022));
      parts.add(P.chrome, wingBolt().applyMatrix4(along(arr(wb), arr(dir))));
      this.floor.push({ a: [foot.x, foot.z], b: [foot.x, foot.z], r: 0.04 });
    }
    parts.build(this.root, 'floor-tom-legs');
  }

  /**
   * Legs for a tripod or a floor tom: n legs to feet `reach` from centre,
   * turned to stay as clear as possible of what is already on the floor
   * (pedals, the kick, other stands' feet). Returns their angles.
   */
  private placeLegs(centre: [number, number], reach: number, n: number, footR: number, prefer = 0): number[] {
    const best = this.bestLegs(centre, reach, n, footR, prefer);
    this.legClearance.push({ at: centre, clear: best.score });
    return Array.from({ length: n }, (_, i) => best.a0 + (i * 2 * Math.PI) / n);
  }

  /** the clearest turn for a set of legs about a centre, and how clear it is (m) */
  private bestLegs(centre: [number, number], reach: number, n: number, footR: number, prefer = 0) {
    let best = { a0: prefer, score: -Infinity };
    for (let k = 0; k < 72; k++) {
      const a0 = prefer + (k / 72) * ((2 * Math.PI) / n);
      let score = Infinity;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i * 2 * Math.PI) / n;
        for (const f of [0.55, 1]) {
          const p: [number, number] = [centre[0] + Math.sin(a) * reach * f, centre[1] + Math.cos(a) * reach * f];
          for (const o of this.floor) score = Math.min(score, segDist(p, o.a, o.b) - o.r - footR);
        }
      }
      if (score > best.score) best = { a0, score };
    }
    return best;
  }

  /** a tripod base: legs from a hub on the tube to rubber feet, braced to a collar */
  private tripod(parts: Parts, centre: [number, number], hubY: number, reach: number, legR = 0.0075): void {
    const P = this.palette;
    const angles = this.placeLegs(centre, reach, 3, 0.035);
    const hub = new THREE.Vector3(centre[0], hubY, centre[1]);
    const collar = new THREE.Vector3(centre[0], 0.11, centre[1]);
    parts.add(P.chrome, new THREE.CylinderGeometry(0.02, 0.02, 0.05, 20).translate(hub.x, hub.y, hub.z));
    parts.add(P.chrome, new THREE.CylinderGeometry(0.017, 0.017, 0.03, 20).translate(collar.x, collar.y, collar.z));
    for (const a of angles) {
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const foot = new THREE.Vector3(centre[0], RUG_TOP + 0.016, centre[1]).add(dir.clone().multiplyScalar(reach));
      const top = hub.clone().add(dir.clone().multiplyScalar(0.018));
      parts.add(P.chrome, tube(arr(top), arr(foot), legR, 12));
      const mid = top.clone().lerp(foot, 0.55);
      parts.add(P.chrome, tube(arr(collar.clone().add(dir.clone().multiplyScalar(0.015))), arr(mid), legR * 0.75, 10));
      parts.add(P.rubber, new THREE.SphereGeometry(0.014, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.9, 1).translate(foot.x, RUG_TOP, foot.z));
      this.floor.push({ a: [foot.x, foot.z], b: [foot.x, foot.z], r: 0.035 });
    }
    this.floor.push({ a: centre, b: centre, r: 0.03 });
  }

  /** the snare stand: a tripod, a tilt joint and a basket gripping the bottom hoop */
  private buildSnareStand() {
    const P = this.palette;
    const d = this.drums.snare;
    const c = d.spec.centre;
    const parts = new Parts();
    // the snare sits over the gap between the feet: the stand's offset basket arm lets its tripod
    // stand a little back toward the stool and to the left, wherever its legs keep clearest
    const reach = 0.2;
    let base: [number, number] = [c[0], c[2]];
    let clear = -Infinity;
    for (const dz of [0, 0.03, 0.06, 0.08])
      for (const dx of [0, -0.03, -0.06]) {
        const at: [number, number] = [c[0] + dx, c[2] + dz];
        const b = this.bestLegs(at, reach, 3, 0.035);
        if (b.score > clear + 0.005) {
          clear = b.score;
          base = at;
        }
      }
    this.tripod(parts, base, 0.19, reach, 0.0068);
    const bottom = new THREE.Vector3(0, -d.spec.depth - 0.035, 0).applyQuaternion(d.base).add(d.group.position);
    const top = new THREE.Vector3(c[0], bottom.y - 0.05, c[2]);
    const tubeTop = new THREE.Vector3(base[0], top.y - 0.06, base[1]);
    parts.add(P.chrome, tube([base[0], 0.19, base[1]], arr(tubeTop), 0.0105, 16));
    parts.add(P.chrome, memoryLock().translate(base[0], 0.34, base[1]));
    if (tubeTop.distanceTo(top) > 0.01) {
      // the offset arm, from the tube's top to the tilter under the basket
      parts.add(P.chrome, new THREE.CylinderGeometry(0.013, 0.013, 0.03, 16).translate(tubeTop.x, tubeTop.y, tubeTop.z));
      parts.add(P.chrome, tube(arr(tubeTop), arr(top), 0.009, 14));
    }
    // the tilt joint and the basket's three arms with rubber-sleeved hooks over the hoop
    parts.add(P.darkMetal, new THREE.CylinderGeometry(0.022, 0.022, 0.03, 18).rotateZ(Math.PI / 2).translate(top.x, top.y + 0.012, top.z));
    parts.add(P.chrome, wingBolt().applyMatrix4(along([top.x + 0.024, top.y + 0.012, top.z], [1, 0, 0])));
    for (let k = 0; k < 3; k++) {
      const a = 0.5 + (k * 2 * Math.PI) / 3;
      const rim = new THREE.Vector3(Math.sin(a) * (d.R + 0.012), -d.spec.depth - 0.017, Math.cos(a) * (d.R + 0.012)).applyQuaternion(d.base).add(d.group.position);
      const knee = new THREE.Vector3(Math.sin(a) * d.R * 0.75, -d.spec.depth - 0.045, Math.cos(a) * d.R * 0.75).applyQuaternion(d.base).add(d.group.position);
      parts.add(P.chrome, tube([top.x, top.y + 0.02, top.z], arr(knee), 0.006, 10));
      parts.add(P.chrome, tube(arr(knee), arr(rim), 0.006, 10));
      parts.add(P.rubber, new THREE.CylinderGeometry(0.008, 0.008, 0.025, 10).translate(0, 0.012, 0).applyMatrix4(along(arr(rim), arr(new THREE.Vector3(0, 1, 0).applyQuaternion(d.base)))));
    }
    parts.build(this.root, 'snare-stand');
  }

  // ---------------------------------------------------------------- pedals
  private buildKickPedal() {
    const P = this.palette;
    const kp = PEDALS.kickPedal;
    const kick = this.drums.kick;
    const x = kp.ball[0];
    const headZ = kick.spec.centre[2];
    // the footboard's hinge (KitLayout's PEDAL_BOARDS: the drummer's foot stands on the same board)
    const heel = new THREE.Vector3(...PEDAL_BOARDS.kickPedal.hinge);
    const axle = new THREE.Vector3(x, 0.128, headZ + 0.05);
    const felt = new THREE.Vector3(x, kick.spec.centre[1] - 0.01, headZ + 0.022);
    const L = felt.distanceTo(axle);
    const hitAngle = Math.atan2(-(felt.z - axle.z), felt.y - axle.y); // forward (toward -z) is positive
    const restAngle = hitAngle - 0.72;
    this.kickPedal.axle.copy(axle);
    this.kickPedal.heel.copy(heel);
    this.kickPedal.hitAngle = hitAngle;
    this.kickPedal.restAngle = restAngle;
    const parts = new Parts();
    // the base plate from the heel to the frame, and the frame's posts either side of the beater
    const toe = new THREE.Vector3(x, 0, headZ + 0.07);
    parts.add(P.darkMetal, new THREE.BoxGeometry(0.1, 0.006, heel.z - toe.z + 0.06).translate(x, RUG_TOP + 0.003, (heel.z + toe.z) / 2 + 0.02));
    for (const s of [-1, 1]) {
      parts.add(P.darkMetal, new RoundedBoxGeometry(0.016, axle.y + 0.012, 0.03, 2, 0.004).translate(x + s * 0.052, (axle.y + 0.012) / 2 + RUG_TOP, axle.z));
      parts.add(P.chrome, new THREE.CylinderGeometry(0.011, 0.011, 0.012, 16).rotateZ(Math.PI / 2).translate(x + s * 0.062, axle.y, axle.z));
    }
    // the hoop clamp at the front, with its T-screw
    parts.add(P.darkMetal, new RoundedBoxGeometry(0.11, 0.02, 0.03, 2, 0.004).translate(x, RUG_TOP + 0.025, headZ + 0.02));
    parts.add(P.chrome, tube([x, RUG_TOP + 0.035, headZ + 0.02], [x, RUG_TOP + 0.085, headZ + 0.02], 0.004, 8));
    parts.add(P.chrome, tube([x - 0.02, RUG_TOP + 0.085, headZ + 0.02], [x + 0.02, RUG_TOP + 0.085, headZ + 0.02], 0.0045, 8));
    // the heel plate with its hinge
    parts.add(P.darkMetal, new RoundedBoxGeometry(0.085, 0.01, 0.07, 2, 0.003).translate(x, RUG_TOP + 0.009, heel.z + 0.03));
    parts.add(P.chrome, new THREE.CylinderGeometry(0.006, 0.006, 0.08, 12).rotateZ(Math.PI / 2).translate(x, heel.y, heel.z));
    // spurs on the base, the spring's anchor on the right post
    const springBase = new THREE.Vector3(x + 0.07, RUG_TOP + 0.03, axle.z);
    this.kickPedal.springBase.copy(springBase);
    parts.add(P.darkMetal, new THREE.BoxGeometry(0.02, 0.01, 0.03).translate(springBase.x, springBase.y - 0.01, springBase.z));
    parts.build(this.root, 'kick-pedal');

    // the axle with the beater holder, the cam (on the left) and the spring's crank (on the right): they turn together
    const beater = new THREE.Group();
    beater.position.copy(axle);
    this.root.add(beater);
    this.beater = beater;
    const bp = new Parts();
    bp.add(P.chrome, new THREE.CylinderGeometry(0.0055, 0.0055, 0.11, 12).rotateZ(Math.PI / 2));
    bp.add(P.chrome, new RoundedBoxGeometry(0.02, 0.024, 0.02, 2, 0.004));
    // the shaft and the felt head (a cylinder across the swing, its face to the head)
    bp.add(P.chrome, tube([0, 0, 0], [0, L - 0.025, 0], 0.0033, 10));
    bp.add(P.beaterFelt, new THREE.CylinderGeometry(0.031, 0.031, 0.034, 28).rotateX(Math.PI / 2).translate(0, L, 0));
    bp.add(P.chrome, new THREE.CylinderGeometry(0.012, 0.012, 0.036, 16).rotateX(Math.PI / 2).translate(0, L - 0.02, 0));
    // the cam (sprocket) on the left, the crank for the spring on the right
    bp.add(P.darkMetal, new THREE.CylinderGeometry(0.026, 0.026, 0.008, 28).rotateZ(Math.PI / 2).translate(-0.04, 0, 0));
    bp.add(P.chrome, new RoundedBoxGeometry(0.006, 0.05, 0.012, 2, 0.002).translate(0.072, -0.02, 0));
    const bm = bp.build(beater, 'beater');
    this.moving.push(...bm);
    this.kickPedal.crank = 0.045;

    // the footboard, hinged at the heel: its toe pulls the chain down onto the cam
    const foot = new THREE.Group();
    foot.position.copy(heel);
    this.root.add(foot);
    this.kickFoot = foot;
    // the toe reaches under the axle, between the posts: the chain pulls the cam's front down
    const len = PEDAL_BOARDS.kickPedal.length;
    const fp = new Parts();
    const board = new RoundedBoxGeometry(0.088, 0.008, len, 2, 0.003).translate(0, 0.006, -len / 2);
    fp.add(P.alu, board);
    // the toe stop and the chain's connector at the front
    fp.add(P.darkMetal, new RoundedBoxGeometry(0.09, 0.016, 0.014, 2, 0.003).translate(0, 0.014, -len + 0.006));
    fp.add(P.darkMetal, new RoundedBoxGeometry(0.03, 0.02, 0.02, 2, 0.004).translate(-0.04, 0.016, -len + 0.012));
    const fm = fp.build(foot, 'kick-footboard');
    this.moving.push(...fm);
    // the footboard rests with its toe raised (7.2 cm); pressed, it drops PEDAL_TRAVEL as the beater meets the head
    // (KitLayout's footboardAngle: the robot's foot turns the same footboard by the same angle)
    this.chainGeo.toe.set(-0.04, 0.026, -len + 0.01);
    // the chain: links between the cam and the toe, posed every frame
    const link = new RoundedBoxGeometry(0.006, 0.011, 0.004, 1, 0.0015);
    const N = 9;
    const mats = Array.from({ length: N }, () => new THREE.Matrix4());
    this.chain = instanced(link, P.darkMetal, mats);
    this.chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chain.frustumCulled = false;
    this.root.add(this.chain);
    this.moving.push(this.chain);
    // the spring: from the crank down to its anchor, stretched as the axle turns
    const coils = helix(0.0075, 0.0011, 1, 14);
    this.spring = new THREE.Mesh(coils, P.chrome);
    this.spring.castShadow = true;
    this.root.add(this.spring);
    this.moving.push(this.spring);
    this.floor.push({ a: [x, axle.z], b: [x, heel.z], r: 0.07 });
  }

  private buildHiHat() {
    const P = this.palette;
    const hh = DRUMS.hihat;
    const shape = CYMBAL_SHAPES.hats;
    const c = hh.centre;
    const q = orientation(hh);
    // the column's head, so that the top cymbal's centre is KitLayout's (the tilt puts it a few mm off the column's line)
    const mount = hihatMount();
    const [cx, cz] = mount.column;
    const colTop = mount.head[1];
    const parts = new Parts();
    // the stand: a tripod around the column, the column, its height lock
    this.tripod(parts, [cx, cz], 0.24, 0.245, 0.0075);
    parts.add(P.chrome, tube([cx, 0.08, cz], [cx, 0.56, cz], 0.0135, 18));
    parts.add(P.chrome, memoryLock(0.0175).translate(cx, 0.56, cz));
    parts.add(P.chrome, tube([cx, 0.56, cz], [cx, colTop, cz], 0.0105, 16));
    // the pedal: a frame from the heel to the column's foot, the footboard on it (separate: it moves)
    const board = PEDAL_BOARDS.hihatPedal;
    const heel = new THREE.Vector3(...board.hinge);
    const len = board.length + 0.03;
    const fq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), board.yaw + Math.PI);
    parts.add(P.darkMetal, new THREE.BoxGeometry(0.095, 0.006, len + 0.05).translate(0, RUG_TOP + 0.003, -(len + 0.05) / 2 + 0.03).applyMatrix4(new THREE.Matrix4().compose(heel.clone().setY(0), fq, new THREE.Vector3(1, 1, 1))));
    parts.add(P.darkMetal, new RoundedBoxGeometry(0.085, 0.01, 0.07, 2, 0.003).translate(0, RUG_TOP + 0.009, 0.03).applyMatrix4(new THREE.Matrix4().compose(heel.clone().setY(0), fq, new THREE.Vector3(1, 1, 1))));
    // the spring housing at the column's foot, and the link up into the column
    parts.add(P.darkMetal, new RoundedBoxGeometry(0.05, 0.07, 0.04, 2, 0.006).translate(cx, RUG_TOP + 0.045, cz));
    parts.build(this.root, 'hihat-stand');
    this.floor.push({ a: [heel.x, heel.z], b: [cx, cz], r: 0.06 });

    const hf = new THREE.Group();
    hf.position.copy(heel);
    hf.quaternion.copy(fq);
    this.root.add(hf);
    this.hhFoot = hf;
    const flen = board.length;
    const fp = new Parts();
    fp.add(P.alu, new RoundedBoxGeometry(0.085, 0.008, flen, 2, 0.003).translate(0, 0.006, -flen / 2));
    fp.add(P.darkMetal, new RoundedBoxGeometry(0.088, 0.016, 0.014, 2, 0.003).translate(0, 0.014, -flen + 0.006));
    this.moving.push(...fp.build(hf, 'hihat-footboard'));

    // the cymbals' head of the stand: tilted as the layout asks, on the column
    const head = new THREE.Group();
    head.position.set(...mount.head);
    head.quaternion.copy(q);
    this.root.add(head);
    const hp2 = new Parts();
    // the seat cup with its felt, and the tilt screw
    hp2.add(P.chrome, revolve([[0.024, 0.0], [0.024, 0.004], [0.012, 0.009], [0.0105, 0.009], [0.0105, -0.012], [0.024, 0.0]], 32, 35));
    hp2.add(P.felt, new THREE.CylinderGeometry(0.02, 0.02, 0.008, 24).translate(0, 0.013, 0));
    hp2.add(P.chrome, tube([0.02, 0.004, 0], [0.032, -0.008, 0], 0.003, 8));
    // the pull rod, out of the column up through both cymbals
    hp2.add(P.chrome, tube([0, -0.02, 0], [0, 0.03, 0], 0.0036, 10));
    hp2.build(head, 'hihat-seat');
    // the bottom cymbal, bell down, resting on the seat's felt
    const bottom = cymbalMesh(shape, 3, P);
    bottom.rotation.x = Math.PI;
    bottom.position.y = mount.bottomY;
    head.add(bottom);
    // the top cymbal and its clutch on the pull rod: lifted by the pedal
    const top = new THREE.Group();
    head.add(top);
    this.hhTop = top;
    const tp = new Parts();
    const topY = mount.topY;
    void c;
    tp.add(P.chrome, tube([0, topY - 0.045, 0], [0, topY + 0.09, 0], 0.0036, 10));
    // the clutch: lower felt, the cymbal, upper felt, the body with its thumb screw
    tp.add(P.chrome, new THREE.CylinderGeometry(0.008, 0.008, 0.006, 16).translate(0, topY + shape.bellH - shape.t[0] - 0.012, 0));
    tp.add(P.felt, new THREE.CylinderGeometry(0.016, 0.016, 0.007, 20).translate(0, topY + shape.bellH - shape.t[0] - 0.0055, 0));
    tp.add(P.felt, new THREE.CylinderGeometry(0.016, 0.016, 0.007, 20).translate(0, topY + shape.bellH + 0.0035, 0));
    tp.add(P.chrome, new THREE.CylinderGeometry(0.009, 0.009, 0.028, 18).translate(0, topY + shape.bellH + 0.021, 0));
    tp.add(P.chrome, tube([0, topY + shape.bellH + 0.026, 0], [0.024, topY + shape.bellH + 0.026, 0], 0.0028, 8));
    tp.add(P.chrome, new THREE.CylinderGeometry(0.0055, 0.0055, 0.012, 12).rotateZ(Math.PI / 2).translate(0.026, topY + shape.bellH + 0.026, 0));
    this.moving.push(...tp.build(top, 'hihat-clutch'));
    const rock = new THREE.Group();
    rock.position.y = topY + shape.bellH - shape.t[0];
    top.add(rock);
    const topCym = cymbalMesh(shape, 2, P);
    topCym.position.y = -(shape.bellH - shape.t[0]);
    rock.add(topCym);
    this.moving.push(topCym, bottom);
    this.cym.hihat = { top: head, rock, q };
  }

  /** a cymbal on a boom stand: tripod, tubes, memory locks, the boom's tilter, arm and counterweight, the cymbal's tilter and felts */
  private buildCymbalStand(id: 'crash' | 'ride', base: [number, number]) {
    const P = this.palette;
    const spec = DRUMS[id];
    const shape = CYMBAL_SHAPES[id];
    const q = orientation(spec);
    const n = v3(surfaceNormal(spec));
    const centre = v3(spec.centre);
    // the tilter's foot: below the cymbal along its axis
    const stack = shape.bellH + 0.03;
    const tilt = centre.clone().addScaledVector(n, -stack);
    const parts = new Parts();
    this.tripod(parts, base, 0.27, 0.3, 0.0085);
    const joint = new THREE.Vector3(base[0], tilt.y - 0.2, base[1]);
    const mid = 0.62;
    parts.add(P.chrome, tube([base[0], 0.08, base[1]], [base[0], mid, base[1]], 0.0145, 18));
    parts.add(P.chrome, memoryLock(0.019).translate(base[0], mid, base[1]));
    parts.add(P.chrome, tube([base[0], mid, base[1]], arr(joint), 0.011, 16));
    parts.build(this.root, `${id}-stand`);
    // the stand's top: the boom tilter, arm and counterweight, the cymbal's tilter; it gives with the cymbal
    const top = new THREE.Group();
    top.position.copy(joint);
    this.root.add(top);
    const tp = new Parts();
    const arm = tilt.clone().sub(joint);
    const dir = arm.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    // the ratchet tilter: a toothed disc across the arm's plane, a wing bolt through it
    tp.add(P.chrome, new THREE.CylinderGeometry(0.021, 0.021, 0.032, 24).applyMatrix4(along([0, 0, 0], arr(side))));
    tp.add(P.chrome, wingBolt(1.2).applyMatrix4(along(arr(side.clone().multiplyScalar(0.02)), arr(side))));
    tp.add(P.chrome, tube(arr(dir.clone().multiplyScalar(-0.13)), arr(arm), 0.0095, 14));
    tp.add(P.chrome, new THREE.CylinderGeometry(0.018, 0.018, 0.06, 20).applyMatrix4(along(arr(dir.clone().multiplyScalar(-0.16)), arr(dir))));
    // the cymbal's tilter: a cup washer and felt below, the threaded rod with its nylon sleeve, felt, washer and wing nut above
    const rel = (k: number) => arr(arm.clone().addScaledVector(n, k));
    // b: the top of the bell (from the tilter's foot); the bell's inside rests on the lower felt
    const b = stack + shape.bellH;
    const under = b - shape.t[0];
    tp.add(P.chrome, tube(arr(arm), rel(b + 0.026), 0.004, 10));
    tp.add(P.chrome, new THREE.CylinderGeometry(0.0115, 0.0115, 0.016, 18).applyMatrix4(along(arr(arm), arr(n))));
    tp.add(P.chrome, revolve([[0.019, 0.003], [0.019, 0.006], [0.006, 0.0], [0.006, -0.002], [0.019, 0.003]], 28, 35).applyMatrix4(along(rel(under - 0.0155), arr(n))));
    tp.add(P.felt, new THREE.CylinderGeometry(0.018, 0.018, 0.009, 22).applyMatrix4(along(rel(under - 0.0045), arr(n))));
    tp.add(P.nylon, new THREE.CylinderGeometry(0.0058, 0.0058, 0.016, 14).applyMatrix4(along(rel(b - 0.002), arr(n))));
    tp.add(P.felt, new THREE.CylinderGeometry(0.016, 0.016, 0.008, 22).applyMatrix4(along(rel(b + 0.0045), arr(n))));
    tp.add(P.chrome, new THREE.CylinderGeometry(0.012, 0.012, 0.0015, 18).applyMatrix4(along(rel(b + 0.0092), arr(n))));
    tp.add(P.chrome, wingNut().applyMatrix4(along(rel(b + 0.014), arr(n))));
    this.moving.push(...tp.build(top, `${id}-top`));
    // the cymbal: it rocks about its felt (where the bell's inside rests)
    const holder = new THREE.Group();
    holder.position.copy(arm).addScaledVector(n, stack);
    holder.quaternion.copy(q);
    top.add(holder);
    const rock = new THREE.Group();
    rock.position.y = shape.bellH - shape.t[0];
    holder.add(rock);
    const mesh = cymbalMesh(shape, id === 'crash' ? 0 : 1, P);
    mesh.position.y = -(shape.bellH - shape.t[0]);
    rock.add(mesh);
    this.moving.push(mesh);
    this.cym[id] = { top, rock, q };
  }

  private buildStool() {
    const P = this.palette;
    const s = SEAT.centre;
    const R = SEAT.diameter / 2;
    const parts = new Parts();
    // the seat: a padded round cushion with a piped seam
    const h = 0.085;
    const y0 = s[1] - h;
    const cushion: P2[] = [];
    cushion.push([0.06, y0 - 0.002]);
    cushion.push([R - 0.02, y0]);
    cushion.push(...arc(R - 0.02, y0 + 0.022, 0.022, -Math.PI / 2, 0, 5).slice(1));
    cushion.push([R, s[1] - 0.03]);
    cushion.push(...arc(R - 0.035, s[1] - 0.03, 0.035, 0, Math.PI / 2, 7).slice(1));
    cushion.push([R * 0.5, s[1] + 0.004]);
    cushion.push([0, s[1] + 0.006]);
    parts.add(P.vinyl, revolve(cushion, 64, 50));
    parts.add(P.vinyl, ring(R - 0.0005, 0.0032, s[1] - 0.026, 64, 6));
    // the seat's steel base and the threaded spindle in its sleeve, the height clamp
    parts.add(P.darkMetal, new THREE.CylinderGeometry(0.12, 0.13, 0.012, 32).translate(s[0], y0 - 0.008, s[2]));
    parts.add(P.chrome, tube([s[0], y0 - 0.014, s[2]], [s[0], 0.34, s[2]], 0.014, 16));
    parts.add(P.chrome, tube([s[0], 0.34, s[2]], [s[0], 0.2, s[2]], 0.021, 18));
    parts.add(P.chrome, memoryLock(0.025).translate(s[0], 0.34, s[2]));
    parts.add(P.chrome, wingBolt(1.3).applyMatrix4(along([s[0] + 0.03, 0.32, s[2]], [1, 0, 0])));
    // three double-braced legs
    for (const a of STOOL_LEGS) {
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const foot = new THREE.Vector3(s[0], RUG_TOP + 0.016, s[2]).add(dir.clone().multiplyScalar(STOOL_REACH));
      const hub = new THREE.Vector3(s[0], 0.24, s[2]).add(dir.clone().multiplyScalar(0.022));
      for (const o of [-0.012, 0.012]) {
        const off = new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(o);
        parts.add(P.chrome, tube(arr(hub.clone().add(off)), arr(foot.clone().add(off)), 0.0078, 12));
      }
      parts.add(P.chrome, tube([s[0] + dir.x * 0.02, 0.12, s[2] + dir.z * 0.02], arr(hub.clone().lerp(foot, 0.55)), 0.0065, 10));
      parts.add(P.rubber, new RoundedBoxGeometry(0.04, 0.02, 0.05, 2, 0.006).translate(foot.x, RUG_TOP + 0.01, foot.z));
    }
    parts.build(this.root, 'stool');
  }

  private buildRug() {
    const g = new THREE.BoxGeometry(2.3, RUG_TOP, 1.9, 1, 1, 1);
    const m = new THREE.Mesh(g, this.palette.rug);
    // under the kit, from behind the stool to beyond the kick
    m.position.set(0.1, RUG_TOP / 2, (SEAT.centre[2] + 0.4 + DRUMS.kick.centre[2] - DRUMS.kick.depth - 0.45) / 2);
    m.castShadow = false;
    m.receiveShadow = true;
    m.name = 'rug';
    this.root.add(m);
  }

  // ---------------------------------------------------------------- posing
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  update(s: KitState) {
    const P = this.palette;
    // heads and wires
    const sh = P.shimmer.value;
    sh[0] = s.heads.kick;
    sh[1] = s.heads.snare;
    sh[2] = s.heads.tom1;
    sh[3] = s.heads.tom2;
    sh[4] = s.heads.floorTom;
    sh[5] = 0;
    P.buzz.value = s.buzz;
    // toms on their mounts
    for (const id of ['tom1', 'tom2', 'floorTom'] as const) {
      const d = this.drums[id];
      d.group.quaternion.copy(d.base).multiply(tiltQ(s.toms[id], this.qa));
    }
    // cymbals: rocking on their felts, and their stands giving a little
    for (const id of ['crash', 'ride', 'hihat'] as CymbalId[]) {
      const c = this.cym[id];
      const t = s.cymbals[id];
      c.rock.quaternion.copy(tiltQ(t, this.qa));
      c.rock.position.y = c.rock.userData.y0 ??= c.rock.position.y;
      c.rock.position.y = (c.rock.userData.y0 as number) + t.drop;
      if (id !== 'hihat') {
        // the stand's top turns about the boom joint, about the same axis as its cymbal (in the kit's frame)
        const g = s.stands[id];
        const a = Math.hypot(g.x, g.z);
        if (a > 1e-9) {
          const axis = new THREE.Vector3(g.x / a, 0, g.z / a).applyQuaternion(c.q);
          c.top.quaternion.setFromAxisAngle(axis, a);
        } else c.top.quaternion.identity();
      }
    }
    // the hi-hat: the top cymbal and clutch lifted by the pedal, the footboard following
    this.hhTop.position.y = s.hihatGap;
    this.hhFoot.quaternion.copy(this.hhFoot.userData.q0 ??= this.hhFoot.quaternion.clone());
    this.hhFoot.quaternion.copy(this.hhFoot.userData.q0 as THREE.Quaternion).multiply(this.qb.setFromAxisAngle(X_AXIS, footboardAngle('hihatPedal', s.hihatClosed)));
    // the kick pedal: beater, axle, cam and crank turn together; the footboard and chain follow; the spring stretches
    const k = this.kickPedal;
    const ang = k.restAngle + (k.hitAngle - k.restAngle) * s.beater;
    this.beater.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -ang);
    this.kickFoot.quaternion.setFromAxisAngle(X_AXIS, footboardAngle('kickPedal', s.beater));
    this.poseChain();
    this.poseSpring();
  }

  private poseChain() {
    const k = this.kickPedal;
    this.root.updateMatrixWorld();
    // from the bottom of the cam to the footboard's connector
    const camPt = new THREE.Vector3(-0.04, -0.008, -0.025).applyMatrix4(this.beater.matrix);
    const toe = this.chainGeo.toe.clone().applyMatrix4(this.kickFoot.matrix);
    const d = toe.clone().sub(camPt);
    const len = d.length();
    const dir = d.clone().normalize();
    const n = this.chain.count;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const p = camPt.clone().addScaledVector(dir, ((i + 0.5) / n) * len);
      const qi = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i % 2 ? Math.PI / 2 : 0));
      m.compose(p, qi, new THREE.Vector3(1, (len / n / 0.011) * 1.05, 1));
      this.chain.setMatrixAt(i, m);
    }
    this.chain.instanceMatrix.needsUpdate = true;
    void k;
  }

  private poseSpring() {
    const k = this.kickPedal;
    const crankEnd = new THREE.Vector3(0.072, -0.042, 0).applyMatrix4(this.beater.matrix);
    const a = k.springBase;
    const d = crankEnd.clone().sub(a);
    const len = d.length();
    this.spring.position.copy(a);
    this.spring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    this.spring.scale.set(1, len, 1);
  }

  /** remember the instanced chain's transforms as the previous ones (motion blur) */
  keepPrevious() {
    const prev = this.chain.geometry.getAttribute('prevInstanceMatrix') as THREE.InstancedBufferAttribute;
    (prev.array as Float32Array).set(this.chain.instanceMatrix.array as Float32Array);
    prev.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- small parts
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

/** a lug on the shell: a rounded body standing off the wood, its swivel nut toward the hoop (+y) */
function lugBody(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new RoundedBoxGeometry(0.019, 0.04, 0.016, 3, 0.006);
  body.translate(0, 0, 0.009);
  parts.push(body);
  const nut = new THREE.CylinderGeometry(0.0045, 0.0045, 0.012, 12);
  nut.translate(0, 0.022, 0.0145);
  parts.push(nut);
  return mergeAll(parts);
}

/** the snare's tube lug: a tube along the shell on two posts */
function snareLug(len: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = new THREE.CylinderGeometry(0.0055, 0.0055, len, 14);
  t.translate(0, 0, 0.0135);
  parts.push(t);
  for (const y of [-0.42 * len, 0.42 * len]) {
    const p = new THREE.CylinderGeometry(0.004, 0.0048, 0.012, 10);
    p.rotateX(Math.PI / 2);
    p.translate(0, y, 0.007);
    parts.push(p);
  }
  return mergeAll(parts);
}

/** a tension rod: through the hoop's flange into the lug, a square head on a washer above the flange */
function tensionRod(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.0024, 0.0024, 0.03, 8).translate(0, -0.03, 0));
  parts.push(new THREE.BoxGeometry(0.0062, 0.008, 0.0062).translate(0, -0.0099, 0));
  parts.push(new THREE.CylinderGeometry(0.005, 0.005, 0.001, 12).translate(0, -0.0138, 0));
  return mergeAll(parts);
}

/** the kick's T-rod: a T handle outside the hoop, the rod through the claw into the lug */
function kickRod(R: number): THREE.BufferGeometry {
  void R;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.0028, 0.0028, 0.06, 8).translate(0, -0.01, 0));
  const t = new THREE.CylinderGeometry(0.0045, 0.0045, 0.044, 10);
  t.rotateZ(Math.PI / 2);
  t.translate(0, 0.024, 0);
  parts.push(t);
  parts.push(new THREE.CylinderGeometry(0.0055, 0.0055, 0.008, 10).translate(0, 0.019, 0));
  return mergeAll(parts);
}

/** a claw over the kick's wooden hoop (in the rod's frame: the hoop is at -z from the rod) */
function claw(R: number): THREE.BufferGeometry {
  void R;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new RoundedBoxGeometry(0.014, 0.008, 0.026, 2, 0.002).translate(0, 0.015, -0.006));
  parts.push(new RoundedBoxGeometry(0.014, 0.024, 0.006, 2, 0.002).translate(0, 0.004, -0.019));
  return mergeAll(parts);
}

/** a memory lock collar with its wing bolt */
function memoryLock(r = 0.017): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.022, 20));
  parts.push(wingBolt().applyMatrix4(along([r + 0.006, 0, 0], [1, 0, 0])));
  return mergeAll(parts);
}

/** a wing bolt: a short threaded shank and a flat two-winged head (along +y) */
function wingBolt(scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.0035, 0.0035, 0.01, 8).translate(0, 0.005, 0));
  parts.push(new THREE.CylinderGeometry(0.0055, 0.0055, 0.006, 10).translate(0, 0.012, 0));
  const wing = new RoundedBoxGeometry(0.03, 0.016, 0.0035, 2, 0.0015);
  wing.translate(0, 0.02, 0);
  parts.push(wing);
  const g = mergeAll(parts);
  g.scale(scale, scale, scale);
  return g;
}

/** a cymbal's wing nut (along +y) */
function wingNut(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.0062, 0.0068, 0.008, 12));
  const w = new RoundedBoxGeometry(0.034, 0.013, 0.003, 2, 0.0012);
  w.translate(0, 0.006, 0);
  parts.push(w);
  return mergeAll(parts);
}

/** a coil spring along +y, unit length (scaled to its stretch) */
function helix(R: number, r: number, length: number, turns: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const N = turns * 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * R, t * length, Math.sin(a) * R));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, r, 5, false);
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const p = new Parts();
  const tmp = new THREE.MeshBasicMaterial();
  for (const g of parts) p.add(tmp, g);
  const holder = new THREE.Group();
  const [m] = p.build(holder);
  return m.geometry;
}

/** a cymbal of the given shape; stamp: 0 crash, 1 ride, 2 hi-hat top, 3 hi-hat bottom */
function cymbalMesh(shape: CymbalShape, stamp: number, P: DrumPalette): THREE.Mesh {
  const g = revolve(cymbalProfile(shape), 160, 28);
  tag(g, 'aCym', stamp, shape.R);
  const m = new THREE.Mesh(g, P.cymbal);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = ['crash', 'ride', 'hihat-top', 'hihat-bottom'][stamp];
  // a cymbal is never perfectly true: turned a little on its stand (the stamp and hammer marks fall differently)
  m.rotation.y = hash01(stamp, 5) * 0.8 - 0.4;
  return m;
}

export type { DrumId };
