// Bundled and run by plan-library.cjs (in Node): the library's pieces, and
// the plan for one of them, made exactly as the app's planner worker makes it.
import { LIBRARY } from '../src/app/library';
import { planChecked } from '../src/app/plan';
import { encodePlan, fingerprint } from '../src/app/planCodec';
import { unlinkPlan } from '../src/performance/MotionPlanner';
import { buildScore, defaultTrackSelection, readMidi } from '../src/interpretation/MidiEngine';

function request(id: string) {
  const e = LIBRARY.find((x) => x.id === id);
  if (!e) throw new Error(`no library piece "${id}"`);
  const bytes = e.bytes();
  const parsed = readMidi(bytes, `${e.id}.mid`);
  return { bytes, name: parsed.name, tracks: defaultTrackSelection(parsed.tracks) };
}

export function pieces() {
  return LIBRARY.map((e) => {
    const r = request(e.id);
    return { id: e.id, midi: fingerprint(r.bytes), tracks: r.tracks };
  });
}

export function plan(id: string): Uint8Array {
  const r = request(id);
  const { perf, timeline } = planChecked(buildScore(readMidi(r.bytes, r.name), r.tracks), new Map());
  unlinkPlan(timeline.plan);
  return encodePlan({ perf, timeline });
}
