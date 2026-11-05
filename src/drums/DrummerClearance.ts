// Does the drummer pass through anything? Sticks, hands, forearms and legs as
// capsules (DRUMMER.capsules), the kit as the solids of KitProxy. A stick may
// touch the surface it is striking near its contact point, and nothing else;
// the two sticks, the forearms and the other hand's stick must stay apart.
// A diagnostic for tests and the lab, not for every frame.
import { DRUMMER, J, apply3, vec3, type Side } from './DrummerSpec';
import type { DrummerPose, DrummerTargets } from './DrummerIK';
import { kitProxies, proxyDistance, segSegDistance, type Proxy } from './KitProxy';

export interface Contact {
  /** e.g. "stick R" */
  a: string;
  /** e.g. "crash", "hi-hat rod", "forearm L" */
  b: string;
  /** clearance in metres: negative is overlap */
  distance: number;
}

interface Capsule {
  name: string;
  a: Float64Array;
  b: Float64Array;
  r: number;
  side?: Side;
  stick?: boolean;
}

const CAP = DRUMMER.capsules;
const STICK_R = (DRUMMER.stick.diameter + DRUMMER.stick.tipDiameter) / 4;

const label = (p: Proxy) => (p.kind === 'rod' ? p.label : p.id === 'hihat' ? 'hi-hat' : p.id);

/** the drummer's capsules in a solved pose */
export function bodyCapsules(pose: DrummerPose): Capsule[] {
  const P = (j: number) => pose.pos.subarray(j * 3, j * 3 + 3) as Float64Array;
  const caps: Capsule[] = [];
  for (const s of ['R', 'L'] as Side[]) {
    const a = J.arm[s];
    const st = pose.stick[s];
    caps.push({ name: `stick ${s}`, a: st.butt, b: st.tip, r: STICK_R, side: s, stick: true });
    caps.push({ name: `forearm ${s}`, a: P(a.forearm), b: P(a.hand), r: CAP.forearm, side: s });
    caps.push({ name: `upper arm ${s}`, a: P(a.upper), b: P(a.forearm), r: CAP.upperArm, side: s });
    // the hand: from the wrist to the knuckles, and down to the curled fingers
    const k = vec3();
    apply3(k, pose.world, [0, -0.012, -0.085], a.palm * 9);
    for (let i = 0; i < 3; i++) k[i] += pose.pos[a.palm * 3 + i];
    caps.push({ name: `hand ${s}`, a: P(a.hand), b: k, r: CAP.hand, side: s });
    const l = J.leg[s];
    caps.push({ name: `thigh ${s}`, a: P(l.thigh), b: P(l.shin), r: CAP.thigh, side: s });
    caps.push({ name: `shin ${s}`, a: P(l.shin), b: P(l.foot), r: CAP.shin, side: s });
  }
  caps.push({ name: 'torso', a: P(J.pelvis), b: P(J.neck), r: CAP.torso });
  return caps;
}

/**
 * Every place the drummer comes closer than `margin` to the kit or to itself
 * (between parts that should never meet), closest first.
 */
export function clearance(pose: DrummerPose, targets: DrummerTargets, opts: { margin?: number; hihatOpen?: boolean } = {}): Contact[] {
  const margin = opts.margin ?? 0;
  const kit = kitProxies({ hihatOpen: opts.hihatOpen });
  const caps = bodyCapsules(pose);
  const out: Contact[] = [];
  const pt = new Float64Array(3);
  const SAMPLES = 40;
  // the surface each stick is striking (its contact point lies on it), and where on the stick it may touch
  const struck: Record<Side, Proxy | null> = { R: null, L: null };
  for (const s of ['R', 'L'] as Side[]) {
    const t = targets[s];
    let best: Proxy | null = null;
    let bd = 0.006;
    for (const x of kit) {
      if (x.kind === 'rod') continue;
      const d = Math.abs(proxyDistance(t.point, x));
      if (d < bd) {
        bd = d;
        best = x;
      }
    }
    struck[s] = t.lift > 0.001 ? null : best;
  }
  // body against kit
  for (const c of caps) {
    if (c.name === 'torso') continue;
    for (const x of kit) {
      let min = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const u = i / SAMPLES;
        for (let k = 0; k < 3; k++) pt[k] = c.a[k] + (c.b[k] - c.a[k]) * u;
        // the stick may touch what it strikes near its contact
        if (c.stick && c.side && struck[c.side] === x) {
          const st = pose.stick[c.side];
          const nearContact = Math.hypot(pt[0] - st.contact[0], pt[1] - st.contact[1], pt[2] - st.contact[2]) < 0.035;
          if (nearContact) continue;
        }
        const d = proxyDistance(pt, x) - c.r;
        if (d < min) min = d;
      }
      // a stick crossing a cymbal's plane inside its rim goes through it, whatever the samples say
      if (c.stick && x.kind === 'disc' && !(c.side && struck[c.side] === x)) {
        const ha = (c.a[0] - x.centre[0]) * x.normal[0] + (c.a[1] - x.centre[1]) * x.normal[1] + (c.a[2] - x.centre[2]) * x.normal[2];
        const hb = (c.b[0] - x.centre[0]) * x.normal[0] + (c.b[1] - x.centre[1]) * x.normal[1] + (c.b[2] - x.centre[2]) * x.normal[2];
        if (ha * hb < 0) {
          const u = ha / (ha - hb);
          for (let k = 0; k < 3; k++) pt[k] = c.a[k] + (c.b[k] - c.a[k]) * u;
          const dx = pt[0] - x.centre[0], dy = pt[1] - x.centre[1], dz = pt[2] - x.centre[2];
          const rho = Math.hypot(dx, dy, dz);
          if (rho < x.radius) min = Math.min(min, -(x.radius - rho));
        }
      }
      if (min < margin) out.push({ a: c.name, b: label(x), distance: min });
    }
  }
  // body against body: the pairs that must never meet
  const byName = new Map(caps.map((c) => [c.name, c]));
  const pairs: [string, string][] = [
    ['stick R', 'stick L'],
    ['stick R', 'forearm L'],
    ['stick L', 'forearm R'],
    ['stick R', 'hand L'],
    ['stick L', 'hand R'],
    ['forearm R', 'forearm L'],
    ['hand R', 'hand L'],
    ['hand R', 'forearm L'],
    ['hand L', 'forearm R'],
    ['stick R', 'torso'],
    ['stick L', 'torso'],
    ['stick R', 'thigh R'],
    ['stick R', 'thigh L'],
    ['stick L', 'thigh R'],
    ['stick L', 'thigh L'],
    ['forearm R', 'thigh R'],
    ['forearm L', 'thigh L'],
    ['hand R', 'thigh R'],
    ['hand L', 'thigh L'],
  ];
  for (const [na, nb] of pairs) {
    const a = byName.get(na)!;
    const b = byName.get(nb)!;
    const d = segSegDistance(a.a, a.b, b.a, b.b) - a.r - b.r;
    if (d < margin) out.push({ a: na, b: nb, distance: d });
  }
  out.sort((x, y) => x.distance - y.distance);
  return out;
}

/** a contact as a line of text */
export function describe(c: Contact) {
  return `${c.a} / ${c.b}: ${(c.distance * 1000).toFixed(1)} mm`;
}

