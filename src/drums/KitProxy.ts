// The kit as simple solids, from KitLayout: drums as cylinders (shell below
// the batter head), cymbals as thin discs in the plane of their playing
// surface, stands as rods. The clearance checks test the drummer against
// these, and the drummer lab draws them as a placeholder kit (the real kit is
// modelled elsewhere). Stands are not in KitLayout, so they are placed the
// way a drummer would set them: a snare stand under the snare, rack toms on
// arms from the kick, three legs round the floor tom, a straight stand and
// pull rod under the hi-hat (the rod standing a few centimetres above the
// top cymbal), and boom stands behind the crash and ride.
import { DRUMS, HIHAT_OPEN_GAP, surfaceNormal, type DrumId, type V3 } from './KitLayout';

export interface DiscProxy {
  kind: 'disc';
  id: DrumId;
  centre: V3;
  normal: V3;
  radius: number;
  thickness: number;
}
export interface CylinderProxy {
  kind: 'cylinder';
  id: DrumId;
  /** centre of the batter head, and the head's outward normal; the shell runs `depth` along -normal */
  centre: V3;
  normal: V3;
  radius: number;
  depth: number;
}
export interface RodProxy {
  kind: 'rod';
  id: DrumId;
  /** what it holds up, for the report */
  label: string;
  a: V3;
  b: V3;
  radius: number;
}
export type Proxy = DiscProxy | CylinderProxy | RodProxy;

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** a horizontal unit vector away from the stool (from the seat's axis through a point) */
function away(p: V3): V3 {
  const l = Math.hypot(p[0], p[2]) || 1;
  return [p[0] / l, 0, p[2] / l];
}

/** the kit as solids. `hihatOpen` lifts the hi-hat's top cymbal (pedal up). */
export function kitProxies(opts: { hihatOpen?: boolean } = {}): Proxy[] {
  const out: Proxy[] = [];
  for (const d of Object.values(DRUMS)) {
    const n = surfaceNormal(d);
    const r = d.diameter / 2;
    if (d.kind === 'cymbal') {
      let c = d.centre;
      if (d.id === 'hihat') {
        // top and bottom cymbals; the top rises when the pedal is up
        const gap = opts.hihatOpen ? HIHAT_OPEN_GAP : 0;
        c = add(d.centre, n, gap);
        out.push({ kind: 'disc', id: d.id, centre: c, normal: n, radius: r, thickness: 0.004 });
        out.push({ kind: 'disc', id: d.id, centre: add(d.centre, n, -0.006), normal: n, radius: r, thickness: 0.004 });
        // the stand under it, and the pull rod and clutch standing above the top cymbal
        out.push({ kind: 'rod', id: d.id, label: 'hi-hat stand', a: [d.centre[0], 0, d.centre[2]], b: add(d.centre, n, -0.03), radius: 0.013 });
        out.push({ kind: 'rod', id: d.id, label: 'hi-hat rod', a: c, b: add(c, n, 0.045), radius: 0.006 });
      } else {
        out.push({ kind: 'disc', id: d.id, centre: c, normal: n, radius: r, thickness: 0.004 });
        // a boom stand: its upright behind the cymbal (away from the drummer), the boom up to the tilter under the bell
        const back = away(c);
        const base: V3 = [c[0] + back[0] * 0.3, 0, c[2] + back[2] * 0.3];
        const top: V3 = [base[0], c[1] - 0.32, base[2]];
        out.push({ kind: 'rod', id: d.id, label: `${d.id} stand`, a: base, b: top, radius: 0.014 });
        out.push({ kind: 'rod', id: d.id, label: `${d.id} boom`, a: top, b: add(c, n, -0.035), radius: 0.011 });
      }
      continue;
    }
    if (d.id === 'kick') {
      out.push({ kind: 'cylinder', id: d.id, centre: d.centre, normal: [0, 0, 1], radius: r, depth: d.depth });
      continue;
    }
    out.push({ kind: 'cylinder', id: d.id, centre: d.centre, normal: n, radius: r, depth: d.depth });
    const bottom = add(d.centre, n, -d.depth);
    if (d.id === 'snare') {
      out.push({ kind: 'rod', id: d.id, label: 'snare stand', a: [bottom[0], 0, bottom[2]], b: add(bottom, n, -0.04), radius: 0.012 });
    } else if (d.id === 'floorTom') {
      // three legs round the shell, the first toward the back
      for (let k = 0; k < 3; k++) {
        const a = Math.atan2(d.centre[0], d.centre[2]) + (k * 2 * Math.PI) / 3;
        const lx = d.centre[0] + Math.sin(a) * (r + 0.025);
        const lz = d.centre[2] + Math.cos(a) * (r + 0.025);
        out.push({ kind: 'rod', id: d.id, label: 'floor tom leg', a: [lx, 0, lz], b: [lx, d.centre[1] - 0.04, lz], radius: 0.007 });
      }
    } else {
      // rack toms: an arm from the top of the kick's shell
      const kick = DRUMS.kick;
      const mount: V3 = [kick.centre[0], kick.centre[1] + kick.diameter / 2, Math.min(bottom[2], kick.centre[2] - 0.12)];
      out.push({ kind: 'rod', id: d.id, label: `${d.id} arm`, a: mount, b: add(bottom, n, -0.01), radius: 0.01 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- distances (signed: negative inside)
type P = ArrayLike<number>;

/** signed distance from a point to a proxy's surface */
export function proxyDistance(p: P, x: Proxy): number {
  if (x.kind === 'disc') return discDistance(p, x.centre, x.normal, x.radius, x.thickness);
  if (x.kind === 'cylinder') return cylinderDistance(p, x.centre, x.normal, x.radius, x.depth);
  return segPointDistance(p, x.a, x.b) - x.radius;
}

export function discDistance(p: P, c: P, n: P, R: number, t: number) {
  const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
  const h = dx * n[0] + dy * n[1] + dz * n[2];
  const qx = dx - n[0] * h, qy = dy - n[1] * h, qz = dz - n[2] * h;
  const rho = Math.hypot(qx, qy, qz);
  const ah = Math.abs(h) - t / 2;
  if (rho <= R) return ah;
  return Math.hypot(rho - R, Math.max(0, ah)) * (ah > 0 || rho > R ? 1 : -1);
}

export function cylinderDistance(p: P, c: P, n: P, R: number, depth: number) {
  const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
  // height below the head along the shell
  const h = -(dx * n[0] + dy * n[1] + dz * n[2]);
  const rho = Math.hypot(dx + n[0] * h, dy + n[1] * h, dz + n[2] * h);
  const ex = rho - R;
  const ey = Math.max(-h, h - depth);
  if (ex <= 0 && ey <= 0) return Math.max(ex, ey);
  return Math.hypot(Math.max(0, ex), Math.max(0, ey));
}

export function segPointDistance(p: P, a: P, b: P) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz || 1e-12;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a[0] + abx * t - p[0], a[1] + aby * t - p[1], a[2] + abz * t - p[2]);
}

/** closest distance between segments ab and cd */
export function segSegDistance(a: P, b: P, c: P, d: P) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - c[0], vy = d[1] - c[1], vz = d[2] - c[2];
  const wx = a[0] - c[0], wy = a[1] - c[1], wz = a[2] - c[2];
  const A = ux * ux + uy * uy + uz * uz;
  const B = ux * vx + uy * vy + uz * vz;
  const C = vx * vx + vy * vy + vz * vz;
  const D = ux * wx + uy * wy + uz * wz;
  const E = vx * wx + vy * wy + vz * wz;
  const den = A * C - B * B;
  let s = den > 1e-12 ? (B * E - C * D) / den : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  let t = C > 1e-12 ? (B * s + E) / C : 0;
  if (t < 0) {
    t = 0;
    s = A > 1e-12 ? Math.min(1, Math.max(0, -D / A)) : 0;
  } else if (t > 1) {
    t = 1;
    s = A > 1e-12 ? Math.min(1, Math.max(0, (B - D) / A)) : 0;
  }
  return Math.hypot(wx + ux * s - vx * t, wy + uy * s - vy * t, wz + uz * s - vz * t);
}
