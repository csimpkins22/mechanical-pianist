// A placeholder drum kit for the drummer lab: plain cylinders and discs from
// KitLayout (through KitProxy, the same solids the clearance checks use), so
// the drummer can be judged against where everything really is. The real kit
// is modelled elsewhere.
import * as THREE from 'three';
import { DRUMS, PEDALS, SEAT, type DrumId, type PedalId } from '../KitLayout';
import { kitProxies, type Proxy } from '../KitProxy';

const up = new THREE.Vector3(0, 1, 0);

function along(mesh: THREE.Object3D, n: ArrayLike<number>) {
  mesh.quaternion.setFromUnitVectors(up, new THREE.Vector3(n[0], n[1], n[2]).normalize());
}

export interface KitMaterials {
  shell: THREE.Material;
  head: THREE.Material;
  chrome: THREE.Material;
  bronze: THREE.Material;
  leather: THREE.Material;
  rug: THREE.Material;
  rubber: THREE.Material;
  felt: THREE.Material;
}

export function kitMaterials(): KitMaterials {
  return {
    shell: new THREE.MeshPhysicalMaterial({ color: 0x3a0d12, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    head: new THREE.MeshPhysicalMaterial({ color: 0xe9e4d8, roughness: 0.62, sheen: 0.3, sheenColor: new THREE.Color(0xffffff) }),
    chrome: new THREE.MeshPhysicalMaterial({ color: 0xe8eaee, metalness: 1, roughness: 0.12 }),
    bronze: new THREE.MeshPhysicalMaterial({ color: 0xc9953f, metalness: 1, roughness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
    leather: new THREE.MeshPhysicalMaterial({ color: 0x141312, roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0x553322) }),
    rug: new THREE.MeshStandardMaterial({ color: 0x2a1a17, roughness: 0.97 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }),
    felt: new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.95 }),
  };
}

export class PlaceholderKit {
  readonly root = new THREE.Group();
  /** footboards, turned about their heel hinges by the pose */
  readonly boards: Record<PedalId, THREE.Object3D> = {} as Record<PedalId, THREE.Object3D>;
  private hatTop: THREE.Object3D | null = null;
  private hatOpenY = 0;

  constructor(readonly mats: KitMaterials = kitMaterials()) {
    this.root.name = 'PlaceholderKit';
    const m = mats;
    // the rug and the throne
    const rug = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.008, 1.9), m.rug);
    rug.position.set(0.05, 0.004, -0.42);
    rug.receiveShadow = true;
    this.root.add(rug);
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(SEAT.diameter / 2, SEAT.diameter / 2 - 0.01, 0.085, 48), m.leather);
    seat.position.set(SEAT.centre[0], SEAT.centre[1] - 0.0425, SEAT.centre[2]);
    this.root.add(seat);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, SEAT.centre[1] - 0.085, 16), m.chrome);
    post.position.set(SEAT.centre[0], (SEAT.centre[1] - 0.085) / 2, SEAT.centre[2]);
    this.root.add(post);
    this.tripod(new THREE.Vector3(SEAT.centre[0], 0, SEAT.centre[2]), 0.28, 0.22);

    const proxies = kitProxies();
    for (const p of proxies) this.root.add(this.solid(p));
    // pedals: a footboard hinged at the heel, a beater for the kick
    for (const id of Object.keys(PEDALS) as PedalId[]) {
      const pd = PEDALS[id];
      const heel = new THREE.Vector3(...pd.heel);
      const ball = new THREE.Vector3(...pd.ball);
      const dir = ball.clone().sub(heel);
      const len = dir.length() + 0.09;
      const hinge = new THREE.Group();
      hinge.position.copy(heel).setY(heel.y - 0.012);
      hinge.lookAt(heel.clone().add(dir.clone().setY(dir.y)));
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.01, len), m.chrome);
      board.position.set(0, 0, len / 2 - 0.02);
      board.castShadow = board.receiveShadow = true;
      // pressing turns the board about its own x at the heel (positive x turns its front down)
      const press = new THREE.Group();
      press.add(board);
      hinge.add(press);
      this.root.add(hinge);
      this.boards[id] = press;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, len + 0.04), m.rubber);
      base.position.set(pd.heel[0] + dir.x * 0.5, 0.006, pd.heel[2] + dir.z * 0.5);
      base.rotation.y = Math.atan2(dir.x, dir.z);
      this.root.add(base);
      if (id === 'kickPedal') {
        const k = DRUMS.kick;
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.025), m.chrome);
        frame.position.set(pd.ball[0], 0.12, k.centre[2] + 0.06);
        this.root.add(frame);
        const beater = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 8), m.chrome);
        beater.position.set(pd.ball[0], k.centre[1] - 0.02, k.centre[2] + 0.04);
        beater.rotation.x = -0.35;
        this.root.add(beater);
        const felt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.035, 20), m.felt);
        felt.rotation.z = Math.PI / 2;
        felt.position.set(pd.ball[0], k.centre[1] + 0.07, k.centre[2] + 0.005);
        this.root.add(felt);
      }
    }
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    rug.castShadow = false;
  }

  /** the hi-hat open (pedal up) or closed; footboards turned (radians, negative pressed) */
  update(pedal: Record<PedalId, number>, hihatOpen: number) {
    for (const id of Object.keys(this.boards) as PedalId[]) {
      this.boards[id].rotation.x = -pedal[id];
    }
    if (this.hatTop) this.hatTop.position.y = (this.hatTop.userData.y0 ??= this.hatTop.position.y) + hihatOpen * this.hatOpenY;
  }

  private tripod(at: THREE.Vector3, spread: number, height: number) {
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3 + 0.4;
      const foot = new THREE.Vector3(at.x + Math.sin(a) * spread, 0.01, at.z + Math.cos(a) * spread);
      const top = new THREE.Vector3(at.x, height, at.z);
      this.root.add(this.rod(foot, top, 0.008, this.mats.chrome));
    }
  }

  private rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) {
    const d = b.clone().sub(a);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 12), mat);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(up, d.normalize());
    return mesh;
  }

  private solid(p: Proxy): THREE.Object3D {
    const m = this.mats;
    if (p.kind === 'rod') {
      const g = new THREE.Group();
      g.add(this.rod(new THREE.Vector3(...p.a), new THREE.Vector3(...p.b), p.radius * 0.8, m.chrome));
      if (p.a[1] < 0.01 && !p.label.includes('leg')) this.tripod(new THREE.Vector3(p.a[0], 0, p.a[2]), 0.25, 0.3);
      return g;
    }
    if (p.kind === 'disc') {
      // a cymbal: a thin bronze disc with a low bell, in its playing plane
      const g = new THREE.Group();
      const prof: THREE.Vector2[] = [];
      const R = p.radius;
      const bell = Math.min(0.06, R * 0.24);
      const pts = 28;
      for (let i = 0; i <= pts; i++) {
        const r = (i / pts) * R;
        const y = r < bell ? 0.014 * Math.cos((Math.PI / 2) * (r / bell)) ** 1.5 : -0.006 * ((r - bell) / (R - bell)) ** 1.4;
        prof.push(new THREE.Vector2(Math.max(r, 1e-4), y + 0.0015));
      }
      for (let i = pts; i >= 0; i--) prof.push(new THREE.Vector2(Math.max(prof[i].x, 1e-4), prof[i].y - 0.002));
      const mesh = new THREE.Mesh(new THREE.LatheGeometry(prof, 64), m.bronze);
      g.add(mesh);
      g.position.set(...p.centre);
      along(g, p.normal);
      if (p.id === 'hihat' && p.centre[1] >= DRUMS.hihat.centre[1] - 1e-6) {
        this.hatTop = g;
        this.hatOpenY = 0.025;
      }
      return g;
    }
    // a drum: shell, batter head, hoops
    const g = new THREE.Group();
    const r = p.radius;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, p.depth, 64, 1, true), m.shell);
    shell.position.y = -p.depth / 2;
    g.add(shell);
    const head = new THREE.Mesh(new THREE.CircleGeometry(r - 0.004, 64), m.head);
    head.rotation.x = -Math.PI / 2;
    head.position.y = -0.0005;
    g.add(head);
    const reso = new THREE.Mesh(new THREE.CircleGeometry(r - 0.004, 64), p.id === 'kick' ? m.shell : m.head);
    reso.rotation.x = Math.PI / 2;
    reso.position.y = -p.depth;
    g.add(reso);
    for (const y of [0.004, -p.depth - 0.004]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, 0.0055, 8, 64), p.id === 'kick' ? m.shell : m.chrome);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = y;
      g.add(hoop);
    }
    // tension rods round the shell
    const lugs = p.id === 'kick' ? 10 : r > 0.17 ? 8 : 6;
    for (let k = 0; k < lugs; k++) {
      const a = (k / lugs) * Math.PI * 2;
      const lug = new THREE.Mesh(new THREE.BoxGeometry(0.012, Math.min(0.07, p.depth * 0.45), 0.014), m.chrome);
      lug.position.set(Math.cos(a) * (r + 0.006), -p.depth / 2, Math.sin(a) * (r + 0.006));
      lug.rotation.y = -a;
      g.add(lug);
    }
    g.position.set(...p.centre);
    along(g, p.normal);
    g.userData.drum = p.id as DrumId;
    return g;
  }
}
