// Debug visualisation for the fingering and kinematics: never shown in the
// cinematic presentation unless asked for.
//   - fingertip targets, coloured by phase; red when a finger on a key cannot reach it
//   - actual fingertip positions (from the IK) and the error between them
//   - contact points on the keys for the notes being played and prepared
//   - each wrist's planned path, one second back and two ahead
//   - joint positions of both rigs
//   - finger numbers and note names, as screen labels
import * as THREE from 'three';
import { noteName } from '../core/keyboard';
import type { Hand } from '../core/types';
import type { HandTrack } from '../performance/MotionPlanner';
import type { FrameState } from '../performance/PerformanceTimeline';
import type { HandRig } from './HandRig';

const PHASE_COLOR: Record<string, number> = {
  idle: 0x8a8a8a,
  prepare: 0xf2c84b,
  attack: 0xff8a3d,
  hold: 0x5bd37a,
  release: 0x4cc9d6,
};
const HAND_COLOR: Record<Hand, string> = { L: '#7fb2ff', R: '#ffb070' };

export class DebugOverlay {
  readonly group = new THREE.Group();
  private targets: THREE.Mesh[] = [];
  private tips: THREE.Mesh[] = [];
  private errLines: THREE.Line[] = [];
  private contacts: THREE.Mesh[] = [];
  private paths: Record<Hand, THREE.Line>;
  private joints: THREE.Points;
  private labels: HTMLDivElement[] = [];
  private labelRoot: HTMLDivElement;
  private v = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.group.name = 'DebugOverlay';
    const sph = new THREE.SphereGeometry(0.0026, 12, 8);
    const ring = new THREE.TorusGeometry(0.004, 0.0006, 6, 20);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(sph, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 100;
      this.targets.push(m);
      const tip = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      tip.renderOrder = 101;
      this.tips.push(tip);
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const l = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xff3030, depthTest: false }));
      l.renderOrder = 102;
      this.errLines.push(l);
      const c = new THREE.Mesh(new THREE.RingGeometry(0.0035, 0.0055, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, side: THREE.DoubleSide }));
      c.rotation.x = -Math.PI / 2;
      c.renderOrder = 99;
      this.contacts.push(c);
      this.group.add(m, tip, l, c);
    }
    const mkPath = (col: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.8 }));
      l.renderOrder = 98;
      l.frustumCulled = false;
      this.group.add(l);
      return l;
    };
    this.paths = { L: mkPath(0x7fb2ff), R: mkPath(0xffb070) };
    const jg = new THREE.BufferGeometry();
    jg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 24 * 3), 3));
    this.joints = new THREE.Points(jg, new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthTest: false }));
    this.joints.renderOrder = 103;
    this.joints.frustumCulled = false;
    this.group.add(this.joints);
    this.labelRoot = document.createElement('div');
    this.labelRoot.className = 'debug-labels';
    container.appendChild(this.labelRoot);
    for (let i = 0; i < 10; i++) {
      const d = document.createElement('div');
      d.className = 'debug-label';
      this.labelRoot.appendChild(d);
      this.labels.push(d);
    }
    this.setVisible(false);
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    this.labelRoot.style.display = v ? 'block' : 'none';
  }

  get visible() {
    return this.group.visible;
  }

  update(frame: FrameState, tracks: Record<Hand, HandTrack>, rigs: Record<Hand, HandRig>, camera: THREE.Camera, w: number, h: number) {
    if (!this.group.visible) return;
    let k = 0;
    for (const hand of ['L', 'R'] as Hand[]) {
      const pose = frame.hands[hand];
      for (let f = 1; f <= 5; f++, k++) {
        const st = pose.states[f];
        const inContact = st.phase === 'attack' || st.phase === 'hold' || (st.phase === 'release' && st.note);
        const err = Math.hypot(st.tip[0] - st.target[0], st.tip[1] - st.target[1], st.tip[2] - st.target[2]);
        const bad = inContact && err > 0.0015;
        const tm = this.targets[k];
        tm.position.set(st.target[0], st.target[1], st.target[2]);
        (tm.material as THREE.MeshBasicMaterial).color.setHex(bad ? 0xff2020 : PHASE_COLOR[st.phase]);
        const tip = this.tips[k];
        tip.position.set(st.tip[0], st.tip[1], st.tip[2]);
        tip.lookAt(camera.position);
        const line = this.errLines[k];
        line.visible = err > 0.001;
        if (line.visible) {
          const p = line.geometry.getAttribute('position') as THREE.BufferAttribute;
          p.setXYZ(0, st.tip[0], st.tip[1], st.tip[2]);
          p.setXYZ(1, st.target[0], st.target[1], st.target[2]);
          p.needsUpdate = true;
        }
        const pn = st.note ?? st.next;
        const c = this.contacts[k];
        c.visible = !!pn;
        if (pn) {
          c.position.set(pn.cx, pn.key.topY + 0.0004, pn.cz);
          (c.material as THREE.MeshBasicMaterial).color.set(HAND_COLOR[hand]);
        }
        // label: finger number, and the note when playing or preparing
        this.v.set(st.tip[0], st.tip[1] + 0.012, st.tip[2]).project(camera);
        const lab = this.labels[k];
        const on = this.v.z < 1;
        lab.style.display = on ? 'block' : 'none';
        if (on) {
          lab.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px)`;
          lab.style.color = HAND_COLOR[hand];
          lab.textContent = `${hand}${f}${pn ? ' ' + noteName(pn.note.midi) : ''}${bad ? ` ⚠ ${(err * 1000).toFixed(1)}mm` : ''}`;
        }
      }
      // planned wrist path
      const tr = tracks[hand];
      const pa = this.paths[hand].geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < 90; i++) {
        const t = frame.t - 1 + (i / 89) * 3;
        pa.setXYZ(i, tr.x.at(t), tr.y.at(t), tr.z.at(t));
      }
      pa.needsUpdate = true;
    }
    // joints of both rigs
    const ja = this.joints.geometry.getAttribute('position') as THREE.BufferAttribute;
    let j = 0;
    for (const hand of ['L', 'R'] as Hand[]) {
      const rig = rigs[hand];
      for (const name of ['Palm', 'T_0', 'T_1', 'T_2', 'F2_0', 'F2_1', 'F2_2', 'F3_0', 'F3_1', 'F3_2', 'F4_0', 'F4_1', 'F4_2', 'F5_0', 'F5_1', 'F5_2', 'Forearm', 'WristCore']) {
        const o = rig.get(name);
        if (!o || j >= 48) continue;
        o.getWorldPosition(this.v);
        ja.setXYZ(j++, this.v.x, this.v.y, this.v.z);
      }
    }
    ja.needsUpdate = true;
    this.joints.geometry.setDrawRange(0, j);
  }
}
