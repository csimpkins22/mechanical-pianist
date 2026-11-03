// Score -> Performance: hand assignment, then fingering per hand, then the
// physical sanity pass that makes sure no finger is asked to be in two places.
// Overrides are inputs, never patches on the output, so an edit simply
// re-plans with a constraint and the renderer never knows the difference.
import type { Finger, Hand, NoteFlag, Override, Performance, PerformanceNote, Score } from '../core/types';
import { keyOf } from '../core/keyboard';
import { fingerHand, pairCost, type Bans } from './Fingering';
import { assignHands, trackHands } from './HandAssignment';

export interface PlanOptions {
  /** where the hands are before the first note (each hand's centre, x): live playing knows */
  handsAt?: Partial<Record<Hand, number>>;
}

export function planPerformance(score: Score, overrides: Map<number, Override> = new Map(), bans: Bans = new Map(), opts: PlanOptions = {}): Performance {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const warnings: string[] = [];
  const tracks = trackHands(score.tracks, score.selectedTracks, score.notes);
  const hands = assignHands(score.notes, overrides, tracks, 40, opts.handsAt);

  const notes: PerformanceNote[] = score.notes.map((n) => {
    const flags: NoteFlag[] = [];
    const o = overrides.get(n.id);
    if (o?.hand) flags.push('hand-override');
    if (o?.finger) flags.push('finger-override');
    if (tracks && tracks.get(n.track) === hands.get(n.id)) flags.push('track-hand');
    return { ...n, hand: hands.get(n.id) ?? (n.midi < 60 ? 'L' : 'R'), finger: 3 as Finger, keyEnd: n.end, flags };
  });

  const byHand: Record<Hand, PerformanceNote[]> = { L: [], R: [] };
  for (const n of notes) byHand[n.hand].push(n);
  let approximated = 0;
  let stretched = 0;
  for (const hand of ['L', 'R'] as Hand[]) {
    const list = byHand[hand];
    const forced = new Map<number, Finger>();
    for (const n of list) {
      const f = overrides.get(n.id)?.finger;
      if (f) forced.set(n.id, f);
    }
    const res = fingerHand(list, hand, forced, bans);
    for (const n of list) {
      n.finger = res.fingers.get(n.id) ?? 3;
      const prior = res.priors.get(n.id);
      if (prior && prior.fingers.includes(n.finger)) n.flags.push(prior.source);
      if (res.overflow.has(n.id)) {
        n.flags.push('chord-overflow');
        approximated++;
      }
      if (res.unreachable.has(n.id)) {
        n.flags.push('unreachable');
        approximated++;
      } else if (res.stretch.has(n.id)) {
        n.flags.push('stretch');
        stretched++;
      }
    }
    list.sort((a, b) => a.start - b.start || a.midi - b.midi);
    // one finger, one key: if a finger is reassigned while still holding a key,
    // it lifts off just before its next attack (the sound may ring on).
    const lastByFinger = new Map<number, PerformanceNote>();
    for (const n of list) {
      if (n.flags.includes('chord-overflow')) continue;
      const prev = lastByFinger.get(n.finger);
      if (prev && prev.keyEnd > n.start - 0.06) {
        const lift = Math.max(prev.start + 0.04, n.start - 0.09);
        if (prev.midi !== n.midi || prev.keyEnd > n.start) {
          // lifting a little early is ordinary technique (the pedal covers it);
          // only a real loss of the held key is an approximation
          const lost = prev.keyEnd - lift;
          if (prev.midi !== n.midi && lost > 0.15 && lost > 0.3 * (prev.end - prev.start)) {
            prev.flags.push('finger-conflict');
            approximated++;
          }
          prev.keyEnd = Math.min(prev.keyEnd, lift);
        }
      }
      lastByFinger.set(n.finger, n);
    }
    // a held key that the hand cannot keep while reaching the next notes is
    // let go in time for the hand to travel (the pedal, if down, keeps it sounding)
    const sign = hand === 'R' ? 1 : -1;
    const playable = list.filter((n) => !n.flags.includes('chord-overflow'));
    for (let i = 0; i < playable.length; i++) {
      const n = playable[i];
      for (let j = i - 1; j >= 0 && n.start - playable[j].start < 8; j--) {
        const h = playable[j];
        if (h.finger === n.finger || h.keyEnd <= n.start - 0.03 || h.start >= n.start - 0.02) continue;
        const a = h.finger < n.finger ? h : n;
        const b = h.finger < n.finger ? n : h;
        const d = sign * (keyOf(b.midi).x - keyOf(a.midi).x);
        const v = pairCost(a.finger, b.finger, d);
        if (!v.impractical && !v.stretch) continue;
        const overlap = h.keyEnd - n.start;
        const travel = 0.05 + Math.abs(keyOf(n.midi).x - keyOf(h.midi).x) / 1.8;
        const lift = Math.max(h.start + 0.5 * (h.end - h.start), n.start - travel);
        if (overlap > 0.4 && v.impractical && lift >= h.keyEnd - 0.4) {
          if (!h.flags.includes('unreachable')) h.flags.push('unreachable');
          continue;
        }
        h.keyEnd = Math.max(h.start + 0.04, Math.min(h.keyEnd, lift));
      }
    }
  }
  if (approximated) warnings.push(`${approximated} note${approximated === 1 ? ' needs' : 's need'} a best-effort approximation (beyond the modelled hands)`);
  if (score.outOfRange) warnings.push(`${score.outOfRange} notes outside A0–C8 were moved by an octave`);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { score, notes, byHand, overrides, warnings, stats: { approximated, stretched, planningMs: t1 - t0 } };
}
