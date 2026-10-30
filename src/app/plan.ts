// Interpretation checked against the physical hand: plan the fingering, plan
// the motion, and where the motion shows a fingertip that cannot stay on its
// key (a chord shape the pairwise span rules allow but this hand cannot make
// with the others it is holding), ban that shape and plan again.
import type { Override, Performance, PerformanceNote, Score } from '../core/types';
import { groupKey, type Bans } from '../interpretation/Fingering';
import { groupOnsets } from '../interpretation/HandAssignment';
import { planPerformance } from '../interpretation/PerformancePlanner';
import { PerformanceTimeline } from '../performance/PerformanceTimeline';
import { poseHand } from '../performance/HandPoser';
import { len, sub } from '../core/handGeometry';

const TOLERANCE = 0.002; // metres of fingertip error that counts as a miss
const MAX_ROUNDS = 2;
const SCAN = 1 / 30;

/**
 * Whether any note of an onset group loses its key. The timeline samples each
 * note at a few instants; shapes at risk (chords of three or more, stretches)
 * are also scanned through the whole hold, since the hand moving on toward
 * what comes next can pull a spread hand off a key between those instants.
 */
function groupMisses(timeline: PerformanceTimeline, notes: PerformanceNote[]): boolean {
  if (notes.some((n) => (timeline.contactError.get(n.id) ?? 0) > TOLERANCE)) return true;
  const risky = notes.length >= 3 || notes.some((n) => n.flags.includes('stretch') || n.flags.includes('unreachable'));
  if (!risky) return false;
  const track = timeline.plan.hands[notes[0].hand];
  const t0 = Math.min(...notes.map((n) => n.start));
  const t1 = Math.max(...notes.map((n) => n.keyEnd));
  for (let t = t0; t <= t1; t += SCAN) {
    const states = poseHand(track, timeline.keys, t).states;
    for (const n of notes) {
      if (t > n.keyEnd) continue;
      const st = states[n.finger];
      if (st.note?.note === n && len(sub(st.tip, st.target)) > TOLERANCE) return true;
    }
  }
  return false;
}

/** progress through planning: fraction 0..1 and what is happening */
export type PlanProgress = (fraction: number, label: string) => void;

export function planChecked(
  score: Score,
  overrides: Map<number, Override> = new Map(),
  progress: PlanProgress = () => {},
): { perf: Performance; timeline: PerformanceTimeline; rounds: number } {
  const bans: Bans = new Map();
  // rough shares of the work: interpretation is light, motion and its
  // refinement heavy; a re-plan (if needed) is reported as a second pass
  let span: [number, number] = [0, 1];
  const at = (u: number, label: string) => progress(span[0] + (span[1] - span[0]) * u, label);
  span = [0, 0.75];
  at(0, 'Choosing hands and fingers');
  let perf = planPerformance(score, overrides, bans);
  at(0.12, 'Planning the motion');
  let timeline = new PerformanceTimeline(perf, (u) => at(0.12 + 0.88 * u, 'Planning the motion'));
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    let added = false;
    for (const hand of ['L', 'R'] as const) {
      const list = perf.notes.filter((n) => n.hand === hand);
      for (const g of groupOnsets(list)) {
        const notes = g.notes as typeof list;
        // shapes beyond any hand (flagged unreachable) cannot be fixed by refingering
        if (notes.length > 5 || notes.some((n) => n.flags.includes('chord-overflow') || n.flags.includes('unreachable'))) continue;
        if (notes.some((n) => overrides.get(n.id)?.finger)) continue; // the user asked for it
        if (!groupMisses(timeline, notes)) continue;
        const key = groupKey(notes.map((n) => n.id));
        const tuple = notes
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((n) => n.finger)
          .join('');
        const list2 = bans.get(key) ?? [];
        if (list2.includes(tuple)) continue;
        bans.set(key, [...list2, tuple]);
        added = true;
      }
    }
    if (!added) break;
    span = [0.75 + 0.25 * (rounds / MAX_ROUNDS), 0.75 + 0.25 * ((rounds + 1) / MAX_ROUNDS)];
    at(0, 'Refingering the shapes the hands could not hold');
    perf = planPerformance(score, overrides, bans);
    timeline = new PerformanceTimeline(perf, (u) => at(0.1 + 0.9 * u, 'Refingering the shapes the hands could not hold'));
  }
  progress(1, 'Ready');
  return { perf, timeline, rounds };
}
