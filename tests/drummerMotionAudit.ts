// The drummer's planned performance of a library groove, sampled at 120 frames a second as a film would be,
// and checked frame by frame (tests/drummerMotion-*.test.ts): contacts with the kit as it moves and between the
// arms, joint limits, the speeds and accelerations of the hands and the sticks' tips, the feet on their boards.
import { readFileSync } from 'node:fs';
import { readDrumMidi, type DrumPerformance } from '../src/drums/DrumScore';
import { assignLimbs, type Sticking } from '../src/drums/Sticking';
import { KitMotion } from '../src/drums/KitMotion';
import { DrummerMotion, blankTargets, handSpot, sharedDrumSides } from '../src/drums/DrummerMotion';
import { createPose, limitViolations, PEDAL_TRAVEL } from '../src/drums/DrummerIK';
import { clearance, type Contact } from '../src/drums/DrummerClearance';
import { posedProxies } from '../src/drums/KitPose';
import { DRUMMER, J, apply3, vec3 } from '../src/drums/DrummerSpec';
import { DRUMS, PEDAL_BOARDS, PRESS_MIN, footboardAt, surfaceNormal } from '../src/drums/KitLayout';
import { cymbalPoint } from '../src/drums/KitPose';
import type { CymbalId } from '../src/drums/KitMotion';

export const GROOVES = ['groove-rock-87', 'groove-funk-102', 'groove-jazz-93'] as const;
/** the library's other grooves: checked by the fast audit (drummerLibrary-*.test.ts) at FAST_FPS, and at 120 fps by tools/drummer-audit.cjs */
export const NEW_GROOVES = [
  'groove-rock-135',
  'groove-rock-6-8-80',
  'groove-pop-132',
  'groove-country-114',
  'groove-soul-105',
  'groove-hiphop-87',
  'groove-secondline-124',
  'groove-shuffle-104',
  'groove-jazz-158',
  'groove-samba-93',
  'groove-reggae-78',
  'groove-afrobeat-103',
  'groove-highlife-126',
] as const;
export type NewGroove = (typeof NEW_GROOVES)[number];
/** the fast audit's frame rate */
export const FAST_FPS = 15;

export function loadGroove(name: string) {
  const perf = readDrumMidi(new Uint8Array(readFileSync(`src/music/drums/${name}.mid`)), name);
  const sticking = assignLimbs(perf);
  const kit = new KitMotion(perf);
  return { perf, sticking, kit, motion: new DrummerMotion(perf, sticking, kit) };
}

/**
 * Where each hand stroke should land: the hit's own spot (its r and angle), on the hand's side of the snare in a
 * roll, on a cymbal where the kit's reactions have it at that instant, a rimshot's and a cross-stick's on the hoop.
 */
export function strokeSpots(g: ReturnType<typeof loadGroove>) {
  const sides = sharedDrumSides(g.sticking, g.perf.hits);
  return (k: number): number[] => {
    const hit = g.perf.hits[k];
    const d = DRUMS[hit.piece];
    let spot = handSpot(d, hit, sides[k]) as number[];
    if (d.kind === 'cymbal') spot = cymbalPoint(hit.piece as CymbalId, spot, g.kit.evaluate(hit.t), [0, 0, 0]) as number[];
    else if (hit.zone === 'rim' || hit.zone === 'crossStick') spot = spot.map((x, i) => x + surfaceNormal(d)[i] * 0.008);
    return spot;
  };
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
  /** frames with any joint angle or stick point not a number */
  nan: number;
  /** frames with any contact (the contacts' own counts are per contact) */
  contactFrames: number;
}

export function audit(g: ReturnType<typeof loadGroove>, from = 0, to = Infinity, fps = 120): Audit {
  const { perf, sticking, kit, motion } = g;
  const tg = blankTargets();
  const pose = createPose();
  const res: Audit = { samples: 0, contacts: new Map(), limits: new Map(), maxHand: 0, maxHandAccel: 0, maxTip: 0, feet: 0, board: 0, handOver: 0, accelOver: 0, tipOver: 0, nan: 0, contactFrames: 0 };
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
  const DT = 1 / fps;
  const ball = vec3();
  const board = { point: [0, 0, 0], along: [0, 0, 0], normal: [0, 0, 0] };
  for (let t = Math.max(0, from); t < Math.min(perf.duration, to); t += DT) {
    motion.pose(t, tg, pose);
    res.samples++;
    let finite = true;
    for (const a of pose.angles) if (!Number.isFinite(a)) finite = false;
    for (const s of ['R', 'L'] as const) for (let k = 0; k < 3; k++) if (!Number.isFinite(pose.stick[s].tip[k]) || !Number.isFinite(pose.stick[s].fulcrum[k])) finite = false;
    if (!finite) res.nan++;
    const prox = posedProxies(kit.evaluate(t));
    let touched = false;
    for (const c of clearance(pose, tg, { kit: prox, margin: -TOLERANCE })) {
      // the stick on what it is striking, in the instant of the stroke (the shoulder on a crash's edge, the tip on a head)
      const side = c.a.startsWith('stick ') ? (c.a.slice(6) as 'R' | 'L') : null;
      const piece = c.b === 'hi-hat' ? 'hihat' : c.b;
      if (side && struckNear(side, t, piece)) continue;
      note(res.contacts, describeContact(c), c.distance, t);
      touched = true;
    }
    if (touched) res.contactFrames++;
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

export function report(name: string, a: Audit, fps = 120): string {
  const lines = [
    `${name}: ${a.samples} frames at ${fps} fps, ${a.contactFrames} (${((100 * a.contactFrames) / a.samples).toFixed(2)}%) with a contact; hands at most ${a.maxHand.toFixed(2)} m/s, ${a.maxHandAccel.toFixed(0)} m/s² away from contacts; tips at most ${a.maxTip.toFixed(1)} m/s; feet ${(a.feet * 1000).toFixed(2)} mm off their boards`,
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
export const KNOWN: Record<(typeof GROOVES)[number], Known> = {
  // (tightened with the posture stage: the arms held as real drummers hold them, the hands low, each hand on its own
  // side of the snare when both play it, rimshots from the hand's own side of the rim, a lower lift under the crossed
  // arm, the left hand on the hi-hat's edge from its side; no joint past its range, and the left stick no longer
  // through the hi-hat in the rock or the jazz groove)
  'groove-rock-87': { contacts: { 'stick R / stick L': [10, 6.8], 'stick L / hand R': [1, 2.9], 'stick R / hi-hat': [1, 1.2] }, limits: {}, handOver: 3, accelOver: 18, tipOver: 0 },
  'groove-funk-102': { contacts: { 'stick R / stick L': [3, 2.4], 'stick R / hi-hat': [6, 2], 'stick L / tom2': [1, 1.9] }, limits: {}, handOver: 1, accelOver: 3, tipOver: 0 },
  'groove-jazz-93': { contacts: { 'stick L / tom2': [15, 14.2], 'stick R / ride': [4, 6.4], 'stick L / crash': [11, 2.6] }, limits: {}, handOver: 4, accelOver: 13, tipOver: 0 },
};

/**
 * The same for the library's other grooves, as the fast audit (FAST_FPS) finds them: it samples an eighth of the
 * frames, so its counts are frames at that rate. The full 120 fps audits of every groove are in the README
 * (tools/drummer-audit.cjs). `dropped`: hits no hand could play (still heard; the kit still reacts). (A few
 * contacts sampled here are new or a little deeper than before the posture stage while each groove's whole audit is
 * better: the left hand waiting over the first rack tom after a fill while the right crosses to the hi-hat in the
 * reggae, the right stick passing over its forearm; in the samba and the shuffle the left stick or hand grazing the
 * snare's rim by 2-3 mm as it leaves a stroke.)
 */
export const KNOWN_FAST: Record<NewGroove, Known & { dropped: number }> = {
  'groove-rock-135': { contacts: { 'stick R / stick L': [2, 5.6] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-rock-6-8-80': { contacts: { 'stick R / ride': [1, 1.4] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-pop-132': { contacts: {}, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-country-114': { contacts: { 'stick R / stick L': [2, 2.6] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-soul-105': { contacts: {}, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-hiphop-87': { contacts: {}, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-secondline-124': { contacts: { 'stick R / stick L': [10, 9.9] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-shuffle-104': { contacts: { 'stick R / stick L': [8, 6.3], 'hand L / snare': [1, 2.6] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-jazz-158': { contacts: { 'stick R / crash': [1, 1.8] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-samba-93': { contacts: { 'stick L / snare': [1, 2.4] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-reggae-78': { contacts: { 'stick R / hand L': [11, 25.8], 'stick R / forearm L': [7, 20.8], 'hand L / hi-hat': [10, 14.1], 'stick R / stick L': [5, 10.5], 'stick L / crash': [2, 5.2], 'hand R / forearm L': [1, 2.1], 'forearm R / forearm L': [1, 1.9], 'stick R / hi-hat': [1, 1.1] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 1 },
  'groove-afrobeat-103': { contacts: { 'stick R / stick L': [5, 6.9], 'stick L / hand R': [1, 2.5], 'stick R / hi-hat': [2, 1.4] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 0 },
  'groove-highlife-126': { contacts: { 'stick R / stick L': [3, 7.3] }, limits: {}, handOver: 0, accelOver: 0, tipOver: 0, dropped: 5 },
};

/** what an audit may find: contacts and limits [frames, mm or degrees], and hand- and tip-frames past the limits */
export interface Known {
  contacts: Record<string, [number, number]>;
  limits: Record<string, [number, number]>;
  handOver: number;
  accelOver: number;
  tipOver: number;
}

/** the audit against KNOWN: what is new or worse (empty when nothing is) */
export function regressions(name: (typeof GROOVES)[number], a: Audit): string[] {
  return against(KNOWN[name], a);
}

/** an audit against what is known of it: what is new or worse (empty when nothing is) */
export function against(k: Known, a: Audit): string[] {
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
