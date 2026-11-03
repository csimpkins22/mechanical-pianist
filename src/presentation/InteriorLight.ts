// Light inside the open piano. With the upper front panel off, the cabinet is
// a deep box with one opening, and almost all of its light has to come in
// through that opening:
//
// - Direct light (the sun through the window, the raking lamp, the soft fill
//   bounced off the room, the window itself) reaches a point inside only along
//   a line that passes through the opening. That is tested analytically for
//   every light at every pixel, with a penumbra that grows with the distance
//   to the opening's edge and with the size of the source (crisp for the sun
//   and the lamp, wide for the fill and the window). The shadow maps still
//   draw what the parts inside cast on one another; this adds what the case
//   itself casts, which the maps cannot (the fills cast no shadows at all).
// - Light from the room (sky fill, bounced light, reflections) is scaled by
//   how much of what a surface faces is the opening rather than the dark
//   inside of the case, with some light left over that the inside itself
//   bounces about. Reflections look out along the mirror direction.
// - The hammers, dampers and wippens stand in rows a millimetre or two apart.
//   Where a part's neighbour stands level with it, the narrow slot between
//   them is dark: the faces toward it see out only near its mouth, and the
//   faces beside it darken toward its edge. When a neighbour rises out of the
//   row, the slot opens and its faces light up. That depends on the frame, so
//   each part carries its neighbours' state as instance attributes, updated
//   every frame from the posed instances themselves (pure functions of t, as
//   is everything else).
import * as THREE from 'three';

/** GLSL, after ambient occlusion in every interior material (PianoInterior): light from the room, through the opening */
export const CAVITY = /* glsl */ `
#ifdef MP_INTERIOR
{
  vec3 mpN = normalize(vWNormal);
  if (!gl_FrontFacing) mpN = -mpN;
  // how much of what the surface faces is the opening (the rest is the dark inside of the case, which bounces a little)
  float mpSky = mpOpenSky(vWPos, mpN);
  reflectedLight.indirectDiffuse *= mix(uMpInner, 1.0, mpSky);
  vec3 mpV = normalize(cameraPosition - vWPos);
  vec3 mpR = reflect(-mpV, mpN);
  reflectedLight.indirectSpecular *= mix(uMpInner * 0.6, 1.0, mpThrough(vWPos, mpR, 0.12 + 0.6 * roughnessFactor));
  #if defined(MP_ROWS) && defined(USE_INSTANCING)
  {
    // the slot beside a neighbour standing level: its faces see out only near its mouth
    vec3 mpON = normalize(vMpONormal);
    float mpL = clamp(-mpON.x, 0.0, 1.0) * vMpRow.x;
    float mpRt = clamp(mpON.x, 0.0, 1.0) * vMpRow.y;
    float mpOcc = max(mpL, mpRt);
    float mpGap = mpL > mpRt ? vMpRow.z : vMpRow.w;
    vec2 mpLo = vOPos.yz - vMpRowBox.xz;
    vec2 mpHi = vMpRowBox.yw - vOPos.yz;
    float mpD = max(0.0, min(min(mpLo.x, mpHi.x), min(mpLo.y, mpHi.y)));
    float mpOpen = mpGap / (mpGap + 2.0 * mpD);
    // and the faces beside it darken toward its edge
    float mpEx = clamp((vOPos.x - vMpRowX.x) / max(1e-4, vMpRowX.y - vMpRowX.x), 0.0, 1.0);
    float mpEdge = (1.0 - smoothstep(0.0, 0.3, mpEx)) * vMpRow.x + (1.0 - smoothstep(0.0, 0.3, 1.0 - mpEx)) * vMpRow.y;
    float mpE = 1.0 - MP_ROW_EDGE_K * clamp(mpEdge, 0.0, 1.0) * (1.0 - abs(mpON.x));
    float mpK = mix(1.0, mpOpen, mpOcc) * mpE;
    reflectedLight.indirectDiffuse *= mpK;
    reflectedLight.indirectSpecular *= mpK;
    float mpKd = mix(1.0, min(1.0, 2.5 * mpOpen), mpOcc) * mix(1.0, mpE, 0.8);
    reflectedLight.directDiffuse *= mpKd;
    reflectedLight.directSpecular *= mpKd;
  }
  #endif
}
#endif
`;

const FRAG_HEAD = /* glsl */ `
#define MP_INTERIOR
// how much the faces beside a level neighbour darken toward their edge, standing in for a rounded edge
// (a material whose parts are already rounded, like the hammers' felt, sets less)
#ifndef MP_ROW_EDGE_K
#define MP_ROW_EDGE_K 0.6
#endif
uniform vec4 uMpOpening;   // the opening, world: x from .x to .y, y from .z to .w
uniform float uMpOpeningZ; // in the plane z = this
uniform vec3 uMpCrisp[2];  // toward the two small sources (sun, lamp), world
uniform vec3 uMpWindow;    // the window's centre, world
uniform float uMpInner;    // light the inside of the case bounces about, as a share of the room's
/** how much of a source in direction d (world, unit, toward it) reaches p through the opening; spread = its angular size */
float mpThrough(vec3 p, vec3 d, float spread) {
  if (p.z >= uMpOpeningZ) return 1.0;
  if (d.z <= 1e-3) return 0.0;
  float s = (uMpOpeningZ - p.z) / d.z;
  vec2 h = p.xy + d.xy * s;
  float w = max(0.0015, s * spread);
  float ax = smoothstep(-w, w, h.x - uMpOpening.x) * smoothstep(-w, w, uMpOpening.y - h.x);
  float ay = smoothstep(-w, w, h.y - uMpOpening.z) * smoothstep(-w, w, uMpOpening.w - h.y);
  return ax * ay;
}
/** the share of the hemisphere around n that looks out through the opening (cosine-weighted, eight directions) */
float mpOpenSky(vec3 p, vec3 n) {
  if (p.z >= uMpOpeningZ) return 1.0;
  const vec3 D0 = vec3(0.0, 0.0, 1.0);
  const vec3 D1 = vec3(0.62, 0.0, 0.78);
  const vec3 D2 = vec3(-0.62, 0.0, 0.78);
  const vec3 D3 = vec3(0.0, 0.62, 0.78);
  const vec3 D4 = vec3(0.0, -0.62, 0.78);
  const vec3 D5 = vec3(0.0, 0.97, 0.24);
  const vec3 D6 = vec3(0.0, -0.97, 0.24);
  const vec3 D7 = vec3(0.0, 0.0, -1.0);
  float s = 0.0, w = 0.0, k;
  k = max(0.0, dot(n, D0)); s += k * mpThrough(p, D0, 0.5); w += k;
  k = max(0.0, dot(n, D1)); s += k * mpThrough(p, D1, 0.5); w += k;
  k = max(0.0, dot(n, D2)); s += k * mpThrough(p, D2, 0.5); w += k;
  k = max(0.0, dot(n, D3)); s += k * mpThrough(p, D3, 0.5); w += k;
  k = max(0.0, dot(n, D4)); s += k * mpThrough(p, D4, 0.5); w += k;
  k = max(0.0, dot(n, D5)); s += k * mpThrough(p, D5, 0.5); w += k;
  k = max(0.0, dot(n, D6)); s += k * mpThrough(p, D6, 0.5); w += k;
  k = max(0.0, dot(n, D7)); w += k; // straight back: the case
  // sideways (along the rows): the case's sides
  k = abs(n.x) * 0.8; w += k;
  return w > 0.0 ? s / w : 0.0;
}
`;

const ROW_DECL = /* glsl */ `
#if defined(MP_ROWS) && defined(USE_INSTANCING)
varying vec4 vMpRow;    // left, right neighbour level (0..1); the gaps to them (m)
varying vec4 vMpRowBox; // the part's own extent: y from .x to .y, z from .z to .w
varying vec2 vMpRowX;   // and x
varying vec3 vMpONormal;
#endif
`;

const ROW_VERTEX_HEAD = /* glsl */ `
#define MP_INTERIOR
${ROW_DECL}
#if defined(MP_ROWS) && defined(USE_INSTANCING)
attribute vec4 aMpRow;
attribute vec4 aMpRowBox;
attribute vec2 aMpRowX;
#endif
`;

const ROW_VERTEX = /* glsl */ `
#if defined(MP_ROWS) && defined(USE_INSTANCING)
vMpRow = aMpRow;
vMpRowBox = aMpRowBox;
vMpRowX = aMpRowX;
vMpONormal = objectNormal;
#endif
`;

/** the per-light test, inside three's light loops: directional lights and the window (a rectangular area light) */
function litThroughOpening(chunk: string): string {
  const dirAt = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const call = 'RE_Direct( directLight, geometryPosition';
  const i = dirAt < 0 ? -1 : chunk.indexOf(call, dirAt);
  const rect = 'RE_Direct_RectArea( rectAreaLight, geometryPosition';
  const j = chunk.indexOf(rect);
  if (i < 0 || j < 0) {
    console.warn('InteriorLight: three.js light loop not recognised; light inside the piano is not limited to the opening');
    return chunk;
  }
  const dir = /* glsl */ `{
      vec3 mpD = normalize((vec4(directLight.direction, 0.0) * viewMatrix).xyz);
      float mpS = (dot(mpD, uMpCrisp[0]) > 0.9995 || dot(mpD, uMpCrisp[1]) > 0.9995) ? 0.01 : 0.35;
      directLight.color *= mpThrough(vWPos, mpD, mpS);
    }
    `;
  const area = /* glsl */ `rectAreaLight.color *= mpThrough(vWPos, normalize(uMpWindow - vWPos), 0.3);
    `;
  // the later insertion first, so the earlier index stays valid
  let out = chunk;
  if (j > i) {
    out = out.slice(0, j) + area + out.slice(j);
    out = out.slice(0, i) + dir + out.slice(i);
  } else {
    out = out.slice(0, i) + dir + out.slice(i);
    out = out.slice(0, j) + area + out.slice(j);
  }
  return out;
}

interface RowData {
  mesh: THREE.InstancedMesh;
  row: THREE.InstancedBufferAttribute;
  centre: THREE.Vector3;
  corner: THREE.Vector3;
  width: number;
  height: number;
}

/**
 * Installs the light inside the piano on every material of the interior, and
 * keeps the rows' neighbour attributes up to date (call update() after the
 * interior has been posed for a frame).
 */
export class InteriorLighting {
  readonly uniforms = {
    uMpOpening: { value: new THREE.Vector4(-0.614, 0.614, 0.118, 0.52) },
    uMpOpeningZ: { value: -0.19 },
    uMpCrisp: { value: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)] },
    uMpWindow: { value: new THREE.Vector3() },
    uMpInner: { value: 0.22 },
  };
  private rows: (RowData & { pos: Float32Array })[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private d = new THREE.Vector3();
  private m = new THREE.Matrix4();

  /**
   * @param root the interior (PianoInterior.root)
   * @param rows its instanced rows of parts, instance i beside i ± 1
   * @param opening the upper panel that comes off (its box is the opening)
   */
  constructor(root: THREE.Object3D, rows: THREE.InstancedMesh[], opening: THREE.Object3D | null, window: THREE.Vector3) {
    if (opening) {
      opening.updateWorldMatrix(true, true);
      const bb = new THREE.Box3().setFromObject(opening);
      this.uniforms.uMpOpening.value.set(bb.min.x, bb.max.x, bb.min.y, bb.max.y);
      this.uniforms.uMpOpeningZ.value = (bb.min.z + bb.max.z) / 2;
    }
    this.uniforms.uMpWindow.value.copy(window);
    const rowMats = new Set<THREE.Material>();
    for (const mesh of rows) {
      const g = mesh.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      const n = mesh.count;
      const box = new Float32Array(n * 4);
      const xs = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        box.set([bb.min.y, bb.max.y, bb.min.z, bb.max.z], i * 4);
        xs.set([bb.min.x, bb.max.x], i * 2);
      }
      const row = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      row.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aMpRow', row);
      g.setAttribute('aMpRowBox', new THREE.InstancedBufferAttribute(box, 4));
      g.setAttribute('aMpRowX', new THREE.InstancedBufferAttribute(xs, 2));
      const size = bb.getSize(new THREE.Vector3());
      this.rows.push({
        mesh,
        row,
        pos: new Float32Array(n * 6),
        centre: bb.getCenter(new THREE.Vector3()),
        corner: new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y, bb.max.z),
        width: size.x,
        height: Math.max(1e-3, Math.min(size.y, size.z)),
      });
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) rowMats.add(m);
    }
    // any other instanced part drawn with a row's material still needs the attributes (left at zero: no neighbours)
    root.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || rows.includes(im)) return;
      if (!([] as THREE.Material[]).concat(im.material).some((m) => rowMats.has(m))) return;
      const n = im.count;
      im.geometry.setAttribute('aMpRow', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      im.geometry.setAttribute('aMpRowBox', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      im.geometry.setAttribute('aMpRowX', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
    });
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
        if (seen.has(m)) continue;
        seen.add(m);
        this.install(m, rowMats.has(m));
      }
    });
  }

  private install(mat: THREE.Material, rows: boolean) {
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey.bind(mat);
    const U = this.uniforms;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, U);
      const defs = rows ? '#define MP_ROWS\n' : '';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `${defs}${ROW_VERTEX_HEAD}\n#include <common>`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${ROW_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `${defs}${FRAG_HEAD}\n${ROW_DECL}\n#include <common>`)
        .replace('#include <lights_fragment_begin>', litThroughOpening(THREE.ShaderChunk.lights_fragment_begin));
    };
    mat.customProgramCacheKey = () => `${prevKey()}|interior${rows ? '-rows' : ''}`;
    mat.needsUpdate = true;
  }

  /** the small sources (whose penumbra through the opening is crisp): their directions now */
  setSources(lights: THREE.DirectionalLight[]) {
    lights.slice(0, 2).forEach((l, i) => {
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
      this.a.setFromMatrixPosition(l.matrixWorld);
      this.b.setFromMatrixPosition(l.target.matrixWorld);
      this.uniforms.uMpCrisp.value[i].subVectors(this.a, this.b).normalize();
    });
  }

  /** after the interior is posed: how level each part's neighbours stand with it, and the gaps between them */
  update() {
    const { a, b, c, d, m } = this;
    for (const r of this.rows) {
      const n = r.mesh.count;
      const pos = r.pos;
      for (let i = 0; i < n; i++) {
        r.mesh.getMatrixAt(i, m);
        a.copy(r.centre).applyMatrix4(m);
        b.copy(r.corner).applyMatrix4(m);
        pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      }
      const out = r.row.array as Float32Array;
      for (let i = 0; i < n; i++) {
        for (let s = 0; s < 2; s++) {
          const j = s === 0 ? i - 1 : i + 1;
          let level = 0;
          let gap = 0.002;
          if (j >= 0 && j < n) {
            const lateral = Math.abs(pos[j * 6] - pos[i * 6]);
            // across a bracket's gap there is no neighbour
            if (lateral < r.width * 1.9 + 0.004) {
              gap = Math.max(0.0004, lateral - r.width);
              c.set(pos[j * 6 + 1] - pos[i * 6 + 1], pos[j * 6 + 2] - pos[i * 6 + 2], 0);
              d.set(pos[j * 6 + 4] - pos[i * 6 + 4], pos[j * 6 + 5] - pos[i * 6 + 5], 0);
              const off = Math.max(c.length(), d.length()) / r.height;
              level = 1 - THREE.MathUtils.smoothstep(off, 0.12, 0.9);
            }
          }
          out[i * 4 + s] = level;
          out[i * 4 + 2 + s] = gap;
        }
      }
      r.row.needsUpdate = true;
    }
  }
}
