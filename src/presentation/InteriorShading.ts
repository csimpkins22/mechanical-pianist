// Surface detail for the inside of the piano, in GLSL for the patched
// materials of PianoInterior.ts (shaderPatch.ts), and the few small canvas
// textures it needs (the plate's cast lettering, the soundboard's decal).
//
// Everything fine here is filtered by its size on screen: each detail fades to
// its average before it is small enough to alias, so it holds still as the
// camera moves instead of shimmering.
//
// Felt is the hard one. It reads as felt, not as painted plastic, through:
// - fine matted fibres in the albedo and the normals, at the scale of the
//   inside shots;
// - a very matte surface, with almost no specular;
// - light that wanders into the wool and comes back out a little warmer
//   around the terminator (wrapped diffuse), so the shading rolls off softly;
// - a sheen at grazing angles, and a soft, slightly fuzzy rim where fibres
//   catch the light along the silhouette;
// - the crown, where the strings strike, pressed smoother and a little
//   yellowed.
import * as THREE from 'three';

// ---------------------------------------------------------------- shared
/** GLSL: how many metres a pixel covers here, and how much of a detail of wavelength l survives at that footprint */
export const DETAIL_GLSL = /* glsl */ `
float mpFoot() { return max(length(fwidth(vWPos)), 1e-7); }
float mpRes(float l, float f) { return 1.0 - smoothstep(0.3 * l, 1.0 * l, f); }
// a height field h (metres) as a bump on the view-space normal n, from its screen derivatives
vec3 mpBump(vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - g);
}
// dust settles on what faces up: a fine grey film, in drifts, thicker in the corners of the noise
float mpDust(vec3 p, vec3 n, float foot) {
  float up = smoothstep(0.45, 0.95, n.y);
  float drift = smoothstep(0.35, 0.8, mpFbm(p * 90.0));
  float specks = mix(0.5, step(0.8, mpHash(floor(p * 2500.0))), mpRes(0.0004, foot));
  return up * (0.25 + 0.75 * drift) * (0.6 + 0.4 * specks);
}
`;

// ---------------------------------------------------------------- felt
/** GLSL for felt materials: fibres (albedo and bump), wrapped diffuse light */
export const FELT_GLSL = /* glsl */ `
float mpFeltH;      // the fibre bump, metres (set with the albedo, used for the normal)
float mpFeltFibre;  // the finest fibres, 0..1 (for the fuzz along the rim)
float mpFeltSmooth; // 1 where the felt is pressed smooth (the crown's strike line)
// matted wool: fibres about a quarter of a millimetre across, tufts of a millimetre, and clumps
float mpFelt(vec3 p, float foot) {
  float w1 = mpRes(0.0003, foot) * (1.0 - 0.6 * mpFeltSmooth);
  float w2 = mpRes(0.0012, foot) * (1.0 - 0.4 * mpFeltSmooth);
  float w3 = mpRes(0.005, foot);
  float a = mpNoise(p * 3300.0);
  float b = mpNoise(p * 5600.0 + 3.1);
  float c = mpNoise(p * 850.0 + 7.3);
  float d = mpNoise(p * 210.0 + 1.7);
  // stray fibres: a few darker and lighter flecks, finer than the rest
  float w0 = mpRes(0.00018, foot) * (1.0 - 0.7 * mpFeltSmooth);
  float e = mpNoise(p * 9000.0 + 11.0);
  float fleck = smoothstep(0.72, 0.9, e) - smoothstep(0.1, 0.28, e) * 0.6;
  mpFeltFibre = mix(0.5, 0.5 * (a + b), w1);
  mpFeltH = w1 * 0.000022 * (0.55 * a + 0.45 * b) + w2 * 0.000036 * c;
  return 1.0 + w0 * 0.05 * fleck + w1 * 0.1 * (a + b - 1.0) + w2 * 0.065 * (2.0 * c - 1.0) + w3 * 0.045 * (2.0 * d - 1.0);
}
// light that wanders into the wool: diffuse wrapped a little past the terminator, coming back warmer there
vec3 mpFeltWrap(float nl) {
  const float W = 0.45;
  float w = clamp((nl + W) / (1.0 + W), 0.0, 1.0);
  float s = clamp(1.0 - abs(nl - 0.05) * 2.2, 0.0, 1.0);
  return w * mix(vec3(1.0), vec3(1.0, 0.82, 0.64), 0.55 * s);
}
`;

/** after normal_fragment_maps: the fibres in the normal, fading out toward the silhouette (where a bump only makes sparks) */
export const FELT_NORMAL = /* glsl */ `
{
  vec3 mpN0 = normal;
  float mpNV0 = abs(dot(mpN0, normalize(vViewPosition)));
  normal = normalize(mix(mpN0, mpBump(mpN0, mpFeltH, faceDirection), smoothstep(0.1, 0.5, mpNV0)));
}`;

/** before opaque_fragment: fibres catching the light along the silhouette */
export const FELT_FUZZ = /* glsl */ `
{
  float mpNV = clamp(dot(normalize(nonPerturbedNormal), normalize(vViewPosition)), 0.0, 1.0);
  float mpRim = pow(1.0 - mpNV, 3.0);
  outgoingLight += min(totalDiffuse, vec3(1.5)) * mpRim * (0.5 + mpFeltFibre) * 0.25;
}`;

/**
 * Turn a patched MeshPhysicalMaterial into felt: wrapped diffuse light (its
 * direct lights reach a little past the terminator), sheen that varies with
 * the fibres, and the fuzzy rim. Call after patch(); chains its onBeforeCompile.
 */
export function feltify<T extends THREE.MeshPhysicalMaterial>(mat: T): T {
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    inner.call(mat, shader, renderer);
    // only the diffuse light wraps: the specular and sheen lobes keep the true
    // cosine, or past the terminator they blow up into sparks at grazing angles
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment
      .replace(
        'vec3 irradiance = dotNL * directLight.color;',
        'vec3 irradiance = dotNL * directLight.color;\n\tvec3 mpWrapIrr = mpFeltWrap( dot( geometryNormal, directLight.direction ) ) * directLight.color;',
      )
      .replace('irradiance *= sheenEnergyComp;', 'irradiance *= sheenEnergyComp;\n\t\tmpWrapIrr *= sheenEnergyComp;')
      .replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
        'reflectedLight.directDiffuse += mpWrapIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
      );
    if (!chunk.includes('mpWrapIrr * BRDF_Lambert') || !chunk.includes('mpWrapIrr *= sheenEnergyComp')) throw new Error('felt: three.js lighting chunk changed');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', chunk)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.sheenColor *= (0.6 + 0.8 * mpFeltFibre) * smoothstep(0.02, 0.3, abs(dot(normal, normalize(vViewPosition))));')
      .replace('#include <opaque_fragment>', `${FELT_FUZZ}\n#include <opaque_fragment>`);
  };
  return mat;
}

// ---------------------------------------------------------------- hammer heads
/**
 * The hammers' numbers: the ten digits in a plain, slightly heavy face, as a
 * rubber stamp would print them, drawn once into a strip (digit d in the d-th
 * tenth), softened a little as ink on wool is.
 */
export function digitsTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const W = 64;
  const H = 96;
  const c = document.createElement('canvas');
  c.width = W * 10;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W * 10, H);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.filter = 'blur(1.2px)';
  g.font = `600 ${Math.round(H * 0.86)}px "Courier New", Courier, "Nimbus Mono PS", monospace`;
  for (let d = 0; d < 10; d++) g.fillText(String(d), W * (d + 0.5), H * 0.54);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** GLSL: the head's number stamped in ink, and the underfelt's U on the sides */
export const HAMMER_GLSL = /* glsl */ `
flat varying float vHammer;
varying vec3 vONormal;
// how much ink: the number n stamped centred on q (metres; reading along +x, its digits h high, up along +y),
// as a rubber stamp leaves it on felt: the ink uneven, a little smudged, missing here and there
float mpStamp(vec2 q, float n, float h, float foot) {
  float tens = floor(n / 10.0);
  float ones = n - 10.0 * tens;
  float nd = tens > 0.0 ? 2.0 : 1.0;
  float w = 0.62 * h;              // a digit's advance
  vec2 c = vec2(q.x / w + 0.5 * nd, q.y / h + 0.5);
  if (c.x < -0.2 || c.x > nd + 0.2 || c.y < -0.2 || c.y > 1.2) return 0.0;
  float k = clamp(floor(c.x), 0.0, nd - 1.0);
  float d = nd > 1.5 && k < 0.5 ? tens : ones;
  // the stamp was pressed a little crooked, each one its own way
  vec2 u = vec2(c.x - k, c.y);
  float j = mpHash(vec3(n, 2.0, 9.0)) - 0.5;
  u = vec2(0.5, 0.5) + mat2(1.0, j * 0.12, -j * 0.12, 1.0) * (u - 0.5);
  float ink = texture2D(uDigits, vec2((d + clamp(u.x, 0.0, 1.0)) / 10.0, clamp(u.y, 0.0, 1.0))).r;
  ink *= step(0.0, u.x) * step(u.x, 1.0) * step(0.0, u.y) * step(u.y, 1.0);
  // uneven ink: lighter where the stamp met the fibres less, a few gaps
  float pres = 0.55 + 0.45 * smoothstep(0.2, 0.75, mpNoise(vec3(q * 2600.0, n)));
  float gaps = mix(1.0, smoothstep(0.15, 0.45, mpNoise(vec3(q * 9000.0, n + 3.0))), mpRes(0.0004, foot));
  // a stamp too small to read is a faint smudge
  float box = smoothstep(-0.2, 0.1, c.x) * (1.0 - smoothstep(nd - 0.1, nd + 0.2, c.x)) * smoothstep(-0.2, 0.1, c.y) * (1.0 - smoothstep(0.9, 1.2, c.y));
  return mix(0.25 * box, ink * pres * gaps, mpRes(h * 0.5, foot));
}
// the underfelt's U on a side of the head (y, z about its centre): the distance to its line, and whether inside it
vec2 mpU(float y, float z, vec4 u) {
  float t = y / u.z;
  if (abs(t) >= 1.0) return vec2(length(vec2(abs(y) - u.z, max(0.0, z - u.x))), 0.0);
  float s = max(1.0 - t * t, 1e-4);
  float g = pow(s, 0.42);
  float F = (u.x - z) / u.y - g;
  float dg = 0.42 * pow(s, -0.58) * (-2.0 * y / (u.z * u.z));
  return vec2(abs(F) / length(vec2(dg, 1.0 / u.y)), F < 0.0 ? 1.0 : 0.0);
}
`;

// ---------------------------------------------------------------- gold paint
/** GLSL: the plate's gold paint, metal flakes in lacquer over sand-cast iron */
export const GOLD_GLSL = /* glsl */ `
float mpFlakeFade;
// a flake's tilt: each cell of a 0.3 mm grid holds one flake, turned its own way
vec3 mpFlake(vec3 p) {
  vec3 c = floor(p / 0.0003);
  return vec3(mpHash(c), mpHash(c + 17.1), mpHash(c + 43.7)) * 2.0 - 1.0;
}
`;

/** after roughnessmap: sharp flakes up close, a smooth satin where they are too small to see */
export const GOLD_ROUGH = /* glsl */ `
{
  float mpF = mpFoot();
  mpFlakeFade = mpRes(0.0006, mpF);
  roughnessFactor = mix(0.42, 0.32, mpFlakeFade) + (mpFbm(vWPos * 220.0) - 0.5) * 0.1;
}`;

/** after normal_fragment_maps: the flakes and the casting's pebbling in the base layer's normal (the clear coat stays smooth) */
export const GOLD_NORMAL = /* glsl */ `
{
  float mpF = mpFoot();
  float mpCast = mpRes(0.0015, mpF) * 0.00004 * mpFbm(vWPos * 700.0) + mpRes(0.004, mpF) * 0.00006 * mpNoise(vWPos * 230.0);
  normal = mpBump(normal, mpCast, faceDirection);
  vec3 mpT = mat3(viewMatrix) * mpFlake(vWPos);
  normal = normalize(normal + mpT * 0.11 * mpFlakeFade);
}`;

// ---------------------------------------------------------------- wood
/**
 * GLSL: wood grain for the action's parts, which are coloured by vertex: the
 * grain runs along each instanced part (object y) and along the static rails
 * (world x); felt strips and cloth (strongly red or green, or near-white)
 * get felt fibres instead, and metal none.
 */
export const WOOD_GLSL = /* glsl */ `
float mpWoodness(vec3 c) {
  float r = max(c.r, 1e-3);
  float gr = c.g / r;
  float br = c.b / r;
  return smoothstep(0.25, 0.4, gr) * (1.0 - smoothstep(0.92, 1.0, gr)) * (1.0 - smoothstep(0.68, 0.8, br)) * smoothstep(0.08, 0.16, r);
}
float mpClothness(vec3 c) {
  float r = max(c.r, 1e-3);
  float red = 1.0 - smoothstep(0.22, 0.32, c.g / r);
  float green = smoothstep(1.2, 1.4, c.g / r);
  float white = smoothstep(0.76, 0.84, dot(c, vec3(0.33))) * (1.0 - smoothstep(0.06, 0.12, max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))));
  return max(max(red, green), white) * smoothstep(0.05, 0.12, r + c.g);
}
// steel among the wood: neutral grey, neither dark iron paint nor white cloth
float mpMetalness(vec3 c) {
  float l = dot(c, vec3(0.33));
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return (1.0 - smoothstep(0.03, 0.06, chroma)) * smoothstep(0.35, 0.45, l) * (1.0 - smoothstep(0.72, 0.8, l));
}
// fine straight grain (maple, beech): growth lines across the part, wandering a little, with ray flecks
float mpGrain(vec3 p, float foot) {
  #ifdef USE_INSTANCING
  vec3 q = p.yxz;   // along the part
  #else
  vec3 q = p;       // along the rail
  #endif
  float wander = mpFbm(vec3(q.x * 25.0, q.y * 300.0, q.z * 300.0)) * 6.0;
  float lines = 0.5 + 0.5 * sin((q.y * 0.8 + q.z * 0.6) * 5200.0 + wander);
  float w = mpRes(0.0012, foot);
  float fleck = step(0.93, mpNoise(vec3(q.x * 900.0, q.y * 2600.0, q.z * 2600.0))) * mpRes(0.0008, foot);
  return 1.0 + w * (0.07 * (mpFbm(vec3(q.x * 6.0, q.y * 140.0, q.z * 140.0)) - 0.5) * 2.0 - 0.09 * smoothstep(0.55, 1.0, lines)) - 0.06 * fleck;
}
`;

// ---------------------------------------------------------------- canvas textures
/** The plate's cast lettering as a height field across its top: R the raised letters, G a wider blur of them (for the shadow they cast). */
export const LETTERING = { x0: -0.62, x1: 0.62, y0: 0.4805, y1: 0.5045 };

export function letteringTexture(maker: string): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const W = 4096;
  const H = Math.round((W * (LETTERING.y1 - LETTERING.y0)) / (LETTERING.x1 - LETTERING.x0));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const atX = (x: number) => ((x - LETTERING.x0) / (LETTERING.x1 - LETTERING.x0)) * W;
  const draw = (color: string, blur: number) => {
    g.filter = `blur(${blur}px)`;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(H * 0.66)}px "Cormorant Garamond", Georgia, "Times New Roman", serif`;
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(H * 0.12)}px`;
    g.fillText(maker.toUpperCase(), atX(0), H * 0.54);
    g.font = `700 ${Math.round(H * 0.36)}px Georgia, "Times New Roman", serif`;
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(H * 0.08)}px`;
    g.fillText('OVERSTRUNG', atX(-0.4), H * 0.54);
    g.fillText('FULL IRON FRAME', atX(0.4), H * 0.54);
    // a cast rib under the name
    g.fillRect(atX(-0.16), H * 0.9, atX(0.16) - atX(-0.16), H * 0.05);
  };
  g.globalCompositeOperation = 'lighter';
  draw('#ff0000', 1.4);
  draw('#00ff00', 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** GLSL: the cast letters on the plate's front face, raised a millimetre */
export const LETTERING_NORMAL = /* glsl */ `
if (vWNormal.z > 0.9 && vWPos.y > ${LETTERING.y0.toFixed(4)} && vWPos.y < ${LETTERING.y1.toFixed(4)}) {
  vec2 mpUV = vec2((vWPos.x - ${LETTERING.x0.toFixed(4)}) / ${(LETTERING.x1 - LETTERING.x0).toFixed(4)}, (vWPos.y - ${LETTERING.y0.toFixed(4)}) / ${(LETTERING.y1 - LETTERING.y0).toFixed(4)});
  vec2 mpE = vec2(1.0 / 4096.0, 1.0 / 80.0);
  float mpHx = texture2D(uLetters, mpUV + vec2(mpE.x, 0.0)).r - texture2D(uLetters, mpUV - vec2(mpE.x, 0.0)).r;
  float mpHy = texture2D(uLetters, mpUV + vec2(0.0, mpE.y)).r - texture2D(uLetters, mpUV - vec2(0.0, mpE.y)).r;
  // height 0.9 mm; the gradient in metres
  vec2 mpG = vec2(mpHx / (2.0 * mpE.x * ${(LETTERING.x1 - LETTERING.x0).toFixed(4)}), mpHy / (2.0 * mpE.y * ${(LETTERING.y1 - LETTERING.y0).toFixed(4)})) * 0.0009;
  normal = normalize(normal - mat3(viewMatrix) * vec3(mpG, 0.0));
}`;

/** GLSL: the letters' faces a little brighter (rubbed), the iron around them in their shadow */
export const LETTERING_MAP = /* glsl */ `
if (vWNormal.z > 0.9 && vWPos.y > ${LETTERING.y0.toFixed(4)} && vWPos.y < ${LETTERING.y1.toFixed(4)}) {
  vec2 mpUV = vec2((vWPos.x - ${LETTERING.x0.toFixed(4)}) / ${(LETTERING.x1 - LETTERING.x0).toFixed(4)}, (vWPos.y - ${LETTERING.y0.toFixed(4)}) / ${(LETTERING.y1 - LETTERING.y0).toFixed(4)});
  vec4 mpL = texture2D(uLetters, mpUV);
  // the letters' faces rubbed bright, the iron in the angle around them darker with old grime
  diffuseColor.rgb *= (1.0 - 0.5 * clamp(mpL.g - mpL.r, 0.0, 1.0)) * (1.0 + 0.35 * mpL.r) * (1.0 - 0.18 * (1.0 - mpL.g));
}`;

/** The soundboard's decal: a fictional maker's gold transfer, in the alpha of a small texture. */
export const DECAL = { x0: 0.19, x1: 0.31, y0: 0.3605, y1: 0.3955 };

export function decalTexture(maker: string): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const W = 1024;
  const H = Math.round((W * (DECAL.y1 - DECAL.y0)) / (DECAL.x1 - DECAL.x0));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  // a double rule with rounded ends, the name in italic between, a line of small capitals below
  g.lineWidth = H * 0.025;
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.stroke();
  };
  rr(W * 0.02, H * 0.06, W * 0.96, H * 0.88, H * 0.44);
  g.lineWidth = H * 0.01;
  rr(W * 0.035, H * 0.11, W * 0.93, H * 0.78, H * 0.39);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `italic 600 ${Math.round(H * 0.42)}px "Cormorant Garamond", Georgia, "Times New Roman", serif`;
  g.fillText(maker, W / 2, H * 0.43);
  g.font = `600 ${Math.round(H * 0.12)}px Georgia, "Times New Roman", serif`;
  (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(H * 0.03)}px`;
  g.fillText('CONCERT UPRIGHT  ·  ESTABLISHED 1887', W / 2, H * 0.72);
  // flourishes either side of the name
  for (const s of [-1, 1]) {
    g.beginPath();
    g.lineWidth = H * 0.018;
    const x = W / 2 + s * W * 0.33;
    g.moveTo(x, H * 0.45);
    g.bezierCurveTo(x + s * W * 0.04, H * 0.2, x + s * W * 0.09, H * 0.7, x + s * W * 0.12, H * 0.45);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** GLSL (after the albedo): the decal's gold leaf, worn and cracked with age */
export const DECAL_MAP = /* glsl */ `
float mpDecal = 0.0;
if (vWPos.x > ${DECAL.x0.toFixed(4)} && vWPos.x < ${DECAL.x1.toFixed(4)} && vWPos.y > ${DECAL.y0.toFixed(4)} && vWPos.y < ${DECAL.y1.toFixed(4)}) {
  vec2 mpUV = vec2((vWPos.x - ${DECAL.x0.toFixed(4)}) / ${(DECAL.x1 - DECAL.x0).toFixed(4)}, (vWPos.y - ${DECAL.y0.toFixed(4)}) / ${(DECAL.y1 - DECAL.y0).toFixed(4)});
  mpDecal = texture2D(uDecal, mpUV).a * (0.72 + 0.28 * smoothstep(0.25, 0.6, mpFbm(vWPos * 900.0)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.76, 0.4), mpDecal);
}`;
