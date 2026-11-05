// Geometry helpers for the drum kit (DrumKitModel.ts): surfaces of
// revolution with real profiles (shells with bearing edges, hoops, heads,
// cymbals), tubes between points, and merging parts by material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type P2 = [number, number];
export type V3 = [number, number, number];

/**
 * A surface of revolution about +y from a profile of (radius, height)
 * points. Unlike THREE.LatheGeometry, corners sharper than `crease` keep
 * hard edges (each segment gets its own normals there), so a bearing edge
 * or a hoop's flange reads as machined. u runs around, v along the profile
 * (in metres).
 */
export function revolve(profile: P2[], segments = 64, crease = 35, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const n = profile.length;
  // each segment's outward normal in the (r, y) plane: profiles are traced with the outside on their right
  // (up an outer wall, inward across a top, down an inner wall)
  const segN: P2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dr = profile[i + 1][0] - profile[i][0];
    const dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
  }
  const cosCrease = Math.cos((crease * Math.PI) / 180);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let vacc = 0;
  for (let i = 0; i + 1 < n; i++) {
    // the normal at each end: smoothed with the neighbour unless the corner is sharp
    const ends: P2[] = [];
    for (const [k, other] of [
      [i, i - 1],
      [i + 1, i + 1],
    ] as const) {
      const a = segN[i];
      const b = other >= 0 && other < segN.length ? segN[other] : null;
      if (b && a[0] * b[0] + a[1] * b[1] > cosCrease) {
        const s: P2 = [a[0] + b[0], a[1] + b[1]];
        const l = Math.hypot(s[0], s[1]) || 1;
        ends.push([s[0] / l, s[1] / l]);
      } else ends.push(a);
      void k;
    }
    const segLen = Math.hypot(profile[i + 1][0] - profile[i][0], profile[i + 1][1] - profile[i][1]);
    const base = pos.length / 3;
    for (let s = 0; s <= segments; s++) {
      const phi = phiStart + (s / segments) * phiLength;
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      for (let e = 0; e < 2; e++) {
        const [r, y] = profile[i + e];
        const [nr, ny] = ends[e];
        pos.push(r * sn, y, r * c);
        nor.push(nr * sn, ny, nr * c);
        uv.push(s / segments, vacc + e * segLen);
      }
    }
    for (let s = 0; s < segments; s++) {
      const a = base + s * 2;
      const b = a + 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    vacc += segLen;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** a closed profile from a polyline: arcs as points, for rounded flanges and beads */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 6): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

const up = new THREE.Vector3(0, 1, 0);

/** a cylinder of radius r between two points (with caps) */
export function tube(a: V3, b: V3, r: number, seg = 12, caps = true, r1 = r): THREE.BufferGeometry {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r1, r, len, seg, 1, !caps);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, vb.clone().sub(va).normalize()));
  g.translate(a[0], a[1], a[2]);
  return g;
}

/** a ring (torus) of major radius R and tube radius r, lying in the xz plane at height y */
export function ring(R: number, r: number, y = 0, seg = 48, tubular = 8): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, r, tubular, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

const KEEP = new Set(['position', 'normal', 'uv', 'aHead', 'aCym']);

/** keep only position, normal, uv and the kit's own tags (so differently built parts merge) */
export function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(p.attributes)) if (!KEEP.has(k)) p.deleteAttribute(k);
  if (!p.getAttribute('uv')) p.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((p.getAttribute('position').count * 2) | 0), 2));
  return p;
}

/** geometries collected per material, merged into one mesh each */
export class Parts {
  private by = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4) {
    const c = clean(g);
    if (m) c.applyMatrix4(m);
    const l = this.by.get(mat) ?? [];
    l.push(c);
    this.by.set(mat, l);
    return this;
  }
  /** add the meshes to a parent; returns them */
  build(parent: THREE.Object3D, name = '', shadows = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, gs] of this.by) {
      const g = mergeGeometries(gs);
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.castShadow = shadows;
      m.receiveShadow = true;
      parent.add(m);
      out.push(m);
    }
    this.by.clear();
    return out;
  }
}

/** for motion blur: an instanced mesh that keeps each instance's transform from the start of the shutter */
export function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[]): THREE.InstancedMesh {
  const g = clean(geo);
  const m = new THREE.InstancedMesh(g, mat, matrices.length);
  matrices.forEach((x, i) => m.setMatrixAt(i, x));
  // static within their part (the part's own transform carries any motion): the previous transforms are the same
  g.setAttribute('prevInstanceMatrix', new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.array as Float32Array), 16));
  m.castShadow = true;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}

/** a matrix placing a part at p, its +y along dir (unit), turned `roll` about it */
export function along(p: V3, dir: V3, roll = 0, scale: V3 = [1, 1, 1]): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...dir).normalize());
  if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(up, roll));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...scale));
}

/** tag every vertex with a constant vec2 (which head or cymbal it is, its radius) */
export function tag(g: THREE.BufferGeometry, name: 'aHead' | 'aCym', a: number, b: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const v = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    v[i * 2] = a;
    v[i * 2 + 1] = b;
  }
  g.setAttribute(name, new THREE.BufferAttribute(v, 2));
  return g;
}
