// Live windows planned off the main thread (see LivePlanner): a request in,
// the planned window out as plain data (planner.ts revives its classes).
import { unlinkPlan } from '../performance/MotionPlanner';
import { planWindow, type WindowRequest } from './LivePlanner';

const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

self.onmessage = (e: MessageEvent<WindowRequest>) => {
  try {
    const w = planWindow(e.data);
    unlinkPlan(w.timeline.plan);
    post({ ok: true, g: w.g, origin: w.origin, perf: w.perf, timeline: w.timeline });
  } catch (err) {
    post({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
