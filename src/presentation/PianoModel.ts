// The piano: the Blender-built case plus 88 keys built here from the shared
// keyboard layout. Every key is its own mesh inside a pivot group on the
// balance rail, so it tilts like a real key rather than sliding down.
import * as THREE from 'three';
import {
  BLACK_FRONT_Z,
  BLACK_HEIGHT,
  BLACK_WIDTH_BOTTOM,
  BLACK_WIDTH_TOP,
  KEYS,
  PIVOT_Y,
  WHITE_FRONT_HEIGHT,
  keyAngle,
  type KeyInfo,
} from '../core/keyboard';
import { hash01 } from '../core/random';
import type { Palette } from './materials';

const KEY_BACK = -0.162; // keys run on under the nameboard

function whiteKeyGeometry(k: KeyInfo): THREE.BufferGeometry {
  // outline in (x, z), relative to the key centre; the front part is full
  // width, the tail narrows between neighbouring black keys
  const l = k.frontLeft - k.x;
  const r = k.frontRight - k.x;
  const tl = k.tailLeft - k.x;
  const tr = k.tailRight - k.x;
  const zf = 0;
  const zt = BLACK_FRONT_Z - 0.0012; // where the tail begins (a hair in front of the black keys)
  const shape = new THREE.Shape();
  shape.moveTo(l, zf);
  shape.lineTo(r, zf);
  if (Math.abs(tr - r) > 1e-5) {
    shape.lineTo(r, zt);
    shape.lineTo(tr, zt);
  }
  shape.lineTo(tr, KEY_BACK);
  shape.lineTo(tl, KEY_BACK);
  if (Math.abs(tl - l) > 1e-5) {
    shape.lineTo(tl, zt);
    shape.lineTo(l, zt);
  }
  shape.lineTo(l, zf);
  const bevel = 0.0008;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: WHITE_FRONT_HEIGHT - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 1,
  });
  // shape plane (x, v) -> world (x, z = v); extrusion downward from y = 0
  g.rotateX(Math.PI / 2);
  g.translate(0, -bevel, 0);
  return g;
}

function blackKeyGeometry(): THREE.BufferGeometry {
  // cross-section (x, y): tapered, with rounded top corners
  const y0 = -0.012;
  const y1 = BLACK_HEIGHT;
  const hb = BLACK_WIDTH_BOTTOM / 2;
  const ht = BLACK_WIDTH_TOP / 2;
  const rc = 0.0016;
  // counter-clockwise seen from the front: bottom, right side, rounded top corners, left side
  const prof: [number, number][] = [[-hb, y0], [hb, y0]];
  for (let i = 0; i <= 5; i++) {
    const a = (Math.PI / 2) * (i / 5);
    prof.push([ht - rc + rc * Math.cos(a), y1 - rc + rc * Math.sin(a)]);
  }
  for (let i = 0; i <= 5; i++) {
    const a = Math.PI / 2 + (Math.PI / 2) * (i / 5);
    prof.push([-ht + rc + rc * Math.cos(a), y1 - rc + rc * Math.sin(a)]);
  }
  // front face slopes back toward the top
  const zFront = (y: number) => BLACK_FRONT_Z - ((y - y0) / (y1 - y0)) * 0.0075;
  const zBack = KEY_BACK + 0.004;
  const n = prof.length;
  const pos: number[] = [];
  const idx: number[] = [];
  // sides: smooth around the profile
  for (const [x, y] of prof) pos.push(x, y, zFront(y));
  for (const [x, y] of prof) pos.push(x, y, zBack);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, n + i, j, j, n + i, n + j);
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sides.setIndex(idx);
  sides.computeVertexNormals();
  // front cap: flat, its own vertices so the edge stays crisp (with a tiny chamfer look from the slope)
  const cap: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of prof) {
    cx += x / n;
    cy += y / n;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, yy0] = prof[i];
    const [x1, yy1] = prof[j];
    cap.push(cx, cy, zFront(cy), x0, yy0, zFront(yy0), x1, yy1, zFront(yy1));
  }
  const capG = new THREE.BufferGeometry();
  capG.setAttribute('position', new THREE.Float32BufferAttribute(cap, 3));
  capG.computeVertexNormals();
  return mergeGeometries([sides.toNonIndexed(), capG]);
}

function mergeGeometries(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g of gs) {
    const p = g.getAttribute('position');
    const nn = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(nn.getX(i), nn.getY(i), nn.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

function tint(g: THREE.BufferGeometry, k: KeyInfo) {
  // each key a slightly different piece of ivory or ebony; a little darker toward the back
  const h = hash01(k.midi, 3);
  const h2 = hash01(k.midi, 5);
  const base = k.black
    ? new THREE.Color().setRGB(1 + (h - 0.5) * 0.25, 1 + (h - 0.5) * 0.2, 1 + (h - 0.5) * 0.15)
    : new THREE.Color().setRGB(1 - h * 0.035, 1 - h * 0.045 - h2 * 0.01, 1 - h * 0.08 - h2 * 0.03);
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const back = THREE.MathUtils.smoothstep(-z, 0.09, 0.16);
    const s = 1 - back * 0.35;
    col[i * 3] = base.r * s;
    col[i * 3 + 1] = base.g * s;
    col[i * 3 + 2] = base.b * s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * No two keys of a real piano sit quite alike: each rests a fraction of a
 * millimetre higher or lower, a hair to one side, turned the slightest bit.
 * Kept well under the 2 mm the fingertips are checked against, and below
 * anything that reads as wear (radians and metres).
 */
function irregularity(k: KeyInfo) {
  const c = (seed: number) => hash01(k.midi, seed) * 2 - 1;
  return { x: 0.00006 * c(11), y: 0.00011 * c(12), yaw: 0.0007 * c(13), tilt: 0.0006 * c(14) };
}

/**
 * The candle sconces are screwed to the upper front panel, but the case
 * builds them into one brass mesh with the pedals: split the triangles above
 * the keyboard into their own mesh, so they come off with the panel.
 */
function splitSconces(caseScene: THREE.Object3D): THREE.Object3D | null {
  const brass = caseScene.getObjectByName('Brass');
  if (!brass) return null;
  caseScene.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.name = 'Sconces';
  const meshes: THREE.Mesh[] = [];
  brass.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const idx = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i);
    const up: number[] = [];
    const down: number[] = [];
    for (let t = 0; t + 2 < idx.length; t += 3) {
      let y = 0;
      for (let k = 0; k < 3; k++) y += v.fromBufferAttribute(pos, idx[t + k]).applyMatrix4(mesh.matrixWorld).y / 3;
      (y > -0.2 ? up : down).push(idx[t], idx[t + 1], idx[t + 2]);
    }
    if (!up.length) continue;
    const top = new THREE.Mesh(g.clone(), mesh.material);
    top.geometry.setIndex(up);
    g.setIndex(down);
    top.castShadow = mesh.castShadow;
    top.receiveShadow = mesh.receiveShadow;
    mesh.matrixWorld.decompose(top.position, top.quaternion, top.scale);
    group.add(top);
  }
  caseScene.add(group);
  return group;
}

export class PianoModel {
  readonly root = new THREE.Group();
  /** the brass sconces on the upper panel (null without a case) */
  readonly sconces: THREE.Object3D | null;
  readonly pivots: THREE.Group[] = [];
  readonly keyMeshes: THREE.Mesh[] = [];
  private angles = new Float32Array(KEYS.length).fill(-1);
  private restTilt = new Float32Array(KEYS.length);

  constructor(caseScene: THREE.Object3D | null, palette: Palette) {
    this.root.name = 'Piano';
    if (caseScene) this.root.add(caseScene);
    this.sconces = caseScene ? splitSconces(caseScene) : null;
    const blackGeo = blackKeyGeometry();
    for (const k of KEYS) {
      const pivot = new THREE.Group();
      pivot.name = `KeyPivot${k.midi}`;
      pivot.position.set(0, PIVOT_Y, k.pivotZ);
      const geo = k.black ? blackGeo.clone() : whiteKeyGeometry(k);
      tint(geo, k);
      const mesh = new THREE.Mesh(geo, k.black ? palette.ebony : palette.ivory);
      mesh.name = `Key${k.midi}`;
      const irr = irregularity(k);
      mesh.position.set(k.x + irr.x, -PIVOT_Y + irr.y, -k.pivotZ);
      mesh.rotation.y = irr.yaw;
      this.restTilt[this.pivots.length] = irr.tilt;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pivot.add(mesh);
      this.root.add(pivot);
      this.pivots.push(pivot);
      this.keyMeshes.push(mesh);
    }
  }

  /** depression per key (0..1), index = midi - 21 */
  setKeys(depression: Float32Array) {
    for (let i = 0; i < KEYS.length; i++) {
      const a = keyAngle(KEYS[i], depression[i]);
      if (a !== this.angles[i]) {
        this.angles[i] = a;
        this.pivots[i].rotation.x = a + this.restTilt[i];
      }
    }
  }
}
