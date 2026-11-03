// Inside the upright: what shows when the upper front panel is off. Built
// here from the shared layout (ActionLayout.ts) rather than in Blender, so
// every hammer stands behind its key and every string runs where its hammer
// strikes. The action: a hammer per key (felt head on a wooden moulding, maple
// shank, buckskin butt), a damper per damped key (felt on a wooden head, a
// wire down to its lever), wippens on the key backs, the rails and cast
// brackets. The strings (steel, copper-wound in the bass and overstrung
// across the tenor), the gilded cast-iron plate with its tuning and hitch
// pins, the bridges and the spruce soundboard behind.
//
// The hammers, dampers and wippens are instanced and posed every frame from
// the FrameState (ActionMechanics.ts); the strings show their swing as the
// camera sees it, an exposure blur (StringMechanics.ts, and the string shaders
// below). The moving parts keep their transforms at the start of the shutter
// (prevInstanceMatrix) for motion blur.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { hash01 } from '../core/random';
import { UNDAMPED_FROM } from '../performance/ActionMechanics';
import type { FrameState } from '../performance/PerformanceTimeline';
import {
  BASS_N,
  CROWN,
  DAMPER_PIVOT_Y,
  DAMPER_SWING,
  HAMMER_REST,
  HAMMER_SPAN,
  HAMMER_X,
  HEAD_W,
  PLATE_Z,
  SHANK,
  SOUNDBOARD_Z,
  STRIKE_Y,
  STRINGS,
  STRUT_X,
  stringRadius,
  stringSlope,
  speakingLength,
  stringZ,
} from './ActionLayout';
import { patch } from './shaderPatch';

const N_DAMPED = UNDAMPED_FROM - LOWEST_MIDI;
const INNER_X = 0.665; // the case's side panels, inside
const TOP_Y = 0.524; // under the lid

/** inside a closed cabinet the room's light reaches less and less far in */
const CAVITY = /* glsl */ `
{
  float mpCav = mix(1.0, 0.55, smoothstep(-0.23, -0.37, vWPos.z)) * mix(1.0, 0.75, smoothstep(0.43, 0.52, vWPos.y));
  reflectedLight.indirectDiffuse *= mpCav;
  reflectedLight.indirectSpecular *= mix(1.0, mpCav, 0.6);
}`;

type C3 = [number, number, number];

/** a part for a merged mesh: non-indexed, positions and normals, a flat vertex colour */
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

/** a cylinder between two points */
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
  if (!g) throw new Error('could not merge the piano interior');
  return g;
}

/** a flat strip of width w along a polyline in the xy plane, from z0 (back) to z1 (front) */
function strip(points: [number, number][], w: number, z0: number, z1: number, color: C3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-5) continue;
    const g = new THREE.BoxGeometry(len + w * 0.02, w, z1 - z0);
    g.rotateZ(Math.atan2(y1 - y0, x1 - x0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    parts.push(part(g, color));
  }
  return merged(parts);
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
  const g = geo.clone();
  // for motion blur: each instance's transform as the shutter opened (see PostPipeline's prepass)
  g.setAttribute('prevInstanceMatrix', new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16));
  const m = new THREE.InstancedMesh(g, mat, count);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = true;
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

/** remember the current instance transforms as the previous ones */
function keepPrevious(m: THREE.InstancedMesh) {
  const prev = m.geometry.getAttribute('prevInstanceMatrix') as THREE.InstancedBufferAttribute;
  (prev.array as Float32Array).set(m.instanceMatrix.array as Float32Array);
  prev.needsUpdate = true;
}

// ---------------------------------------------------------------- strings
// A string vibrates hundreds of times a second, so through a camera it is never
// a moving wire: over the exposure it smears into the envelope of its swing, a
// translucent band widest at mid-span and pinched at both ends, darker toward
// the middle and brighter at its edges, where the wire lingers as it turns. Each
// string is drawn as a ribbon facing the camera, as wide as the wire plus the
// part of its swing seen across the line of sight, and every pixel takes the
// share of the exposure the wire covers it (so the band holds exactly the wire's
// light however wide it spreads). The same filter keeps distant strings, much
// thinner than a pixel, a faint steady line rather than a broken, flickering one,
// and the normal across the ribbon is the round wire's, so the light runs along
// each string in a bright streak.
const STRING_VS_HEAD = /* glsl */ `
attribute vec2 aSwing;  // peak swing at mid-span (m): toward the soundboard, and across
attribute vec2 aSpan;   // the speaking length, from the bridge to the top bearing (0..1 from the hitch pin)
varying float vLat;
varying float vHalfPx;
varying float vRad;
varying float vSwing;
varying vec3 vSideV;
varying vec3 vFrontV;
`;
const STRING_VS = /* glsl */ `
{
  vec3 mpL = transformed;
  vec3 mpAx = instanceMatrix[1].xyz;
  float mpR = length(instanceMatrix[0].xyz);
  vec3 mpA = instanceMatrix[3].xyz + mpAx * mpL.y;
  vec3 mpT = normalize(mpAx);
  vec3 mpCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vec3 mpS = cross(mpT, mpCam - mpA);
  float mpSl = length(mpS);
  mpS = mpSl > 1e-6 ? mpS / mpSl : normalize(cross(mpT, vec3(0.0, 0.0, 1.0)));
  vec3 mpF = cross(mpS, mpT);
  // the swing here: the string's first mode between its bearings, in the
  // hammer's plane (toward the soundboard) and, growing, across it
  float mpEnv = sin(3.14159265 * clamp((mpL.y - aSpan.x) / (aSpan.y - aSpan.x), 0.0, 1.0));
  vec3 mpPz = normalize(vec3(0.0, 0.0, 1.0) - mpT * mpT.z);
  vec3 mpPx = cross(mpT, mpPz);
  float mpSw = mpEnv * length(vec2(aSwing.x * dot(mpS, mpPz), aSwing.y * dot(mpS, mpPx)));
  // a pixel at this distance (uViewH: the target's height in pixels)
  vec4 mpV = modelViewMatrix * vec4(mpA, 1.0);
  float mpPx1 = max(-mpV.z, 1e-4) * 2.0 / (projectionMatrix[1][1] * uViewH);
  // the ribbon: the wire and its swing, at least a pixel wide, with room for the edge filter
  float mpW = max(mpR + mpSw, 0.5 * mpPx1) + 0.75 * mpPx1;
  vec3 mpQ = mpA + mpS * (mpW * mpL.x) + mpF * (mpR * mpL.z);
  transformed = (inverse(instanceMatrix) * vec4(mpQ, 1.0)).xyz;
  vLat = mpW * mpL.x;
  vHalfPx = 0.5 * mpPx1;
  vRad = mpR;
  vSwing = mpSw;
  vSideV = mat3(modelViewMatrix) * mpS;
  vFrontV = mat3(modelViewMatrix) * mpF;
}`;
const STRING_FS_HEAD = /* glsl */ `
varying float vLat;
varying float vHalfPx;
varying float vRad;
varying float vSwing;
varying vec3 vSideV;
varying vec3 vFrontV;
// the integral of asin(clamp(y / a)): over the swing, the share of time a point
// at y is passed by the wire's centre, accumulated
float mpG(float y, float a) {
  return abs(y) >= a ? 1.5707963 * abs(y) : y * asin(y / a) + sqrt(a * a - y * y);
}
`;
// how much of this pixel the swinging wire covers over the exposure: the wire
// (radius r) swung sinusoidally over +-a, averaged over the pixel's width
const STRING_COVERAGE = /* glsl */ `
{
  float mpH = max(vHalfPx, 1e-7);
  float mpAa = max(vSwing, 1e-4 * vRad);
  float mpR = vRad;
  float mpC = ((mpG(vLat + mpH + mpR, mpAa) - mpG(vLat - mpH + mpR, mpAa)) - (mpG(vLat + mpH - mpR, mpAa) - mpG(vLat - mpH - mpR, mpAa))) / (3.14159265 * 2.0 * mpH);
  mpC = clamp(mpC, 0.0, 1.0);
  if (mpC < 0.003) discard;
  diffuseColor.a *= mpC;
}`;
// the round wire's normal across the ribbon; where it is smeared into a band the
// highlights average out toward the band's face. A wire only a pixel or two
// wide shows its whole fan of normals within the pixel: there it faces the
// camera with a correspondingly broader highlight (STRING_ROUGH), so the light
// along it does not depend on where the pixel's centre happens to fall.
const STRING_NORMAL = /* glsl */ `
{
  float mpE = vRad + vSwing;
  float mpRes = smoothstep(0.75, 2.5, mpE / vHalfPx);
  float mpX = clamp(vLat / mpE, -1.0, 1.0) * mix(1.0, 0.3, vSwing / mpE) * mpRes;
  vec3 mpN = normalize(normalize(vSideV) * mpX + normalize(vFrontV) * sqrt(max(0.0, 1.0 - mpX * mpX)));
  normal = mpN;
  #ifdef USE_CLEARCOAT
  clearcoatNormal = mpN;
  #endif
}`;
const STRING_ROUGH = /* glsl */ `roughnessFactor = mix(max(roughnessFactor, 0.3), roughnessFactor, smoothstep(0.75, 2.5, (vRad + vSwing) / vHalfPx));`;

// ---------------------------------------------------------------- materials
function materials() {
  const felt = patch(
    new THREE.MeshPhysicalMaterial({ color: 0xebe3d0, roughness: 0.93, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xffffff) }),
    {
      afterMap: /* glsl */ `
      {
        // each hammer's felt a little different; the red underfelt shows as a
        // band on the sides next to the moulding; the crown carries the
        // grooves its strings have pressed into it
        diffuseColor.rgb *= 0.9 + 0.14 * mpNoise(vWPos * 60.0) + 0.06 * mpNoise(vWPos * 2200.0);
        // on the flat sides the layers show in section: the white felt, the
        // red underfelt inside it, the mahogany moulding at the core
        float side = smoothstep(0.55, 0.8, abs(vWNormal.x));
        vec2 hc = vec2((vOPos.z - 0.0095) / 0.027, (vOPos.y - ${SHANK.toFixed(4)}) / 0.024);
        float e = length(hc);
        vec3 layer = e < 0.48 ? vec3(0.42, 0.24, 0.14) : e < 0.6 ? vec3(0.55, 0.1, 0.08) : diffuseColor.rgb;
        diffuseColor.rgb = mix(diffuseColor.rgb, layer, side);
        // the crown: worn flat and a little grey along the strike line, with the strings' grooves pressed in
        float crown = smoothstep(-0.0125, -0.016, vOPos.z) * (1.0 - side);
        float strike = exp(-pow((vOPos.y - ${SHANK.toFixed(4)}) / 0.0022, 2.0));
        float g = 0.0;
        for (int k = -1; k <= 1; k++) { float d = (vOPos.x - float(k) * 0.0024) / 0.0005; g += exp(-d * d); }
        diffuseColor.rgb *= 1.0 - crown * strike * (0.12 + 0.42 * min(g, 1.0));
      }`,
      afterAO: CAVITY,
      bounce: 0.7,
    },
  );
  const underfelt = patch(
    new THREE.MeshPhysicalMaterial({ color: 0x8e2019, roughness: 0.92, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xd06050) }),
    { afterMap: /* glsl */ `diffuseColor.rgb *= 0.88 + 0.16 * mpNoise(vWPos * 2000.0);`, afterAO: CAVITY, bounce: 0.7 },
  );
  const damperFelt = patch(
    new THREE.MeshPhysicalMaterial({ color: 0xf1eee7, roughness: 0.95, sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff) }),
    { afterMap: /* glsl */ `diffuseColor.rgb *= 0.9 + 0.12 * mpNoise(vWPos * 1800.0);`, afterAO: CAVITY, bounce: 0.7 },
  );
  // wood, buckskin, felt strips and painted iron, by vertex colour
  const wood = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }), {
    afterMap: /* glsl */ `diffuseColor.rgb *= 0.88 + 0.22 * mpNoise(vWPos * vec3(260.0, 18.0, 260.0)) + 0.06 * mpNoise(vWPos * 1500.0);`,
    afterAO: CAVITY,
    bounce: 0.7,
  });
  const plate = patch(new THREE.MeshPhysicalMaterial({ color: 0xdcb46a, metalness: 0.45, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3 }), {
    // cast iron under gold paint: a sandy casting texture, the paint thinner on the edges
    afterMap: /* glsl */ `diffuseColor.rgb *= 0.86 + 0.2 * mpFbm(vWPos * 140.0) - 0.05 * mpNoise(vWPos * 2600.0);`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpFbm(vWPos * 220.0) - 0.5) * 0.25, 0.2, 0.8);`,
    afterAO: CAVITY,
    bounce: 0.6,
  });
  const pins = patch(new THREE.MeshPhysicalMaterial({ color: 0xd2d6dc, metalness: 0.55, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.2 }), { afterAO: CAVITY, bounce: 0.6 });
  const viewH = { value: 1080 };
  const steel = patch(new THREE.MeshPhysicalMaterial({ color: 0xdadce0, metalness: 1, roughness: 0.16, transparent: true, depthWrite: false }), {
    uniforms: { uViewH: viewH },
    vertexHead: STRING_VS_HEAD,
    afterBegin: STRING_VS,
    fragHead: STRING_FS_HEAD,
    afterMap: STRING_COVERAGE,
    afterRough: STRING_ROUGH,
    afterNormal: STRING_NORMAL,
    afterAO: CAVITY,
    bounce: 0.5,
  });
  const copper = patch(new THREE.MeshPhysicalMaterial({ color: 0xb4703c, metalness: 1, roughness: 0.3, transparent: true, depthWrite: false }), {
    uniforms: { uViewH: viewH },
    vertexHead: STRING_VS_HEAD,
    afterBegin: STRING_VS,
    fragHead: STRING_FS_HEAD,
    // the winding: fine helical grooves, faded out where they would only shimmer
    afterMap: /* glsl */ `
    {
      float mpA = vWPos.y * 5200.0 + vWPos.x * 2100.0;
      float mpFade = (1.0 - smoothstep(0.4, 1.6, fwidth(mpA))) * (1.0 - smoothstep(0.3, 1.0, vSwing / vRad));
      diffuseColor.rgb *= 1.0 - 0.35 * mpFade * smoothstep(0.3, 1.0, 0.5 + 0.5 * sin(mpA));
    }
    ${STRING_COVERAGE}`,
    afterRough: STRING_ROUGH,
    afterNormal: STRING_NORMAL,
    afterAO: CAVITY,
    bounce: 0.5,
  });
  const soundboard = patch(new THREE.MeshPhysicalMaterial({ color: 0xcc9e62, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 }), {
    // quarter-sawn spruce, its grain on the diagonal, under old varnish
    afterMap: /* glsl */ `
    {
      vec2 sp = vec2(vWPos.x * 0.83 + vWPos.y * 0.56, vWPos.y * 0.83 - vWPos.x * 0.56);
      float mpA = sp.x * 1300.0 + mpFbm(vec3(sp * vec2(5.0, 1.2), 0.0)) * 14.0;
      float mpFade = 1.0 - smoothstep(0.5, 1.8, fwidth(mpA));
      float late = smoothstep(0.55, 1.0, 0.5 + 0.5 * sin(mpA));
      diffuseColor.rgb *= mix(0.93, mix(1.0, 0.82, late), mpFade) * (0.9 + 0.16 * mpFbm(vec3(sp * vec2(2.0, 30.0), 3.0)));
    }`,
    afterAO: CAVITY,
    bounce: 0.6,
  });
  const bridge = patch(new THREE.MeshStandardMaterial({ color: 0x8c5a30, roughness: 0.5 }), {
    afterMap: /* glsl */ `diffuseColor.rgb *= 0.85 + 0.25 * mpNoise(vWPos * vec3(30.0, 300.0, 300.0));`,
    afterAO: CAVITY,
    bounce: 0.6,
  });
  return { felt, underfelt, damperFelt, wood, plate, pins, steel, copper, soundboard, bridge, viewH };
}

// ---------------------------------------------------------------- geometry
const MAPLE: C3 = [0.86, 0.72, 0.52];
const WALNUT: C3 = [0.25, 0.16, 0.1];
const BUCKSKIN: C3 = [0.72, 0.6, 0.44];
const RED_FELT: C3 = [0.42, 0.07, 0.07];
const GREEN_FELT: C3 = [0.17, 0.32, 0.2];
const IRON: C3 = [0.07, 0.07, 0.075];
const WIRE: C3 = [0.62, 0.62, 0.64];

/**
 * A hammer's felt, around its pivot: an egg-shaped profile from the back of
 * the head (zBack) over a broad rounded crown (`crown` toward the strings,
 * -z) whose height is 2h; tapering from wBack wide at the moulding to wCrown
 * at the crown, with softly rounded edges; the strike line worn flat and
 * pressed in by `flat`. Centred SHANK above the pivot.
 */
function feltShape(zBack: number, crown: number, h: number, wBack: number, wCrown: number, flat: number): THREE.BufferGeometry {
  const K = 32;
  const D = zBack + crown;
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= K; k++) {
    const th = -Math.PI / 2 + (Math.PI * k) / K;
    const y = h * Math.sin(th);
    const z = zBack - D * Math.pow(Math.max(0, Math.cos(th)), 0.7) + flat * Math.exp(-((y / 0.0016) ** 2));
    pts.push(new THREE.Vector2(z, y));
  }
  const bevel = 0.0009;
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth: wBack - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 1,
  });
  // shape (x, y) = world (z, y); extruded along world x
  g.rotateY(-Math.PI / 2);
  g.translate(wBack / 2 - bevel, SHANK, 0);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const tau = Math.min(1, Math.max(0, (zBack - pos.getZ(i)) / D));
    pos.setX(i, pos.getX(i) * (1 - (1 - wCrown / wBack) * tau));
  }
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-7);
  m.computeVertexNormals();
  return m;
}

/** the outer felt: white, wrapping the head, with the crown that meets the string */
const hammerHead = () => feltShape(0.0085, CROWN, 0.024, HEAD_W, 0.0082, 0.00045);
/** the underfelt: red, under the outer felt, stepping out behind it toward the moulding */
const hammerUnderfelt = () => feltShape(0.0107, 0.0125, 0.0192, HEAD_W - 0.0004, 0.0084, 0);

function hammerWood(): THREE.BufferGeometry {
  return merged([
    rod([0, 0.012, 0.011], [0, 0.104, 0.011], 0.0027, MAPLE), // shank
    box(HEAD_W * 0.86, 0.026, 0.005, 0, SHANK, 0.012, [0.42, 0.24, 0.14]), // moulding, mahogany
    box(0.01, 0.028, 0.03, 0, 0.008, 0.002, BUCKSKIN), // butt
    box(0.0102, 0.006, 0.03, 0, -0.008, 0.002, RED_FELT),
    rod([0, 0.03, 0.016], [0, 0.03, 0.04], 0.0019, MAPLE, 6), // backcheck catcher
    box(0.008, 0.012, 0.006, 0, 0.03, 0.043, [0.55, 0.4, 0.28]),
  ]);
}

/** damper around its lever pivot: felt pressing the strings (-z), head block, wire down to the lever beside the hammer */
function damperFeltGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.0105, 0.03, 0.0115, 1, 1, 1).translate(0, 0.165, -0.0157);
  const p = g.toNonIndexed();
  p.deleteAttribute('uv');
  return p;
}

function damperWood(): THREE.BufferGeometry {
  return merged([
    box(0.0098, 0.026, 0.011, 0, 0.165, -0.0045, WALNUT),
    box(0.003, 0.006, 0.006, 0.0058, 0.154, -0.004, WIRE),
    rod([0.0058, 0.0, -0.004], [0.0058, 0.155, -0.004], 0.0006, WIRE, 5),
    box(0.004, 0.014, 0.01, 0.0058, 0.0, -0.004, WALNUT),
  ]);
}

function wippenGeo(): THREE.BufferGeometry {
  return merged([box(0.0092, 0.05, 0.036, 0, 0, 0, MAPLE), box(0.0094, 0.004, 0.02, 0, 0.027, -0.004, RED_FELT)]);
}

/** a key's hammer pivot */
function pivotOf(i: number): C3 {
  return [HAMMER_X[i], STRIKE_Y - SHANK, stringZ(i) + CROWN + stringRadius(i)];
}

export class PianoInterior {
  readonly root = new THREE.Group();
  private hammerFelt: THREE.InstancedMesh;
  private hammerUnder: THREE.InstancedMesh;
  private hammerWood: THREE.InstancedMesh;
  private damperFelt: THREE.InstancedMesh;
  private damperWood: THREE.InstancedMesh;
  private wippens: THREE.InstancedMesh;
  private steel: THREE.InstancedMesh;
  private copper: THREE.InstancedMesh;
  /** per string: its mesh and index there */
  private stringSlot: { wound: boolean; index: number }[] = [];
  private swingSteel: THREE.InstancedBufferAttribute;
  private swingCopper: THREE.InstancedBufferAttribute;
  /** per string: its swing as a share of its key's (unisons differ a little) */
  private swingShare: Float32Array;
  private leans: THREE.Quaternion[] = [];
  private dampPivot: C3[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private xAxis = new THREE.Vector3(1, 0, 0);
  private size = new THREE.Vector2();

  constructor() {
    this.root.name = 'Interior';
    const M = materials();

    // the action, posed every frame
    this.hammerFelt = instanced(hammerHead(), M.felt, KEY_COUNT);
    this.hammerUnder = instanced(hammerUnderfelt(), M.underfelt, KEY_COUNT);
    this.hammerWood = instanced(hammerWood(), M.wood, KEY_COUNT);
    this.damperFelt = instanced(damperFeltGeo(), M.damperFelt, N_DAMPED);
    this.damperWood = instanced(damperWood(), M.wood, N_DAMPED);
    this.wippens = instanced(wippenGeo(), M.wood, KEY_COUNT);
    this.root.add(this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood, this.wippens);
    for (let i = 0; i < N_DAMPED; i++) {
      // the damper sits on its strings above the strike line, leaning with them in the bass
      const s = stringSlope(i);
      const r = stringRadius(i);
      const dy = 0.165 + DAMPER_PIVOT_Y - STRIKE_Y; // felt centre above the strike line
      this.dampPivot.push([HAMMER_X[i] + s * dy, DAMPER_PIVOT_Y, stringZ(i) + r + 0.0215]);
      this.leans.push(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan(-s)));
    }

    // strings
    const nPlain = STRINGS.filter((s) => !s.wound).length;
    const nWound = STRINGS.length - nPlain;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 6, 8, true).translate(0, 0.5, 0);
    this.steel = instanced(cyl, M.steel, nPlain);
    this.copper = instanced(cyl, M.copper, nWound);
    this.swingSteel = new THREE.InstancedBufferAttribute(new Float32Array(nPlain * 2), 2);
    this.swingCopper = new THREE.InstancedBufferAttribute(new Float32Array(nWound * 2), 2);
    this.swingSteel.setUsage(THREE.DynamicDrawUsage);
    this.swingCopper.setUsage(THREE.DynamicDrawUsage);
    this.steel.geometry.setAttribute('aSwing', this.swingSteel);
    this.copper.geometry.setAttribute('aSwing', this.swingCopper);
    // each string's speaking length, from the bridge up to the bearing an eighth above the strike line
    const spanSteel = new Float32Array(nPlain * 2);
    const spanCopper = new Float32Array(nWound * 2);
    this.swingShare = new Float32Array(STRINGS.length);
    // the strings are drawn after everything opaque and before the glass of the hands, back (steel) to front (copper)
    this.steel.renderOrder = -2;
    this.copper.renderOrder = -1;
    for (const m of [this.steel, this.copper]) {
      m.onBeforeRender = (renderer) => {
        const rt = renderer.getRenderTarget();
        M.viewH.value = rt ? rt.height : renderer.getDrawingBufferSize(this.size).y;
      };
    }
    const up = new THREE.Vector3(0, 1, 0);
    let ip = 0;
    let iw = 0;
    for (const s of STRINGS) {
      const a = new THREE.Vector3(...s.hitch);
      const b = new THREE.Vector3(...s.pin);
      const len = a.distanceTo(b);
      const q = new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
      const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(s.radius, len, s.radius));
      const L = speakingLength(s.key);
      const at = (p: number[]) => Math.hypot(p[0] - s.hitch[0], p[1] - s.hitch[1]) / len;
      const span = [at(s.bridge), at([s.strike[0] + s.dir[0] * L / 8, s.strike[1] + s.dir[1] * L / 8])];
      this.swingShare[this.stringSlot.length] = 0.88 + 0.24 * hash01(this.stringSlot.length, 9);
      if (s.wound) {
        this.copper.setMatrixAt(iw, m);
        spanCopper.set(span, iw * 2);
        this.stringSlot.push({ wound: true, index: iw++ });
      } else {
        this.steel.setMatrixAt(ip, m);
        spanSteel.set(span, ip * 2);
        this.stringSlot.push({ wound: false, index: ip++ });
      }
    }
    this.steel.geometry.setAttribute('aSpan', new THREE.InstancedBufferAttribute(spanSteel, 2));
    this.copper.geometry.setAttribute('aSpan', new THREE.InstancedBufferAttribute(spanCopper, 2));
    for (const m of [this.steel, this.copper]) {
      m.castShadow = true;
      keepPrevious(m);
    }
    this.root.add(this.steel, this.copper);

    // tuning pins (the bass ones stand further out, to their strings' plane) and hitch pins
    const pinGeo = merged([
      rod([0, 0, -0.012], [0, 0, 0.031], 0.0034, [1, 1, 1], 10),
      rod([0, 0, 0.0108], [0, 0, 0.0162], 0.0043, [0.9, 0.9, 0.92], 10), // the coil of string
    ]);
    const tuning = instanced(pinGeo, M.pins, STRINGS.length);
    const hitchGeo = rod([0, 0, -0.004], [0, 0, 0.016], 0.0021, [1, 1, 1], 6);
    const hitch = instanced(hitchGeo, M.pins, STRINGS.length);
    STRINGS.forEach((s, j) => {
      const dz = s.wound ? 0.012 : 0;
      tuning.setMatrixAt(j, this.m4.makeTranslation(s.pin[0], s.pin[1], PLATE_Z + dz));
      hitch.setMatrixAt(j, this.m4.makeTranslation(s.hitch[0], s.hitch[1], PLATE_Z - (s.wound ? 0 : 0)));
    });
    for (const m of [tuning, hitch]) {
      m.castShadow = false;
      keepPrevious(m);
      this.root.add(m);
    }

    this.root.add(this.buildPlate(M.plate, M.pins));
    this.root.add(this.buildSoundboard(M.soundboard, M.bridge));
    this.root.add(this.buildRails(M.wood));
  }

  private buildPlate(gold: THREE.Material, steel: THREE.Material): THREE.Object3D {
    const g = new THREE.Group();
    g.name = 'Plate';
    const W: C3 = [1, 1, 1];
    const zb = PLATE_Z - 0.014;
    const zc = (PLATE_Z + zb) / 2;
    const parts: THREE.BufferGeometry[] = [
      // the pin field across the top, with a cast lip below it
      box(2 * INNER_X, TOP_Y - 0.403, 0.014, 0, (TOP_Y + 0.403) / 2, zc, W),
      box(2 * INNER_X - 0.04, 0.012, 0.02, 0, 0.398, PLATE_Z - 0.004, W),
      // sides and the bass hitch-pin rail at the bottom
      box(0.028, 1.06, 0.014, -INNER_X + 0.014, -0.127, zc, W),
      box(0.028, 1.06, 0.014, INNER_X - 0.014, -0.127, zc, W),
      box(0.74, 0.07, 0.014, -0.29, -0.63, zc, W),
    ];
    // struts between the sections
    for (const x of STRUT_X) parts.push(box(0.034, 1.0, 0.016, x, -0.1, PLATE_Z - 0.006, W), box(0.02, 1.0, 0.006, x, -0.1, PLATE_Z + 0.004, W));
    // the hitch-pin rail of the steel strings, following their lower ends
    const hp = STRINGS.filter((s) => !s.wound && s.hitch[1] > -0.7).map((s) => [s.hitch[0], s.hitch[1]] as [number, number]);
    const every = hp.filter((_, j) => j % 3 === 1);
    parts.push(strip(every, 0.05, zb, PLATE_Z, W));
    const plate = new THREE.Mesh(merged(parts), gold);
    plate.castShadow = true;
    plate.receiveShadow = true;
    g.add(plate);
    // bolts through the plate into the pin block and the back
    const bolts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 13; k++) {
      const x = -INNER_X + 0.04 + (k * (2 * INNER_X - 0.08)) / 12;
      bolts.push(rod([x, 0.512, PLATE_Z - 0.002], [x, 0.512, PLATE_Z + 0.004], 0.0062, [0.3, 0.3, 0.32], 6));
    }
    for (const x of STRUT_X) bolts.push(rod([x, 0.36, PLATE_Z + 0.004], [x, 0.36, PLATE_Z + 0.01], 0.0068, [0.3, 0.3, 0.32], 6));
    const b = new THREE.Mesh(merged(bolts), steel);
    b.castShadow = true;
    g.add(b);
    return g;
  }

  private buildSoundboard(spruce: THREE.Material, wood: THREE.Material): THREE.Object3D {
    const g = new THREE.Group();
    g.name = 'Soundboard';
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(2 * INNER_X, TOP_Y + 0.66, 1, 1).translate(0, (TOP_Y - 0.66) / 2, SOUNDBOARD_Z), spruce);
    sb.receiveShadow = true;
    g.add(sb);
    // the long bridge under the steel strings (in pieces between the struts), and the bass bridge
    const near = (x: number) => STRUT_X.some((sx) => Math.abs(x - sx) < 0.022);
    const treble = STRINGS.filter((s, j) => !s.wound && j % 3 === 1).map((s) => [s.bridge[0], s.bridge[1]] as [number, number]);
    const runs: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (const p of treble) {
      if (near(p[0])) {
        if (cur.length > 1) runs.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length > 1) runs.push(cur);
    const top = (z: number) => z - 0.0006;
    const parts = runs.map((r) => strip(r, 0.022, SOUNDBOARD_Z, top(-0.338), [1, 1, 1]));
    const bass = STRINGS.filter((s) => s.wound).map((s) => [s.bridge[0], s.bridge[1]] as [number, number]);
    parts.push(strip(bass, 0.026, SOUNDBOARD_Z, -0.326 - 0.0026, [1, 1, 1]));
    const bridges = new THREE.Mesh(merged(parts), wood);
    bridges.castShadow = true;
    bridges.receiveShadow = true;
    g.add(bridges);
    return g;
  }

  /** the static action: key frame, rails, brackets */
  private buildRails(wood: THREE.Material): THREE.Object3D {
    const [x0, x1] = HAMMER_SPAN;
    const xm = (x0 + x1) / 2;
    const w = x1 - x0 + 0.03;
    const zp = (pivotOf(30)[2] + pivotOf(10)[2]) / 2; // hammer pivots (the bass a little forward)
    const restZ = zp + 0.045 * Math.tan(HAMMER_REST) + 0.0027 + 0.007;
    const parts: THREE.BufferGeometry[] = [
      box(2 * INNER_X, 0.006, 0.12, 0, -0.003, -0.29, [0.1, 0.07, 0.06]), // key frame, cloth
      box(w, 0.018, 0.026, xm, 0.124, zp - 0.002, MAPLE.map((c) => c * 0.8) as C3), // flange rail
      box(w, 0.014, 0.012, xm, 0.185, restZ, MAPLE.map((c) => c * 0.75) as C3), // hammer rest rail
      box(w, 0.012, 0.003, xm, 0.185, restZ - 0.0075, GREEN_FELT),
      box(w, 0.012, 0.02, xm, 0.165, zp - 0.012, WALNUT), // damper lever rail
    ];
    // cast brackets carrying the rails, in the gaps and at the ends
    for (const x of [x0 - 0.012, ...STRUT_X, x1 + 0.012]) {
      parts.push(
        box(0.008, 0.29, 0.016, x, 0.125, zp + 0.05, IRON),
        box(0.008, 0.016, 0.07, x, 0.124, zp + 0.018, IRON),
        box(0.008, 0.016, 0.05, x, 0.27, zp + 0.03, IRON),
        box(0.008, 0.03, 0.03, x, 0.01, zp + 0.04, IRON),
      );
    }
    const m = new THREE.Mesh(merged(parts), wood);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'ActionRails';
    return m;
  }

  /** pose the action for a frame */
  update(f: FrameState) {
    const { m4, q, q2, p, one, xAxis } = this;
    for (let i = 0; i < KEY_COUNT; i++) {
      const [x, y, z] = pivotOf(i);
      q.setFromAxisAngle(xAxis, HAMMER_REST * (1 - f.hammers[i]));
      m4.compose(p.set(x, y, z), q, one);
      this.hammerFelt.setMatrixAt(i, m4);
      this.hammerUnder.setMatrixAt(i, m4);
      this.hammerWood.setMatrixAt(i, m4);
      // the wippen rides on the key's back
      q.identity();
      m4.compose(p.set(x, 0.045 + 0.011 * Math.max(0, f.keys[i]), z + 0.032), q, one);
      this.wippens.setMatrixAt(i, m4);
    }
    for (let i = 0; i < N_DAMPED; i++) {
      const [x, y, z] = this.dampPivot[i];
      q2.setFromAxisAngle(xAxis, DAMPER_SWING * f.dampers[i]);
      q.copy(this.leans[i]).multiply(q2);
      m4.compose(p.set(x, y, z), q, one);
      this.damperFelt.setMatrixAt(i, m4);
      this.damperWood.setMatrixAt(i, m4);
    }
    for (const m of [this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood, this.wippens]) m.instanceMatrix.needsUpdate = true;
    this.vibrate(f);
  }

  /** each string's swing, from its key's (StringMechanics) */
  private vibrate(f: FrameState) {
    const vs = this.swingSteel.array as Float32Array;
    const vc = this.swingCopper.array as Float32Array;
    for (let j = 0; j < STRINGS.length; j++) {
      const i = STRINGS[j].key;
      const k = this.swingShare[j];
      const slot = this.stringSlot[j];
      const out = slot.wound ? vc : vs;
      out[slot.index * 2] = f.strings[2 * i] * k;
      out[slot.index * 2 + 1] = f.strings[2 * i + 1] * (2 - k);
    }
    this.swingSteel.needsUpdate = true;
    this.swingCopper.needsUpdate = true;
  }

  /** remember the moving parts' transforms as they were when the shutter opened (call after update with that frame) */
  keepPrevious() {
    for (const m of [this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood, this.wippens]) keepPrevious(m);
  }
}

export { BASS_N };
