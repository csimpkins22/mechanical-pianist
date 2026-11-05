// The kit's hardware as line segments with radii: every tripod's legs and
// braces, the stands' tubes, booms and tilters, the snare's basket, the
// hi-hat's column, pull rod and clutch, the tom holder and arms, the floor
// tom's legs and the kick's spurs. They are placed exactly as the kit's model
// (src/presentation/DrumKitModel.ts) places them, by the same rules in the
// same order (tests/drummer.test.ts checks that both agree), so the drummer's
// clearance checks see the stands that are drawn, without loading the model.
import { CYMBAL_PROFILES, DRUMS, PEDALS, SEAT, hihatMount, type DrumId, type DrumSpec, type V3 } from './KitLayout';

export interface StandRod {
  id: DrumId;
  /** what it is, for reports: "snare stand leg", "hi-hat clutch", ... */
  label: string;
  a: V3;
  b: V3;
  radius: number;
}

export interface KitStands {
  rods: StandRod[];
  /** for each tripod (and the floor tom's legs), in the model's order: its centre on the floor and how clear its legs stand of what was already there (m) */
  legClearance: { at: [number, number]; clear: number }[];
}

// DrumKitModel's constants
const RUG_TOP = 0.008;
const STOOL_LEGS = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
const STOOL_REACH = 0.28;

type P2 = [number, number];
interface FloorItem {
  a: P2;
  b: P2;
  r: number;
}

/** a drum's or cymbal's frame applied to a local vector (DrumKitModel's orientation(): Euler(tilt, yaw, 0, 'YXZ')) */
function rot(d: DrumSpec, v: V3): V3 {
  const ct = Math.cos(d.tilt), st = Math.sin(d.tilt);
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
  // about x by the tilt, then about y by the yaw
  const x = v[0];
  const y = v[1] * ct - v[2] * st;
  const z = v[1] * st + v[2] * ct;
  return [x * cy + z * sy, y, -x * sy + z * cy];
}
/** the inverse */
function unrot(d: DrumSpec, v: V3): V3 {
  const ct = Math.cos(d.tilt), st = Math.sin(d.tilt);
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw);
  const x = v[0] * cy - v[2] * sy;
  const z0 = v[0] * sy + v[2] * cy;
  return [x, v[1] * ct + z0 * st, -v[1] * st + z0 * ct];
}
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

/** the kit's stands, as DrumKitModel builds them */
export function kitStands(): KitStands {
  const rods: StandRod[] = [];
  const legClearance: KitStands['legClearance'] = [];
  const floor: FloorItem[] = [];
  const rod = (id: DrumId, label: string, a: V3, b: V3, radius: number) => rods.push({ id, label, a, b, radius });

  function bestLegs(centre: P2, reach: number, n: number, footR: number, prefer = 0) {
    let best = { a0: prefer, score: -Infinity };
    for (let k = 0; k < 72; k++) {
      const a0 = prefer + (k / 72) * ((2 * Math.PI) / n);
      let score = Infinity;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i * 2 * Math.PI) / n;
        for (const f of [0.55, 1]) {
          const p: P2 = [centre[0] + Math.sin(a) * reach * f, centre[1] + Math.cos(a) * reach * f];
          for (const o of floor) score = Math.min(score, segDist(p, o.a, o.b) - o.r - footR);
        }
      }
      if (score > best.score) best = { a0, score };
    }
    return best;
  }
  function placeLegs(centre: P2, reach: number, n: number, footR: number, prefer = 0): number[] {
    const best = bestLegs(centre, reach, n, footR, prefer);
    legClearance.push({ at: centre, clear: best.score });
    return Array.from({ length: n }, (_, i) => best.a0 + (i * 2 * Math.PI) / n);
  }
  function tripod(id: DrumId, name: string, centre: P2, hubY: number, reach: number, legR: number) {
    const angles = placeLegs(centre, reach, 3, 0.035);
    const hub: V3 = [centre[0], hubY, centre[1]];
    const collar: V3 = [centre[0], 0.11, centre[1]];
    rod(id, `${name} hub`, [centre[0], hubY - 0.025, centre[1]], [centre[0], hubY + 0.025, centre[1]], 0.02);
    for (const a of angles) {
      const dir: V3 = [Math.sin(a), 0, Math.cos(a)];
      const foot = add([centre[0], RUG_TOP + 0.016, centre[1]], dir, reach);
      const top = add(hub, dir, 0.018);
      rod(id, `${name} leg`, top, foot, legR);
      rod(id, `${name} brace`, add(collar, dir, 0.015), lerp(top, foot, 0.55), legR * 0.75);
      floor.push({ a: [foot[0], foot[2]], b: [foot[0], foot[2]], r: 0.035 });
    }
    floor.push({ a: centre, b: centre, r: 0.03 });
  }

  // the floor before any tripod: the kick, the pedals, the stool's column and legs
  const kick = DRUMS.kick;
  const kp = PEDALS.kickPedal;
  const hp = PEDALS.hihatPedal;
  const kr = 0.15;
  floor.push({ a: [kick.centre[0], kick.centre[2] + 0.02 - kr], b: [kick.centre[0], kick.centre[2] - kick.depth - 0.02 + kr], r: kr });
  floor.push({ a: [kp.heel[0], kp.heel[2] + 0.04], b: [kp.ball[0], kick.centre[2]], r: 0.075 });
  floor.push({ a: [hp.heel[0], hp.heel[2] + 0.04], b: [DRUMS.hihat.centre[0], DRUMS.hihat.centre[2]], r: 0.07 });
  floor.push({ a: [SEAT.centre[0], SEAT.centre[2]], b: [SEAT.centre[0], SEAT.centre[2]], r: 0.05 });
  for (const a of STOOL_LEGS) floor.push({ a: [SEAT.centre[0], SEAT.centre[2]], b: [SEAT.centre[0] + Math.sin(a) * STOOL_REACH, SEAT.centre[2] + Math.cos(a) * STOOL_REACH], r: 0.035 });

  // the kick's spurs
  const KR = kick.diameter / 2;
  for (const s of [-1, 1]) {
    const bracket = add(kick.centre, rot(kick, [s * Math.sin(1.0) * (KR + 0.012), -0.12, Math.cos(1.0) * (KR + 0.012)]));
    const foot: V3 = [kick.centre[0] + s * (KR + 0.16), RUG_TOP + 0.004, kick.centre[2] - 0.12];
    rod('kick', 'kick spur', bracket, [foot[0], foot[1] + 0.03, foot[2]], 0.0055);
    floor.push({ a: [foot[0], foot[2]], b: [foot[0], foot[2]], r: 0.04 });
  }

  // the tom holder on the kick, and each rack tom's arm
  const hTop: V3 = [kick.centre[0], kick.centre[1] + KR, kick.centre[2] - kick.depth * 0.45];
  const post: V3 = [hTop[0], hTop[1] + 0.11, hTop[2]];
  rod('kick', 'tom holder', hTop, post, 0.011);
  for (const id of ['tom1', 'tom2'] as const) {
    const d = DRUMS[id];
    const R = d.diameter / 2;
    const toPost = unrot(d, sub(post, d.centre));
    const ang = Math.atan2(toPost[0], toPost[2]);
    const local: V3 = [Math.sin(ang) * (R + 0.016), -d.depth * 0.45, Math.cos(ang) * (R + 0.016)];
    const out = add(local, [Math.sin(ang), 0, Math.cos(ang)], 0.05);
    const postLocal = unrot(d, sub([post[0], post[1] + 0.02, post[2]], d.centre));
    rod(id, `${id} arm`, add(d.centre, rot(d, local)), add(d.centre, rot(d, out)), 0.0085);
    rod(id, `${id} arm`, add(d.centre, rot(d, out)), add(d.centre, rot(d, postLocal)), 0.0085);
  }

  // the floor tom's legs
  {
    const d = DRUMS.floorTom;
    const R = d.diameter / 2;
    const c = d.centre;
    for (const a of placeLegs([c[0], c[2]], R + 0.13, 3, 0.05, Math.PI / 6)) {
      const dir: V3 = [Math.sin(a), 0, Math.cos(a)];
      const bracket = add([c[0], c[1] - 0.11, c[2]], dir, R + 0.018);
      const foot = add([c[0], RUG_TOP, c[2]], dir, R + 0.13);
      rod('floorTom', 'floor tom leg', [bracket[0], bracket[1] + 0.03, bracket[2]], [foot[0], foot[1] + 0.025, foot[2]], 0.0058);
      floor.push({ a: [foot[0], foot[2]], b: [foot[0], foot[2]], r: 0.04 });
    }
  }

  // the snare stand: its tripod where its legs keep clearest, the tube, the offset arm, the basket under the drum
  {
    const d = DRUMS.snare;
    const R = d.diameter / 2;
    const c = d.centre;
    const reach = 0.2;
    let base: P2 = [c[0], c[2]];
    let clear = -Infinity;
    for (const dz of [0, 0.03, 0.06, 0.08])
      for (const dx of [0, -0.03, -0.06]) {
        const at: P2 = [c[0] + dx, c[2] + dz];
        const b = bestLegs(at, reach, 3, 0.035);
        if (b.score > clear + 0.005) {
          clear = b.score;
          base = at;
        }
      }
    tripod('snare', 'snare stand', base, 0.19, reach, 0.0068);
    const bottom = add(c, rot(d, [0, -d.depth - 0.035, 0]));
    const top: V3 = [c[0], bottom[1] - 0.05, c[2]];
    const tubeTop: V3 = [base[0], top[1] - 0.06, base[1]];
    rod('snare', 'snare stand', [base[0], 0.19, base[1]], tubeTop, 0.0105);
    if (len(sub(tubeTop, top)) > 0.01) rod('snare', 'snare stand arm', tubeTop, top, 0.009);
    rod('snare', 'snare stand tilter', [top[0] - 0.015, top[1] + 0.012, top[2]], [top[0] + 0.035, top[1] + 0.012, top[2]], 0.022);
    for (let k = 0; k < 3; k++) {
      const a = 0.5 + (k * 2 * Math.PI) / 3;
      const rim = add(c, rot(d, [Math.sin(a) * (R + 0.012), -d.depth - 0.017, Math.cos(a) * (R + 0.012)]));
      const knee = add(c, rot(d, [Math.sin(a) * R * 0.75, -d.depth - 0.045, Math.cos(a) * R * 0.75]));
      rod('snare', 'snare basket', [top[0], top[1] + 0.02, top[2]], knee, 0.006);
      rod('snare', 'snare basket', knee, rim, 0.006);
    }
  }

  // the kick pedal's frame on the floor
  floor.push({ a: [kp.ball[0], kick.centre[2] + 0.05], b: [kp.ball[0], kp.heel[2] + 0.03], r: 0.07 });

  // the hi-hat: tripod and column (under the head that puts the top cymbal's centre on KitLayout's); the cymbals'
  // seat on top, the pull rod and the clutch above the top cymbal
  {
    const m = hihatMount();
    const [cx, cz] = m.column;
    tripod('hihat', 'hi-hat stand', [cx, cz], 0.24, 0.245, 0.0075);
    rod('hihat', 'hi-hat stand', [cx, 0.08, cz], [cx, 0.56, cz], 0.0135);
    rod('hihat', 'hi-hat stand', [cx, 0.56, cz], m.head, 0.0105);
    floor.push({ a: [hp.heel[0], hp.heel[2] + 0.03], b: [cx, cz], r: 0.06 });
  }

  // the boom stands for the crash and the ride, behind and outside their cymbals
  for (const id of ['crash', 'ride'] as const) {
    const d = DRUMS[id];
    const p = CYMBAL_PROFILES[id];
    const n = rot(d, [0, 1, 0]);
    const stack = p.bellHeight + 0.03;
    const tilt = add(d.centre, n, -stack);
    const { base, joint } = boomStand(id);
    tripod(id, `${id} stand`, base, 0.27, 0.3, 0.0085);
    rod(id, `${id} stand`, [base[0], 0.08, base[1]], [base[0], 0.62, base[1]], 0.0145);
    rod(id, `${id} stand`, [base[0], 0.62, base[1]], joint, 0.011);
    const arm = sub(tilt, joint);
    const dir = [arm[0] / len(arm), arm[1] / len(arm), arm[2] / len(arm)] as V3;
    rod(id, `${id} boom`, add(joint, dir, -0.13), tilt, 0.0095);
    rod(id, `${id} counterweight`, add(joint, dir, -0.13), add(joint, dir, -0.19), 0.018);
    rod(id, `${id} tilter`, tilt, add(d.centre, n, p.bellHeight + 0.026), 0.006);
    rod(id, `${id} wing nut`, add(d.centre, n, p.bellHeight + 0.008), add(d.centre, n, p.bellHeight + 0.02), 0.016);
  }
  return { rods, legClearance };
}

/**
 * A boom stand's base on the floor (behind and outside its cymbal) and its
 * boom joint, about which the stand's top gives a little with the cymbal
 * (DrumKitModel turns it there).
 */
export function boomStand(id: 'crash' | 'ride'): { base: [number, number]; joint: V3 } {
  const d = DRUMS[id];
  const p = CYMBAL_PROFILES[id];
  const base: [number, number] = id === 'crash' ? [d.centre[0] - 0.3, d.centre[2] - 0.28] : [d.centre[0] + 0.34, d.centre[2] - 0.3];
  const n = rot(d, [0, 1, 0]);
  const tilt = add(d.centre, n, -(p.bellHeight + 0.03));
  return { base, joint: [base[0], tilt[1] - 0.2, base[1]] };
}

/**
 * The hi-hat's moving parts, which DrumKitModel mounts on the column's head
 * (on the column's axis, tilted as KitLayout asks): the pull rod and the
 * clutch above the top cymbal, lifted by `gap` when the pedal is up.
 */
export function hihatTop(gap: number): StandRod[] {
  const d = DRUMS.hihat;
  const p = CYMBAL_PROFILES.hihat;
  const m = hihatMount();
  const at = (x: number, y: number): V3 => add(m.head, rot(d, [x, y + gap, 0]));
  const topY = m.topY;
  const b = topY + p.bellHeight;
  return [
    { id: 'hihat', label: 'hi-hat rod', a: at(0, topY - 0.045), b: at(0, topY + 0.09), radius: 0.0036 },
    { id: 'hihat', label: 'hi-hat clutch', a: at(0, b + 0.007), b: at(0, b + 0.035), radius: 0.009 },
    { id: 'hihat', label: 'hi-hat clutch', a: at(0, b + 0.026), b: at(0.032, b + 0.026), radius: 0.0055 },
  ];
}
