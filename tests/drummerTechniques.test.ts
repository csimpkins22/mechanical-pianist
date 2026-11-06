// The techniques the newer library grooves rely on, played by the drummer on short performances written here:
// a cross-stick laid across the snare, a rim click in the middle of the snare's own playing, a pattern on the
// ride's bell, both hands on the snare in a roll, and a groove in 6/8 (its bars, its beat, its nod).
import { describe, expect, it } from 'vitest';
import { CLICK_WINDOW, CROSS_STICK_ANGLE, drumMidiBytes, readDrumMidi } from '../src/drums/DrumScore';
import { assignLimbs, beatGrid } from '../src/drums/Sticking';
import { KitMotion } from '../src/drums/KitMotion';
import { DrummerMotion, SHARED_SIDE, blankTargets, sharedDrumSides } from '../src/drums/DrummerMotion';
import { STICK_BEAD, createPose } from '../src/drums/DrummerIK';
import { clearance } from '../src/drums/DrummerClearance';
import { posedProxies } from '../src/drums/KitPose';
import { DRUMS, surfaceNormal, type V3 } from '../src/drums/KitLayout';
import { articulationFor } from '../src/drums/DrumAudio';

type N = [t: number, midi: number, velocity?: number];
function play(notes: N[], opts: { bpm?: number; timeSignature?: [number, number] } = {}) {
  const bytes = drumMidiBytes(
    notes.map(([t, midi, velocity]) => ({ t, midi, velocity: velocity ?? 0.8 })),
    { bpm: opts.bpm, timeSignature: opts.timeSignature, cc4: [{ t: 0, value: 90 }, { t: 0.1, value: 90 }, { t: 0.2, value: 90 }, { t: 0.3, value: 90 }, { t: 0.4, value: 90 }] },
  );
  const perf = readDrumMidi(bytes, 'test');
  const sticking = assignLimbs(perf);
  const kit = new KitMotion(perf);
  return { perf, sticking, kit, motion: new DrummerMotion(perf, sticking, kit) };
}

const SN = DRUMS.snare;
const N_SN = surfaceNormal(SN);
/** a point relative to the snare: its height above the head, and how far it is from the drum's axis across it */
function onSnare(p: ArrayLike<number>) {
  const v = [p[0] - SN.centre[0], p[1] - SN.centre[1], p[2] - SN.centre[2]];
  const h = v[0] * N_SN[0] + v[1] * N_SN[1] + v[2] * N_SN[2];
  const r = Math.hypot(v[0] - h * N_SN[0], v[1] - h * N_SN[1], v[2] - h * N_SN[2]);
  return { h, r };
}
const R_SN = SN.diameter / 2;

describe('a cross-stick', () => {
  // a one-drop at 76: the hi-hat in eighths, the kick and a cross-stick together on two and four, nothing else on the snare
  const b = 60 / 76;
  const notes: N[] = [];
  for (let k = 0; k < 16; k++) notes.push([0.5 + k * b * 0.5, 42, k % 2 ? 0.45 : 0.7]);
  for (const q of [1, 3, 5, 7]) notes.push([0.5 + q * b, 37, 0.8], [0.5 + q * b, 36, 0.85]);
  const g = play(notes, { bpm: 76 });

  it('is the left hand laying its stick across the snare: the shaft on the far hoop, the tip over it, the hand resting on the head', () => {
    const xs = g.sticking.hits.filter((h) => h.zone === 'crossStick');
    expect(xs).toHaveLength(4);
    const tg = blankTargets();
    const pose = createPose();
    for (const h of xs) {
      const hit = g.perf.hits[h.hit];
      expect(hit.click).toBeUndefined();
      expect(h.limb).toBe('L');
      // the spot: on the hoop, on the far side a little to the right
      expect(hit.r).toBeGreaterThan(0.93);
      expect(Math.abs(hit.angle - CROSS_STICK_ANGLE)).toBeLessThan(0.11);
      g.motion.pose(h.t, tg, pose);
      const s = pose.stick.L;
      expect(pose.error.L).toBeLessThan(0.002);
      // the shaft meets the hoop a few centimetres from the tip, which overhangs it
      const c = onSnare(s.contact);
      const tip = onSnare(s.tip);
      expect(c.r).toBeGreaterThan(R_SN - 0.012);
      expect(tip.r).toBeGreaterThan(R_SN + 0.02);
      expect(tg.L.contactFromTip).toBeGreaterThan(0.05);
      // the stick nearly flat across the head, rising a little toward the hand
      const u = [s.tip[0] - s.butt[0], s.tip[1] - s.butt[1], s.tip[2] - s.butt[2]];
      const sinTilt = (u[0] * N_SN[0] + u[1] * N_SN[1] + u[2] * N_SN[2]) / Math.hypot(u[0], u[1], u[2]);
      expect(Math.abs(Math.asin(sinTilt))).toBeLessThan((8 * Math.PI) / 180);
      // the hand over the head, low: the fulcrum inside the hoop and within a few centimetres of the head
      const f = onSnare(s.fulcrum);
      expect(f.r).toBeLessThan(R_SN);
      expect(f.h).toBeGreaterThan(0);
      expect(f.h).toBeLessThan(0.05);
      // and nothing through the drum or the hi-hat beside it
      const near = clearance(pose, tg, { kit: posedProxies(g.kit.evaluate(h.t)), margin: -0.001 }).filter((x) => x.a.endsWith(' L') && x.b !== 'snare');
      expect(near).toEqual([]);
    }
  }, 60000);

  it('lifts only its far end a few centimetres, the hand staying where it rests', () => {
    const S = g.motion.hands.L.strokes.filter((s) => s.zone === 'crossStick');
    expect(S).toHaveLength(4);
    for (const s of S) expect(s.prep).toBeLessThanOrEqual(0.06 + 1e-9);
  });

  it('in the middle of the snare\'s own playing is a rim click: struck where a rimshot is, sounding as the cross-stick it was', () => {
    const t0 = 0.5;
    const p = play([
      [t0, 38, 0.4],
      [t0 + 0.12, 37, 0.8],
      [t0 + 0.24, 38, 0.4],
      [t0 + 1.5, 37, 0.8],
    ]);
    const [click, alone] = p.perf.hits.filter((h) => h.zone === 'crossStick');
    expect(click.click).toBe(true);
    expect(alone.click).toBeUndefined();
    expect(Math.abs(click.angle)).toBeLessThan(0.3);
    expect(CLICK_WINDOW).toBeGreaterThan(0.12);
    for (const h of [click, alone]) expect(articulationFor(h.piece, h.zone, 1, h.velocity)).toBe('crossStick');
    const hand = p.sticking.hits[click.i].limb as 'R' | 'L';
    const s = p.motion.hands[hand].strokes.find((x) => x.hit === click.i)!;
    expect(s.zone).toBe('rim');
  });
});

describe('the ride bell', () => {
  it('is played with the tip, the stick clear of the crown and the wing nut, frame by frame', () => {
    // a samba's bell figure at 96 over the kick
    const b = 60 / 96;
    const notes: N[] = [];
    for (let k = 0; k < 48; k++) {
      const t = 0.5 + k * b * 0.25;
      if ([0, 3, 6, 10, 12].includes(k % 16)) notes.push([t, 53, 0.7]);
      else if ([2, 9, 14].includes(k % 16)) notes.push([t, 51, 0.6]);
      if (k % 4 === 0) notes.push([t, 36, 0.6]);
    }
    const g = play(notes, { bpm: 96 });
    const tg = blankTargets();
    const pose = createPose();
    const bells = g.sticking.hits.filter((h) => h.zone === 'bell');
    expect(bells.length).toBeGreaterThan(3);
    for (const h of bells) {
      expect(h.limb).toBe('R');
      g.motion.pose(h.t, tg, pose);
      expect(tg.R.contactFromTip).toBeCloseTo(STICK_BEAD, 6);
      expect(pose.error.R).toBeLessThan(0.002);
    }
    const bad: string[] = [];
    for (let t = 0.3; t < g.perf.duration; t += 1 / 60) {
      g.motion.pose(t, tg, pose);
      for (const c of clearance(pose, tg, { kit: posedProxies(g.kit.evaluate(t)), margin: -0.001 }))
        if (c.a === 'stick R' && c.b.startsWith('ride') && !g.sticking.hits.some((h) => h.limb === 'R' && Math.abs(h.t - t) < 0.015)) bad.push(`${t.toFixed(3)} ${c.b} ${(c.distance * 1000).toFixed(1)} mm`);
    }
    expect(bad).toEqual([]);
  }, 60000);
});

describe('two hands on the snare in a roll', () => {
  it('each plays its own side: the left tip stays left of the right, the sticks never cross', () => {
    // two bars of sixteenths at 110, hand to hand, accents on the beats
    const b = 60 / 110;
    const notes: N[] = [];
    for (let k = 0; k < 32; k++) notes.push([0.5 + k * b * 0.25, 38, k % 4 === 0 ? 0.9 : 0.45]);
    notes.push([0.5 + 32 * b * 0.25, 38, 0.95], [0.5 + 32 * b * 0.25, 36, 0.9]);
    const g = play(notes, { bpm: 110 });
    const sides = sharedDrumSides(g.sticking, g.perf.hits);
    const hands = g.sticking.hits.filter((h) => h.limb === 'R' || h.limb === 'L');
    expect(new Set(hands.map((h) => h.limb)).size).toBe(2);
    for (const h of hands) expect(sides[h.hit]).toBe(h.limb === 'L' ? -1 : 1);
    expect(SHARED_SIDE).toBeGreaterThan(0.015);
    const tg = blankTargets();
    const pose = createPose();
    // across the head, toward the drummer's right
    const across: V3 = [Math.cos(SN.yaw), 0, -Math.sin(SN.yaw)];
    const x = (p: ArrayLike<number>) => (p[0] - SN.centre[0]) * across[0] + (p[2] - SN.centre[2]) * across[2];
    let crossed = 0;
    for (let t = 0.5; t < 0.5 + 8 * b; t += 1 / 120) {
      g.motion.pose(t, tg, pose);
      if (x(pose.stick.L.tip) > x(pose.stick.R.tip)) crossed++;
      for (const c of clearance(pose, tg, { margin: -0.001 })) expect(`${c.a} / ${c.b}`).not.toBe('stick R / stick L');
    }
    expect(crossed).toBe(0);
  }, 60000);
});

describe('a groove in 6/8 and in 3/4', () => {
  it('reads 6/8 as two dotted-quarter beats to a bar of six eighths; 3/4 as three beats; 4/4 as four', () => {
    const notes = (q: number) => Array.from({ length: 24 }, (_, k) => ({ t: (k * 60) / q / 2, midi: 51, velocity: 0.6 }));
    const six = readDrumMidi(drumMidiBytes(notes(80), { bpm: 80, timeSignature: [6, 8] }));
    expect(six.pulse).toBe(1.5);
    expect(six.bars[1] - six.bars[0]).toBeCloseTo((3 * 60) / 80, 6);
    expect(beatGrid(six)).toMatchObject({ perBar: 2 });
    expect(beatGrid(six).beat).toBeCloseTo((1.5 * 60) / 80, 9);
    const three = readDrumMidi(drumMidiBytes(notes(120), { bpm: 120, timeSignature: [3, 4] }));
    expect(three.pulse ?? 1).toBe(1);
    expect(three.bars[1] - three.bars[0]).toBeCloseTo(1.5, 6);
    expect(beatGrid(three)).toMatchObject({ perBar: 3 });
    const four = readDrumMidi(drumMidiBytes(notes(120), { bpm: 120 }));
    expect(four.bars[1] - four.bars[0]).toBeCloseTo(2, 6);
    expect(beatGrid(four)).toMatchObject({ perBar: 4, beat: 0.5 });
  });

  it('nods once a beat: in 6/8 on the dotted quarters', () => {
    // a 6/8 groove at quarter = 80 (dotted quarter = 53): the ride on every eighth, kick on the beats, snare on the second
    const q = 60 / 80;
    const ns: N[] = [];
    for (let k = 0; k < 36; k++) ns.push([k * q * 0.5, 51, 0.6]);
    for (let k = 0; k < 12; k++) ns.push([k * 1.5 * q, k % 2 ? 38 : 36, 0.8]);
    const g = play(ns, { bpm: 80, timeSignature: [6, 8] });
    // the head's nod, sampled through a beat: one dip, and the same a beat later
    const tg = blankTargets();
    const nodAt = (t: number) => g.motion.evaluate(t, tg).body!.nod;
    const beat = 1.5 * q;
    const peaks: number[] = [];
    for (let k = 2; k < 8; k++) {
      let best = -Infinity;
      let at = 0;
      for (let t = k * beat - 0.3 * beat; t < k * beat + 0.3 * beat; t += 0.005) {
        const n = nodAt(t);
        if (n > best) [best, at] = [n, t];
      }
      peaks.push(at - k * beat);
    }
    // each nod's deepest point within 60 ms of its dotted-quarter beat (it is smoothed a little)
    for (const d of peaks) expect(Math.abs(d)).toBeLessThan(0.06);
    // and between beats, at the eighths that are not beats, the head is up
    expect(nodAt(3 * beat + q * 0.5)).toBeLessThan(nodAt(3 * beat));
  }, 60000);
});
