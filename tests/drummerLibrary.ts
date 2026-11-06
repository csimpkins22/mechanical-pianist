// The fast check of the library's other grooves (drummerLibrary-*.test.ts, the grooves shared between the files so
// they run side by side): each is read onto this kit, every hit given a limb, the performance planned; every hand
// stroke lands on its spot within 2 mm; the same t gives the same pose in any order and from a fresh plan; and the
// whole performance, sampled at FAST_FPS, has no NaN, the feet on their boards, and nothing new or worse than
// KNOWN_FAST (contacts, joint limits, hands and stick tips past their speeds). The full 120 fps audit of every
// groove is run by tools/drummer-audit.cjs (its results are in the README).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Midi } from '@tonejs/midi';
import { FAST_FPS, KNOWN_FAST, against, audit, loadGroove, report, strokeSpots, type NewGroove } from './drummerMotionAudit';
import { blankTargets, maxLift } from '../src/drums/DrummerMotion';
import { createPose } from '../src/drums/DrummerIK';
import { DRUM_MAP } from '../src/drums/DrumScore';
import { mulberry32 } from '../src/core/random';

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function libraryGrooves(names: readonly NewGroove[]) {
  describe.each(names)('%s', (name) => {
    const g = loadGroove(name);
    const known = KNOWN_FAST[name];

    test('every note is a piece of this kit, every hit has a limb, the performance is planned', () => {
      const midi = new Midi(readFileSync(`src/music/drums/${name}.mid`));
      const notes = midi.tracks.flatMap((t) => t.notes);
      expect(notes.filter((n) => !DRUM_MAP[n.midi]).map((n) => n.midi)).toEqual([]);
      expect(g.perf.hits).toHaveLength(notes.length);
      expect(g.perf.hihatFromCC || !g.perf.hits.some((h) => h.piece === 'hihat')).toBe(true);
      expect(g.sticking.hits).toHaveLength(g.perf.hits.length);
      g.sticking.hits.forEach((h, k) => expect(h.hit).toBe(k));
      expect(g.sticking.dropped.length).toBeLessThanOrEqual(known.dropped);
      for (const hand of ['R', 'L'] as const)
        for (const s of g.motion.hands[hand].strokes) {
          if (s.kind === 'ready') continue;
          expect(Number.isFinite(s.prep) && Number.isFinite(s.top)).toBe(true);
        }
    });

    test("every hand's stroke lands on its spot at its time, the stick's contact within 2 mm; preparations within reach", () => {
      const tg = blankTargets();
      const pose = createPose();
      const spotOf = strokeSpots(g);
      const bad: string[] = [];
      let n = 0;
      for (const h of g.sticking.hits) {
        if (!h.played || (h.limb !== 'R' && h.limb !== 'L')) continue;
        g.motion.pose(h.t, tg, pose);
        const e = Math.max(pose.error[h.limb], dist(pose.stick[h.limb].contact, tg[h.limb].point));
        const off = dist(tg[h.limb].point, spotOf(h.hit));
        n++;
        if (!(e <= 0.002 && off <= 0.002 && tg[h.limb].lift <= 1e-9)) bad.push(`${h.t.toFixed(3)} ${h.limb} ${h.piece}/${h.zone}: contact ${(e * 1000).toFixed(2)} mm, spot ${(off * 1000).toFixed(2)} mm`);
      }
      expect(n).toBeGreaterThan(100);
      expect(bad).toEqual([]);
      // no stroke prepared higher than its hand can lift between it and the stroke before
      for (const hand of ['R', 'L'] as const) {
        const S = g.motion.hands[hand].strokes;
        for (let i = 1; i < S.length; i++) {
          if (S[i].kind === 'ready' || S[i].kind === 'choke') continue;
          const D = S[i - 1].kind === 'ready' ? 2 : S[i].t - S[i - 1].t;
          expect(S[i].prep).toBeLessThanOrEqual(Math.max(0.0081, maxLift(D)) + 1e-9);
        }
      }
    }, 240000);

    test('the same t gives the same pose, whatever was evaluated before (forward, shuffled, from a fresh plan)', () => {
      const rnd = mulberry32(11);
      const times = Array.from({ length: 16 }, () => rnd() * Math.min(12, g.perf.duration));
      const snap = (m: typeof g.motion, t: number) => {
        const tg = blankTargets();
        const p = createPose();
        m.pose(t, tg, p);
        return [...p.angles, ...p.stick.R.tip, ...p.stick.L.tip, tg.R.lift, tg.L.lift, tg.feet.R.press, tg.feet.L.heelLift!];
      };
      const fwd = times.slice().sort((a, b) => a - b).map((t) => [t, snap(g.motion, t)] as const);
      const fresh = loadGroove(name).motion;
      const back = new Map(times.slice().sort(() => rnd() - 0.5).map((t) => [t, snap(fresh, t)]));
      for (const [t, a] of fwd) {
        expect(a.every(Number.isFinite)).toBe(true);
        expect(back.get(t)).toEqual(a);
      }
    }, 240000);

    test(`every frame at ${FAST_FPS} fps: no NaN, the feet on their boards, nothing through the kit or the other arm beyond what is known`, () => {
      const a = audit(g, 0, Infinity, FAST_FPS);
      console.log(report(name, a, FAST_FPS));
      expect(a.nan).toBe(0);
      expect(a.feet).toBeLessThan(0.002);
      expect(a.board).toBeLessThan(1e-9);
      expect(against(known, a)).toEqual([]);
    }, 600000);
  });
}
