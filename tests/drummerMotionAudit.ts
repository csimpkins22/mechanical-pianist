// The drummer's planned performance of a library groove, sampled at 120 frames a second as a film would be,
// and checked frame by frame (tests/drummerMotion-*.test.ts): contacts with the kit as it moves and between the
// arms, joint limits, the speeds and accelerations of the hands and the sticks' tips, the feet on their boards.
import { readFileSync } from 'node:fs';
import { readDrumMidi, type DrumPerformance } from '../src/drums/DrumScore';
import { assignLimbs, type Sticking } from '../src/drums/Sticking';
import { KitMotion } from '../src/drums/KitMotion';
import { DrummerMotion, blankTargets } from '../src/drums/DrummerMotion';
import { createPose, limitViolations, PEDAL_TRAVEL } from '../src/drums/DrummerIK';
import { clearance, type Contact } from '../src/drums/DrummerClearance';
import { posedProxies } from '../src/drums/KitPose';
import { DRUMMER, J, apply3, vec3 } from '../src/drums/DrummerSpec';
import { PEDAL_BOARDS, PRESS_MIN, footboardAt } from '../src/drums/KitLayout';

export const GROOVES = ['groove-rock-87', 'groove-funk-102', 'groove-jazz-93'] as const;

export function loadGroove(name: string) {
  const perf = readDrumMidi(new Uint8Array(readFileSync(`src/music/drums/${name}.mid`)), name);
  const sticking = assignLimbs(perf);
  const kit = new KitMotion(perf);
  return { perf, sticking, kit, motion: new DrummerMotion(perf, sticking, kit) };
}

/**
 * Limits, from what people do (and say so where they are tested):
 *   - a hand (the stick's fulcrum) moves at most 7 m/s: the fastest moves around a kit, a floor tom to a crash in
 *     a fill, peak at 4-6 m/s (Sticking's own top speed is 6 m/s), with the stroke's own motion on top;
 *   - away from its contacts a hand accelerates at most 400 m/s² (about 40 g: the wrist's snap into a loud stroke);
 *   - a stick's tip moves at most 20 m/s (loud strokes reach 6-12 m/s at the head; the tip whips);
 *   - within 20 ms of a contact the tip is in its impact and rebound, where acceleration is unbounded.
 */
export const LIMITS = { hand: 7, handAccel: 400, tip: 20 };
/** contacts deeper than this count (the proxies are faceted; the stick's taper and the hand's capsule are approximate) */
export const TOLERANCE = 0.001;

export interface Audit {
  samples: number;
  contacts: Map<string, { n: number; worst: number; at: number }>;
  limits: Map<string, { n: number; worst: number; at: number }>;
  maxHand: number;
  maxHandAccel: number;
  maxTip: number;
  feet: number;
  board: number;
  /** hand-frames past the limits (each hand counted on its own) */
  handOver: number;
  accelOver: number;
  tipOver: number;
}

export function audit(g: ReturnType<typeof loadGroove>, from = 0, to = Infinity): Audit {
  const { perf, sticking, kit, motion } = g;
  const tg = blankTargets();
  const pose = createPose();
  const res: Audit = { samples: 0, contacts: new Map(), limits: new Map(), maxHand: 0, maxHandAccel: 0, maxTip: 0, feet: 0, board: 0, handOver: 0, accelOver: 0, tipOver: 0 };
  const note = (m: Audit['contacts'], k: string, d: number, t: number) => {
    const e = m.get(k) ?? { n: 0, worst: 0, at: t };
    e.n++;
    if (d < e.worst) [e.worst, e.at] = [d, t];
    m.set(k, e);
  };
  // the hand hits, by limb, for "near a contact"
  const hits = { R: [] as { t: number; piece: string }[], L: [] as { t: number; piece: string }[] };
  for (const h of sticking.hits) if (h.played && (h.limb === 'R' || h.limb === 'L')) hits[h.limb].push({ t: h.t, piece: h.piece });
  const near = (s: 'R' | 'L', t: number, w: number) => hits[s].some((h) => Math.abs(h.t - t) < w);
  const struckNear = (s: 'R' | 'L', t: number, piece: string) => hits[s].some((h) => Math.abs(h.t - t) < 0.015 && h.piece === piece);
  const prev = { R: [] as number[][], L: [] as number[][] };
  const DT = 1 / 120;
  const ball = vec3();
  const board = { point: [0, 0, 0], along: [0, 0, 0], normal: [0, 0, 0] };
  for (let t = Math.max(0, from); t < Math.min(perf.duration, to); t += DT) {
    motion.pose(t, tg, pose);
    res.samples++;
    const prox = posedProxies(kit.evaluate(t));
    for (const c of clearance(pose, tg, { kit: prox, margin: -TOLERANCE })) {
      // the stick on what it is striking, in the instant of the stroke (the shoulder on a crash's edge, the tip on a head)
      const side = c.a.startsWith('stick ') ? (c.a.slice(6) as 'R' | 'L') : null;
      const piece = c.b === 'hi-hat' ? 'hihat' : c.b;
      if (side && struckNear(side, t, piece)) continue;
      note(res.contacts, describeContact(c), c.distance, t);
    }
    for (const v of limitViolations(pose, 0.5 * (Math.PI / 180))) note(res.limits, v.name, -Math.max(v.limits[0] - v.value, v.value - v.limits[1]), t);
    for (const s of ['R', 'L'] as const) {
      const p = prev[s];
      p.push([...pose.stick[s].tip, ...pose.stick[s].fulcrum]);
      if (p.length > 3) p.shift();
      if (p.length < 3) continue;
      const [a, b, c] = p;
      const vt = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) / DT;
      const vh = Math.hypot(c[3] - b[3], c[4] - b[4], c[5] - b[5]) / DT;
      res.maxTip = Math.max(res.maxTip, vt);
      res.maxHand = Math.max(res.maxHand, vh);
      if (vt > LIMITS.tip) res.tipOver++;
      if (vh > LIMITS.hand) res.handOver++;
      if (!near(s, t - DT, 0.02)) {
        const ah = Math.hypot(c[3] - 2 * b[3] + a[3], c[4] - 2 * b[4] + a[4], c[5] - 2 * b[5] + a[5]) / (DT * DT);
        res.maxHandAccel = Math.max(res.maxHandAccel, ah);
        if (ah > LIMITS.handAccel) res.accelOver++;
      }
    }
    // the feet: the ball of each foot on its board, the board where the kit's reactions put it
    for (const s of ['R', 'L'] as const) {
      const f = tg.feet[s];
      const press = s === 'R' ? kit.beater(t) : kit.hihatClosed(t);
      res.board = Math.max(res.board, Math.abs(f.press - press), Math.abs(pose.pedal[f.pedal] + PEDAL_TRAVEL * Math.min(1, Math.max(PRESS_MIN, press))));
      const foot = J.leg[s].foot;
      // (the foot's ball sits its sole's thickness, ankle height less the ball's height, above the board's top)
      apply3(ball, pose.world, DRUMMER.foot.ball, foot * 9);
      for (let k = 0; k < 3; k++) ball[k] += pose.pos[foot * 3 + k];
      footboardAt(f.pedal, press, PEDAL_BOARDS[f.pedal].ballAlong, board);
      const sole = DRUMMER.foot.ankleHeight + DRUMMER.foot.ball[1];
      res.feet = Math.max(res.feet, Math.hypot(ball[0] - board.point[0] - board.normal[0] * sole, ball[1] - board.point[1] - board.normal[1] * sole, ball[2] - board.point[2] - board.normal[2] * sole));
    }
  }
  return res;
}

export function describeContact(c: Contact) {
  return `${c.a} / ${c.b}`;
}

export function report(name: string, a: Audit): string {
  const lines = [
    `${name}: ${a.samples} frames at 120 fps; hands at most ${a.maxHand.toFixed(2)} m/s, ${a.maxHandAccel.toFixed(0)} m/s² away from contacts; tips at most ${a.maxTip.toFixed(1)} m/s; feet ${(a.feet * 1000).toFixed(2)} mm off their boards`,
    `  hand-frames past ${LIMITS.hand} m/s: ${a.handOver}, past ${LIMITS.handAccel} m/s²: ${a.accelOver}; tip-frames past ${LIMITS.tip} m/s: ${a.tipOver}`,
  ];
  for (const [k, v] of [...a.contacts].sort((x, y) => x[1].worst - y[1].worst)) lines.push(`  contact ${k}: ${v.n} frames, deepest ${(-v.worst * 1000).toFixed(1)} mm at ${v.at.toFixed(3)} s`);
  for (const [k, v] of a.limits) lines.push(`  limit ${k}: ${v.n} frames, ${((-v.worst * 180) / Math.PI).toFixed(1)} degrees past at ${v.at.toFixed(3)} s`);
  return lines.join('\n');
}

export type { DrumPerformance, Sticking };

/**
 * What the audit still finds, and is accepted for now (each a known fault, not a tolerance): for each contact,
 * how many frames at most and how deep (mm); for each joint, frames and degrees past its range; and how many
 * hand-frames may pass the speed and acceleration limits. Anything not listed here, or more of it, fails.
 *
 * Why they remain (see the stage's report): the arms' free choices are interpolated between planned keys, and
 * where the best way of holding the arms changes quickly between two keys (a hand moving between the hi-hat and
 * the drums, the right arm crossing to the crash in a fill, the sticks crossing in the hi-hat groove) a frame can
 * pass briefly through a pose its keys did not have. The right stick grazing the hi-hat (4-6 mm) is its shoulder
 * on the edge in the frames either side of a stroke, as the open top cymbal rocks.
 */
export const KNOWN: Record<(typeof GROOVES)[number], { contacts: Record<string, [number, number]>; limits: Record<string, [number, number]>; handOver: number; accelOver: number; tipOver: number }> = {
  'groove-rock-87': {
    contacts: {
      'stick L / hi-hat': [56, 73],
      'stick R / stick L': [60, 14],
      'hand L / hi-hat': [6, 14],
      'forearm L / hi-hat': [4, 9],
      'stick R / hi-hat': [66, 6],
      'stick R / crash': [3, 5],
      'stick L / hand R': [18, 5],
      'stick R / hand L': [4, 5],
      'stick L / forearm R': [5, 5],
    },
    limits: {},
    handOver: 14,
    accelOver: 86,
    tipOver: 5,
  },
  'groove-funk-102': {
    contacts: {
      'forearm R / forearm L': [18, 82],
      'stick L / hi-hat': [6, 66],
      'hand L / forearm R': [34, 57],
      'stick L / forearm R': [4, 11],
      'stick R / hi-hat': [67, 7],
      'stick R / stick L': [16, 5],
      'stick L / tom2': [4, 5],
      'stick L / hand R': [3, 4],
    },
    limits: { 'UpperArmL.abduction': [5, 1.5] },
    handOver: 10,
    accelOver: 40,
    tipOver: 2,
  },
  'groove-jazz-93': {
    contacts: {
      'stick L / hi-hat': [110, 112],
      'stick L / tom2': [21, 24],
      'stick L / hi-hat clutch': [15, 12],
      'stick L / crash': [20, 10],
      'hand L / hi-hat': [15, 10],
      'stick R / ride': [5, 9],
      'stick L / hi-hat rod': [3, 8],
      'upper arm L / snare': [23, 8],
    },
    limits: { 'UpperArmL.rotation': [24, 3.5], 'ForearmTwistL.supination': [50, 4.5], 'L_Palm.flexion': [20, 3], 'UpperArmL.flexion': [32, 3] },
    handOver: 14,
    accelOver: 50,
    tipOver: 4,
  },
};

/** the audit against KNOWN: what is new or worse (empty when nothing is) */
export function regressions(name: (typeof GROOVES)[number], a: Audit): string[] {
  const k = KNOWN[name];
  const out: string[] = [];
  for (const [c, v] of a.contacts) {
    const lim = k.contacts[c];
    if (!lim) out.push(`new contact ${c}: ${v.n} frames, ${(-v.worst * 1000).toFixed(1)} mm`);
    else if (v.n > lim[0] || -v.worst * 1000 > lim[1]) out.push(`contact ${c}: ${v.n} frames (at most ${lim[0]}), ${(-v.worst * 1000).toFixed(1)} mm (at most ${lim[1]})`);
  }
  for (const [j, v] of a.limits) {
    const lim = k.limits[j];
    const deg = (-v.worst * 180) / Math.PI;
    if (!lim) out.push(`new limit ${j}: ${v.n} frames, ${deg.toFixed(1)} degrees`);
    else if (v.n > lim[0] || deg > lim[1]) out.push(`limit ${j}: ${v.n} frames (at most ${lim[0]}), ${deg.toFixed(1)} degrees (at most ${lim[1]})`);
  }
  if (a.handOver > k.handOver) out.push(`hand-frames past ${LIMITS.hand} m/s: ${a.handOver} (at most ${k.handOver})`);
  if (a.accelOver > k.accelOver) out.push(`hand-frames past ${LIMITS.handAccel} m/s²: ${a.accelOver} (at most ${k.accelOver})`);
  if (a.tipOver > k.tipOver) out.push(`tip-frames past ${LIMITS.tip} m/s: ${a.tipOver} (at most ${k.tipOver})`);
  return out;
}
