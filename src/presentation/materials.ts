// The material palette: porcelain, chrome, steel, graphite, iridescent glass
// and matte fingertip pads for the hands;
// lacquered walnut, ivory, ebony, felt and brass for the piano. Glow is kept
// quiet (bloom picks it up, it does not flood the frame).
import * as THREE from 'three';
import { CONTACT_SHADOW_GLSL, patch } from './shaderPatch';

/**
 * The robot forearms are only forearms. The camera keeps their ends out of
 * frame (CinematicCamera.guard); as a safety net the last few centimetres
 * also fade into the dark. A longer fade read as a black band across the arm
 * in bright shots. Only the forearm extends toward +Z in its own object space
 * (fingers and palm point along -Z), so the hand's materials can share this.
 */
const ARM_FADE = /* glsl */ `outgoingLight *= 1.0 - smoothstep(0.29, 0.335, vOPos.z);`;

/**
 * The live mirror image for the vertical lacquer behind the keys (the
 * nameboard and the panel above it): SceneRenderer renders the scene mirrored
 * in that plane each frame, and the lacquer's clear coat reflects it instead
 * of the static environment there.
 */
export const MIRROR_UNIFORMS = {
  uMirror: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) as THREE.Texture },
  uMirrorMatrix: { value: new THREE.Matrix4() },
  uMirrorOn: { value: 0 },
  uMirrorZ: { value: -0.15 },
};

const MIRROR_GLSL = /* glsl */ `
#ifdef USE_CLEARCOAT
if (uMirrorOn > 0.0 && vWNormal.z > 0.9 && abs(vWPos.z - uMirrorZ) < 0.012 && vWPos.y > -0.012 && vWPos.y < 0.53 && abs(vWPos.x) < 0.62) {
  vec4 mc = uMirrorMatrix * vec4(vWPos, 1.0);
  vec2 muv = mc.xy / mc.w;
  // the coat's roughness (with its micro-variation) spreads the image
  float lod = clamp(material.clearcoatRoughness * 26.0 - 0.6, 0.0, 6.0);
  vec3 refl = textureLod(uMirror, muv, lod).rgb;
  float inside = smoothstep(0.0, 0.03, muv.x) * smoothstep(1.0, 0.97, muv.x) * smoothstep(0.0, 0.03, muv.y) * smoothstep(1.0, 0.97, muv.y);
  vec3 planar = refl * EnvironmentBRDF(geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness);
  clearcoatSpecularIndirect = mix(clearcoatSpecularIndirect, planar, inside * uMirrorOn);
}
#endif
`;

/** AO from the baked mask, applied to indirect light only (direct light has real shadows). */
const MASK_AO = (strength: number) => /* glsl */ `
{
  float ao = mix(1.0, vMask.r, ${strength.toFixed(2)});
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao * ao;
}`;

export interface Palette {
  shell: THREE.MeshPhysicalMaterial;
  shellInner: THREE.MeshStandardMaterial;
  chrome: THREE.MeshPhysicalMaterial;
  steel: THREE.MeshPhysicalMaterial;
  graphite: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  pad: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lacquer: THREE.MeshPhysicalMaterial;
  felt: THREE.MeshPhysicalMaterial;
  brass: THREE.MeshPhysicalMaterial;
  gold: THREE.MeshPhysicalMaterial;
  cloth: THREE.MeshStandardMaterial;
  ivory: THREE.MeshPhysicalMaterial;
  ebony: THREE.MeshPhysicalMaterial;
  glowUniform: { value: number };
  byName: Record<string, THREE.Material>;
}

/** the forearm's printed label (white ink in the alpha): right hand above, left below */
function makeLabel(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 288;
  const g = c.getContext('2d')!;
  const half = (side: 'R' | 'L', y0: number) => {
    g.save();
    g.translate(0, y0);
    g.strokeStyle = '#fff';
    g.fillStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(8, 10, 496, 124);
    g.font = '600 38px Inter, Helvetica, Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('VEY AUTOMATA', 26, 48);
    g.font = '500 25px Inter, Helvetica, Arial, sans-serif';
    g.fillText(`MP-7 ${side}   SN 0472-${side}   24 V`, 26, 100);
    g.beginPath();
    g.moveTo(440, 30);
    g.lineTo(474, 88);
    g.lineTo(406, 88);
    g.closePath();
    g.stroke();
    g.font = '700 30px Inter, Helvetica, Arial, sans-serif';
    g.fillText('!', 434, 70);
    g.restore();
  };
  half('R', 0);
  half('L', 144);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export function createPalette(): Palette {
  const glowUniform = { value: 1 };

  const shell = patch(
    new THREE.MeshPhysicalMaterial({
      color: 0xefebe4,
      roughness: 0.34,
      clearcoat: 0.75,
      clearcoatRoughness: 0.12,
      sheen: 0.25,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0xfff4e6),
    }),
    {
      masks: true,
      // porcelain: a breath of warmth deep in the cavities, faint orange-peel in the coat;
      // a working machine's few small scuffs and hairline scratches, the seams
      // between the forearm's panels, and its printed label
      uniforms: { uLabel: { value: makeLabel() } },
      vertexHead: /* glsl */ `varying vec3 vONormal; varying float vMirror;`,
      vertexEnd: /* glsl */ `vONormal = objectNormal; vMirror = determinant(mat3(modelMatrix)) < 0.0 ? 1.0 : 0.0;`,
      fragHead: /* glsl */ `varying vec3 vONormal; varying float vMirror; float mpWear = 0.0; float mpInk = 0.0;`,
      afterMap: /* glsl */ `
      {
        diffuseColor.rgb *= mix(vec3(0.86, 0.83, 0.8), vec3(1.0), smoothstep(0.25, 0.9, vMask.r));
        float scuff = smoothstep(0.8, 0.92, mpNoise(vOPos * 520.0)) * smoothstep(0.5, 0.72, mpFbm(vOPos * 60.0));
        float scratch = smoothstep(0.95, 0.99, mpNoise(vec3(vOPos.x * 5200.0, vOPos.y * 5200.0, vOPos.z * 70.0))) * smoothstep(0.52, 0.75, mpFbm(vOPos * 35.0 + 4.0));
        mpWear = max(scuff, scratch * 0.7);
        diffuseColor.rgb *= 1.0 - 0.05 * mpWear;
        if (vOPos.z > 0.05) {
          float seam = 1.0 - smoothstep(0.00012, 0.00034, min(abs(vOPos.z - 0.165), abs(vOPos.z - 0.235)));
          diffuseColor.rgb *= 1.0 - 0.55 * seam;
          vec2 luv = vec2((vOPos.x - 0.0025) / 0.03 + 0.5, (0.105 - vOPos.z) / 0.0085 + 0.5);
          if (vMirror > 0.5) luv.x = 1.0 - luv.x;
          if (vONormal.y > 0.6 && luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
            mpInk = texture2D(uLabel, vec2(luv.x, luv.y * 0.5 + (vMirror > 0.5 ? 0.0 : 0.5))).a;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.175, 0.18), mpInk * 0.72);
          }
        }
      }`,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 900.0) - 0.5) * 0.05 + 0.14 * mpWear + 0.12 * mpInk, 0.05, 1.0);`,
      afterAO: MASK_AO(0.85),
      beforeOpaque: ARM_FADE,
      // the hands' own captured keyboard environment already brings some of this
      bounce: 0.5,
    },
  );
  const shellInner = patch(new THREE.MeshStandardMaterial({ color: 0x8d8984, roughness: 0.6 }), { masks: true, afterAO: MASK_AO(0.9), beforeOpaque: ARM_FADE, bounce: 0.5 });
  const chrome = patch(new THREE.MeshPhysicalMaterial({ color: 0xf4f5f7, metalness: 1, roughness: 0.065 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor += vMask.b * 0.15;`,
    afterAO: MASK_AO(0.7),
    beforeOpaque: ARM_FADE,
  });
  const steel = patch(new THREE.MeshPhysicalMaterial({ color: 0xb4b9c0, metalness: 1, roughness: 0.27 }), {
    masks: true,
    // brushed: anisotropic-looking streaks along the part
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vec3(vOPos.x * 4000.0, vOPos.y * 4000.0, vOPos.z * 60.0)) - 0.5) * 0.18, 0.08, 0.6);`,
    afterAO: MASK_AO(0.8),
    beforeOpaque: ARM_FADE,
  });
  const graphite = patch(new THREE.MeshPhysicalMaterial({ color: 0x1b1e22, metalness: 0.55, roughness: 0.42, clearcoat: 0.2, clearcoatRoughness: 0.4 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 1500.0) - 0.5) * 0.12, 0.1, 0.9);`,
    afterAO: MASK_AO(0.95),
    beforeOpaque: ARM_FADE,
  });
  const rubber = patch(new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.72 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 3000.0) - 0.5) * 0.1, 0.4, 1.0);`,
    afterAO: MASK_AO(0.9),
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x0a2629,
    emissive: new THREE.Color(0x5ef0ff),
    emissiveIntensity: 2.4,
    roughness: 0.25,
  });

  // fingertip pads: a pale, slightly warm elastomer, matte with a soft sheen
  const pad = patch(
    new THREE.MeshPhysicalMaterial({ color: 0xd8d2c8, roughness: 0.62, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xf2ece2) }),
    {
      masks: true,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 2600.0) - 0.5) * 0.12, 0.35, 0.9);`,
      afterAO: MASK_AO(0.85),
      bounce: 0.5,
    },
  );
  // thin iridescent glass over the lit mechanics: mostly reflection, teal to
  // violet with the viewing angle; drawn after the opaque parts, casts no shadow
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fd6da,
    metalness: 0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    specularIntensity: 1,
    iridescence: 1,
    iridescenceIOR: 1.6,
    iridescenceThicknessRange: [280, 620],
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.6,
  });

  // --- piano -----------------------------------------------------------
  const lacquer = patch(
    new THREE.MeshPhysicalMaterial({
      color: 0x1a0f09,
      roughness: 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.075,
      ior: 1.52,
    }),
    {
      masks: true,
      // dark walnut under a deep lacquer: grain runs along the boards (x),
      // figure varies slowly; edges are a little worn through to the wood
      afterMap: /* glsl */ `
      {
        vec3 q = vWPos * vec3(2.2, 36.0, 36.0);
        float fig = mpFbm(vec3(vWPos.x * 1.5, vWPos.y * 9.0, vWPos.z * 9.0));
        float rings = sin((vWPos.y + vWPos.z) * 260.0 + fig * 9.0 + mpFbm(q) * 4.0) * 0.5 + 0.5;
        float pores = mpNoise(vWPos * vec3(60.0, 1400.0, 1400.0));
        vec3 dark = vec3(0.032, 0.018, 0.011);
        vec3 light = vec3(0.085, 0.048, 0.026);
        vec3 wood = mix(dark, light, pow(rings, 2.2) * 0.8 + fig * 0.35);
        wood *= 0.85 + 0.3 * pores;
        float wear = smoothstep(0.35, 0.9, vMask.g) * smoothstep(0.4, 0.75, mpFbm(vWPos * 40.0));
        wood = mix(wood, vec3(0.16, 0.09, 0.05), wear * 0.6);
        // fine dust settled on what faces up
        wood += vec3(0.028, 0.026, 0.024) * mpDust(vWPos, vWNormal);
        diffuseColor.rgb = wood;
      }`,
      afterAO: MASK_AO(0.9) + MIRROR_GLSL,
      uniforms: MIRROR_UNIFORMS,
      // patchy micro-scratches in the coat: subtle variation in reflections
      fragHead: /* glsl */ `
      float mpCoatVar(vec3 p) { return mpFbm(p * 14.0); }
      // dust specks (about half a millimetre) on upward faces
      float mpDust(vec3 p, vec3 n) {
        float up = smoothstep(0.5, 0.85, n.y);
        float speck = step(0.993, mpHash(floor(p * 1800.0)));
        return up * speck * smoothstep(0.3, 0.6, mpFbm(p * 9.0));
      }
      // one fingerprint: an oval of fine ridges (0.45 mm apart), patchy, fading at its rim
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
      // how much handling the coat shows here: smudges and the odd fingerprint within reach of the hands
      float mpHandled(vec3 p, vec3 n) {
        float reach = smoothstep(-0.12, -0.06, p.y) * (1.0 - smoothstep(0.12, 0.25, p.y)) * (1.0 - smoothstep(0.62, 0.72, abs(p.x)));
        float smudge = smoothstep(0.58, 0.8, mpFbm(p * 22.0)) * reach;
        float prints = 0.0;
        if (n.z > 0.8 && reach > 0.0) {
          vec2 cell = floor(p.xy / 0.07);
          float h = mpHash(vec3(cell, 5.0));
          if (h > 0.7) {
            vec2 c = (cell + 0.2 + 0.6 * vec2(mpHash(vec3(cell, 6.0)), mpHash(vec3(cell, 7.0)))) * 0.07;
            prints = mpPrint(p.xy, c, mpHash(vec3(cell, 8.0)) * 3.14159);
          }
        }
        return max(smudge * 0.6, prints) * reach;
      }`,
    },
  );
  lacquer.onBeforeCompile = ((orig) => (shader: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => {
    orig(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
      material.clearcoatRoughness = clamp(material.clearcoatRoughness + (mpCoatVar(vWPos) - 0.45) * 0.12 + vMask.g * 0.08
        + 0.13 * mpHandled(vWPos, vWNormal) + 0.08 * mpDust(vWPos, vWNormal) + 0.015 * smoothstep(0.5, 0.85, vWNormal.y), 0.04, 0.45);
      #endif`,
    );
  })(lacquer.onBeforeCompile);
  const felt = patch(
    new THREE.MeshPhysicalMaterial({ color: 0x4e0f14, roughness: 0.95, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x9a3535) }),
    { masks: true, afterMap: /* glsl */ `diffuseColor.rgb *= 0.8 + 0.4 * mpNoise(vWPos * 2500.0);`, afterAO: MASK_AO(0.9) },
  );
  const brass = patch(new THREE.MeshPhysicalMaterial({ color: 0xc89d55, metalness: 1, roughness: 0.3 }), {
    masks: true,
    afterMap: /* glsl */ `diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.3, 0.7, mpFbm(vWPos * 70.0)));`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpFbm(vWPos * 90.0) - 0.5) * 0.4, 0.12, 0.8);`,
    afterAO: MASK_AO(0.9),
  });
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xd8b06a, metalness: 1, roughness: 0.38 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x1a110d, roughness: 1 });

  // ivory and ebony keys; per-key tint arrives as vertex colour
  const ivory = patch(
    new THREE.MeshPhysicalMaterial({
      color: 0xf0e6d0,
      roughness: 0.34,
      clearcoat: 0.35,
      clearcoatRoughness: 0.22,
      vertexColors: true,
    }),
    {
      afterMap: /* glsl */ `
      {
        // ivory: faint grain lines across the key, slightly yellower toward the front
        float grain = mpNoise(vec3(vWPos.x * 3000.0, vWPos.y * 200.0, vWPos.z * 90.0));
        diffuseColor.rgb *= 0.965 + 0.05 * grain;
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.0, 0.965, 0.9), smoothstep(-0.06, 0.0, vWPos.z));
        // a whisper of use: where fingers land most (more in the middle of the
        // keyboard, more on some keys than others) a touch more polished and a
        // hair warmer; a trace of grime down the sides where keys meet
        float keyId = floor((vWPos.x + 1.0) / 0.02355);
        float use = (0.35 + 0.65 * mpHash(vec3(keyId, 3.0, 7.0))) * exp(-vWPos.x * vWPos.x / 0.12);
        float zone = smoothstep(-0.08, -0.035, vOPos.z) * (1.0 - smoothstep(-0.005, 0.0, vOPos.z)) * exp(-vOPos.x * vOPos.x / 0.00005);
        mpPolish = use * zone;
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.988, 0.978, 0.958), mpPolish);
        diffuseColor.rgb *= 1.0 - 0.16 * step(0.8, abs(vWNormal.x)) * smoothstep(-0.007, -0.0015, vOPos.y);
        diffuseColor.rgb *= mpContact(vWPos);
      }`,
      fragHead: CONTACT_SHADOW_GLSL + `float mpPolish = 0.0;`,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vWPos * 700.0) - 0.5) * 0.12 - 0.07 * mpPolish, 0.12, 0.8);`,
      afterAO: /* glsl */ `{ float c = mpContact(vWPos); reflectedLight.indirectDiffuse *= c; reflectedLight.indirectSpecular *= c; }`,
    },
  );
  const ebony = patch(
    new THREE.MeshPhysicalMaterial({ color: 0x0b0908, roughness: 0.36, clearcoat: 0.45, clearcoatRoughness: 0.25, vertexColors: true }),
    {
      afterMap: /* glsl */ `diffuseColor.rgb *= (0.8 + 0.4 * mpNoise(vec3(vWPos.x * 2000.0, vWPos.y * 2000.0, vWPos.z * 40.0))) * mpContact(vWPos);`,
      fragHead: CONTACT_SHADOW_GLSL,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vec3(vWPos.x * 1500.0, vWPos.y * 1500.0, vWPos.z * 30.0)) - 0.5) * 0.2, 0.15, 0.7);`,
      afterAO: /* glsl */ `{ float c = mpContact(vWPos); reflectedLight.indirectDiffuse *= c; reflectedLight.indirectSpecular *= c; }`,
    },
  );

  const byName: Record<string, THREE.Material> = {
    shell,
    shell_inner: shellInner,
    chrome,
    steel,
    graphite,
    rubber,
    glow,
    pad,
    glass,
    lacquer,
    walnut: lacquer,
    felt,
    brass,
    gold_leaf: gold,
    cloth,
  };
  return { shell, shellInner, chrome, steel, graphite, rubber, glow, pad, glass, lacquer, felt, brass, gold, cloth, ivory, ebony, glowUniform, byName };
}

/** Replace glTF materials (by their Blender names) with the palette's. Multi-material meshes are groups of primitives. */
export function applyPalette(root: THREE.Object3D, palette: Palette) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (m.material as THREE.Material).name.replace(/\.\d+$/, '');
    const mat = palette.byName[name];
    if (mat) m.material = mat;
    m.castShadow = name !== 'glow' && name !== 'glass';
    m.receiveShadow = true;
  });
}
