// The drummer's planned performance (DrummerMotion) of the library's grooves: every stroke lands exactly where
// the kit's reactions say it landed, the same t always gives the same pose whatever came before, and evaluating
// it allocates nothing. (Frame-by-frame contacts, limits and speeds: drummerMotion-*.test.ts.)
import { describe, expect, test } from 'vitest';
import { GROOVES, loadGroove, strokeSpots } from './drummerMotionAudit';
import { blankTargets, maxLift, PREP } from '../src/drums/DrummerMotion';
import { createPose } from '../src/drums/DrummerIK';
import { mulberry32 } from '../src/core/random';
import { execFileSync } from 'node:child_process';
import { PostureLog, armPosture, postureGroup } from './drummerPosture';

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe.each(GROOVES)('%s', (name) => {
  const g = loadGroove(name);

  test("every hand's stroke lands on its spot at its time: the stick's contact within 2 mm, the spot where the kit's reactions put the hit; the arms held as real drummers hold them (drummerPosture.ts)", () => {
    const tg = blankTargets();
    const pose = createPose();
    const spotOf = strokeSpots(g);
    const posture = new PostureLog();
    const bad: string[] = [];
    let n = 0;
    let worst = 0;
    for (const h of g.sticking.hits) {
      if (!h.played || (h.limb !== 'R' && h.limb !== 'L')) continue;
      const hit = g.perf.hits[h.hit];
      g.motion.pose(h.t, tg, pose);
      // where the kit's reactions take the hit to land: its r and angle on the instrument, as it is at that instant
      // (on the hand's side of the snare in a roll)
      const spot = spotOf(h.hit);
      const e = Math.max(pose.error[h.limb], dist(pose.stick[h.limb].contact, tg[h.limb].point));
      const off = dist(tg[h.limb].point, spot);
      worst = Math.max(worst, e, off);
      n++;
      posture.add(postureGroup(hit.piece, h.limb), armPosture(pose, h.limb, tg[h.limb].point));
      if (e > 0.002 || off > 0.002 || tg[h.limb].lift > 1e-9) bad.push(`${h.t.toFixed(3)} ${h.limb} ${hit.piece}/${hit.zone}: contact ${(e * 1000).toFixed(2)} mm, spot ${(off * 1000).toFixed(2)} mm, lift ${tg[h.limb].lift}`);
    }
    expect(n).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    expect(worst).toBeLessThan(0.002);
    console.log(`${name} posture at impact:\n${posture.summary()}`);
    expect(posture.check()).toEqual([]);
  }, 240000);

  test('stroke heights by loudness, held down by the tempo', () => {
    // each hand stroke's preparation: a ghost note lower than a tap, a tap lower than an accent, none higher than
    // its hand can lift between it and the stroke before
    const by: Record<string, number[]> = { ghost: [], tap: [], accent: [] };
    for (const hand of ['R', 'L'] as const) {
      const S = g.motion.hands[hand].strokes;
      for (let i = 1; i < S.length; i++) {
        const s = S[i];
        if (s.kind === 'ready' || s.kind === 'choke') continue;
        const D = S[i - 1].kind === 'ready' ? 2 : s.t - S[i - 1].t;
        expect(s.prep).toBeLessThanOrEqual(Math.max(0.0081, maxLift(D)) + 1e-9);
        if (s.kind === 'double' || s.kind === 'buzz' || s.kind === 'grace') continue;
        by[s.level].push(s.prep);
      }
    }
    const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    if (by.ghost.length && by.tap.length) expect(med(by.ghost)).toBeLessThan(med(by.tap));
    if (by.tap.length && by.accent.length) expect(med(by.tap)).toBeLessThan(med(by.accent));
    // (at most the level's loudest, varied by up to 18% per hit, on a crash 15% larger)
    for (const x of by.ghost) expect(x).toBeLessThan(PREP.ghost[1] * 1.18 * 1.15 + 1e-9);
    for (const x of by.accent) expect(x).toBeLessThan(PREP.accent[1] * 1.18 * 1.15 + 1e-9);
  }, 60000);

  test('the same t gives the same pose, whatever was evaluated before (forward, backward, shuffled, from a fresh plan)', () => {
    const rnd = mulberry32(7);
    const times = Array.from({ length: 60 }, () => rnd() * Math.min(25, g.perf.duration));
    const snap = (m: typeof g.motion, t: number) => {
      const tg = blankTargets();
      const p = createPose();
      m.pose(t, tg, p);
      return [...p.angles, ...p.stick.R.tip, ...p.stick.L.tip, tg.R.lift, tg.L.lift, tg.feet.R.press, tg.feet.L.heelLift!];
    };
    const fwd = times.slice().sort((a, b) => a - b).map((t) => [t, snap(g.motion, t)] as const);
    const fresh = loadGroove(name).motion;
    const shuffled = times.slice().sort(() => rnd() - 0.5);
    const back = new Map(shuffled.map((t) => [t, snap(fresh, t)]));
    for (const [t, a] of fwd) expect(back.get(t)).toEqual(a);
    // and again in reverse on the same object
    for (const [t, a] of fwd.slice().reverse()) expect(snap(fresh, t)).toEqual(a);
  }, 240000);
});

test('evaluating targets, and posing once the arms are planned, allocate nothing', () => {
  // measured in a node of its own with a collection forced before each measure (tools/drummer-alloc.cjs), as the
  // robot's IK was: a call that made any object or array would grow the heap by tens of bytes or more each time.
  // What remains is the engine boxing a double across a call it does not inline: the IK alone, which allocates
  // nothing, grows it by a few KB a solve this way.
  const out = JSON.parse(execFileSync(process.execPath, ['tools/drummer-alloc.cjs'], { encoding: 'utf8' })) as Record<string, number>;
  console.log(`heap growth per call: evaluate ${out.evaluate.toFixed(1)} bytes, pose ${out.pose.toFixed(0)} bytes, the IK's own solve ${out.solve.toFixed(0)} bytes`);
  expect(out.evaluate).toBeLessThan(64);
  expect(out.pose).toBeLessThan(out.solve);
}, 240000);

