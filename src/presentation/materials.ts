// The material palette: porcelain, chrome, steel, graphite, iridescent glass
// and matte fingertip pads for the hands;
// lacquered walnut, ivory, ebony, felt and brass for the piano. Glow is kept
// quiet (bloom picks it up, it does not flood the frame).
import * as THREE from 'three';
import { CONTACT_SHADOW_GLSL, patch } from './shaderPatch';

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
      // porcelain: a breath of warmth deep in the cavities, faint orange-peel in the coat
      afterMap: /* glsl */ `diffuseColor.rgb *= mix(vec3(0.86, 0.83, 0.8), vec3(1.0), smoothstep(0.25, 0.9, vMask.r));`,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 900.0) - 0.5) * 0.05, 0.05, 1.0);`,
      afterAO: MASK_AO(0.85),
    },
  );
  const shellInner = patch(new THREE.MeshStandardMaterial({ color: 0x8d8984, roughness: 0.6 }), { masks: true, afterAO: MASK_AO(0.9) });
  const chrome = patch(new THREE.MeshPhysicalMaterial({ color: 0xf4f5f7, metalness: 1, roughness: 0.065 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor += vMask.b * 0.15;`,
    afterAO: MASK_AO(0.7),
  });
  const steel = patch(new THREE.MeshPhysicalMaterial({ color: 0xb4b9c0, metalness: 1, roughness: 0.27 }), {
    masks: true,
    // brushed: anisotropic-looking streaks along the part
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vec3(vOPos.x * 4000.0, vOPos.y * 4000.0, vOPos.z * 60.0)) - 0.5) * 0.18, 0.08, 0.6);`,
    afterAO: MASK_AO(0.8),
  });
  const graphite = patch(new THREE.MeshPhysicalMaterial({ color: 0x1b1e22, metalness: 0.55, roughness: 0.42, clearcoat: 0.2, clearcoatRoughness: 0.4 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 1500.0) - 0.5) * 0.12, 0.1, 0.9);`,
    afterAO: MASK_AO(0.95),
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
        diffuseColor.rgb = wood;
      }`,
      afterAO: MASK_AO(0.9),
      // patchy micro-scratches in the coat: subtle variation in reflections
      fragHead: /* glsl */ `float mpCoatVar(vec3 p) { return mpFbm(p * 14.0); }`,
    },
  );
  lacquer.onBeforeCompile = ((orig) => (shader: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => {
    orig(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
      material.clearcoatRoughness = clamp(material.clearcoatRoughness + (mpCoatVar(vWPos) - 0.45) * 0.12 + vMask.g * 0.08, 0.04, 0.4);
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
        diffuseColor.rgb *= mpContact(vWPos);
      }`,
      fragHead: CONTACT_SHADOW_GLSL,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vWPos * 700.0) - 0.5) * 0.12, 0.15, 0.8);`,
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
