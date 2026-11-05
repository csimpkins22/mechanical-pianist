// Interpretation off the main thread: MIDI bytes in, a planned performance
// (plain data: the structured clone of the Performance and its timeline)
// out, with progress along the way. See planner.ts for the other side.
import type { Override } from '../core/types';
import { buildScore, readMidi } from '../interpretation/MidiEngine';
import { unlinkPlan } from '../performance/MotionPlanner';
import { planChecked } from './plan';

interface Request {
  bytes: Uint8Array;
  name: string;
  tracks: number[];
  overrides: [number, Override][];
}

const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

self.onmessage = (e: MessageEvent<Request>) => {
  const { bytes, name, tracks, overrides } = e.data;
  try {
    const score = buildScore(readMidi(bytes, name), tracks);
    let last = 0;
    const res = planChecked(score, new Map(overrides), (fraction, label) => {
      const now = performance.now();
      if (now - last > 100 || fraction >= 1) {
        last = now;
        post({ type: 'progress', fraction, label });
      }
    });
    unlinkPlan(res.timeline.plan);
    post({ type: 'done', perf: res.perf, timeline: res.timeline });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
