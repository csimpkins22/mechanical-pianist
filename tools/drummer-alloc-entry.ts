// Bundled by tools/drummer-alloc.cjs: how much the heap grows per call of the drummer's performance
// (evaluate: the targets; pose: the targets through the IK), with a collection forced before each measure.
import { readFileSync } from 'node:fs';
import { readDrumMidi } from '../src/drums/DrumScore';
import { assignLimbs } from '../src/drums/Sticking';
import { KitMotion } from '../src/drums/KitMotion';
import { DrummerMotion, blankTargets } from '../src/drums/DrummerMotion';
import { createPose, solveDrummer } from '../src/drums/DrummerIK';
import { namedPoses } from '../src/drums/DrummerPoses';

export function measure(file: string) {
  const perf = readDrumMidi(new Uint8Array(readFileSync(file)), file);
  const m = new DrummerMotion(perf, assignLimbs(perf), new KitMotion(perf));
  m.solveKeys();
  const tg = blankTargets();
  const p = createPose();
  const gc = (globalThis as unknown as { gc: () => void }).gc;
  const D = perf.duration - 1;
  function evals(n: number) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      m.evaluate((i * 0.0137) % D, tg);
      s += tg.R.lift;
    }
    return s;
  }
  function poses(n: number) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      m.pose((i * 0.0137) % D, tg, p);
      s += p.angles[3];
    }
    return s;
  }
  // the robot's IK alone, as its own stage measured it
  const named = namedPoses().map((x) => x.targets);
  function solves(n: number) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      solveDrummer(named[i % named.length], p);
      s += p.angles[3];
    }
    return s;
  }
  const out: Record<string, number> = {};
  for (const [k, f, n] of [
    ['evaluate', evals, 50000],
    ['pose', poses, 3000],
    ['solve', solves, 600],
  ] as const) {
    // (warmed up well past the optimizing compiler's thresholds first, so what is measured is optimized code; the
    // median of five runs, each after a collection)
    for (let w = 0; w < 4; w++) f(n);
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      f(n);
      runs.push((process.memoryUsage().heapUsed - h0) / n);
    }
    out[k] = runs.sort((a, b) => a - b)[2];
  }
  return out;
}
