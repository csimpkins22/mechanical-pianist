// Extends three's built-in PBR materials through onBeforeCompile, so they keep
// three's lights, shadows and image-based lighting while adding procedural
// detail: baked masks from Blender (vertex colour R = ambient occlusion,
// G = convex edges, B = cavities), wood grain, wear and contact shadows.
import * as THREE from 'three';

export const NOISE_GLSL = /* glsl */ `
float mpHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float mpNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mpHash(i + vec3(0,0,0)), mpHash(i + vec3(1,0,0)), f.x),
                 mix(mpHash(i + vec3(0,1,0)), mpHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(mpHash(i + vec3(0,0,1)), mpHash(i + vec3(1,0,1)), f.x),
                 mix(mpHash(i + vec3(0,1,1)), mpHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float mpFbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * mpNoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

/** Uniforms shared by all patched materials, updated once per frame. */
export const SHARED_UNIFORMS = {
  uFingertips: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, -10, 0, 0)) },
  // bounced light: three spherical-harmonic irradiance probes captured from
  // the lit room (low, at the keys, high; see SceneRenderer.captureBounce),
  // blended by height
  uBounceSH: { value: Array.from({ length: 27 }, () => new THREE.Vector3()) },
  uBounceY: { value: new THREE.Vector3(-0.45, 0.07, 0.45) },
  uBounce: { value: 0 },
};

/** GLSL: irradiance from probe o (three's shGetIrradianceAt), and the height blend of the three */
const BOUNCE_GLSL = /* glsl */ `
vec3 mpSH(int o, vec3 n) {
  vec3 r = uBounceSH[o] * 0.886227;
  r += uBounceSH[o + 1] * 1.023328 * n.y;
  r += uBounceSH[o + 2] * 1.023328 * n.z;
  r += uBounceSH[o + 3] * 1.023328 * n.x;
  r += uBounceSH[o + 4] * 0.858086 * n.x * n.y;
  r += uBounceSH[o + 5] * 0.858086 * n.y * n.z;
  r += uBounceSH[o + 6] * (0.743125 * n.z * n.z - 0.247708);
  r += uBounceSH[o + 7] * 0.858086 * n.x * n.z;
  r += uBounceSH[o + 8] * 0.429043 * (n.x * n.x - n.y * n.y);
  return max(r, vec3(0.0));
}
vec3 mpBounce(vec3 p, vec3 n) {
  float a = clamp((p.y - uBounceY.x) / (uBounceY.y - uBounceY.x), 0.0, 1.0);
  float b = clamp((p.y - uBounceY.y) / (uBounceY.z - uBounceY.y), 0.0, 1.0);
  return p.y < uBounceY.y ? mix(mpSH(0, n), mpSH(9, n), a) : mix(mpSH(9, n), mpSH(18, n), b);
}
`;

export interface PatchOptions {
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string;
  vertexEnd?: string;
  fragHead?: string;
  /** after the albedo is known (diffuseColor) */
  afterMap?: string;
  afterRough?: string;
  afterMetal?: string;
  afterNormal?: string;
  afterEmissive?: string;
  /** after ambient occlusion: can scale reflectedLight.indirect* */
  afterAO?: string;
  beforeOpaque?: string;
  /** read the Blender masks from the vertex colour attribute (not as albedo) */
  masks?: boolean;
  /** how much bounced light from the room probes this surface takes (default 1) */
  bounce?: number;
}

let nextId = 0;

function glslType(v: unknown): string {
  if (typeof v === 'number') return 'float';
  if (v instanceof THREE.Vector2) return 'vec2';
  if (v instanceof THREE.Vector3 || v instanceof THREE.Color) return 'vec3';
  if (v instanceof THREE.Vector4) return 'vec4';
  if (v instanceof THREE.Matrix4) return 'mat4';
  if (v instanceof THREE.Texture) return 'sampler2D';
  return 'float';
}

export function patch<T extends THREE.Material>(mat: T, o: PatchOptions): T {
  const key = 'mp' + nextId++;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED_UNIFORMS, o.uniforms ?? {});
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    const decl = Object.entries(o.uniforms ?? {})
      .map(([k, u]) => `uniform ${glslType(u.value)} ${k};`)
      .join('\n');
    vs = vs.replace(
      '#include <common>',
      `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec3 vOPos;
${o.masks ? 'attribute vec4 color;\nvarying vec3 vMask;' : ''}
${decl}
${o.vertexHead ?? ''}`,
    );
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
{
  vec4 mpW = modelMatrix * vec4(transformed, 1.0);
  vWPos = mpW.xyz;
  vWNormal = normalize(mat3(modelMatrix) * objectNormal);
  vOPos = transformed;
  ${o.masks ? 'vMask = color.rgb;' : ''}
}
${o.vertexEnd ?? ''}`,
    );
    fs = fs.replace(
      '#include <common>',
      `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec3 vOPos;
${o.masks ? 'varying vec3 vMask;' : ''}
uniform vec4 uFingertips[10];
uniform vec3 uBounceSH[27];
uniform vec3 uBounceY;
uniform float uBounce;
${NOISE_GLSL}
${BOUNCE_GLSL}
${decl}
${o.fragHead ?? ''}`,
    );
    const after = (inc: string, code?: string) => {
      if (code) fs = fs.replace(`#include <${inc}>`, `#include <${inc}>\n${code}`);
    };
    after('map_fragment', o.afterMap);
    after('roughnessmap_fragment', o.afterRough);
    after('metalnessmap_fragment', o.afterMetal);
    after('normal_fragment_maps', o.afterNormal);
    after('emissivemap_fragment', o.afterEmissive);
    // light bounced off the room, before any ambient occlusion darkens it
    const bounce = o.bounce ?? 1;
    if (bounce > 0)
      fs = fs.replace(
        '#include <aomap_fragment>',
        `if (uBounce > 0.0) reflectedLight.indirectDiffuse += uBounce * ${bounce.toFixed(3)} * mpBounce(vWPos, normalize(vWNormal)) * BRDF_Lambert(material.diffuseColor);
#include <aomap_fragment>`,
      );
    after('aomap_fragment', o.afterAO);
    if (o.beforeOpaque) fs = fs.replace('#include <opaque_fragment>', `${o.beforeOpaque}\n#include <opaque_fragment>`);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  return mat;
}

/**
 * GLSL: soft contact shadow cast by the ten fingertips onto a surface at
 * world position p (darkening that grows as a fingertip approaches). w of
 * each fingertip holds its radius.
 */
export const CONTACT_SHADOW_GLSL = /* glsl */ `
float mpContact(vec3 p) {
  float occ = 1.0;
  for (int i = 0; i < 10; i++) {
    vec4 f = uFingertips[i];
    if (f.w <= 0.0) continue;
    vec3 d = p - f.xyz;
    float h = max(0.0, -d.y - f.w);                   // gap between the tip and the surface
    float lat = length(d.xz);
    float r = f.w * (1.05 + h * 60.0);
    float a = 1.0 - smoothstep(r * 0.25, r * 1.45, lat);
    a *= 1.0 - smoothstep(0.0, 0.03, h);
    occ *= 1.0 - 0.62 * a;
  }
  return occ;
}
`;
