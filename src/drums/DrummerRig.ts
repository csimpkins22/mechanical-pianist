// Binds a DrummerPose (pure data from DrummerIK) to the robot drummer's node
// hierarchy (public/assets/robot_drummer.glb, built by
// tools/blender/build_drummer.py). Every joint node has its origin on its
// pivot and an identity rest rotation, so a pose's local rotations go straight
// onto the nodes; the hands' own nodes (R_/L_ + the robot hand's names) take
// the grip's finger rotations, and the wrist's segmented rings share the
// wrist's bend as on the piano's hands. Applying a pose allocates nothing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRUMMER, J, JOINTS, NJ, type Side } from './DrummerSpec';
import { FINGER_NODES, type DrummerPose } from './DrummerIK';
import { applyDrummerPalette, type DrummerPalette } from './drummerMaterials';

const m4 = new THREE.Matrix4();
const qi = new THREE.Quaternion();

function setRot(o: THREE.Object3D, R: ArrayLike<number>, i = 0) {
  m4.set(R[i], R[i + 1], R[i + 2], 0, R[i + 3], R[i + 4], R[i + 5], 0, R[i + 6], R[i + 7], R[i + 8], 0, 0, 0, 0, 1);
  o.quaternion.setFromRotationMatrix(m4);
}

/** load the drummer's glTF and give it the drummer's materials */
export async function loadDrummer(url: string, palette: DrummerPalette): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync(url);
  applyDrummerPalette(gltf.scene, palette);
  return gltf.scene;
}

export class DrummerRig {
  readonly root: THREE.Object3D;
  /** the joint nodes, in spec order */
  readonly joints: THREE.Object3D[] = [];
  private fingers: Record<Side, THREE.Object3D[]> = { R: [], L: [] };
  private rings: Record<Side, THREE.Object3D[]> = { R: [], L: [] };
  private glows: THREE.MeshStandardMaterial[] = [];

  constructor(template: THREE.Object3D, palette?: DrummerPalette) {
    this.root = template.clone(true);
    this.root.name = 'RobotDrummer';
    const byName = new Map<string, THREE.Object3D>();
    this.root.traverse((o) => {
      if (o.name) byName.set(o.name, o);
    });
    const need = (n: string) => {
      const o = byName.get(n);
      if (!o) throw new Error(`robot drummer model is missing node ${n}`);
      return o;
    };
    for (const j of JOINTS) this.joints.push(need(j.name));
    for (const s of ['R', 'L'] as Side[]) {
      const pre = DRUMMER.hand.prefix[s];
      this.fingers[s] = FINGER_NODES.map((n) => need(pre + n));
      // the wrist's spine: rings and core share the bend between the forearm and the palm
      this.rings[s] = ['WristRing2', 'WristRing1', 'WristCore'].map((n) => need(pre + n));
    }
    // the model's root sits on the seat; the IK says where
    const top = byName.get('Drummer');
    if (top && top !== this.root) {
      top.position.set(0, 0, 0);
      top.quaternion.identity();
    }
    if (palette) {
      // one servo-light material per side, so each can breathe on its own
      for (const s of ['R', 'L'] as Side[]) {
        const m = palette.glow.clone();
        const arm = this.joints[J.arm[s].clavicle];
        arm.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.material === palette.glow) mesh.material = m;
        });
        this.glows.push(m);
      }
      this.glows.push(palette.glow);
    }
  }

  /** the servo rings' brightness: the whole body, then each arm a little brighter with its effort (0..1) */
  setGlow(base: number, effortR = 0, effortL = 0) {
    if (!this.glows.length) return;
    this.glows[0].emissiveIntensity = base * (1 + 0.6 * effortR);
    this.glows[1].emissiveIntensity = base * (1 + 0.6 * effortL);
    this.glows[2].emissiveIntensity = base;
  }

  apply(p: DrummerPose) {
    this.root.position.set(p.root[0], p.root[1], p.root[2]);
    for (let j = 0; j < NJ; j++) setRot(this.joints[j], p.local, j * 9);
    for (const s of ['R', 'L'] as Side[]) {
      const F = this.fingers[s];
      const L = p.fingers[s];
      for (let k = 0; k < F.length; k++) setRot(F[k], L, k * 9);
      const palm = this.joints[J.arm[s].palm].quaternion;
      const r = this.rings[s];
      r[0].quaternion.slerpQuaternions(qi, palm, 0.33);
      r[1].quaternion.slerpQuaternions(qi, palm, 0.66);
      r[2].quaternion.slerpQuaternions(qi, palm, 0.82);
    }
  }
}
