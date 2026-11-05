// The robot drummer's materials: the robot hands' palette (porcelain with
// clearcoat and cavity warmth, chrome, brushed steel, graphite, matte pads,
// iridescent glass over lit mechanics, cyan servo light) without what is
// specific to the piano's forearms (their fade into the dark, their seams and
// label, all keyed to the forearm's own coordinates). Adds hickory for the
// sticks, a rubber sole, and the maker's printed label as a decal.
import * as THREE from 'three';
import { patch } from '../presentation/shaderPatch';

/** AO from the baked mask, on indirect light only (direct light has real shadows) */
const MASK_AO = (strength: number) => /* glsl */ `
{
  float ao = mix(1.0, vMask.r, ${strength.toFixed(2)});
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao * ao;
}`;

export interface DrummerPalette {
  shell: THREE.MeshPhysicalMaterial;
  shellInner: THREE.MeshStandardMaterial;
  chrome: THREE.MeshPhysicalMaterial;
  steel: THREE.MeshPhysicalMaterial;
  graphite: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  pad: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  hickory: THREE.MeshPhysicalMaterial;
  label: THREE.MeshPhysicalMaterial;
  byName: Record<string, THREE.Material>;
}

/** the maker's label: white ink in the alpha (black on transparent elsewhere) */
function makeLabel(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 384;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.strokeRect(10, 10, 1004, 364);
  g.lineWidth = 2;
  g.strokeRect(22, 22, 980, 340);
  g.textBaseline = 'middle';
  g.font = '600 92px Inter, Helvetica, Arial, sans-serif';
  g.fillText('VEY AUTOMATA', 54, 112);
  g.font = '500 44px Inter, Helvetica, Arial, sans-serif';
  g.fillText('DR-3  PERCUSSION UNIT', 56, 214);
  g.font = '500 34px Inter, Helvetica, Arial, sans-serif';
  g.fillText('SN 0815-D     48 V  ⎓  6.5 A     MADE BY HAND', 56, 296);
  // a small maker's mark: a circle with a stroke through it
  g.lineWidth = 6;
  g.beginPath();
  g.arc(900, 140, 62, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(856, 184);
  g.lineTo(944, 96);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function createDrummerPalette(): DrummerPalette {
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
      // porcelain: warmth deep in the cavities, faint orange peel in the coat, a working machine's few
      // small scuffs and hairline scratches (more on what faces forward and down, where it meets the kit)
      fragHead: /* glsl */ `float mpWear = 0.0;`,
      afterMap: /* glsl */ `
      {
        diffuseColor.rgb *= mix(vec3(0.86, 0.83, 0.8), vec3(1.0), smoothstep(0.25, 0.9, vMask.r));
        float scuff = smoothstep(0.8, 0.92, mpNoise(vOPos * 420.0)) * smoothstep(0.5, 0.72, mpFbm(vOPos * 50.0));
        float scratch = smoothstep(0.95, 0.99, mpNoise(vec3(vOPos.x * 4200.0, vOPos.y * 4200.0, vOPos.z * 60.0))) * smoothstep(0.52, 0.75, mpFbm(vOPos * 30.0 + 4.0));
        mpWear = max(scuff, scratch * 0.7);
        diffuseColor.rgb *= 1.0 - 0.05 * mpWear;
      }`,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 700.0) - 0.5) * 0.05 + 0.14 * mpWear, 0.05, 1.0);`,
      afterAO: MASK_AO(0.85),
      bounce: 0.5,
    },
  );
  const shellInner = patch(new THREE.MeshStandardMaterial({ color: 0x8d8984, roughness: 0.6 }), { masks: true, afterAO: MASK_AO(0.9), bounce: 0.5 });
  const chrome = patch(new THREE.MeshPhysicalMaterial({ color: 0xf4f5f7, metalness: 1, roughness: 0.065 }), {
    masks: true,
    afterRough: /* glsl */ `roughnessFactor += vMask.b * 0.15;`,
    afterAO: MASK_AO(0.7),
  });
  const steel = patch(new THREE.MeshPhysicalMaterial({ color: 0xb4b9c0, metalness: 1, roughness: 0.27 }), {
    masks: true,
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
  const glow = new THREE.MeshStandardMaterial({ color: 0x0a2629, emissive: new THREE.Color(0x5ef0ff), emissiveIntensity: 2.4, roughness: 0.25 });
  const pad = patch(
    new THREE.MeshPhysicalMaterial({ color: 0xd8d2c8, roughness: 0.62, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xf2ece2) }),
    {
      masks: true,
      afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + (mpNoise(vOPos * 2600.0) - 0.5) * 0.12, 0.35, 0.9);`,
      afterAO: MASK_AO(0.85),
      bounce: 0.5,
    },
  );
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
  // hickory: pale, warm, a satin lacquer; grain along the stick (its local -z), darker and rougher where it
  // has been played (the shoulder and the tip, and a band where the rim catches it), and where the hand holds it
  const hickory = patch(new THREE.MeshPhysicalMaterial({ color: 0xd9b88a, roughness: 0.46, clearcoat: 0.35, clearcoatRoughness: 0.35 }), {
    masks: true,
    fragHead: /* glsl */ `float mpPlayed = 0.0;`,
    afterMap: /* glsl */ `
    {
      vec3 q = vOPos;
      float grain = mpFbm(vec3(q.x * 900.0, q.y * 900.0, q.z * 14.0));
      float lines = smoothstep(0.35, 0.75, mpNoise(vec3(q.x * 2600.0, q.y * 2600.0, q.z * 3.0)));
      diffuseColor.rgb *= mix(vec3(0.84, 0.78, 0.7), vec3(1.04, 1.0, 0.95), grain);
      diffuseColor.rgb *= 1.0 - 0.07 * lines;
      // vMask.g carries how played the wood is (baked along the stick in Blender)
      mpPlayed = vMask.g;
      float chip = smoothstep(0.55, 0.85, mpNoise(q * 900.0)) * mpPlayed;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.7, 0.62), 0.55 * mpPlayed + 0.3 * chip);
      diffuseColor.rgb *= mix(vec3(0.9, 0.86, 0.8), vec3(1.0), smoothstep(0.3, 0.9, vMask.r));
    }`,
    afterRough: /* glsl */ `roughnessFactor = clamp(roughnessFactor + 0.25 * mpPlayed + (mpNoise(vOPos * 1200.0) - 0.5) * 0.08, 0.2, 0.95);`,
    afterAO: MASK_AO(0.8),
  });
  // the printed label: a decal over the porcelain, its ink a dark graphite
  const label = new THREE.MeshPhysicalMaterial({
    color: 0x2b2d30,
    roughness: 0.5,
    clearcoat: 0.6,
    clearcoatRoughness: 0.14,
    transparent: true,
    alphaMap: makeLabel(),
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    opacity: 0.8,
  });
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
    hickory,
    label,
  };
  return { shell, shellInner, chrome, steel, graphite, rubber, glow, pad, glass, hickory, label, byName };
}

/** replace the glTF's materials (by their Blender names) with the palette's */
export function applyDrummerPalette(root: THREE.Object3D, palette: DrummerPalette) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (m.material as THREE.Material).name.replace(/\.\d+$/, '');
    const mat = palette.byName[name];
    if (mat) m.material = mat;
    m.castShadow = name !== 'glow' && name !== 'glass' && name !== 'label';
    m.receiveShadow = true;
  });
}
