// The drummer as capsules between its joints, straight from the spec and a
// solved pose: the lab's skeleton view, for judging the IK before (or
// alongside) the modelled robot. Updating allocates nothing.
import * as THREE from 'three';
import { DRUMMER, J, type Side } from '../DrummerSpec';
import type { DrummerPose } from '../DrummerIK';

const Y = new THREE.Vector3(0, 1, 0);
const ta = new THREE.Vector3();
const tb = new THREE.Vector3();
const td = new THREE.Vector3();
const tm = new THREE.Matrix4();

interface Bone {
  mesh: THREE.Mesh;
  a: (p: DrummerPose, o: THREE.Vector3) => THREE.Vector3;
  b: (p: DrummerPose, o: THREE.Vector3) => THREE.Vector3;
}

const at = (j: number) => (p: DrummerPose, o: THREE.Vector3) => o.set(p.pos[j * 3], p.pos[j * 3 + 1], p.pos[j * 3 + 2]);
/** a point in joint j's frame */
const local = (j: number, x: number, y: number, z: number) => (p: DrummerPose, o: THREE.Vector3) => {
  const R = p.world;
  const i = j * 9;
  return o.set(R[i] * x + R[i + 1] * y + R[i + 2] * z + p.pos[j * 3], R[i + 3] * x + R[i + 4] * y + R[i + 5] * z + p.pos[j * 3 + 1], R[i + 6] * x + R[i + 7] * y + R[i + 8] * z + p.pos[j * 3 + 2]);
};

export class SkeletonFigure {
  readonly root = new THREE.Group();
  private bones: Bone[] = [];

  constructor(mat = new THREE.MeshStandardMaterial({ color: 0xd9d4cc, roughness: 0.45 }), stickMat = new THREE.MeshStandardMaterial({ color: 0xc8a272, roughness: 0.6 })) {
    this.root.name = 'Skeleton';
    const C = DRUMMER.capsules;
    const add = (r: number, a: Bone['a'], b: Bone['b'], m: THREE.Material = mat) => {
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, 1, 6, 16), m);
      mesh.castShadow = mesh.receiveShadow = true;
      this.root.add(mesh);
      this.bones.push({ mesh, a, b });
    };
    add(C.torso * 0.9, at(J.pelvis), at(J.spine2));
    add(C.torso, at(J.spine2), at(J.neck));
    add(0.05, at(J.neck), at(J.head));
    add(C.head, local(J.head, 0, 0.07, -0.02), local(J.head, 0, 0.09, -0.01));
    for (const s of ['R', 'L'] as Side[]) {
      const a = J.arm[s];
      const sx = s === 'R' ? 1 : -1;
      add(0.03, at(a.clavicle), at(a.upper));
      add(C.upperArm, at(a.upper), at(a.forearm));
      add(C.forearm, at(a.forearm), at(a.hand));
      add(0.03, at(a.palm), local(a.palm, sx * 0.004, -0.005, -0.09));
      add(0.012, local(a.palm, sx * -0.02, -0.01, -0.06), local(a.palm, sx * -0.03, -0.035, -0.1));
      const l = J.leg[s];
      add(C.thigh, at(l.thigh), at(l.shin));
      add(C.shin, at(l.shin), at(l.foot));
      add(0.035, local(l.foot, 0, -0.04, 0.03), local(l.foot, 0, -0.045, -0.14));
      add(0.025, at(l.toes), local(l.toes, 0, -0.005, -0.055));
      const st = (k: 'butt' | 'tip') => (p: DrummerPose, o: THREE.Vector3) => o.set(p.stick[s][k][0], p.stick[s][k][1], p.stick[s][k][2]);
      add(DRUMMER.stick.diameter / 2, st('butt'), st('tip'), stickMat);
    }
  }

  update(p: DrummerPose) {
    for (const b of this.bones) {
      b.a(p, ta);
      b.b(p, tb);
      td.subVectors(tb, ta);
      const len = td.length();
      b.mesh.position.addVectors(ta, tb).multiplyScalar(0.5);
      b.mesh.quaternion.setFromUnitVectors(Y, td.multiplyScalar(1 / (len || 1)));
      // the capsule's cylinder is 1 m long: scale it to the bone, keeping the rounded ends
      b.mesh.scale.set(1, 1, 1);
      const r = (b.mesh.geometry as THREE.CapsuleGeometry).parameters.radius;
      b.mesh.scale.y = Math.max(0.001, len) / (1 + 2 * r) + (2 * r) / (1 + 2 * r);
      void tm;
    }
  }
}
