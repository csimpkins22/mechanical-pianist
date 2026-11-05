// The kit as simple solids, from KitLayout: drums as cylinders (shell below
// the batter head), cymbals as their real cross-sections (KitLayout's
// CYMBAL_PROFILES: the bell above the reference plane, the bow falling away
// to the edge, the metal's thickness), the hi-hat as its two cymbals (the
// bottom one upside down, edge to edge with the top when closed), and the
// hardware as rods: every stand, leg, brace, boom, basket and clutch where the
// kit's model puts it (KitStands). The clearance checks and the IK test the
// drummer against these, and the drummer lab can draw them.
import { CYMBAL_PROFILES, DRUMS, HIHAT_OPEN_GAP, cymbalTop, surfaceNormal, type CymbalProfile, type DrumId, type V3 } from './KitLayout';
import { hihatTop, kitStands } from './KitStands';

export interface CymbalProxy {
  kind: 'cymbal';
  id: DrumId;
  /** the centre of its reference plane (the top of the bow at the bell), and the normal its top faces */
  centre: V3;
  normal: V3;
  radius: number;
  profile: CymbalProfile;
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
  /** what it is, for the report */
  label: string;
  a: V3;
  b: V3;
  radius: number;
}
export type Proxy = CymbalProxy | CylinderProxy | RodProxy;

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

/** the kit as solids. `hihatOpen` lifts the hi-hat's top cymbal (pedal up). */
export function kitProxies(opts: { hihatOpen?: boolean } = {}): Proxy[] {
  const out: Proxy[] = [];
  for (const d of Object.values(DRUMS)) {
    const n = surfaceNormal(d);
    const r = d.diameter / 2;
    if (d.kind === 'cymbal') {
      const profile = CYMBAL_PROFILES[d.id as keyof typeof CYMBAL_PROFILES];
      if (d.id === 'hihat') {
        // the top cymbal, lifted when the pedal is up; the bottom one upside down under it, edges meeting
        const gap = opts.hihatOpen ? HIHAT_OPEN_GAP : 0;
        out.push({ kind: 'cymbal', id: d.id, centre: add(d.centre, n, gap), normal: n, radius: r, profile });
        const below = 2 * profile.drop + 2 * profile.thickness[2] + 0.0005;
        out.push({ kind: 'cymbal', id: d.id, centre: add(d.centre, n, -below), normal: neg(n), radius: r, profile });
        for (const x of hihatTop(gap)) out.push({ kind: 'rod', ...x });
      } else out.push({ kind: 'cymbal', id: d.id, centre: d.centre, normal: n, radius: r, profile });
      continue;
    }
    if (d.id === 'kick') {
      out.push({ kind: 'cylinder', id: d.id, centre: d.centre, normal: [0, 0, 1], radius: r, depth: d.depth });
      continue;
    }
    out.push({ kind: 'cylinder', id: d.id, centre: d.centre, normal: n, radius: r, depth: d.depth });
  }
  for (const x of kitStands().rods) out.push({ kind: 'rod', ...x });
  return out;
}

/** a cymbal's metal thickness r metres from its centre (as the kit's model makes it) */
export function cymbalThickness(p: CymbalProfile, R: number, r: number): number {
  if (r < p.bellRadius) return p.thickness[0];
  const u = Math.min(1, Math.max(0, (r - p.bellRadius) / (R - p.bellRadius)));
  return p.thickness[1] + (p.thickness[2] - p.thickness[1]) * u * u;
}

// ---------------------------------------------------------------- distances (signed: negative inside)
type P = ArrayLike<number>;

/** signed distance from a point to a proxy's surface */
export function proxyDistance(p: P, x: Proxy): number {
  if (x.kind === 'cymbal') return cymbalDistance(p, x);
  if (x.kind === 'cylinder') return cylinderDistance(p, x.centre, x.normal, x.radius, x.depth);
  return segPointDistance(p, x.a, x.b) - x.radius;
}

/**
 * Where a point is against a cymbal: its height above the middle of the metal
 * (along the cymbal's normal) and its distance from the axis. (Allocation-free:
 * the result goes in `out`.)
 */
export function cymbalSide(p: P, x: CymbalProxy, out: { h: number; rho: number }) {
  const c = x.centre, n = x.normal;
  const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
  const h = dx * n[0] + dy * n[1] + dz * n[2];
  const rho = Math.hypot(dx - n[0] * h, dy - n[1] * h, dz - n[2] * h);
  const r = rho < x.radius ? rho : x.radius;
  out.h = h - (cymbalTop(x.profile, x.radius, r) - cymbalThickness(x.profile, x.radius, r) / 2);
  out.rho = rho;
  return out;
}
const cs = { h: 0, rho: 0 };

/** signed distance from a point to a cymbal's metal: across it, corrected for the slope of its bow and bell */
export function cymbalDistance(p: P, x: CymbalProxy): number {
  cymbalSide(p, x, cs);
  const R = x.radius;
  if (cs.rho >= R) {
    // past the edge: from the rounded edge
    const t = x.profile.thickness[2];
    return Math.hypot(cs.rho - R, Math.max(0, Math.abs(cs.h) - t / 2));
  }
  const t = cymbalThickness(x.profile, R, cs.rho);
  const e = 0.002;
  const r0 = Math.max(0, cs.rho - e), r1 = Math.min(R, cs.rho + e);
  const slope = (cymbalTop(x.profile, R, r1) - cymbalTop(x.profile, R, r0)) / (r1 - r0);
  return (Math.abs(cs.h) - t / 2) / Math.sqrt(1 + slope * slope);
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
