// The drum kit's materials, extending three's physical materials through the
// same shader patch as the piano's (shaderPatch.ts), with all fine detail
// filtered by its size on screen (InteriorShading's DETAIL_GLSL), so nothing
// shimmers as the camera drifts.
//
// - Shells: a deep blue sparkle lacquer. Metal flakes (a third of a
//   millimetre) in a tinted base, each tilted its own way, under a thick
//   clear coat; up close single flakes catch the light, further off it is a
//   metallic satin. The coat carries fingerprints and smudges where hands go.
// - Heads: a white sprayed coating over Mylar, a little yellowed; where the
//   sticks land the coating is worn greyer and smoother, with stick-tip marks.
//   A head that has just been struck smears its highlight for a moment (the
//   camera sees the vibration only as an exposure blur).
// - Cymbals: cast bronze, lathed: fine circular grooves whose highlights fan
//   out radially (anisotropic, rough across the grooves, smooth along them),
//   hammer marks on the bow, a faint stamped logo, a little patina, and stick
//   marks and fingerprints at the edge.
// - Chrome with fine scratches and handling marks; felt (wrapped light, sheen
//   and fuzz, from InteriorShading); rubber; nylon sleeves; a woven rug.
import * as THREE from 'three';
import { DETAIL_GLSL, FELT_GLSL, FELT_NORMAL, feltify } from './InteriorShading';
import { patch } from './shaderPatch';

/** the kit's invented makers (never real brands) */
export const MAKERS = { drums: 'Corbel & Wren', heads: 'Aldane', cymbals: 'Marrowby' };

// ---------------------------------------------------------------- the logo atlas
/** regions of the atlas (u0, v0, u1, v1) */
export const ATLAS = {
  head: [0, 0.75, 0.5, 1] as const, // the batter heads' printed logo
  kick: [0.5, 0.5, 1, 1] as const, // the front head's emblem
  crash: [0, 0.5, 0.5, 0.625] as const,
  ride: [0, 0.625, 0.5, 0.75] as const,
  hats: [0, 0.375, 0.5, 0.5] as const,
  badge: [0.5, 0.25, 0.75, 0.5] as const, // the shells' maker's badge
  patch: [0.75, 0.25, 1, 0.5] as const, // the kick's beater patch
  pedal: [0, 0.25, 0.5, 0.375] as const, // the footboards' cast lettering
};

/**
 * One canvas for every printed or stamped mark: white on black in R (ink),
 * G a second ink (the emblem's gold), drawn once. Text in an ordinary serif
 * and sans; everything invented.
 */
export function logoAtlas(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const S = 2048;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const box = (r: readonly [number, number, number, number]) => ({ x: r[0] * S, y: (1 - r[3]) * S, w: (r[2] - r[0]) * S, h: (r[3] - r[1]) * S });
  const sp = (px: number) => ((g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // the batter heads: maker in a heavy italic, the head's name in small capitals, between two rules
  {
    const b = box(ATLAS.head);
    g.fillStyle = '#f00';
    g.font = `italic 800 ${b.h * 0.34}px Georgia, "Times New Roman", serif`;
    sp(4);
    g.fillText(MAKERS.heads, b.x + b.w / 2, b.y + b.h * 0.38);
    // (kept between the rules: a wider line ran out of its region into the kick's emblem)
    g.font = `600 ${b.h * 0.085}px Helvetica, Arial, sans-serif`;
    sp(b.h * 0.018);
    g.fillText('COATED  ·  MEDIUM  ·  MADE BY HAND', b.x + b.w / 2, b.y + b.h * 0.72, b.w * 0.74);
    g.fillRect(b.x + b.w * 0.12, b.y + b.h * 0.61, b.w * 0.76, b.h * 0.012);
    g.fillRect(b.x + b.w * 0.12, b.y + b.h * 0.83, b.w * 0.76, b.h * 0.012);
  }
  // the kick's front head: a gold double ring, the maker's name in white, "drum makers", the year
  {
    const b = box(ATLAS.kick);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const R = b.w * 0.46;
    g.strokeStyle = '#0f0';
    g.lineWidth = R * 0.035;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = R * 0.012;
    g.beginPath();
    g.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#f00';
    g.font = `italic 700 ${R * 0.36}px Georgia, "Times New Roman", serif`;
    sp(2);
    g.fillText('Corbel', cx, cy - R * 0.2);
    g.font = `italic 700 ${R * 0.2}px Georgia, "Times New Roman", serif`;
    g.fillText('&', cx, cy + R * 0.05);
    g.font = `italic 700 ${R * 0.36}px Georgia, "Times New Roman", serif`;
    g.fillText('Wren', cx, cy + R * 0.3);
    g.fillStyle = '#0f0';
    g.font = `600 ${R * 0.085}px Helvetica, Arial, sans-serif`;
    sp(R * 0.04);
    g.fillText('DRUM MAKERS', cx, cy - R * 0.58);
    g.fillText('EST. 1931', cx, cy + R * 0.62);
  }
  // the cymbals' stamps: the maker and the model, as a single line of ink
  for (const [k, model] of [
    ['crash', '18" THIN CRASH'],
    ['ride', '21" MEDIUM RIDE'],
    ['hats', '14" HI-HATS'],
  ] as const) {
    const b = box(ATLAS[k]);
    g.fillStyle = '#f00';
    g.font = `700 ${b.h * 0.42}px Georgia, "Times New Roman", serif`;
    sp(b.h * 0.08);
    g.fillText(MAKERS.cymbals.toUpperCase(), b.x + b.w / 2, b.y + b.h * 0.36, b.w * 0.9);
    g.font = `600 ${b.h * 0.2}px Helvetica, Arial, sans-serif`;
    sp(b.h * 0.05);
    g.fillText(`${model}  ·  B20`, b.x + b.w / 2, b.y + b.h * 0.78, b.w * 0.9);
  }
  // the shells' badge: an oval plate with the maker's name and a serial
  {
    const b = box(ATLAS.badge);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    g.fillStyle = '#0f0';
    g.beginPath();
    g.ellipse(cx, cy, b.w * 0.47, b.h * 0.47, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse(cx, cy, b.w * 0.42, b.h * 0.42, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f00';
    g.font = `italic 700 ${b.h * 0.17}px Georgia, serif`;
    sp(1);
    g.fillText('Corbel', cx, cy - b.h * 0.14, b.w * 0.7);
    g.fillText('& Wren', cx, cy + b.h * 0.04, b.w * 0.7);
    g.font = `600 ${b.h * 0.06}px Helvetica, Arial, sans-serif`;
    sp(3);
    g.fillText('No. 30417  ·  MAPLE', cx, cy + b.h * 0.22, b.w * 0.6);
  }
  // the beater patch: a black disc with a thin ring and the head maker's mark
  {
    const b = box(ATLAS.patch);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    g.fillStyle = '#0f0';
    g.beginPath();
    g.arc(cx, cy, b.w * 0.47, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f00';
    g.font = `italic 800 ${b.h * 0.13}px Georgia, serif`;
    g.fillText(MAKERS.heads, cx, cy - b.h * 0.18);
    g.lineWidth = 4;
    g.strokeStyle = '#f00';
    g.beginPath();
    g.arc(cx, cy, b.w * 0.42, 0, Math.PI * 2);
    g.stroke();
  }
  // the footboards: the maker's name cast in
  {
    const b = box(ATLAS.pedal);
    g.fillStyle = '#f00';
    g.font = `italic 800 ${b.h * 0.5}px Georgia, serif`;
    sp(6);
    g.fillText('Corbel & Wren', b.x + b.w / 2, b.y + b.h * 0.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

/** GLSL: sample a region of the atlas at uv (0..1 inside it); 0 outside */
const ATLAS_GLSL = /* glsl */ `
vec4 mpAtlas(vec4 rect, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uAtlas, mix(rect.xy, rect.zw, uv));
}
`;
const rect = (r: readonly [number, number, number, number]) => new THREE.Vector4(r[0], r[1], r[2], r[3]);

// ---------------------------------------------------------------- handling marks (shared)
/** GLSL: fingerprints and smudges, in the coat's (or the chrome's) roughness only */
const PRINTS_GLSL = /* glsl */ `
float mpPrint(vec2 q, vec2 c, float ang) {
  vec2 d = q - c;
  float ca = cos(ang), sa = sin(ang);
  d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) / vec2(0.0072, 0.0094);
  float r = length(d);
  float f = r * 19.0 + mpNoise(vec3(q * 700.0, 1.0)) * 1.4;
  float ridge = 0.5 + 0.5 * sin(f * 6.2831853);
  ridge = mix(ridge, 0.5, smoothstep(0.3, 0.6, fwidth(f)));
  float mask = (1.0 - smoothstep(0.6, 1.0, r)) * smoothstep(0.3, 0.62, mpFbm(vec3(q * 180.0, 3.0)));
  return r > 1.0 ? 0.0 : mask * (0.3 + 0.7 * ridge);
}
// prints scattered over a surface (2D coordinates in metres), about one per cell that has one
float mpPrints(vec2 q, float cellSize, float chance, float seed) {
  vec2 cell = floor(q / cellSize);
  float h = mpHash(vec3(cell, seed));
  if (h < 1.0 - chance) return 0.0;
  vec2 c = (cell + 0.2 + 0.6 * vec2(mpHash(vec3(cell, seed + 1.0)), mpHash(vec3(cell, seed + 2.0)))) * cellSize;
  return mpPrint(q, c, mpHash(vec3(cell, seed + 3.0)) * 3.14159);
}
`;

// ---------------------------------------------------------------- shells
const FLAKE_GLSL = /* glsl */ `
float mpFlakeOn;
float mpFlakeFade;
vec3 mpFlakeTilt;
// one flake per 0.55 mm cell (a coarse glass-glitter sparkle), most cells hold one, each tilted its own way
void mpFlakes(vec3 p, float foot) {
  vec3 c = floor(p / 0.00055);
  float h = mpHash(c + 0.37);
  mpFlakeFade = mpRes(0.0011, foot);
  mpFlakeOn = step(0.38, h);
  mpFlakeTilt = vec3(mpHash(c + 17.1), mpHash(c + 43.7), mpHash(c + 71.3)) * 2.0 - 1.0;
}
`;

function shellMaterial(): THREE.MeshPhysicalMaterial {
  const m = patch(new THREE.MeshPhysicalMaterial({ color: 0x0a1a3c, metalness: 0.45, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.5 }), {
    fragHead: DETAIL_GLSL + FLAKE_GLSL + PRINTS_GLSL,
    afterMap: /* glsl */ `
    {
      float mpF = mpFoot();
      mpFlakes(vOPos, mpF);
      // navy pigment in the lacquer; the flakes silver, a little blue, some brighter than others
      vec3 base = vec3(0.008, 0.024, 0.11);
      vec3 flake = vec3(0.55, 0.66, 0.92) * (0.7 + 0.6 * mpHash(floor(vOPos / 0.00055) + 5.3));
      // far off, the flakes and the pigment average to a blue metallic
      vec3 avg = vec3(0.1, 0.16, 0.38);
      diffuseColor.rgb = mix(avg, mix(base, flake, mpFlakeOn), mpFlakeFade);
      // the finish is never perfectly even: a slow cloud in the density of the flakes
      diffuseColor.rgb *= 0.9 + 0.2 * mpFbm(vOPos * 18.0);
    }`,
    afterMetal: /* glsl */ `metalnessFactor = mix(0.58, mix(0.05, 1.0, mpFlakeOn), mpFlakeFade);`,
    afterRough: /* glsl */ `roughnessFactor = mix(0.46, mix(0.5, 0.16, mpFlakeOn), mpFlakeFade);`,
    afterNormal: /* glsl */ `normal = normalize(normal + mat3(viewMatrix) * mpFlakeTilt * 0.32 * mpFlakeOn * mpFlakeFade);`,
  });
  // the clear coat: thick and glossy, with a hint of orange peel, smudges and the odd fingerprint where hands go
  const inner = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    inner.call(m, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
      {
        float mpHand = mpPrints(vec2(atan(vOPos.x, vOPos.z) * 0.18, vOPos.y), 0.06, 0.22, 4.0);
        float mpSmudge = smoothstep(0.62, 0.85, mpFbm(vOPos * 20.0));
        material.clearcoatRoughness = clamp(material.clearcoatRoughness + 0.1 * mpHand + 0.05 * mpSmudge + (mpFbm(vOPos * 60.0) - 0.5) * 0.02, 0.02, 0.4);
      }
      #endif`,
    );
  };
  return m;
}

// ---------------------------------------------------------------- heads
/**
 * Coated heads: aDrum (0..4: kick, snare, tom1, tom2, floor tom; 5 = a
 * resonant head) picks each head's shimmer and wear; the playing area is
 * about where the sticks land (a little toward the drummer, +z in the head's
 * own frame), and every head's own radius comes in aRadius.
 */
function headMaterial(atlas: THREE.Texture, shimmer: { value: number[] }): THREE.MeshPhysicalMaterial {
  const m = patch(new THREE.MeshPhysicalMaterial({ color: 0xd8d2c2, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xfff4e0), side: THREE.DoubleSide }), {
    uniforms: { uAtlas: { value: atlas }, uRectHead: { value: rect(ATLAS.head) }, uRectPatch: { value: rect(ATLAS.patch) } },
    vertexHead: /* glsl */ `attribute vec2 aHead; varying vec2 vHead;`,
    vertexEnd: /* glsl */ `vHead = aHead;`,
    fragHead:
      DETAIL_GLSL +
      ATLAS_GLSL +
      /* glsl */ `
      varying vec2 vHead;
      uniform float uShimmer[6];
      float mpWorn;
      float mpShim;
      float mpInk;`,
    afterMap: /* glsl */ `
    {
      float mpF = mpFoot();
      int id = int(vHead.x + 0.5);
      float R = vHead.y;
      vec2 q = vOPos.xz;              // in the head's plane; +z toward the drummer
      float r = length(q) / R;
      // the sprayed coating: fine granules, and a slow unevenness
      float gran = mix(0.5, mpNoise(vOPos * 9000.0), mpRes(0.00025, mpF)) * 0.6 + mix(0.5, mpNoise(vOPos * 2200.0), mpRes(0.001, mpF)) * 0.4;
      vec3 coat = vec3(0.80, 0.775, 0.72) * (0.93 + 0.12 * gran) * (0.96 + 0.08 * mpFbm(vOPos * 30.0));
      // where the sticks land: the coating worn greyer and smoother, with stick-tip marks
      vec2 c = vec2(0.0, 0.16 * R);
      float d = length((q - c) / vec2(0.36 * R, 0.3 * R));
      float zone = (id == 1 || id == 2 || id == 3 || id == 4) ? 1.0 - smoothstep(0.35, 1.1, d + 0.25 * (mpFbm(vOPos * 25.0) - 0.5)) : 0.0;
      if (id == 1) zone *= 1.25;
      // stick-tip marks: scattered anywhere in their cells (two layers, offset), of any size and strength
      float dots = 0.0;
      for (int k = 0; k < 2; k++) {
        vec2 o = vec2(float(k) * 0.0031, float(k) * 0.0047);
        vec2 cell = floor((q + o) / 0.0062);
        float h = mpHash(vec3(cell, 9.0 + float(k)));
        vec2 dc = (cell + vec2(mpHash(vec3(cell, 10.0 + float(k))), mpHash(vec3(cell, 11.0 + float(k))))) * 0.0062 - o;
        float dotR = 0.0005 + 0.0016 * mpHash(vec3(cell, 12.0 + float(k))) * mpHash(vec3(cell, 13.0));
        float d = length((q - dc) * vec2(1.0, 0.7 + 0.6 * mpHash(vec3(cell, 14.0))));
        float there = step(1.0 - 0.38 * zone * zone, h);
        dots = max(dots, (1.0 - smoothstep(dotR * 0.3, dotR, d)) * there * (0.35 + 0.65 * mpHash(vec3(cell, 15.0))));
      }
      dots = mix(0.06 * zone, dots, mpRes(0.004, mpF));
      // the coating wears unevenly: patches where it is thin, the rest only dulled
      float mottle = smoothstep(0.4, 0.78, mpFbm(vOPos * 70.0 + 3.0)) * 0.8 + 0.2 * mpNoise(vOPos * 400.0);
      mpWorn = clamp(zone * (0.3 + 0.7 * mottle), 0.0, 1.0);
      coat = mix(coat, coat * vec3(0.9, 0.89, 0.87), 0.6 * mpWorn);
      coat *= 1.0 - 0.32 * dots;
      // the printed logo near the far edge, readable from the stool
      mpInk = 0.0;
      if (id >= 1) {
        // readable from the stool: right is +x, up is away from the drummer (-z); a resonant head's from below
        float fx = id == 5 ? -1.0 : 1.0;
        vec2 lq = vec2(fx * q.x / (0.56 * R) + 0.5, (-q.y - 0.72 * R) / (0.28 * R) + 0.5);
        mpInk = mpAtlas(uRectHead, lq).r * (id == 5 ? 0.6 : 0.85);
      }
      // the kick's beater patch, a black disc where the beater lands
      if (id == 0) {
        vec2 pq = (q - vec2(0.0, 0.0)) / (0.09) + 0.5;
        vec4 pa = mpAtlas(uRectPatch, vec2(pq.x, 1.0 - pq.y));
        coat = mix(coat, vec3(0.025), pa.g);
        coat = mix(coat, vec3(0.5, 0.48, 0.45), pa.r * pa.g * 0.6);
      }
      coat = mix(coat, vec3(0.03, 0.03, 0.035), mpInk);
      // a resonant head: the same coating, unplayed
      diffuseColor.rgb = coat;
      mpShim = id < 6 ? uShimmer[id] : 0.0;
    }`,
    // the back of a head faces into its drum: little of the room's light reaches it there
    // (the fills cast no shadows, so their direct light is damped there too)
    afterAO: /* glsl */ `if (!gl_FrontFacing) { reflectedLight.indirectDiffuse *= 0.2; reflectedLight.indirectSpecular *= 0.15; reflectedLight.directDiffuse *= 0.15; reflectedLight.directSpecular *= 0.1; }`,
    afterRough: /* glsl */ `
    {
      float r = length(vOPos.xz) / vHead.y;
      // worn coating is smoother; a head still vibrating smears its highlight (strongest mid-head: the fundamental)
      roughnessFactor = clamp(roughnessFactor - 0.16 * mpWorn - 0.1 * mpInk + 0.3 * mpShim * (1.0 - r * r), 0.2, 0.95);
    }`,
  });
  const inner = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    inner.call(m, shader, r);
    shader.uniforms.uShimmer = shimmer;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
      material.clearcoat = clamp(0.25 + 0.5 * mpWorn, 0.0, 1.0);
      material.clearcoatRoughness = clamp(0.38 - 0.18 * mpWorn + 0.5 * mpShim, 0.08, 0.9);
      #endif`,
    );
  };
  return m;
}

/** the kick's front head: black, smooth, with the maker's emblem (white and gold) */
function frontHeadMaterial(atlas: THREE.Texture, R: number): THREE.MeshPhysicalMaterial {
  return patch(new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12, side: THREE.DoubleSide }), {
    uniforms: { uAtlas: { value: atlas }, uRectKick: { value: rect(ATLAS.kick) } },
    fragHead: DETAIL_GLSL + ATLAS_GLSL + 'float mpEmblem;',
    afterMap: /* glsl */ `
    {
      vec2 q = vec2(vOPos.x, -vOPos.z) / (${(R * 1.24).toFixed(4)}) + 0.5;
      vec4 e = mpAtlas(uRectKick, vec2(1.0 - q.x, q.y));
      // printed inks, a little worn
      float wear = 0.85 + 0.15 * smoothstep(0.3, 0.7, mpFbm(vOPos * 300.0));
      vec3 c = vec3(0.02, 0.02, 0.022) * (0.9 + 0.2 * mpFbm(vOPos * 40.0));
      c = mix(c, vec3(0.62, 0.45, 0.2), e.g * wear);
      c = mix(c, vec3(0.78, 0.76, 0.72), e.r * wear);
      mpEmblem = max(e.r, e.g);
      diffuseColor.rgb = c;
    }`,
    afterMetal: /* glsl */ `metalnessFactor = 0.0;`,
    afterRough: /* glsl */ `roughnessFactor = clamp(0.28 + 0.25 * mpEmblem + (mpFbm(vOPos * 50.0) - 0.5) * 0.06, 0.1, 0.8);`,
  });
}

// ---------------------------------------------------------------- metal
function chromeMaterial(): THREE.MeshPhysicalMaterial {
  return patch(new THREE.MeshPhysicalMaterial({ color: 0xf0f1f3, metalness: 1, roughness: 0.1 }), {
    fragHead: DETAIL_GLSL + PRINTS_GLSL,
    afterRough: /* glsl */ `
    {
      float mpF = mpFoot();
      // hairline scratches in all directions, too fine to see but in the highlights
      float s1 = mpNoise(vec3(vOPos.x * 30.0, vOPos.y * 4000.0, vOPos.z * 30.0));
      float s2 = mpNoise(vec3(vOPos.x * 3000.0 + vOPos.z * 2000.0, vOPos.y * 40.0, 3.0));
      float scratch = smoothstep(0.82, 0.95, max(s1, s2)) * mpRes(0.0006, mpF);
      // handling: smudges and prints (on everything, but slight), and fine pitting in places
      float smudge = smoothstep(0.6, 0.85, mpFbm(vOPos * 35.0));
      float prints = mpPrints(vOPos.xy + vOPos.zz * 0.7, 0.05, 0.12, 7.0);
      roughnessFactor = clamp(roughnessFactor + 0.12 * scratch + 0.1 * smudge + 0.14 * prints + (mpFbm(vOPos * 120.0) - 0.5) * 0.03, 0.035, 0.45);
    }`,
    afterMap: /* glsl */ `
    {
      float pit = step(0.996, mpHash(floor(vOPos * 3000.0))) * mpRes(0.0005, mpFoot());
      diffuseColor.rgb *= 1.0 - 0.5 * pit;
    }`,
  });
}

/** the hoops: chrome, with marks where the stick has hit the rim (on the drummer's side) */
function hoopMaterial(): THREE.MeshPhysicalMaterial {
  return patch(new THREE.MeshPhysicalMaterial({ color: 0xeceef1, metalness: 1, roughness: 0.09 }), {
    vertexHead: /* glsl */ `attribute vec2 aHead; varying vec2 vHead;`,
    vertexEnd: /* glsl */ `vHead = aHead;`,
    fragHead: DETAIL_GLSL + 'varying vec2 vHead; float mpRim;',
    afterMap: /* glsl */ `
    {
      // rimshots land on the top of the hoop nearest the drummer: dulled chrome, grey smears of stick
      float R = vHead.y;
      float ang = atan(vOPos.x, vOPos.z);
      float side = exp(-ang * ang / 0.35);
      float top = smoothstep(-0.002, 0.004, vOPos.y);
      float amt = vHead.x > 0.5 && vHead.x < 1.5 ? 1.0 : 0.35;
      float marks = smoothstep(0.55, 0.8, mpNoise(vec3(ang * 180.0, vOPos.y * 600.0, 1.0))) * side * top * amt;
      marks *= mpRes(0.0015, mpFoot()) * 0.8 + 0.2;
      mpRim = marks;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.38, 0.33), 0.55 * marks);
    }`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + 0.35 * mpRim + (mpFbm(vOPos * 90.0) - 0.5) * 0.03, 0.04, 0.6);`,
  });
}

// ---------------------------------------------------------------- cymbals
/**
 * Lathed bronze. aCym.x picks the stamp (0 crash, 1 ride, 2 hi-hat top,
 * 3 hi-hat bottom), aCym.y is the cymbal's radius. vRadV is the radial
 * direction in view space: across the lathe's grooves, the direction the
 * highlight stretches.
 */
function cymbalMaterial(atlas: THREE.Texture): THREE.MeshPhysicalMaterial {
  const m = patch(new THREE.MeshPhysicalMaterial({ color: 0xd9b07a, metalness: 1, roughness: 0.2, anisotropy: 0.82 }), {
    uniforms: { uAtlas: { value: atlas }, uRectCrash: { value: rect(ATLAS.crash) }, uRectRide: { value: rect(ATLAS.ride) }, uRectHats: { value: rect(ATLAS.hats) } },
    vertexHead: /* glsl */ `attribute vec2 aCym; varying vec2 vCym; varying vec3 vRadV;`,
    vertexEnd: /* glsl */ `vCym = aCym; vRadV = normalize(mat3(modelViewMatrix) * normalize(vec3(transformed.x, 0.0, transformed.z) + vec3(1e-6, 0.0, 0.0)));`,
    fragHead:
      DETAIL_GLSL +
      ATLAS_GLSL +
      PRINTS_GLSL +
      /* glsl */ `
      varying vec2 vCym;
      varying vec3 vRadV;
      float mpGrooveH;   // the lathe grooves and hammer dents, as a height (m)
      float mpHammer;
      float mpStamp;
      float mpTarnish;
      float mpEdgeMarks;
      float mpTonal;
      // hammer marks: shallow peens scattered by hand (about 7 to 16 mm, not in every cell, overlapping)
      float mpDent(vec2 q, out float inside) {
        vec2 cell = floor(q / 0.011);
        float h = 0.0;
        inside = 0.0;
        for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 cc = cell + vec2(float(i), float(j));
            if (mpHash(vec3(cc, 25.0)) < 0.35) continue;
            vec2 c = (cc + vec2(mpHash(vec3(cc, 21.0)), mpHash(vec3(cc, 22.0)))) * 0.011;
            float rr = 0.0035 + 0.0045 * mpHash(vec3(cc, 23.0));
            float d = length((q - c) * vec2(1.0, 0.75 + 0.5 * mpHash(vec3(cc, 26.0)))) / rr;
            float depth = 0.000008 + 0.000012 * mpHash(vec3(cc, 24.0));
            float k = max(0.0, 1.0 - d * d);
            h -= depth * k * k;
            inside = max(inside, k * 0.7);
          }
        return h;
      }`,
    afterMap: /* glsl */ `
    {
      float mpF = mpFoot();
      float R = vCym.y;
      vec2 q = vOPos.xz;
      float r = length(q);
      float u = r / R;
      // the lathe: fine grooves (0.55 mm) and wider tonal bands that wander a little
      float gw = mpRes(0.00055, mpF);
      float bands = mpFbm(vec3(r * 260.0, 0.0, vCym.x * 7.0));
      mpGrooveH = gw * 0.00002 * sin(r / 0.00055 * 6.2831853 + bands * 3.0);
      // tonal grooves: the lathe's cut varies in depth and pitch from ring to ring (a few millimetres), so the fan of light is banded
      mpTonal = mix(0.5, mpFbm(vec3(r * 700.0, 1.7, vCym.x * 3.0)), mpRes(0.0025, mpF));
      // hammer marks across the bow, not on the bell or the very edge
      float inside;
      float dent = mpDent(q + vec2(vCym.x * 0.37), inside);
      float bow = smoothstep(0.32, 0.4, u) * (1.0 - smoothstep(0.93, 0.98, u));
      mpHammer = inside * bow * mpRes(0.006, mpF);
      mpGrooveH += dent * bow * mpRes(0.006, mpF);
      // bronze, a little uneven; the bell's casting skin a touch darker; tarnish in slow patches and near the bell
      vec3 c = vec3(0.86, 0.62, 0.36) * (0.92 + 0.12 * bands) * (0.9 + 0.2 * mpTonal);
      mpTarnish = smoothstep(0.55, 0.85, mpFbm(vOPos * 18.0 + vCym.x)) * 0.5 + 0.35 * (1.0 - smoothstep(0.2, 0.45, u));
      c = mix(c, c * vec3(0.72, 0.6, 0.48), 0.45 * mpTarnish);
      c *= 1.0 - 0.03 * mpHammer;
      // the maker's stamp in ink, on the top of the bow (faded)
      mpStamp = 0.0;
      if (vOPos.y > -0.02 && vWNormal.y > -0.2) {
        // readable from the stool: right is +x, up is away from the drummer (-z)
        vec2 sq = vec2(q.x / (0.46 * R) + 0.5, (-q.y - 0.56 * R) / (0.115 * R) + 0.5);
        vec4 s = vCym.x < 0.5 ? mpAtlas(uRectCrash, sq) : vCym.x < 1.5 ? mpAtlas(uRectRide, sq) : vCym.x < 2.5 ? mpAtlas(uRectHats, sq) : vec4(0.0);
        mpStamp = s.r * (0.55 + 0.45 * smoothstep(0.35, 0.7, mpFbm(vOPos * 400.0)));
      }
      c = mix(c, vec3(0.05, 0.04, 0.035), 0.75 * mpStamp);
      // stick marks on the edge where it is crashed (the drummer's side, +z): short grey smears
      float ang = atan(q.x, q.y);
      float edge = smoothstep(0.9, 0.985, u);
      float near = exp(-ang * ang / 0.5);
      mpEdgeMarks = edge * near * smoothstep(0.5, 0.8, mpNoise(vec3(ang * 140.0, u * 40.0, vCym.x))) * mpRes(0.002, mpF);
      c = mix(c, vec3(0.32, 0.29, 0.26), 0.5 * mpEdgeMarks);
      diffuseColor.rgb = c;
    }`,
    afterRough: /* glsl */ `
    {
      float u = length(vOPos.xz) / vCym.y;
      float prints = mpPrints(vOPos.xz, 0.04, 0.25, 13.0 + vCym.x) * smoothstep(0.75, 0.95, u);
      roughnessFactor = clamp(roughnessFactor + 0.1 * mpTarnish + 0.03 * mpHammer + 0.12 * (mpTonal - 0.5) + 0.25 * mpStamp + 0.2 * mpEdgeMarks + 0.15 * prints, 0.08, 0.7);
    }`,
    afterNormal: /* glsl */ `normal = mpBump(normal, mpGrooveH, faceDirection);`,
  });
  const inner = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    inner.call(m, shader, r);
    // the grooves run around the cymbal: rough across them (radially), smooth along them, so highlights fan out radially
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_ANISOTROPY
      {
        vec3 mpRad = normalize(vRadV - normal * dot(vRadV, normal) + 1e-6);
        material.anisotropyT = mpRad;
        material.anisotropyB = normalize(cross(normal, mpRad));
        // the stamp's ink and the tarnish are not lathed
        material.anisotropy *= 1.0 - 0.8 * mpStamp;
        material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
      }
      #endif`,
    );
  };
  return m;
}

// ---------------------------------------------------------------- soft things
function feltMaterial(color: number, sheen: number): THREE.MeshPhysicalMaterial {
  return feltify(
    patch(new THREE.MeshPhysicalMaterial({ color, roughness: 0.95, specularIntensity: 0.1, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(sheen) }), {
      fragHead: DETAIL_GLSL + FELT_GLSL,
      afterMap: /* glsl */ `mpFeltSmooth = 0.0; diffuseColor.rgb *= mpFelt(vOPos, mpFoot());`,
      afterNormal: FELT_NORMAL,
    }),
  );
}

function rubberMaterial(): THREE.MeshStandardMaterial {
  return patch(new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.82 }), {
    fragHead: DETAIL_GLSL,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 2500.0) - 0.5) * 0.12 * mpRes(0.0008, mpFoot()), 0.5, 1.0);`,
  });
}

/** the drum stool's seat: black vinyl, a soft grain, a stitched seam */
function vinylMaterial(): THREE.MeshPhysicalMaterial {
  return patch(new THREE.MeshPhysicalMaterial({ color: 0x0c0c0d, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x2a2a30) }), {
    fragHead: DETAIL_GLSL,
    afterMap: /* glsl */ `diffuseColor.rgb *= 0.85 + 0.3 * mpFbm(vOPos * 60.0);`,
    afterNormal: /* glsl */ `
    {
      float mpF = mpFoot();
      float g = mix(0.0, mpNoise(vOPos * 1800.0) * 0.00004, mpRes(0.0008, mpF));
      normal = mpBump(normal, g, faceDirection);
    }`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpFbm(vOPos * 25.0) - 0.5) * 0.25 - 0.15 * smoothstep(0.1, 0.3, vOPos.y) * (1.0 - smoothstep(0.0, 0.12, length(vOPos.xz))), 0.2, 0.8);`,
  });
}

/** a worn Persian-style rug: a border, a medallion, a field of small motifs; wool pile, flattened where feet and the stool go */
function rugMaterial(): THREE.MeshPhysicalMaterial {
  return patch(new THREE.MeshPhysicalMaterial({ color: 0x5a1a14, roughness: 0.95, specularIntensity: 0.15, sheen: 0.6, sheenRoughness: 0.8, sheenColor: new THREE.Color(0x8a5040) }), {
    fragHead:
      DETAIL_GLSL +
      /* glsl */ `
      float mpPile;
      vec3 mpRugColor(vec2 q) {
        // q: metres from the rug's centre; the rug is 2.3 x 1.9 m
        vec2 h = vec2(1.15, 0.95);
        vec2 a = abs(q);
        vec2 e = h - a;                       // distance in from each edge
        float edge = min(e.x, e.y);
        vec3 red = vec3(0.30, 0.055, 0.04);
        vec3 indigo = vec3(0.035, 0.05, 0.12);
        vec3 ivory = vec3(0.46, 0.39, 0.27);
        vec3 ochre = vec3(0.42, 0.26, 0.09);
        vec3 c = red;
        // the borders: an outer guard stripe, the main border with a running motif, an inner guard
        if (edge < 0.035) c = indigo;
        else if (edge < 0.05) c = ivory;
        else if (edge < 0.2) {
          // the main border: indigo ground, a vine running along it with a rosette every 16 cm
          float along = e.x < e.y ? q.y : q.x;
          float across = edge - 0.125;
          float vine = abs(across - 0.03 * sin(along * 39.27));
          c = mix(indigo, ochre, 1.0 - smoothstep(0.004, 0.008, vine));
          vec2 rp = vec2(fract(along / 0.16 + 0.25) - 0.5, across / 0.16);
          float rr = length(rp);
          float petals = 0.5 + 0.5 * cos(atan(rp.y, rp.x) * 8.0);
          c = mix(c, red * 1.3, smoothstep(0.24, 0.2, rr - 0.05 * petals));
          c = mix(c, ivory, smoothstep(0.1, 0.07, rr));
          c = mix(c, ochre, smoothstep(0.035, 0.02, rr));
        } else if (edge < 0.215) c = ivory;
        else {
          // the field: staggered rows of small flowers on a faint curving trellis, and the central medallion
          vec2 g = q * 7.0;
          float row = floor(g.y);
          vec2 f = vec2(fract(g.x + 0.5 * mod(row, 2.0)), fract(g.y)) - 0.5;
          float flower = smoothstep(0.2, 0.1, length(f)) * (0.55 + 0.45 * cos(atan(f.y, f.x) * 6.0));
          c = mix(red, ivory * 0.9, 0.42 * flower);
          c = mix(c, ochre, 0.5 * smoothstep(0.05, 0.02, length(f)));
          float tr = abs(sin((q.x + q.y) * 15.0 + 0.8 * sin(q.x * 11.0))) * abs(sin((q.x - q.y) * 15.0 + 0.8 * sin(q.y * 11.0)));
          c = mix(c, indigo, 0.3 * smoothstep(0.85, 1.0, 1.0 - tr));
          // abrash: the dye lots change across the weave in soft bands
          c *= 0.9 + 0.14 * smoothstep(-0.6, 0.6, sin(q.y * 4.3 + 1.3 + 0.6 * sin(q.x * 2.0)));
          float md = length(q * vec2(1.0, 1.25));
          float med = smoothstep(0.42, 0.38, md + 0.04 * sin(atan(q.y, q.x) * 12.0));
          vec3 mc = mix(indigo, ochre, smoothstep(0.2, 0.25, md) * (1.0 - smoothstep(0.3, 0.32, md)));
          mc = mix(mc, ivory, smoothstep(0.07, 0.05, md));
          mc = mix(mc, red, smoothstep(0.12, 0.1, md) * smoothstep(0.06, 0.08, md));
          c = mix(c, mc, med);
        }
        return c;
      }`,
    afterMap: /* glsl */ `
    {
      float mpF = mpFoot();
      vec2 q = vOPos.xz;
      // the knots: the pattern is woven, each knot about 3 mm, so colour edges are stepped up close
      vec2 kq = (floor(q / 0.003) + 0.5) * 0.003;
      vec3 c = mix(mpRugColor(q), mpRugColor(kq), mpRes(0.003, mpF));
      // wool: fibre texture, and the colour abraded and faded where the drummer's feet and the stool go
      float fib = mix(0.5, mpNoise(vOPos * 2500.0), mpRes(0.0006, mpF)) * 0.5 + mix(0.5, mpNoise(vOPos * 600.0), mpRes(0.002, mpF)) * 0.5;
      vec2 sq = q - vec2(-0.1, 0.35);
      mpPile = exp(-dot(sq, sq) / 0.12);
      c = mix(c, c * 0.65 + vec3(0.07, 0.06, 0.05), 0.4 * mpPile);
      c *= (0.82 + 0.36 * fib) * (0.9 + 0.2 * mpFbm(vOPos * 6.0));
      diffuseColor.rgb = c;
    }`,
    afterRough: /* glsl */ `roughnessFactor = clamp(0.95 - 0.12 * mpPile, 0.6, 1.0);`,
  });
}

export interface DrumPalette {
  shell: THREE.MeshPhysicalMaterial;
  wood: THREE.MeshStandardMaterial;
  head: THREE.MeshPhysicalMaterial;
  front: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshPhysicalMaterial;
  hoop: THREE.MeshPhysicalMaterial;
  cymbal: THREE.MeshPhysicalMaterial;
  felt: THREE.MeshPhysicalMaterial;
  beaterFelt: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  nylon: THREE.MeshPhysicalMaterial;
  darkMetal: THREE.MeshPhysicalMaterial;
  alu: THREE.MeshPhysicalMaterial;
  vinyl: THREE.MeshPhysicalMaterial;
  rug: THREE.MeshPhysicalMaterial;
  wire: THREE.MeshPhysicalMaterial;
  strap: THREE.MeshStandardMaterial;
  badge: THREE.MeshPhysicalMaterial;
  /** per head (kick, snare, tom1, tom2, floor tom, resonant): its shimmer 0..1 */
  shimmer: { value: number[] };
  /** the snare wires' buzz */
  buzz: { value: number };
  atlas: THREE.Texture;
}

export function createDrumPalette(kickRadius: number): DrumPalette {
  const atlas = logoAtlas();
  const shimmer = { value: [0, 0, 0, 0, 0, 0] };
  const buzz = { value: 0 };
  const wood = patch(new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.62 }), {
    fragHead: DETAIL_GLSL,
    afterMap: /* glsl */ `
    {
      // sealed maple plies: fine grain running around the shell, flecks
      float a = atan(vOPos.x, vOPos.z);
      float lines = 0.5 + 0.5 * sin(vOPos.y * 1800.0 + mpFbm(vec3(a * 30.0, vOPos.y * 40.0, 0.0)) * 5.0);
      diffuseColor.rgb = vec3(0.42, 0.28, 0.16) * (0.85 + 0.2 * lines * mpRes(0.0015, mpFoot())) * (0.9 + 0.2 * mpFbm(vOPos * 80.0));
    }`,
    // the wood is mostly the inside of the shell, a cavity the room's light hardly enters
    afterAO: /* glsl */ `reflectedLight.indirectDiffuse *= 0.35; reflectedLight.indirectSpecular *= 0.3; reflectedLight.directDiffuse *= 0.4; reflectedLight.directSpecular *= 0.3;`,
  });
  const nylon = patch(new THREE.MeshPhysicalMaterial({ color: 0xd9d3c3, roughness: 0.45, sheen: 0.3, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff) }), {
    afterMap: /* glsl */ `diffuseColor.rgb *= 0.92 + 0.12 * mpFbm(vOPos * 300.0);`,
  });
  const darkMetal = patch(new THREE.MeshPhysicalMaterial({ color: 0x1a1b1d, metalness: 0.75, roughness: 0.42 }), {
    fragHead: DETAIL_GLSL,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpFbm(vOPos * 300.0) - 0.5) * 0.15, 0.2, 0.7);`,
  });
  const alu = patch(new THREE.MeshPhysicalMaterial({ color: 0xb9bcc0, metalness: 1, roughness: 0.32 }), {
    uniforms: { uAtlas: { value: atlas }, uRectPedal: { value: rect(ATLAS.pedal) } },
    fragHead: DETAIL_GLSL + ATLAS_GLSL + 'float mpCast;',
    afterMap: /* glsl */ `
    {
      // cast aluminium footboards: the maker's name cast in along the board (local z), worn bright where the foot goes
      vec2 lq = vec2(vOPos.x / 0.07 + 0.5, (vOPos.z + 0.17) / 0.06 + 0.5);
      mpCast = vWNormal.y > 0.5 ? mpAtlas(uRectPedal, vec2(lq.y, lq.x)).r : 0.0;
      diffuseColor.rgb *= 1.0 - 0.45 * mpCast;
    }`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vec3(vOPos.x * 3000.0, vOPos.y * 3000.0, vOPos.z * 40.0)) - 0.5) * 0.2 + 0.2 * mpCast, 0.12, 0.7);`,
  });
  const wire = patch(new THREE.MeshPhysicalMaterial({ color: 0xc8ccd2, metalness: 1, roughness: 0.25 }), {
    uniforms: { uBuzz: buzz },
    // the buzzing wires as the camera sees them: a little wider and dimmer (their swing over the exposure)
    afterBegin: /* glsl */ `transformed.xz *= 1.0 + 2.5 * uBuzz;`,
    beforeOpaque: /* glsl */ `outgoingLight *= 1.0 / (1.0 + 1.6 * uBuzz);`,
  });
  const strap = new THREE.MeshStandardMaterial({ color: 0x18140f, roughness: 0.9 });
  const badge = patch(new THREE.MeshPhysicalMaterial({ color: 0xd8c08a, metalness: 1, roughness: 0.25 }), {
    uniforms: { uAtlas: { value: atlas }, uRectBadge: { value: rect(ATLAS.badge) } },
    vertexHead: 'varying vec2 vBadgeUv;',
    vertexEnd: 'vBadgeUv = uv;',
    fragHead: ATLAS_GLSL + 'varying vec2 vBadgeUv; float mpB;',
    afterMap: /* glsl */ `
    {
      vec4 b = mpAtlas(uRectBadge, vBadgeUv);
      mpB = b.r;
      diffuseColor.rgb = mix(vec3(0.03, 0.025, 0.02), vec3(0.85, 0.68, 0.38), max(b.g, b.r));
    }`,
    afterMetal: /* glsl */ `metalnessFactor = mix(0.2, 1.0, step(0.3, mpB));`,
  });
  return {
    shell: shellMaterial(),
    wood,
    head: headMaterial(atlas, shimmer),
    front: frontHeadMaterial(atlas, kickRadius),
    chrome: chromeMaterial(),
    hoop: hoopMaterial(),
    cymbal: cymbalMaterial(atlas),
    felt: feltMaterial(0x5a1416, 0xa04040),
    beaterFelt: feltMaterial(0xcfc4ae, 0xfff4e0),
    rubber: rubberMaterial(),
    nylon,
    darkMetal,
    alu,
    vinyl: vinylMaterial(),
    rug: rugMaterial(),
    wire,
    strap,
    badge,
    shimmer,
    buzz,
    atlas,
  };
}
