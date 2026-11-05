// The robot drummer's IK against KitLayout: every strike spot reached with
// the stick's contact within 2 mm at a drummer's stick angle, every joint
// within its limits, no NaNs across a sweep between spots, the same targets
// always giving the same pose, a drummer's lean, and no stick, arm, leg or
// foot through the kit (its drums, its cymbals' real profiles and every
// stand, leg and brace where the kit's model puts them).
import { describe, expect, test } from 'vitest';
import { DRUMS, SPOTS, type DrumId } from '../src/drums/KitLayout';
import { kitStands } from '../src/drums/KitStands';
import { GRIP_FIT, STICK_BEAD, STICK_SHOULDER, createPose, limitViolations, solveDrummer, type DrummerPose, type DrummerTargets, type StickTarget } from '../src/drums/DrummerIK';
import { SWEEP, blendTargets, emptyTargets, namedPoses, stroke, type Spot } from '../src/drums/DrummerPoses';
import { clearance } from '../src/drums/DrummerClearance';
import { DOF_BASE, J, NJ, type Side } from '../src/drums/DrummerSpec';

const D = Math.PI / 180;

/** a strike with one hand, the other ready over the snare */
function strike(side: Side, id: DrumId, spot: Spot = 'head', opts: { open?: boolean } = {}): DrummerTargets {
  const hit = stroke(id, spot, 0, opts);
  // the other hand ready over the snare: beside the striking stick on the snare; otherwise toward the drum's
  // middle (the left hand away from the hi-hat when the right plays elsewhere)
  const ready = stroke('snare', 'head', 0.06, { across: (id === 'snare' ? -1 : 1) * (side === 'R' ? 0.04 : -0.04) });
  return {
    R: side === 'R' ? hit : ready,
    L: side === 'L' ? hit : ready,
    lead: side,
    feet: { R: { pedal: 'kickPedal', heel: 'up', press: 0 }, L: { pedal: 'hihatPedal', heel: 'down', press: opts.open ? 0 : 1 } },
  };
}

/** every spot KitLayout offers the sticks, with the hands that play it */
const REACH: { name: string; side: Side; id: DrumId; spot: Spot; open?: boolean; angle: [number, number] }[] = [
  { name: 'snare head (R)', side: 'R', id: 'snare', spot: 'head', angle: [10, 25] },
  { name: 'snare head (L)', side: 'L', id: 'snare', spot: 'head', angle: [10, 25] },
  { name: 'tom 1 head (R)', side: 'R', id: 'tom1', spot: 'head', angle: [10, 25] },
  { name: 'tom 1 head (L)', side: 'L', id: 'tom1', spot: 'head', angle: [10, 25] },
  { name: 'tom 2 head (R)', side: 'R', id: 'tom2', spot: 'head', angle: [10, 25] },
  { name: 'tom 2 head (L)', side: 'L', id: 'tom2', spot: 'head', angle: [10, 25] },
  { name: 'floor tom head (R)', side: 'R', id: 'floorTom', spot: 'head', angle: [10, 25] },
  { name: 'hi-hat closed (R, crossed)', side: 'R', id: 'hihat', spot: 'head', angle: [8, 20] },
  { name: 'hi-hat open (R, crossed)', side: 'R', id: 'hihat', spot: 'head', open: true, angle: [8, 20] },
  { name: 'ride bow (R)', side: 'R', id: 'ride', spot: 'head', angle: [5, 12] },
  { name: 'ride bell (R)', side: 'R', id: 'ride', spot: 'bell', angle: [15, 30] },
  // a crash is struck with the shoulder of the stick, the stick rising over the edge (a negative angle)
  { name: 'crash edge (L)', side: 'L', id: 'crash', spot: 'edge', angle: [-20, -5] },
  { name: 'crash edge (R)', side: 'R', id: 'crash', spot: 'edge', angle: [-20, -5] },
];

const finite = (p: DrummerPose) =>
  [p.local, p.world, p.pos, p.angles, p.fingers.R, p.fingers.L].every((a) => a.every(Number.isFinite)) &&
  (['R', 'L'] as Side[]).every((s) => [p.stick[s].tip, p.stick[s].butt].every((v) => v.every(Number.isFinite)));

describe('drummer IK reaches every strike spot', () => {
  const pose = createPose();
  for (const r of REACH) {
    test(r.name, () => {
      const t = strike(r.side, r.id, r.spot, { open: r.open });
      solveDrummer(t, pose);
      expect(finite(pose)).toBe(true);
      // the stick's surface where it is meant to touch (the tip's bead; the shoulder for a crash) is on the spot
      expect(pose.error[r.side]).toBeLessThan(0.002);
      const contact = pose.stick[r.side].contact;
      const spot = t[r.side].point;
      expect(Math.hypot(contact[0] - spot[0], contact[1] - spot[1], contact[2] - spot[2])).toBeLessThan(0.002);
      expect(t[r.side].contactFromTip).toBe(r.spot === 'edge' && DRUMS[r.id].kind === 'cymbal' ? STICK_SHOULDER : STICK_BEAD);
      // at the angle asked for, which is a drummer's
      const a = pose.stickAngle[r.side] / D;
      expect(a).toBeGreaterThanOrEqual(r.angle[0]);
      expect(a).toBeLessThanOrEqual(r.angle[1]);
      expect(Math.abs(pose.stickAngle[r.side] - t[r.side].angle)).toBeLessThan(0.5 * D);
      expect(limitViolations(pose)).toEqual([]);
    });
  }

  test("the spots are KitLayout's own", () => {
    // the targets come from SPOTS, not from copies of its numbers
    const t = stroke('ride', 'bell');
    expect(t.point).toEqual(SPOTS.bell(DRUMS.ride));
  });

  test('the fingers close on the stick (index, middle and thumb within 1 mm; ring and little loosely)', () => {
    expect(GRIP_FIT[0]).toBeLessThan(0.001);
    expect(GRIP_FIT[1]).toBeLessThan(0.001);
    expect(GRIP_FIT[4]).toBeLessThan(0.001);
    expect(GRIP_FIT[2]).toBeLessThan(0.004);
    expect(GRIP_FIT[3]).toBeLessThan(0.006);
  });
});

describe('drummer poses', () => {
  const pose = createPose();
  const poses = namedPoses();

  test('every named pose keeps every joint within its limits, with the sticks where asked', () => {
    for (const np of poses) {
      solveDrummer(np.targets, pose);
      expect(limitViolations(pose), np.name).toEqual([]);
      expect(finite(pose), np.name).toBe(true);
      for (const s of ['R', 'L'] as Side[]) expect(pose.error[s], `${np.name} ${s}`).toBeLessThan(0.002);
      expect(pose.footError.R + pose.footError.L, np.name).toBeLessThan(0.002);
    }
  });

  test('ghost note against accent: the stick 2-3 cm off the snare, then high', () => {
    const ghost = poses.find((p) => p.name === 'ghost')!;
    const accent = poses.find((p) => p.name === 'accent')!;
    solveDrummer(ghost.targets, pose);
    const n = ghost.targets.L.normal;
    const above = (tip: Float64Array, p: number[]) => (tip[0] - p[0]) * n[0] + (tip[1] - p[1]) * n[1] + (tip[2] - p[2]) * n[2];
    const g = above(pose.stick.L.tip, ghost.targets.L.point);
    expect(g).toBeGreaterThan(0.02);
    expect(g).toBeLessThan(0.035);
    solveDrummer(accent.targets, pose);
    expect(above(pose.stick.L.tip, accent.targets.L.point)).toBeGreaterThan(0.33);
    // the stick near upright, the wrist cocked back and the forearm raised: a stroke made mostly at the wrist
    expect(pose.stickAngle.L).toBeLessThan(-35 * D);
  });

  test('kick heel up and heel down; hi-hat heel down with the toe pressing', () => {
    const up = poses.find((p) => p.name === 'kickHeelUp')!;
    const down = poses.find((p) => p.name === 'kickHeelDown')!;
    solveDrummer(up.targets, pose);
    const toesUp = pose.angles[DOF_BASE[J.leg.R.toes]];
    const heelUpY = pose.pos[J.leg.R.foot * 3 + 1];
    expect(toesUp).toBeGreaterThan(15 * D);
    expect(pose.pedal.kickPedal).toBeLessThan(-0.05);
    solveDrummer(down.targets, pose);
    expect(pose.angles[DOF_BASE[J.leg.R.toes]]).toBeCloseTo(0, 6);
    expect(pose.pos[J.leg.R.foot * 3 + 1]).toBeLessThan(heelUpY - 0.03);
    // the hi-hat foot: heel down, the board pressed
    expect(pose.angles[DOF_BASE[J.leg.L.toes]]).toBeCloseTo(0, 6);
    expect(pose.pedal.hihatPedal).toBeLessThan(-0.1);
  });

  test('the body turns for far targets and the arms do not overstretch', () => {
    const floor = poses.find((p) => p.name === 'floorTom')!;
    solveDrummer(floor.targets, pose);
    expect(pose.torso[0]).toBeLessThan(-8 * D); // turned right
    const groove = poses.find((p) => p.name === 'groove')!;
    solveDrummer(groove.targets, pose);
    expect(pose.torso[0]).toBeGreaterThan(5 * D); // turned left toward the hi-hat
    for (const np of poses) {
      solveDrummer(np.targets, pose);
      for (const s of ['R', 'L'] as Side[]) {
        const e = pose.angles[DOF_BASE[J.arm[s].forearm]];
        expect(e, `${np.name} ${s} elbow`).toBeGreaterThan(45 * D);
      }
    }
  });
});

describe('a sweep between spots', () => {
  test('no NaNs, no joint out of range, and the sticks move without jumping', () => {
    const poses = namedPoses();
    const by = (n: string) => poses.find((p) => p.name === n)!;
    const pose = createPose();
    const t = emptyTargets();
    const steps = 60;
    const prev = { R: new Float64Array(3), L: new Float64Array(3) };
    const moves: number[] = [];
    for (let k = 0; k < SWEEP.length; k++) {
      const a = by(SWEEP[k]).targets;
      const b = by(SWEEP[(k + 1) % SWEEP.length]).targets;
      for (let i = 0; i <= steps; i++) {
        blendTargets(a, b, i / steps, t);
        solveDrummer(t, pose);
        expect(finite(pose), `${SWEEP[k]} ${i}`).toBe(true);
        const v = limitViolations(pose, 0.02);
        if (v.length) console.log(SWEEP[k], i, v.map((x) => `${x.name} ${(x.value / D).toFixed(1)}`).join(', '));
        expect(v, `${SWEEP[k]} ${i}`).toEqual([]);
        if (k + i > 0) for (const s of ['R', 'L'] as Side[]) moves.push(Math.hypot(...[0, 1, 2].map((q) => pose.stick[s].tip[q] - prev[s][q])));
        for (const s of ['R', 'L'] as Side[]) prev[s].set(pose.stick[s].tip);
      }
    }
    moves.sort((x, y) => x - y);
    // most of the way the tips glide (a transition takes 60 steps). The fast turns stay bounded: the largest
    // (about 0.19 m in one step) is the left stick rising to an accent under the crossed right arm, where the
    // straight-line blend makes the arm change how it passes. (A performance's planned motion does not blend
    // straight through like this: tests/drummerMotion.test.ts holds its sticks to a speed limit.)
    expect(moves[Math.floor(moves.length * 0.95)]).toBeLessThan(0.02);
    expect(moves[moves.length - 1]).toBeLessThan(0.2);
  }, 60000);
});

describe('determinism', () => {
  test('the same targets give the same pose, whatever was solved before', () => {
    const poses = namedPoses();
    const a = createPose();
    const b = createPose();
    solveDrummer(poses[0].targets, a);
    for (const p of poses.slice(1)) solveDrummer(p.targets, b);
    solveDrummer(poses[0].targets, b);
    expect(Array.from(b.local)).toEqual(Array.from(a.local));
    expect(Array.from(b.angles)).toEqual(Array.from(a.angles));
    expect(Array.from(b.fingers.L)).toEqual(Array.from(a.fingers.L));
    expect(Array.from(b.stick.R.tip)).toEqual(Array.from(a.stick.R.tip));
    expect(a.local.length).toBe(NJ * 9);
  });
});

describe('clearance against the kit (KitProxy: drums, cymbal profiles, stands)', () => {
  const pose = createPose();
  const cases: { name: string; targets: DrummerTargets; open?: boolean }[] = [
    ...namedPoses().map((p) => ({ name: p.name, targets: p.targets, open: p.name === 'hihatOpen' })),
    ...REACH.map((r) => ({ name: r.name, targets: strike(r.side, r.id, r.spot, { open: r.open }), open: r.open })),
  ];
  for (const c of cases) {
    test(c.name, () => {
      solveDrummer(c.targets, pose);
      const contacts = clearance(pose, c.targets, { hihatOpen: c.open });
      // sticks: never through a cymbal, a stand, a drum or the other stick (1 mm for the proxies' facets)
      const sticks = contacts.filter((x) => x.a.startsWith('stick') && !['torso', 'thigh R', 'thigh L'].includes(x.b));
      expect(sticks.filter((x) => x.distance < -0.001)).toEqual([]);
      // forearms and hands: never through a cymbal or a stand, nor each other
      const arms = contacts.filter((x) => /^(forearm|hand)/.test(x.a) && !/thigh/.test(x.b));
      expect(arms.filter((x) => x.distance < -0.001)).toEqual([]);
      // thighs, shins, feet and toes: never through a drum or a stand's legs
      const legs = contacts.filter((x) => /^(thigh|shin|foot|toes)/.test(x.a));
      expect(legs.filter((x) => x.distance < -0.001)).toEqual([]);
    });
  }

  test("the stands are where the kit's model puts them", async () => {
    // the same tripods, placed by the same rule in the same order: the same centres and the same clearances
    const { DrumKitModel } = await import('../src/presentation/DrumKitModel');
    const model = new DrumKitModel();
    const ours = kitStands().legClearance;
    expect(ours.length).toBe(model.legClearance.length);
    ours.forEach((c, i) => {
      expect(c.at[0]).toBeCloseTo(model.legClearance[i].at[0], 9);
      expect(c.at[1]).toBeCloseTo(model.legClearance[i].at[1], 9);
      expect(c.clear).toBeCloseTo(model.legClearance[i].clear, 9);
    });
  });
});

describe("a drummer's posture", () => {
  const pose = createPose();
  const poses = namedPoses();
  /** the lean of a line from vertical, toward the kit (-z), degrees */
  const lean = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.atan2(-(b[2] - a[2]), b[1] - a[1]) / D;
  const P = (j: number) => pose.pos.subarray(j * 3, j * 3 + 3);

  test('leaning in from the hips, the upper back a little rounded, in every pose', () => {
    for (const np of poses) {
      solveDrummer(np.targets, pose);
      // the back, from the pelvis to the chest's pivot (as in clips 4 and 8: 15-20 degrees, a little more when reaching)
      const back = lean(P(J.pelvis), P(J.chest));
      expect(back, np.name).toBeGreaterThan(15);
      expect(back, np.name).toBeLessThan(21);
      // the chest leans further than the back below it: the upper back rounds
      const cw = pose.world.subarray(J.chest * 9, J.chest * 9 + 9);
      expect(Math.atan2(-cw[7], cw[4]) / D, np.name).toBeGreaterThan(back + 4);
    }
    // at the snare, nothing reaching: 15-18 degrees
    solveDrummer(poses.find((p) => p.name === 'snare')!.targets, pose);
    expect(lean(P(J.pelvis), P(J.chest))).toBeGreaterThan(15);
    expect(lean(P(J.pelvis), P(J.chest))).toBeLessThan(18);
  });

  // (leaning in, the back tilts forward over elbows that still hang: they may sit up to 3 cm past its plane; the
  // floor tom draws the right one back, and reaching up and out to the crash the left one)
  test('the elbows hang beside the body, not out behind the back (bar the floor tom and the crash)', () => {
    for (const np of poses) {
      solveDrummer(np.targets, pose);
      const sw = pose.world.subarray(J.spine2 * 9, J.spine2 * 9 + 9);
      const s2 = P(J.spine2);
      for (const s of ['R', 'L'] as Side[]) {
        if (s === 'R' && (np.name === 'floorTom' || np.name === 'fill')) continue;
        if (s === 'L' && np.name === 'crash') continue;
        const e = P(J.arm[s].forearm);
        // the elbow's back (its barrel, 4.5 cm) at most 3 cm past the lower thorax's back (its half-depth, 9.2 cm)
        const behind = (e[0] - s2[0]) * sw[2] + (e[1] - s2[1]) * sw[5] + (e[2] - s2[2]) * sw[8] - 0.092 + 0.045;
        expect(behind, `${np.name} ${s}`).toBeLessThan(0.03);
      }
    }
  });
});

void ({} as StickTarget);
