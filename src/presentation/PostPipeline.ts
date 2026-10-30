// Post-processing: HDR scene (MSAA, depth) -> volumetric light shafts from
// the window (raymarched at half resolution against the scene depth and the
// sun's shadow map) -> physical thin-lens depth of field (bokeh gather at
// half resolution) -> bloom -> anamorphic streaks (bright parts smeared
// horizontally) -> filmic grade (highlight roll-off, ACES, lift/gamma/gain,
// split toning, warm blacks, vignette, gentle chromatic aberration,
// frame-seeded grain, letterbox). Every parameter arrives per frame in
// `PostParams`; everything is a pure function of them and the scene.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { NOISE_GLSL } from './shaderPatch';

export const SENSOR_W = 0.036; // metres, full-frame horizontal

export interface PostParams {
  focalLength: number; // mm
  fstop: number;
  focus: number; // metres
  dof: boolean;
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  saturation: number;
  contrast: number;
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  temperature: number;
  vignette: number;
  grain: number;
  aberration: number;
  frame: number;
  /** highlight roll-off before the tone curve (0 = none) */
  rolloff: number;
  /** lifted, faded blacks (0 = none) */
  fade: number;
  /** keep cyan hues saturated when the rest is desaturated (0..1) */
  accent: number;
  /** added to the blacks after the contrast curve (warm or cool) */
  blackTint: [number, number, number];
  /** anamorphic streak strength (0 = off) */
  streaks: number;
  /** letterbox aspect ratio (0 = off) */
  letterbox: number;
  shafts: Shafts | null;
}

export interface Shafts {
  strength: number;
  color: THREE.Color;
  sunDir: THREE.Vector3; // direction the light travels
  window: { x: number; y: number; z: number; w: number; h: number };
  /** z of the two vertical glazing bars, y of the two horizontal ones; their half width */
  bars: { vertical: number[]; horizontal: number[]; half: number };
  shadow: { map: THREE.Texture; matrix: THREE.Matrix4 } | null;
  time: number;
}

const quadVS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const depthFns = /* glsl */ `
uniform float uNear;
uniform float uFar;
uniform float uCocScale;
uniform float uFocus;
uniform float uMaxCoc;
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
float cocOf(float z) {
  return clamp(uCocScale * (z - uFocus) / max(z, 1e-4), -uMaxCoc, uMaxCoc);
}
`;

const prefilterFS = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
varying vec2 vUv;
${depthFns}
void main() {
  vec2 o = uTexel * 0.5;
  float d = min(min(texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r, texture2D(tDepth, vUv + vec2(o.x, -o.y)).r),
                min(texture2D(tDepth, vUv + vec2(-o.x, o.y)).r, texture2D(tDepth, vUv + vec2(o.x, o.y)).r));
  // colour through a wider tent (about 3 half-res pixels), so a tiny bright
  // highlight covers enough of the half-res image for the spiral gather to
  // catch it everywhere: a soft disc, not the gather's own sample pattern
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float w = (2.0 - abs(float(x))) * (2.0 - abs(float(y)));
      c += texture2D(tColor, vUv + vec2(float(x), float(y)) * uTexel * 3.0).rgb * w;
      wsum += w;
    }
  }
  c /= wsum;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= min(1.0, 16.0 / max(l, 1e-4));
  gl_FragColor = vec4(c, linearDepth(d));
}
`;

const bokehFS = /* glsl */ `
uniform sampler2D tHalf;
uniform vec2 uHalfTexel;
uniform float uRadScale;
varying vec2 vUv;
${depthFns}
#define GOLDEN_ANGLE 2.39996323
void main() {
  vec4 c0 = texture2D(tHalf, vUv);
  float centerDepth = c0.a;
  float centerSize = abs(cocOf(centerDepth)) * 0.5;
  vec3 color = c0.rgb;
  float tot = 1.0;
  float nearW = 0.0;
  float radius = uRadScale;
  float maxR = uMaxCoc * 0.5;
  // turn the spiral by a fixed per-pixel angle (interleaved gradient noise),
  // so what the sparse gather leaves is fine noise, not a repeated pattern
  float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < 160; i++) {
    if (radius >= maxR) break;
    float ang = float(i) * GOLDEN_ANGLE + spin;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uHalfTexel * radius;
    vec4 s = texture2D(tHalf, tc);
    float sc = cocOf(s.a);
    float sampleSize = abs(sc) * 0.5;
    if (s.a > centerDepth) sampleSize = clamp(sampleSize, 0.0, centerSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
    color += mix(color / tot, s.rgb, m);
    tot += 1.0;
    if (sc < 0.0 && s.a < centerDepth) nearW += m;
    radius += uRadScale / radius;
  }
  gl_FragColor = vec4(color / tot, clamp(nearW / max(tot - 1.0, 1.0) * 2.5, 0.0, 1.0));
}
`;

const shaftsFS = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2DShadow tShadow;
uniform float uHasShadow;
uniform mat4 uShadowMatrix;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uColor;
uniform float uStrength;
uniform float uTime;
uniform float uSteps;
uniform vec4 uWin;   // window centre x, y, z
uniform vec2 uWinSize;
uniform vec4 uBars;  // vertical bars z, z, horizontal bars y, y
uniform float uBarHalf;
varying vec2 vUv;
${NOISE_GLSL}
/** a soft-edged rectangular opening in the curtains (window-plane coordinates) */
float aperture(vec2 p, vec2 c, vec2 h) {
  vec2 a = abs(p - c) / h;
  return (1.0 - smoothstep(0.7, 1.0, a.x)) * (1.0 - smoothstep(0.7, 1.0, a.y));
}
void main() {
  float d = texture2D(tDepth, vUv).r;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 rd = wp - uCamPos;
  float tMax = min(length(rd), 4.0);
  rd = normalize(rd);
  float dt = tMax / uSteps;
  // a fixed per-pixel offset along the ray (interleaved gradient noise): banding becomes fine grain
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float acc = 0.0;
  for (int i = 0; i < 48; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = uCamPos + rd * ((float(i) + jitter) * dt);
    // follow the sunlight back to the window: lit if it came through a pane
    float s = (p.x - uWin.x) / uSunDir.x;
    if (s <= 0.0) continue;
    vec3 q = p - uSunDir * s;
    vec2 a = abs(vec2(q.z - uWin.z, q.y - uWin.y)) / (0.5 * uWinSize);
    float m = (1.0 - smoothstep(0.9, 1.0, a.x)) * (1.0 - smoothstep(0.9, 1.0, a.y));
    m *= smoothstep(uBarHalf, uBarHalf * 1.4, abs(q.z - uBars.x)) * smoothstep(uBarHalf, uBarHalf * 1.4, abs(q.z - uBars.y));
    m *= smoothstep(uBarHalf, uBarHalf * 1.4, abs(q.y - uBars.z)) * smoothstep(uBarHalf, uBarHalf * 1.4, abs(q.y - uBars.w));
    // heavy curtains drawn almost closed: the sun gets through only a few
    // small openings (where the panels part, a moth-eaten spot), so it
    // crosses the room as distinct beams and the rest of the air stays dark;
    // the openings sway a little with the fabric
    vec2 o = vec2(q.z - uWin.z, q.y - uWin.y) + 0.008 * vec2(sin(uTime * 0.21 + q.y * 2.0), sin(uTime * 0.17));
    float gap = 0.0;
    gap += aperture(o, vec2(0.30, 0.20), vec2(0.032, 0.17));
    gap += aperture(o, vec2(0.45, 0.04), vec2(0.022, 0.24));
    gap += aperture(o, vec2(0.12, 0.34), vec2(0.036, 0.11));
    gap += 0.8 * aperture(o, vec2(-0.24, -0.22), vec2(0.026, 0.28));
    gap += 0.7 * aperture(o, vec2(0.38, 0.44), vec2(0.016, 0.09));
    m *= min(gap, 1.0);
    if (m < 0.001) continue;
    // anything between the window and here (hands, the piano) shades the air too
    float sh = 1.0;
    if (uHasShadow > 0.5) {
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      sc.xyz /= sc.w;
      if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) sh = texture(tShadow, vec3(sc.xy, sc.z - 0.003));
    }
    // dusty air, drifting slowly, thicker in some places than others, and
    // hanging over the instrument (the far room stays clear and dark)
    float n = mpFbm(p * 2.6 + vec3(uTime * 0.03, uTime * 0.012, -uTime * 0.02));
    vec3 dc = (p - vec3(-0.25, 0.25, -0.05)) / vec3(0.95, 0.45, 0.55);
    float dens = (0.15 + 1.8 * n * n) * exp(-dot(dc, dc));
    acc += m * sh * dens * dt;
  }
  // forward scattering (Henyey-Greenstein): brightest looking toward the sun
  float c = dot(uSunDir, -rd);
  float g = 0.55;
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  gl_FragColor = vec4(uColor * acc * phase * uStrength * 7.0, 1.0);
}
`;

/** bright parts only, for the anamorphic streaks */
const streakExtractFS = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  for (int y = -1; y <= 1; y += 2)
    for (int x = -1; x <= 1; x += 2) c += texture2D(tColor, vUv + vec2(float(x), float(y)) * uTexel).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * w, vec3(30.0)), 1.0);
}
`;

/** a horizontal smear; run three times at growing spacing for a long, thin streak */
const streakBlurFS = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  float ws = 0.0;
  for (int k = -6; k <= 6; k++) {
    float w = exp(-0.28 * abs(float(k)));
    c += texture2D(tSrc, vUv + uStep * float(k)).rgb * w;
    ws += w;
  }
  gl_FragColor = vec4(c / ws * uTint, 1.0);
}
`;

const compositeFS = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
uniform sampler2D tShafts;
uniform vec2 uHalfTexel;
uniform float uShaftsOn;
uniform float uExposure;
uniform float uDofOn;
varying vec2 vUv;
${depthFns}
void main() {
  vec3 sharp = texture2D(tColor, vUv).rgb;
  vec3 outc = sharp;
  if (uDofOn > 0.5) {
    vec4 blur = texture2D(tBlur, vUv);
    float coc = abs(cocOf(linearDepth(texture2D(tDepth, vUv).r)));
    float m = max(smoothstep(0.6, 2.2, coc), blur.a);
    outc = mix(sharp, blur.rgb, m);
  }
  // light in the air, after the lens blur (it is soft already, and it lives
  // in front of the blurred background as much as in front of the hands)
  if (uShaftsOn > 0.5) {
    vec2 o = uHalfTexel * 0.75;
    outc += 0.25 * (texture2D(tShafts, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tShafts, vUv + vec2(o.x, -o.y)).rgb
                  + texture2D(tShafts, vUv + vec2(-o.x, o.y)).rgb + texture2D(tShafts, vUv + vec2(o.x, o.y)).rgb);
  }
  gl_FragColor = vec4(outc * uExposure, 1.0);
}
`;

const gradeFS = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uRes;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uTemperature;
uniform float uVignette;
uniform float uGrain;
uniform float uFrame;
uniform float uAberration;
uniform float uRolloff;
uniform float uFade;
uniform float uAccent;
uniform vec3 uBlackTint;
uniform sampler2D tStreak;
uniform float uStreak;
uniform float uLetterbox;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 color) {
  const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec2 d = vUv - 0.5;
  float aspect = uRes.x / uRes.y;
  float r2 = dot(d * vec2(aspect, 1.0), d * vec2(aspect, 1.0));
  vec2 ca = d * uAberration * r2;
  vec3 c;
  c.r = texture2D(tColor, vUv - ca).r;
  c.g = texture2D(tColor, vUv).g;
  c.b = texture2D(tColor, vUv + ca).b;
  if (uStreak > 0.0) c += texture2D(tStreak, vUv).rgb * uStreak;
  c *= vec3(1.0 + uTemperature * 0.12, 1.0 + uTemperature * 0.015, 1.0 - uTemperature * 0.12);
  // heavier highlight roll-off: compress the top end before the tone curve
  float hl = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= 1.0 / (1.0 + uRolloff * max(hl - 0.35, 0.0));
  c = acesFitted(c);
  c = c * uGain + uLift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / uGamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uShadowTint, uHighlightTint, smoothstep(0.05, 0.7, l));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // selective colour: the cyan of the joints can keep its saturation
  vec3 chroma = c - vec3(l);
  float cyan = smoothstep(0.55, 0.85, dot(chroma / max(length(chroma), 1e-5), vec3(-0.85, 0.3, 0.43))) * smoothstep(0.015, 0.06, length(chroma));
  c = mix(vec3(l), c, max(uSaturation, uAccent * cyan * 1.2));
  c = max(c, 0.0);
  float v = 1.0 - smoothstep(0.3, 1.1, length(d * vec2(1.2, 1.55)));
  c *= mix(1.0, v, uVignette);
  vec3 s = toSRGB(clamp(c, 0.0, 1.0));
  s = clamp((s - 0.5) * uContrast + 0.5, 0.0, 1.0);
  // warm (or cool) blacks: the deepest shadows keep a little colour
  float sl = dot(s, vec3(0.333));
  s += uBlackTint * pow(1.0 - sl, 5.0);
  // faded print: blacks lifted to a warm grey, whites a touch lower
  s = s * (1.0 - 0.13 * uFade) + vec3(0.095, 0.08, 0.065) * uFade;
  float g = hash12(floor(vUv * uRes) + uFrame * 17.31) - 0.5;
  g += hash12(floor(vUv * uRes * 0.5) + uFrame * 3.7) - 0.5;
  float lum = dot(s, vec3(0.333));
  s += g * uGrain * (1.0 - lum * 0.6);
  // letterbox: bars top and bottom when the screen is taller than the aspect
  if (uLetterbox > 0.0) {
    float bar = max(0.0, 0.5 * (1.0 - (uRes.x / uRes.y) / uLetterbox));
    if (vUv.y < bar || vUv.y > 1.0 - bar) s = vec3(0.0);
  }
  gl_FragColor = vec4(s, 1.0);
}
`;

export type Quality = 'high' | 'medium' | 'low';

export class PostPipeline {
  width = 2;
  height = 2;
  quality: Quality = 'high';
  private rtScene: THREE.WebGLRenderTarget;
  private rtHalfA: THREE.WebGLRenderTarget;
  private rtHalfB: THREE.WebGLRenderTarget;
  private rtFull: THREE.WebGLRenderTarget;
  private rtShafts: THREE.WebGLRenderTarget;
  private rtStreakA: THREE.WebGLRenderTarget;
  private rtStreakB: THREE.WebGLRenderTarget;
  private shaftsQ: FullScreenQuad;
  private streakExtract: FullScreenQuad;
  private streakBlur: FullScreenQuad;
  private prefilter: FullScreenQuad;
  private bokeh: FullScreenQuad;
  private composite: FullScreenQuad;
  private grade: FullScreenQuad;
  private bloom: UnrealBloomPass;

  constructor(private renderer: THREE.WebGLRenderer) {
    const half = () =>
      new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.rtScene = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtScene.depthTexture = new THREE.DepthTexture(2, 2);
    this.rtScene.depthTexture.type = THREE.FloatType;
    this.rtHalfA = half();
    this.rtHalfB = half();
    this.rtFull = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtShafts = half();
    this.rtStreakA = half();
    this.rtStreakB = half();
    const depthU = () => ({ uNear: { value: 0.05 }, uFar: { value: 50 }, uCocScale: { value: 0 }, uFocus: { value: 1 }, uMaxCoc: { value: 20 } });
    const q = (fs: string, uniforms: Record<string, THREE.IUniform>) =>
      new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, vertexShader: quadVS, fragmentShader: fs, depthTest: false, depthWrite: false }));
    this.prefilter = q(prefilterFS, { tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, ...depthU() });
    this.bokeh = q(bokehFS, { tHalf: { value: null }, uHalfTexel: { value: new THREE.Vector2() }, uRadScale: { value: 0.9 }, ...depthU() });
    this.composite = q(compositeFS, {
      tColor: { value: null },
      tDepth: { value: null },
      tBlur: { value: null },
      tShafts: { value: null },
      uHalfTexel: { value: new THREE.Vector2() },
      uShaftsOn: { value: 0 },
      uExposure: { value: 1 },
      uDofOn: { value: 1 },
      ...depthU(),
    });
    this.shaftsQ = q(shaftsFS, {
      tDepth: { value: null },
      tShadow: { value: null },
      uHasShadow: { value: 0 },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(1, -1, 0) },
      uColor: { value: new THREE.Color() },
      uStrength: { value: 0 },
      uTime: { value: 0 },
      uSteps: { value: 32 },
      uWin: { value: new THREE.Vector4() },
      uWinSize: { value: new THREE.Vector2() },
      uBars: { value: new THREE.Vector4() },
      uBarHalf: { value: 0.03 },
    });
    this.streakExtract = q(streakExtractFS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.1 } });
    this.streakBlur = q(streakBlurFS, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uTint: { value: new THREE.Vector3(1, 1, 1) } });
    this.grade = q(gradeFS, {
      tColor: { value: null },
      uRes: { value: new THREE.Vector2() },
      uSaturation: { value: 1 },
      uContrast: { value: 1 },
      uLift: { value: new THREE.Vector3() },
      uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
      uHighlightTint: { value: new THREE.Vector3(1, 1, 1) },
      uTemperature: { value: 0 },
      uVignette: { value: 0.5 },
      uGrain: { value: 0.03 },
      uFrame: { value: 0 },
      uAberration: { value: 0.002 },
      uRolloff: { value: 0 },
      uFade: { value: 0 },
      uAccent: { value: 0 },
      uBlackTint: { value: new THREE.Vector3() },
      tStreak: { value: null },
      uStreak: { value: 0 },
      uLetterbox: { value: 0 },
    });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.6, 0.9);
  }

  setQuality(q: Quality) {
    this.quality = q;
    const samples = q === 'low' ? 0 : 4;
    if (this.rtScene.samples !== samples) {
      this.rtScene.samples = samples;
      this.rtScene.dispose();
    }
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.rtScene.setSize(w, h);
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    this.rtHalfA.setSize(hw, hh);
    this.rtHalfB.setSize(hw, hh);
    this.rtFull.setSize(w, h);
    this.rtShafts.setSize(hw, hh);
    // streaks: a quarter across, half down, so they stay thin
    const sw = Math.max(1, Math.floor(w / 4));
    this.rtStreakA.setSize(sw, hh);
    this.rtStreakB.setSize(sw, hh);
    (this.streakExtract.material as THREE.ShaderMaterial).uniforms.uTexel.value.set(1 / w, 1 / h);
    (this.composite.material as THREE.ShaderMaterial).uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
    this.bloom.setSize(w, h);
    (this.prefilter.material as THREE.ShaderMaterial).uniforms.uTexel.value.set(1 / w, 1 / h);
    (this.bokeh.material as THREE.ShaderMaterial).uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
    (this.grade.material as THREE.ShaderMaterial).uniforms.uRes.value.set(w, h);
  }

  /** thin-lens circle of confusion scale, in full-resolution pixels */
  private cocScale(focalMm: number, fstop: number, focus: number) {
    const f = focalMm / 1000;
    const S = Math.max(focus, f * 1.5);
    const c = (f * f) / (fstop * (S - f));
    return (c / SENSOR_W) * this.width;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, p: PostParams) {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);
    const dofOn = p.dof && this.quality !== 'low';
    const U = (q: FullScreenQuad) => (q.material as THREE.ShaderMaterial).uniforms;
    const cocScale = dofOn ? this.cocScale(p.focalLength, p.fstop, p.focus) : 0;
    const maxCoc = Math.min(this.width * 0.02, 36) * (this.quality === 'high' ? 1 : 0.7);
    for (const q of [this.prefilter, this.bokeh, this.composite]) {
      const u = U(q);
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uCocScale.value = cocScale;
      u.uFocus.value = p.focus;
      u.uMaxCoc.value = maxCoc;
    }
    if (dofOn) {
      U(this.prefilter).tColor.value = this.rtScene.texture;
      U(this.prefilter).tDepth.value = this.rtScene.depthTexture;
      r.setRenderTarget(this.rtHalfA);
      this.prefilter.render(r);
      U(this.bokeh).tHalf.value = this.rtHalfA.texture;
      U(this.bokeh).uRadScale.value = this.quality === 'high' ? 0.85 : 1.4;
      r.setRenderTarget(this.rtHalfB);
      this.bokeh.render(r);
    }
    const sh = p.shafts;
    if (sh && sh.strength > 0.001) {
      const su = U(this.shaftsQ);
      su.tDepth.value = this.rtScene.depthTexture;
      su.tShadow.value = sh.shadow?.map ?? null;
      su.uHasShadow.value = sh.shadow ? 1 : 0;
      if (sh.shadow) su.uShadowMatrix.value.copy(sh.shadow.matrix);
      su.uInvProj.value.copy(camera.projectionMatrixInverse);
      su.uCamWorld.value.copy(camera.matrixWorld);
      su.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      su.uSunDir.value.copy(sh.sunDir);
      su.uColor.value.copy(sh.color);
      su.uStrength.value = sh.strength;
      su.uTime.value = sh.time;
      su.uSteps.value = this.quality === 'high' ? 48 : this.quality === 'medium' ? 28 : 14;
      su.uWin.value.set(sh.window.x, sh.window.y, sh.window.z, 0);
      su.uWinSize.value.set(sh.window.w, sh.window.h);
      su.uBars.value.set(sh.bars.vertical[0], sh.bars.vertical[1], sh.bars.horizontal[0], sh.bars.horizontal[1]);
      su.uBarHalf.value = sh.bars.half;
      r.setRenderTarget(this.rtShafts);
      this.shaftsQ.render(r);
    }
    const cu = U(this.composite);
    cu.tShafts.value = this.rtShafts.texture;
    cu.uShaftsOn.value = sh && sh.strength > 0.001 ? 1 : 0;
    cu.tColor.value = this.rtScene.texture;
    cu.tDepth.value = this.rtScene.depthTexture;
    cu.tBlur.value = this.rtHalfB.texture;
    cu.uExposure.value = p.exposure;
    cu.uDofOn.value = dofOn ? 1 : 0;
    r.setRenderTarget(this.rtFull);
    this.composite.render(r);
    if (p.bloomStrength > 0.001) {
      this.bloom.strength = p.bloomStrength;
      this.bloom.radius = p.bloomRadius;
      this.bloom.threshold = p.bloomThreshold;
      this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.rtFull, 0, false);
    }
    if (p.streaks > 0.001) {
      const eu = U(this.streakExtract);
      eu.tColor.value = this.rtFull.texture;
      r.setRenderTarget(this.rtStreakA);
      this.streakExtract.render(r);
      const bu = U(this.streakBlur);
      const tw = 1 / this.rtStreakA.width;
      let src = this.rtStreakA;
      let dst = this.rtStreakB;
      for (const [i, spread] of [1, 4, 14].entries()) {
        bu.tSrc.value = src.texture;
        bu.uStep.value.set(tw * spread, 0);
        // the classic anamorphic blue, applied once
        bu.uTint.value.set(...((i === 2 ? [0.62, 0.84, 1.25] : [1, 1, 1]) as [number, number, number]));
        r.setRenderTarget(dst);
        this.streakBlur.render(r);
        [src, dst] = [dst, src];
      }
      U(this.grade).tStreak.value = src.texture;
    }
    const g = U(this.grade);
    g.uStreak.value = p.streaks;
    g.uRolloff.value = p.rolloff;
    g.uFade.value = p.fade;
    g.uAccent.value = p.accent;
    g.uBlackTint.value.fromArray(p.blackTint);
    g.uLetterbox.value = p.letterbox;
    g.tColor.value = this.rtFull.texture;
    g.uSaturation.value = p.saturation;
    g.uContrast.value = p.contrast;
    g.uLift.value.fromArray(p.lift);
    g.uGamma.value.fromArray(p.gamma);
    g.uGain.value.fromArray(p.gain);
    g.uShadowTint.value.fromArray(p.shadowTint);
    g.uHighlightTint.value.fromArray(p.highlightTint);
    g.uTemperature.value = p.temperature;
    g.uVignette.value = p.vignette;
    g.uGrain.value = p.grain;
    g.uFrame.value = p.frame;
    g.uAberration.value = p.aberration;
    r.setRenderTarget(null);
    this.grade.render(r);
  }
}
