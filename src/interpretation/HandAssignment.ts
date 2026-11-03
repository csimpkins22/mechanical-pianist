// Which hand plays each note.
//
// A beam search over onset groups. Each search state carries where both hands
// are, which notes each is still holding and when each last moved; a group is
// split between the hands at every possible point and scored for reach, span,
// travel speed, hand collision, register and (when the file has them) the
// MIDI track a note came from. The cheapest path through the piece wins, so a
// split decision can depend on what comes several groups later.
//
// A hand holding a key is not tied to it: it may let go to play elsewhere (a
// bass note caught by the pedal goes on sounding while the hand moves up to
// play a chord in the middle of the keyboard). Letting go costs a little,
// more when no pedal holds the sound, so a hand keeps what it can comfortably
// hold and gives up only what would stretch it beyond reach.
import { keyOf, WHITE_PITCH } from '../core/keyboard';
import type { Hand, Override, PedalEvent, ScoreNote, TrackInfo } from '../core/types';
import { pedalDownAt } from './MidiEngine';

export interface OnsetGroup {
  time: number;
  notes: ScoreNote[]; // sorted by pitch
}

/** Notes whose onsets chain within `gap` seconds (and span < maxSpan) form one group. */
export function groupOnsets(notes: ScoreNote[], gap = 0.035, maxSpan = 0.1): OnsetGroup[] {
  const sorted = notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
  const groups: OnsetGroup[] = [];
  let cur: ScoreNote[] = [];
  let first = 0;
  let last = 0;
  for (const n of sorted) {
    if (cur.length && (n.start - last > gap || n.start - first > maxSpan)) {
      groups.push({ time: first, notes: cur.sort((a, b) => a.midi - b.midi) });
      cur = [];
    }
    if (!cur.length) first = n.start;
    cur.push(n);
    last = n.start;
  }
  if (cur.length) groups.push({ time: first, notes: cur.sort((a, b) => a.midi - b.midi) });
  return groups;
}

const W = WHITE_PITCH;
const COMFORT_SPAN = 0.17; // just over an octave of white keys
const MAX_SPAN = 0.215; // a ninth/tenth: the modelled hand's limit
const MIDDLE_X = keyOf(62).x; // D4: soft boundary between the hands' registers

interface HState {
  pos: number; // centre of the hand's current position (x)
  last: number; // time of last onset
  held: { x: number; end: number }[];
}

interface BeamState {
  L: HState;
  R: HState;
  cost: number;
  parent: BeamState | null;
  assign: Hand[] | null; // per note of this group
}

/** Track -> hand mapping when the file separates the hands into tracks. */
export function trackHands(tracks: TrackInfo[], selected: number[], notes: ScoreNote[]): Map<number, Hand> | null {
  const used = selected.filter((ti) => notes.some((n) => n.track === ti));
  if (used.length !== 2) return null;
  const named = new Map<number, Hand>();
  for (const ti of used) {
    const nm = tracks[ti]?.name.toLowerCase() ?? '';
    if (/\b(left|lh|bass|links|gauche|sinistra)\b|left hand/.test(nm)) named.set(ti, 'L');
    else if (/\b(right|rh|treble|melody|rechts|droite|destra)\b|right hand/.test(nm)) named.set(ti, 'R');
  }
  if (named.size === 2 && new Set(named.values()).size === 2) return named;
  const mean = (ti: number) => {
    const ns = notes.filter((n) => n.track === ti);
    return ns.reduce((s, n) => s + n.midi, 0) / ns.length;
  };
  const [a, b] = used;
  const ma = mean(a);
  const mb = mean(b);
  if (Math.abs(ma - mb) < 5) return null;
  return new Map<number, Hand>([
    [a, ma < mb ? 'L' : 'R'],
    [b, ma < mb ? 'R' : 'L'],
  ]);
}

/** what it costs to let go of a sounding key to play elsewhere: little under the pedal, more without it */
const RELEASE_PEDALLED = 0.6;
const RELEASE_DRY = 3;

/** the cost of a hand shape: more than five keys, and spans beyond comfort and beyond reach */
function shapeCost(xs: number[]): number {
  let cost = 0;
  if (xs.length > 5) cost += 400 * (xs.length - 5);
  const span = Math.max(...xs) - Math.min(...xs);
  if (span > COMFORT_SPAN) cost += (12 * (span - COMFORT_SPAN)) / W;
  if (span > MAX_SPAN) cost += (150 * (span - MAX_SPAN)) / W;
  return cost;
}

function handCost(h: HState, xs: number[], t: number, hand: Hand, pedalled: boolean): { cost: number; next: HState } {
  let held = h.held.filter((n) => n.end > t + 0.01);
  if (!xs.length) return { cost: 0, next: { ...h, held } };
  // keep holding everything, or let go of what lies furthest from the new
  // notes, one key at a time, whichever costs least
  let cost = shapeCost(xs.concat(held.map((n) => n.x)));
  if (held.length && cost > 0) {
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const byDistance = held.slice().sort((a, b) => Math.abs(b.x - mid) - Math.abs(a.x - mid));
    const each = pedalled ? RELEASE_PEDALLED : RELEASE_DRY;
    for (let k = 1; k <= byDistance.length; k++) {
      const kept = byDistance.slice(k);
      const c = each * k + shapeCost(xs.concat(kept.map((n) => n.x)));
      if (c < cost) {
        cost = c;
        held = kept;
      }
    }
  }
  const all = xs.concat(held.map((n) => n.x));
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const centre = (lo + hi) / 2;
  const d = Math.abs(centre - h.pos);
  const dt = Math.max(0.04, t - h.last);
  // travel: distance, plus a penalty for moving fast
  const speed = d / dt;
  cost += (0.35 * d) / W + 0.9 * Math.max(0, speed - 0.5) * Math.min(1, d / (3 * W));
  // register preference: left hand low, right hand high (soft)
  for (const x of xs) {
    if (hand === 'L' && x > MIDDLE_X) cost += (0.25 * (x - MIDDLE_X)) / W;
    if (hand === 'R' && x < MIDDLE_X) cost += (0.25 * (MIDDLE_X - x)) / W;
  }
  const newHeld = held.slice();
  return { cost, next: { pos: centre, last: t, held: newHeld } };
}

export function assignHands(
  notes: ScoreNote[],
  overrides: Map<number, Override>,
  tracks: Map<number, Hand> | null,
  beamWidth = 40,
  pedal: PedalEvent[] = [],
): Map<number, Hand> {
  const groups = groupOnsets(notes);
  const startL: HState = { pos: keyOf(48).x, last: -10, held: [] };
  const startR: HState = { pos: keyOf(72).x, last: -10, held: [] };
  // start the hands near the first notes so the opening is not penalised
  if (groups.length) {
    const xs = groups.slice(0, 8).flatMap((g) => g.notes.map((n) => keyOf(n.midi).x));
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    startL.pos = Math.min(startL.pos, lo + 0.04);
    startR.pos = Math.max(startR.pos, hi - 0.04);
  }
  let beam: BeamState[] = [{ L: startL, R: startR, cost: 0, parent: null, assign: null }];

  for (const g of groups) {
    const k = g.notes.length;
    const xs = g.notes.map((n) => keyOf(n.midi).x);
    const pedalled = pedalDownAt(pedal, g.time);
    const forced = g.notes.map((n) => overrides.get(n.id)?.hand);
    const candidates: Hand[][] = [];
    for (let s = 0; s <= k; s++) {
      const a: Hand[] = g.notes.map((_, i) => (forced[i] ?? (i < s ? 'L' : 'R')) as Hand);
      if (!candidates.some((c) => c.every((h, i) => h === a[i]))) candidates.push(a);
    }
    const next: BeamState[] = [];
    for (const st of beam) {
      for (const a of candidates) {
        const lx = xs.filter((_, i) => a[i] === 'L');
        const rx = xs.filter((_, i) => a[i] === 'R');
        const l = handCost(st.L, lx, g.time, 'L', pedalled);
        const r = handCost(st.R, rx, g.time, 'R', pedalled);
        let cost = st.cost + l.cost + r.cost;
        // the hands must not collide: left stays left of right
        const lPos = lx.length ? l.next.pos : st.L.pos;
        const rPos = rx.length ? r.next.pos : st.R.pos;
        // (when the file says which hand plays what, interlocking hands are the
        // composer's intent and cost much less)
        const sep = rPos - lPos;
        const crowd = tracks ? 0.35 : 1;
        if (sep < 0.07) cost += crowd * Math.min(8, (4 * (0.07 - sep)) / W);
        if (lx.length && rx.length && Math.max(...lx) >= Math.min(...rx)) cost += 30 * crowd;
        if (tracks) {
          g.notes.forEach((n, i) => {
            const th = tracks.get(n.track);
            if (th && th !== a[i]) cost += 12;
          });
        }
        // notes forced by the user are never moved
        if (a.some((h, i) => forced[i] && forced[i] !== h)) continue;
        const L: HState = lx.length ? l.next : { ...st.L, held: l.next.held };
        const R: HState = rx.length ? r.next : { ...st.R, held: r.next.held };
        g.notes.forEach((n, i) => {
          const target = a[i] === 'L' ? L : R;
          target.held = target.held.concat([{ x: xs[i], end: n.end }]);
        });
        next.push({ L, R, cost, parent: st, assign: a });
      }
    }
    // keep the best state per (rounded positions) signature, then the cheapest few
    next.sort((p, q) => p.cost - q.cost);
    const seen = new Set<string>();
    beam = [];
    for (const s of next) {
      const sig = `${Math.round(s.L.pos / (W * 0.5))}:${Math.round(s.R.pos / (W * 0.5))}:${s.L.held.length}:${s.R.held.length}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      beam.push(s);
      if (beam.length >= beamWidth) break;
    }
  }

  const out = new Map<number, Hand>();
  let s: BeamState | null = beam[0] ?? null;
  const path: BeamState[] = [];
  while (s && s.assign) {
    path.push(s);
    s = s.parent;
  }
  path.reverse();
  path.forEach((st, gi) => {
    groups[gi].notes.forEach((n, i) => out.set(n.id, st.assign![i]));
  });
  return out;
}
