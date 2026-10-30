// Binds a HandPose (pure data from the performance layer) to the robot hand's
// node hierarchy. The left hand is the right-hand model mirrored by its root's
// negative x scale; all rotations stay in the canonical right-hand frame.
import * as THREE from 'three';
import { FINGERS, THUMB, flex, mul, rotY, rotZ, thumbBase, type M3 } from '../core/handGeometry';
import type { Hand } from '../core/types';
import type { HandPose } from '../performance/HandPoser';

const m4 = new THREE.Matrix4();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

function setRot(o: THREE.Object3D, m: M3) {
  m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
  o.quaternion.setFromRotationMatrix(m4);
}

const T_BASE = thumbBase(THUMB);

export class HandRig {
  readonly root: THREE.Object3D;
  private node: Record<string, THREE.Object3D> = {};

  constructor(template: THREE.Object3D, readonly hand: Hand) {
    this.root = template.clone(true);
    this.root.name = hand === 'R' ? 'RightHand' : 'LeftHand';
    this.root.traverse((o) => {
      if (o.name) this.node[o.name] = o;
    });
    const required = ['Palm', 'Forearm', 'WristCore', 'WristRing1', 'WristRing2', 'T_0', 'T_1', 'T_2', ...FINGERS.flatMap((f) => [0, 1, 2].map((k) => `F${f.id}_${k}`))];
    for (const r of required) if (!this.node[r]) throw new Error(`robot hand model is missing node ${r}`);
    // the Blender root node carries the hierarchy; we drive it from here
    const handNode = this.node['Hand'];
    if (handNode && handNode !== this.root) {
      handNode.position.set(0, 0, 0);
      handNode.quaternion.identity();
    }
    this.root.scale.set(hand === 'R' ? 1 : -1, 1, 1);
  }

  get(name: string) {
    return this.node[name];
  }

  apply(p: HandPose) {
    this.root.position.set(p.wrist[0], p.wrist[1], p.wrist[2]);
    setRot(this.node['Palm'], p.rot);
    setRot(this.node['Forearm'], p.forearm);
    // the wrist spine shares the bend between forearm and palm
    qa.copy(this.node['Forearm'].quaternion);
    qb.copy(this.node['Palm'].quaternion);
    this.node['WristRing2'].quaternion.slerpQuaternions(qa, qb, 0.33);
    this.node['WristRing1'].quaternion.slerpQuaternions(qa, qb, 0.66);
    this.node['WristCore'].quaternion.slerpQuaternions(qa, qb, 0.82);
    FINGERS.forEach((f, i) => {
      const s = p.fingers[i];
      setRot(this.node[`F${f.id}_0`], mul(rotY(f.baseYaw + s.abduction), flex(s.angles[0])));
      setRot(this.node[`F${f.id}_1`], flex(s.angles[1]));
      setRot(this.node[`F${f.id}_2`], flex(s.angles[2]));
    });
    const t = p.thumb;
    setRot(this.node['T_0'], mul(mul(mul(rotY(t.swing), T_BASE), rotZ(t.twist)), flex(t.angles[0])));
    setRot(this.node['T_1'], flex(t.angles[1]));
    setRot(this.node['T_2'], flex(t.angles[2]));
  }
}
