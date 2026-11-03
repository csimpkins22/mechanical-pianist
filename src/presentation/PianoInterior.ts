// Inside the upright: what shows when the upper front panel is off. Built
// here from the shared layout (ActionLayout.ts) rather than in Blender, so
// every hammer stands behind its key and every string runs where its hammer
// strikes. The action: a hammer per key (felt head on a wooden moulding, maple
// shank, buckskin butt), a damper per damped key (felt on a wooden head, a
// wire down to its lever), the rails and cast brackets; below them the
// mechanism that drives them, from the keys' backs up (ActionParts.ts). The
// strings (steel, copper-wound in the bass and overstrung across the tenor),
// the gilded cast-iron plate with its tuning and hitch pins, the bridges and
// the spruce soundboard behind.
//
// The hammers, dampers and the mechanism are instanced and posed every frame from
// the FrameState (ActionMechanics.ts); the strings show their swing as the
// camera sees it, an exposure blur (StringMechanics.ts, and the string shaders
// below). The moving parts keep their transforms at the start of the shutter
// (prevInstanceMatrix) for motion blur.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { KEY_COUNT, LOWEST_MIDI } from '../core/keyboard';
import { hash01 } from '../core/random';
import { UNDAMPED_FROM } from '../performance/ActionMechanics';
import { SOFT_BLOW } from '../performance/Pedals';
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
import { ActionParts, damperQuaternion, hammerQuaternion } from './ActionParts';
import { CAVITY } from './InteriorLight';
import {
  DECAL_MAP,
  DETAIL_GLSL,
  FELT_GLSL,
  FELT_NORMAL,
  GOLD_GLSL,
  GOLD_NORMAL,
  GOLD_ROUGH,
  HAMMER_GLSL,
  LETTERING_MAP,
  LETTERING_NORMAL,
  WOOD_GLSL,
  decalTexture,
  feltify,
  letteringTexture,
} from './InteriorShading';
import { patch } from './shaderPatch';

/** the piano's (invented) maker, cast into the plate and on the soundboard's decal (as on the nameboard) */
const MAKER = 'Halloran & Vey';

const N_DAMPED = UNDAMPED_FROM - LOWEST_MIDI;
/** the hammer rest rail is this far above the hammer pivots, which stand at about this depth */
const RAIL_H = 0.045;
const RAIL_PIVOT_Z = (pivotOf(30)[2] + pivotOf(10)[2]) / 2;
/** the damper lift rail's height */
const LIFT_RAIL_Y = DAMPER_PIVOT_Y + 0.03;
const INNER_X = 0.665; // the case's side panels, inside
const TOP_Y = 0.524; // under the lid

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
  // each instance's number (hammer i is key i), and the object-space normal, for the felt's layers and stamp
  const INSTANCE_VS_HEAD = 'flat varying float vHammer;\nvarying vec3 vONormal;';
  const INSTANCE_VS = 'vHammer = float(gl_InstanceID);\nvONormal = objectNormal;';
  // dust on what faces up: a grey film that also takes the gloss off
  const DUST = /* glsl */ `
  {
    float mpD = mpDust(vWPos, vWNormal, mpFoot());
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.52, 0.5, 0.47), 0.2 * mpD);
    roughnessFactor = mix(roughnessFactor, 1.0, 0.6 * mpD);
  }`;
  // The hammers' felt, as in the footage: warm cream wool, matte and soft,
  // thick around a beech moulding; on the sides the layers show in section
  // (the thin dark-red U of the underfelt inside the white felt, the wood
  // inside that); the crown pressed smoother and a little yellowed along the
  // strike line, the strings' grooves in it; and each head's number stamped
  // in ink on its upper side, by the moulding.
  const felt = feltify(
    patch(
      new THREE.MeshPhysicalMaterial({
        color: 0xe6d1ae,
        roughness: 1,
        specularIntensity: 0.1,
        sheen: 1,
        sheenRoughness: 0.85,
        sheenColor: new THREE.Color(0xa49a88),
      }),
      {
        vertexHead: INSTANCE_VS_HEAD,
        vertexEnd: INSTANCE_VS,
        fragHead: DETAIL_GLSL + FELT_GLSL + HAMMER_GLSL,
        afterMap: /* glsl */ `
        float mpWoodIn = 0.0;
        {
          float mpF = mpFoot();
          vec3 mpO = vOPos - vec3(0.0, ${SHANK.toFixed(4)}, 0.0);
          float side = smoothstep(0.55, 0.85, abs(vONormal.x));
          float back = smoothstep(0.6, 0.9, vONormal.z);
          // the crown, where the strings strike
          float crown = smoothstep(${(-CROWN + 0.007).toFixed(4)}, ${(-CROWN + 0.003).toFixed(4)}, mpO.z) * (1.0 - side);
          float strike = exp(-pow(mpO.y / 0.0034, 2.0));
          mpFeltSmooth = crown * strike;
          // each head's felt a little different, the fibres moving with it
          float a = mpFelt(vOPos + vec3(vHammer * 0.0371, vHammer * 0.0213, 0.0), mpF);
          float h = mpHash(vec3(vHammer, 3.0, 7.0));
          vec3 wool = diffuseColor.rgb * a * mix(vec3(0.97, 0.98, 1.0), vec3(1.03, 1.0, 0.95), h);
          // the layers, on the sides and the back
          vec2 u = mpU(mpO.y, mpO.z, vec4(${HEAD_BACK.toFixed(4)}, ${U_DEPTH.toFixed(4)}, ${U_HALF.toFixed(4)}, 0.0));
          float layers = max(side, back);
          float line = (1.0 - smoothstep(0.00045, 0.00045 + max(0.00025, 1.5 * mpF), u.x)) * layers;
          mpWoodIn = u.y * layers * smoothstep(0.00025, 0.0006, u.x);
          vec3 beech = vec3(0.72, 0.55, 0.35) * (0.94 + 0.08 * mpNoise(vec3(vOPos.x * 300.0, vOPos.y * 4000.0, vOPos.z * 300.0)));
          vec3 c = mix(wool, beech, mpWoodIn);
          c = mix(c, vec3(0.32, 0.05, 0.05) * (0.9 + 0.2 * a), line);
          // the strike line, pressed smooth and a little yellowed, with three grooves
          float g = 0.0;
          for (int k = -1; k <= 1; k++) { float d = (mpO.x - float(k) * 0.0024) / 0.00045; g += exp(-d * d); }
          c *= mix(vec3(1.0), vec3(0.95, 0.91, 0.8) * (1.0 - 0.28 * min(g, 1.0)), mpFeltSmooth);
          // the number, stamped on the upper side by the moulding, upright to someone looking in from the keys
          float top = smoothstep(0.4, 0.7, vONormal.y) * (1.0 - side);
          float ink = top * mpStamp(vec2(mpO.x, ${(HEAD_BACK - 0.0058).toFixed(4)} - mpO.z), vHammer + 1.0, 0.00056, mpF);
          c = mix(c, vec3(0.2, 0.185, 0.2), 0.62 * ink * (0.7 + 0.3 * mpNoise(vOPos * 3000.0)));
          diffuseColor.rgb = c;
          mpFeltH *= 1.0 - mpWoodIn;
        }`,
        afterRough: /* glsl */ `roughnessFactor = mix(roughnessFactor, 0.55, mpWoodIn);${DUST}`,
        afterNormal: FELT_NORMAL,
        afterAO: CAVITY,
        bounce: 0.75,
      },
    ),
  );
  // inside the felt now, where it belongs: what shows of it is the U on the sides
  const underfelt = patch(
    new THREE.MeshPhysicalMaterial({ color: 0x8e2019, roughness: 0.92, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xd06050) }),
    { afterMap: /* glsl */ `diffuseColor.rgb *= 0.88 + 0.16 * mpNoise(vWPos * 2000.0);`, afterAO: CAVITY, bounce: 0.7 },
  );
  const damperFelt = feltify(
    patch(
      new THREE.MeshPhysicalMaterial({ color: 0xece4d4, roughness: 1, specularIntensity: 0.1, sheen: 1, sheenRoughness: 0.85, sheenColor: new THREE.Color(0xa8a194) }),
      {
        vertexHead: INSTANCE_VS_HEAD,
        vertexEnd: INSTANCE_VS,
        fragHead: 'flat varying float vHammer;\n' + DETAIL_GLSL + FELT_GLSL,
        afterMap: /* glsl */ `diffuseColor.rgb *= mpFelt(vOPos + vec3(vHammer * 0.0371, vHammer * 0.0213, 0.0), mpFoot()) * (0.97 + 0.06 * mpHash(vec3(vHammer, 5.0, 1.0)));`,
        afterRough: DUST,
        afterNormal: FELT_NORMAL,
        afterAO: CAVITY,
        bounce: 0.75,
      },
    ),
  );
  // wood, buckskin, felt strips, cloth and painted iron, by vertex colour: the
  // wood with a fine straight grain along each part, the felt and cloth with fibres
  const wood = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }), {
    fragHead: DETAIL_GLSL + FELT_GLSL + WOOD_GLSL,
    afterMap: /* glsl */ `
    float mpCloth = 0.0;
    {
      float mpF = mpFoot();
      #ifdef USE_INSTANCING
      vec3 mpP = vOPos;
      #else
      vec3 mpP = vWPos;
      #endif
      float wd = mpWoodness(vColor.rgb);
      mpCloth = mpClothness(vColor.rgb);
      float other = 0.95 + 0.1 * mpNoise(vWPos * 1500.0) * mpRes(0.0007, mpF);
      diffuseColor.rgb *= mix(mix(other, mpGrain(mpP, mpF), wd), mpFelt(mpP, mpF), mpCloth);
      mpFeltH *= mpCloth;
    }`,
    afterRough: /* glsl */ `roughnessFactor = mix(roughnessFactor, 1.0, mpCloth);${DUST}`,
    afterNormal: FELT_NORMAL,
    afterAO: CAVITY,
    bounce: 0.7,
  });
  // The plate's gold paint: bronze powder in lacquer over sand-cast iron, so
  // fine flakes catch the light up close and it reads as satin gold further
  // off; the maker's name and the casting's legends raised across its top.
  const plate = patch(new THREE.MeshPhysicalMaterial({ color: 0xecd384, metalness: 0.38, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.18, specularColor: new THREE.Color(0xffe2a0) }), {
    uniforms: { uLetters: { value: letteringTexture(MAKER) } },
    fragHead: DETAIL_GLSL + GOLD_GLSL,
    afterMap: /* glsl */ `
    {
      float mpF = mpFoot();
      diffuseColor.rgb *= 0.9 + 0.14 * mpFbm(vWPos * 140.0) - 0.05 * mpNoise(vWPos * 2600.0) * mpRes(0.0004, mpF);
      ${LETTERING_MAP}
    }`,
    afterRough: GOLD_ROUGH + DUST,
    afterNormal: GOLD_NORMAL + LETTERING_NORMAL,
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
  // copper winding: its turns face every way along the string, so it catches
  // the light from far more directions than a smooth wire and never goes black
  // just because it faces the dark cabinet
  const copper = patch(new THREE.MeshPhysicalMaterial({ color: 0xc78150, metalness: 0.88, roughness: 0.42, transparent: true, depthWrite: false }), {
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
    afterNormal: /* glsl */ `${STRING_NORMAL}
    {
      // the turns tilt the normal back and forth along the string
      float mpA = vWPos.y * 5200.0 + vWPos.x * 2100.0;
      float mpFade = (1.0 - smoothstep(0.4, 1.6, fwidth(mpA))) * (1.0 - smoothstep(0.3, 1.0, vSwing / vRad));
      vec3 mpAx = normalize(cross(normalize(vSideV), normalize(vFrontV)));
      normal = normalize(normal + mpAx * 0.5 * mpFade * cos(mpA));
    }`,
    // ... the room's bounced light comes back off the turns in the copper's own colour
    afterAO: /* glsl */ `
    if (uBounce > 0.0) reflectedLight.indirectSpecular += uBounce * 0.45 * mpBounce(vWPos, normalize(vWNormal)) * material.specularColor;
    ${CAVITY}`,
    bounce: 1,
  });
  const soundboard = patch(new THREE.MeshPhysicalMaterial({ color: 0xcc9e62, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 }), {
    uniforms: { uDecal: { value: decalTexture(MAKER) } },
    fragHead: DETAIL_GLSL,
    // quarter-sawn spruce, its grain on the diagonal, under old varnish; the
    // maker's gold transfer in the treble; a film of dust over it all
    afterMap: /* glsl */ `
    {
      vec2 sp = vec2(vWPos.x * 0.83 + vWPos.y * 0.56, vWPos.y * 0.83 - vWPos.x * 0.56);
      float mpA = sp.x * 1300.0 + mpFbm(vec3(sp * vec2(5.0, 1.2), 0.0)) * 14.0;
      float mpFade = 1.0 - smoothstep(0.5, 1.8, fwidth(mpA));
      float late = smoothstep(0.55, 1.0, 0.5 + 0.5 * sin(mpA));
      diffuseColor.rgb *= mix(0.93, mix(1.0, 0.82, late), mpFade) * (0.9 + 0.16 * mpFbm(vec3(sp * vec2(2.0, 30.0), 3.0)));
    }
    ${DECAL_MAP}
    {
      float mpF = mpFoot();
      float mpD = (0.35 + 0.65 * smoothstep(0.3, 0.75, mpFbm(vWPos * 60.0))) * mix(0.5, step(0.82, mpHash(floor(vWPos * 2600.0))), mpRes(0.0004, mpF));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.47, 0.43), 0.12 * mpD * (1.0 - mpDecal));
    }`,
    afterRough: /* glsl */ `roughnessFactor = mix(roughnessFactor, 0.34, mpDecal);`,
    afterMetal: /* glsl */ `metalnessFactor = mix(metalnessFactor, 0.3, mpDecal);`,
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
 * The hammer head, as in the footage: thick cream felt nearly as wide as the
 * keys' spacing allows, longer from the moulding to the crown than it is
 * tall, with a broad, round crown and soft, pillowy edges.
 */
const FELT_W = HEAD_W + 0.0002;
/** how far the felt's back (where the moulding goes in) stands behind the head's centre, and its half-height there */
const HEAD_BACK = 0.0125;
const HEAD_HALF = 0.0165;
/** the red underfelt's U, inside: from the back to its front, and the half-height of its arms */
const U_DEPTH = 0.0235;
const U_HALF = 0.0105;
const BEECH: C3 = [0.72, 0.55, 0.35];

/**
 * A hammer's felt, around its pivot: an egg-shaped profile from the back of
 * the head (zBack) over a broad rounded crown (`crown` toward the strings,
 * -z) whose height is 2h; tapering from wBack wide at the moulding to wCrown
 * at the crown, with soft, rounded edges (bevel); the strike line worn flat
 * and pressed in by `flat`. Centred SHANK above the pivot. The wool is a
 * little uneven: every vertex sits a few hundredths of a millimetre in or out.
 */
function feltShape(zBack: number, crown: number, h: number, wBack: number, wCrown: number, flat: number, bevel = 0.0021, K = 30, bevelSegments = 3): THREE.BufferGeometry {
  const D = zBack + crown;
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= K; k++) {
    const th = -Math.PI / 2 + (Math.PI * k) / K;
    const y = h * Math.sin(th);
    const z = zBack - D * Math.pow(Math.max(0, Math.cos(th)), 0.85) + flat * Math.exp(-((y / 0.0016) ** 2));
    pts.push(new THREE.Vector2(z, y));
  }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth: wBack - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments,
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
  // uneven wool, never at the crown's strike line
  const p = m.getAttribute('position');
  const n = m.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const q = [p.getX(i), p.getY(i), p.getZ(i)];
    const cell = Math.imul(Math.floor(q[0] * 900), 73856093) ^ Math.imul(Math.floor(q[1] * 900), 19349663) ^ Math.imul(Math.floor(q[2] * 900), 83492791);
    const atStrike = Math.exp(-(((q[1] - SHANK) / 0.004) ** 2)) * (q[2] < -crown + 0.004 ? 1 : 0);
    const d = (hash01(cell, 5) - 0.5) * 0.00008 * (1 - atStrike);
    p.setXYZ(i, q[0] + n.getX(i) * d, q[1] + n.getY(i) * d, q[2] + n.getZ(i) * d);
  }
  m.computeVertexNormals();
  return m;
}

/** the outer felt: cream, wrapping the head, with the crown that meets the string */
const hammerHead = () => feltShape(HEAD_BACK, CROWN, HEAD_HALF, FELT_W, FELT_W * 0.9, 0.00045);
/** the underfelt, inside the outer felt: what shows of it is its U on the sides (the felt's shader) */
const hammerUnderfelt = () => feltShape(HEAD_BACK - 0.0008, U_DEPTH - HEAD_BACK - 0.0005, U_HALF - 0.0006, FELT_W - 0.0018, FELT_W * 0.8, 0, 0.0008, 8, 1);

function hammerWood(): THREE.BufferGeometry {
  return merged([
    rod([0, 0.012, 0.011], [0, 0.104, 0.011], 0.0027, MAPLE), // shank
    box(FELT_W - 0.0012, 0.015, 0.0095, 0, SHANK - 0.0035, HEAD_BACK + 0.0035, BEECH), // moulding, beech, its tail out behind the felt down to the shank
    box(0.01, 0.028, 0.03, 0, 0.008, 0.002, BUCKSKIN), // butt
    box(0.0102, 0.006, 0.03, 0, -0.008, 0.002, RED_FELT),
    rod([0, 0.03, 0.016], [0, 0.03, 0.04], 0.0019, MAPLE, 6), // backcheck catcher
    box(0.008, 0.012, 0.006, 0, 0.03, 0.043, [0.55, 0.4, 0.28]),
  ]);
}

/** damper around its lever pivot: felt pressing the strings (-z), head block, wire down to the lever beside the hammer */
function damperFeltGeo(): THREE.BufferGeometry {
  // a soft block of felt with rounded edges, its face on the strings where it always was
  const g = new RoundedBoxGeometry(0.0105, 0.03, 0.0105, 2, 0.0016).translate(0, 0.165, -0.01625);
  g.deleteAttribute('uv');
  return g;
}

function damperWood(): THREE.BufferGeometry {
  return merged([
    box(0.0101, 0.029, 0.0013, 0, 0.165, -0.0104, RED_FELT), // the red cloth the felt is glued on with
    box(0.0098, 0.026, 0.011, 0, 0.165, -0.0045, WALNUT),
    box(0.003, 0.006, 0.006, 0.0058, 0.154, -0.004, WIRE),
    rod([0.0058, 0.0, -0.004], [0.0058, 0.155, -0.004], 0.0006, WIRE, 5),
    box(0.004, 0.014, 0.01, 0.0058, 0.0, -0.004, WALNUT),
  ]);
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
  private parts: ActionParts;
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
  /** the hammer rest rail (moved toward the strings by the soft pedal) and the damper lift rail (the sustain pedal) */
  private restRail: THREE.Object3D;
  private liftRail: THREE.Object3D;
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
    this.root.add(this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood);
    for (let i = 0; i < N_DAMPED; i++) {
      // the damper sits on its strings above the strike line, leaning with them in the bass
      const s = stringSlope(i);
      const r = stringRadius(i);
      const dy = 0.165 + DAMPER_PIVOT_Y - STRIKE_Y; // felt centre above the strike line
      this.dampPivot.push([HAMMER_X[i] + s * dy, DAMPER_PIVOT_Y, stringZ(i) + r + 0.0215]);
      this.leans.push(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan(-s)));
    }

    // the mechanism below the hammers: keys' backs, capstans, wippens, jacks, bridles, spoons (ActionParts.ts)
    this.parts = new ActionParts({ wood: M.wood, steel: M.pins, cavity: CAVITY, dampPivot: this.dampPivot, leans: this.leans });
    this.root.add(this.parts.root);

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
    this.restRail = this.buildRestRail(M.wood);
    this.liftRail = this.buildLiftRail(M.wood);
    this.root.add(this.restRail, this.liftRail);
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
    const parts: THREE.BufferGeometry[] = [
      box(w, 0.012, 0.02, xm, 0.165, zp - 0.012, WALNUT), // damper lever rail
    ];
    // cast brackets carrying the rails, in the gaps and at the ends
    for (const x of [x0 - 0.012, ...STRUT_X, x1 + 0.012]) {
      parts.push(
        box(0.008, 0.29, 0.016, x, 0.125, zp + 0.05, IRON),
        box(0.008, 0.016, 0.07, x, 0.124, zp + 0.018, IRON),
        box(0.008, 0.016, 0.05, x, 0.27, zp + 0.03, IRON),
        box(0.008, 0.03, 0.03, x, 0.035, zp + 0.04, IRON),
      );
    }
    const m = new THREE.Mesh(merged(parts), wood);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'ActionRails';
    return m;
  }

  /**
   * The hammer rest rail: the shanks lie against its felt. The soft pedal
   * swings it toward the strings, taking every hammer a part of the way with it.
   */
  private buildRestRail(wood: THREE.Material): THREE.Object3D {
    const [x0, x1] = HAMMER_SPAN;
    const xm = (x0 + x1) / 2;
    const w = x1 - x0 + 0.03;
    const restZ = RAIL_PIVOT_Z + RAIL_H * Math.tan(HAMMER_REST) + 0.0027 + 0.007;
    const m = new THREE.Mesh(
      merged([box(w, 0.014, 0.012, xm, 0.185, restZ, MAPLE.map((c) => c * 0.75) as C3), box(w, 0.012, 0.003, xm, 0.185, restZ - 0.0075, GREEN_FELT)]),
      wood,
    );
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'HammerRestRail';
    return m;
  }

  /**
   * The damper lift rail: a felt-faced rail behind the damper wires, a few
   * centimetres above their pivots, in two runs (the bass dampers stand
   * further forward with their strings). The sustain pedal pushes it toward
   * the player, and every damper with it.
   */
  private buildLiftRail(wood: THREE.Material): THREE.Object3D {
    const runs: [number, number, number][] = [];
    const first = (i: number) => this.dampPivot[i];
    // the bass run, and the rest up to the last damper
    const bassEnd = BASS_N - 1;
    const zOf = (i: number) => first(i)[2] - 0.004 - 0.0085;
    runs.push([HAMMER_X[0] - 0.008, HAMMER_X[bassEnd] + 0.008, zOf(bassEnd)]);
    runs.push([HAMMER_X[BASS_N] - 0.008, HAMMER_X[N_DAMPED - 1] + 0.008, zOf(BASS_N)]);
    const parts: THREE.BufferGeometry[] = [];
    for (const [a, b, z] of runs) {
      parts.push(box(b - a, 0.012, 0.006, (a + b) / 2, LIFT_RAIL_Y, z, WALNUT), box(b - a, 0.01, 0.002, (a + b) / 2, LIFT_RAIL_Y, z + 0.004, RED_FELT));
    }
    const m = new THREE.Mesh(merged(parts), wood);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'DamperLiftRail';
    return m;
  }

  /** pose the action for a frame */
  update(f: FrameState) {
    const { m4, q, q2, p, one, xAxis } = this;
    for (let i = 0; i < KEY_COUNT; i++) {
      const [x, y, z] = pivotOf(i);
      hammerQuaternion(i, f.hammers[i], f.leans[i], q);
      m4.compose(p.set(x, y, z), q, one);
      this.hammerFelt.setMatrixAt(i, m4);
      this.hammerUnder.setMatrixAt(i, m4);
      this.hammerWood.setMatrixAt(i, m4);
    }
    for (let i = 0; i < N_DAMPED; i++) {
      const [x, y, z] = this.dampPivot[i];
      damperQuaternion(i, f.dampers[i], this.leans[i], DAMPER_SWING, q);
      m4.compose(p.set(x, y, z), q, one);
      this.damperFelt.setMatrixAt(i, m4);
      this.damperWood.setMatrixAt(i, m4);
    }
    for (const m of [this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood]) m.instanceMatrix.needsUpdate = true;
    this.parts.update(f);
    this.vibrate(f);
    // the rails: the soft pedal's (toward the strings) and the sustain pedal's (toward the player)
    const softAngle = HAMMER_REST * (1 - SOFT_BLOW * f.softPedal);
    this.restRail.position.z = RAIL_H * (Math.tan(softAngle) - Math.tan(HAMMER_REST));
    this.liftRail.position.z = (LIFT_RAIL_Y - DAMPER_PIVOT_Y) * Math.sin(DAMPER_SWING * f.damperRail);
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

  /** the instanced rows of parts, instance i beside i ± 1 (for the light between them: InteriorLight) */
  rows(): THREE.InstancedMesh[] {
    return [this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood, ...this.parts.rows()];
  }

  /** remember the moving parts' transforms as they were when the shutter opened (call after update with that frame) */
  keepPrevious() {
    for (const m of [this.hammerFelt, this.hammerUnder, this.hammerWood, this.damperFelt, this.damperWood]) keepPrevious(m);
    this.parts.keepPrevious();
  }
}

export { BASS_N };
