// Post-processing: HDR scene (MSAA, depth) -> physical thin-lens depth of
// field (bokeh gather at half resolution) -> bloom -> filmic grade (ACES,
// lift/gamma/gain, split toning, vignette, gentle chromatic aberration,
// frame-seeded grain). Every parameter arrives per frame in `PostParams`.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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

const compositeFS = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
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
  c *= vec3(1.0 + uTemperature * 0.12, 1.0 + uTemperature * 0.015, 1.0 - uTemperature * 0.12);
  c = acesFitted(c);
  c = c * uGain + uLift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / uGamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uShadowTint, uHighlightTint, smoothstep(0.05, 0.7, l));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = max(c, 0.0);
  float v = 1.0 - smoothstep(0.3, 1.1, length(d * vec2(1.2, 1.55)));
  c *= mix(1.0, v, uVignette);
  vec3 s = toSRGB(clamp(c, 0.0, 1.0));
  s = clamp((s - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float g = hash12(floor(vUv * uRes) + uFrame * 17.31) - 0.5;
  g += hash12(floor(vUv * uRes * 0.5) + uFrame * 3.7) - 0.5;
  float lum = dot(s, vec3(0.333));
  s += g * uGrain * (1.0 - lum * 0.6);
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
    const depthU = () => ({ uNear: { value: 0.05 }, uFar: { value: 50 }, uCocScale: { value: 0 }, uFocus: { value: 1 }, uMaxCoc: { value: 20 } });
    const q = (fs: string, uniforms: Record<string, THREE.IUniform>) =>
      new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, vertexShader: quadVS, fragmentShader: fs, depthTest: false, depthWrite: false }));
    this.prefilter = q(prefilterFS, { tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, ...depthU() });
    this.bokeh = q(bokehFS, { tHalf: { value: null }, uHalfTexel: { value: new THREE.Vector2() }, uRadScale: { value: 0.9 }, ...depthU() });
    this.composite = q(compositeFS, { tColor: { value: null }, tDepth: { value: null }, tBlur: { value: null }, uExposure: { value: 1 }, uDofOn: { value: 1 }, ...depthU() });
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
    const cu = U(this.composite);
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
    const g = U(this.grade);
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
