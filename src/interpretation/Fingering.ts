// Which finger plays each note, for one hand.
//
// A beam search over the hand's onset groups. A state remembers the last key
// each finger played (and whether it is still holding it), the hand's implied
// position, and the previous group. Transition costs follow the rule set of
// Parncutt et al. (1997), "An ergonomic model of keyboard fingering for
// melodic fragments", extended to chords and to timing: comfortable and
// practical spans between finger pairs, thumb passing, weak fingers, thumb
// and little finger on black keys, same-finger reuse, held-note conflicts
// and hand travel speed. Distances are physical (metres between keys, in
// "semitone equivalents" of 13.7 mm), because hands care how far a key is,
// not what interval it makes: E-F is as wide as C-D.
//
// Everything runs in the right-hand canonical frame; left-hand positions are
// mirrored (x -> -x) so finger 1 is always on the low side.
import { isBlack, keyOf } from '../core/keyboard';
import { NATURAL_OFFSET } from '../core/handGeometry';
import type { Finger, Hand, ScoreNote } from '../core/types';
import { groupOnsets } from './HandAssignment';

/** how long a key may still be held when its finger is needed elsewhere */
const HELD_SLACK = 0.1;
const SEMI = 0.0137; // metres per "semitone equivalent" (an octave is 164.5 mm)
const W = 0.0235;

// [MinPrac, MinComf, MinRel, MaxRel, MaxComf, MaxPrac] in semitone equivalents,
// for finger pair (a, b), a < b, distance measured from a to b.
// Spans are scaled slightly for the robot hand, which is a little larger than
// the average hand the original table was written for.
const TABLE: Record<string, number[]> = {
  '1-2': [-6, -4, 1, 5, 8, 10.5],
  '1-3': [-7, -3.5, 3, 7, 10, 12.5],
  '1-4': [-6.5, -2.5, 5, 9, 11, 13.5],
  '1-5': [-2, 0, 7, 10, 12.4, 15],
  '2-3': [0.6, 1, 1, 2.6, 3.7, 5.6],
  '2-4': [1, 1.5, 3, 4.6, 6, 8],
  '2-5': [2, 2.5, 5, 7, 8.6, 10.5],
  '3-4': [0.6, 1, 1, 2.2, 3.1, 4.7],
  '3-5': [1, 1.5, 3, 4.6, 6, 8],
  '4-5': [0.6, 1, 1, 2.4, 3.7, 5.5],
};

export interface FingerNote {
  note: ScoreNote;
  X: number; // canonical position
  black: boolean;
}

interface Slot {
  X: number;
  black: boolean;
  start: number;
  end: number;
}

interface FState {
  slots: (Slot | null)[]; // index 1..5
  hand: number; // implied hand reference position (canonical)
  handT: number;
  prev: { f: number; X: number; black: boolean; end: number }[];
  prevT: number;
  cost: number;
  parent: FState | null;
  assign: number[] | null;
  sig2: string;
}

export interface PairVerdict {
  cost: number;
  impractical: boolean;
  stretch: boolean;
}

/** Cost of fingers a < b being `d` metres apart (canonical, b minus a). */
export function pairCost(a: number, b: number, d: number): PairVerdict {
  const [minP, minC, minR, maxR, maxC, maxP] = TABLE[`${a}-${b}`];
  const s = d / SEMI;
  let cost = 0;
  let impractical = false;
  let stretch = false;
  const relW = a === 1 ? 1 : 1.3;
  if (s < minP) {
    cost += 10 + 6 * (minP - s);
    impractical = true;
  } else if (s < minC) {
    cost += 2 * (minC - s);
    stretch = true;
  }
  if (s < minR) cost += relW * (minR - s) * 0.6;
  if (s > maxP) {
    cost += 10 + 6 * (s - maxP);
    impractical = true;
  } else if (s > maxC) {
    cost += 2 * (s - maxC);
    stretch = true;
  }
  if (s > maxR) cost += relW * (s - maxR);
  return { cost, impractical, stretch };
}

const COMBOS: number[][][] = [[], [], [], [], [], []];
(function build() {
  const rec = (k: number, from: number, acc: number[]) => {
    if (acc.length === k) {
      COMBOS[k].push(acc.slice());
      return;
    }
    for (let f = from; f <= 5; f++) {
      acc.push(f);
      rec(k, f + 1, acc);
      acc.pop();
    }
  };
  for (let k = 1; k <= 5; k++) rec(k, 1, []);
})();

function handRef(notes: FingerNote[], fingers: number[]): number {
  let s = 0;
  for (let i = 0; i < notes.length; i++) s += notes[i].X - NATURAL_OFFSET[fingers[i]];
  return s / notes.length;
}

/** Transition cost from state `st` to playing group `g` with `fingers`. */
function transition(st: FState, g: { time: number; notes: FingerNote[] }, fingers: number[], forced: (number | undefined)[]): number {
  const t = g.time;
  let c = 0;
  for (let i = 0; i < fingers.length; i++) if (forced[i] && forced[i] !== fingers[i]) return Infinity;

  // fingers still holding keys
  // (an overlap of up to ~0.1 s is ordinary legato: the finger lifts a moment early)
  const contact: { f: number; X: number }[] = [];
  for (let f = 1; f <= 5; f++) {
    const s = st.slots[f];
    if (s && s.end > t + HELD_SLACK) {
      if (fingers.includes(f)) c += 6 + 40 * Math.min(1, (s.end - t - HELD_SLACK) / 0.3); // would have to abandon a held key
      else contact.push({ f, X: s.X });
    }
  }
  for (let i = 0; i < fingers.length; i++) contact.push({ f: fingers[i], X: g.notes[i].X });
  contact.sort((p, q) => p.f - q.f);
  for (let i = 0; i < contact.length; i++)
    for (let j = i + 1; j < contact.length; j++) {
      const v = pairCost(contact[i].f, contact[j].f, contact[j].X - contact[i].X);
      c += v.cost * (contact.length > 2 ? 0.7 : 1);
    }

  // the move from the previous group
  const ioi = t - st.prevT;
  const prevEnd = st.prev.length ? Math.max(...st.prev.map((p) => p.end)) : -1e9;
  const gap = t - prevEnd;
  const legato = gap <= 0.01 ? 1 : Math.max(0.15, 1 - gap / 0.35);
  const speed = ioi < 0.22 ? 1 : Math.max(0.15, 1 - (ioi - 0.22) / 0.5);
  const w = Math.max(legato, speed);
  // between chords the whole hand shifts and every finger moves: melodic
  // finger-to-finger span rules hardly apply
  const chordShift = st.prev.length > 1 && fingers.length > 1 ? 0.25 : 1;
  for (const p of st.prev) {
    for (let i = 0; i < fingers.length; i++) {
      const f = fingers[i];
      const n = g.notes[i];
      if (p.f === f) {
        if (Math.abs(p.X - n.X) < 1e-4) c += ioi < 0.16 ? 2.5 : 0.25; // repeated key, same finger
        else {
          // one finger to a new key: impossible to connect, and slow to get there
          const wasLegato = p.end >= t - 0.02;
          c += chordShift * ((ioi < 0.3 ? 5 : wasLegato ? 3.2 : 1.2) + (0.4 * Math.abs(p.X - n.X)) / W);
        }
        continue;
      }
      const a = Math.min(p.f, f);
      const b = Math.max(p.f, f);
      const d = p.f < f ? n.X - p.X : p.X - n.X;
      const v = pairCost(a, b, d);
      c += (chordShift * w * v.cost) / Math.max(1, st.prev.length * 0.6);
      // thumb passing under / finger crossing over the thumb
      if (a === 1 && d < 0) {
        const thumbBlack = p.f === 1 ? p.black : n.black;
        const otherBlack = p.f === 1 ? n.black : p.black;
        c += thumbBlack === otherBlack ? 2.6 : !thumbBlack && otherBlack ? 3.4 : 4.5;
      }
      // Parncutt: three-to-four, four-on-black
      if (p.f === 3 && f === 4) c += 0.6 * w;
      if (p.f === 3 && f === 4 && !p.black && n.black) c += 1 * w;
      if (p.f === 4 && f === 5) c += 0.3 * w;
    }
  }

  // finger-and-key colour rules
  for (let i = 0; i < fingers.length; i++) {
    const f = fingers[i];
    const n = g.notes[i];
    if (f === 4) c += 0.3;
    if (f === 5 && fingers.length === 1) c += 0.25;
    if (n.black && f === 1) {
      c += 1.6;
      if (st.prev.length === 1 && !st.prev[0].black) c += 0.8;
    }
    if (n.black && f === 5 && fingers.length === 1) c += 0.8;
    if (!n.black) {
      // leaving a thumb or fifth that sat on a black key for a white one
      for (const p of st.prev) if ((p.f === 1 || p.f === 5) && p.black && st.prev.length === 1) c += 0.6;
    }
  }

  // hand travel
  const h = handRef(g.notes, fingers);
  if (st.handT > -1e8) {
    const dh = Math.abs(h - st.hand) / W;
    const dt = Math.max(0.05, t - st.handT);
    // linear in distance (a scale moves the hand steadily); fast long jumps cost extra
    c += 0.2 * dh + 0.05 * Math.max(0, dh - 3) * Math.min(3, 0.3 / dt);
  }
  return c;
}

export interface FingeringResult {
  fingers: Map<number, Finger>;
  /** notes that could not be given a finger (more than five at once) */
  overflow: Set<number>;
  stretch: Set<number>;
  unreachable: Set<number>;
}

export function assignFingers(notes: ScoreNote[], hand: Hand, forcedFingers: Map<number, Finger>, beamWidth = 72): FingeringResult {
  const sign = hand === 'R' ? 1 : -1;
  const overflow = new Set<number>();
  const groups = groupOnsets(notes).map((g) => {
    let fn: FingerNote[] = g.notes.map((note) => ({ note, X: sign * keyOf(note.midi).x, black: isBlack(note.midi) }));
    fn.sort((a, b) => a.X - b.X);
    if (fn.length > 5) {
      // keep the outer notes and an even spread between them
      const keep = new Set([0, Math.round((fn.length - 1) * 0.25), Math.round((fn.length - 1) * 0.5), Math.round((fn.length - 1) * 0.75), fn.length - 1]);
      fn.forEach((n, i) => {
        if (!keep.has(i)) overflow.add(n.note.id);
      });
      fn = fn.filter((_, i) => keep.has(i));
    }
    return { time: g.time, notes: fn };
  });

  const start: FState = { slots: [null, null, null, null, null, null], hand: 0, handT: -1e9, prev: [], prevT: -1e9, cost: 0, parent: null, assign: null, sig2: '' };
  let beam: FState[] = [start];
  for (const g of groups) {
    const k = g.notes.length;
    const forced = g.notes.map((n) => forcedFingers.get(n.note.id));
    const next: FState[] = [];
    for (const st of beam) {
      for (const fingers of COMBOS[k]) {
        const tc = transition(st, g, fingers, forced);
        if (!isFinite(tc)) continue;
        const slots = st.slots.slice();
        fingers.forEach((f, i) => {
          const n = g.notes[i];
          slots[f] = { X: n.X, black: n.black, start: n.note.start, end: n.note.end };
        });
        const sigNow = fingers.join('');
        next.push({
          slots,
          hand: handRef(g.notes, fingers),
          handT: g.time,
          prev: fingers.map((f, i) => ({ f, X: g.notes[i].X, black: g.notes[i].black, end: g.notes[i].note.end })),
          prevT: g.time,
          cost: st.cost + tc,
          parent: st,
          assign: fingers,
          sig2: sigNow + '|' + (st.assign ? st.assign.join('') : ''),
        });
      }
    }
    if (!next.length) {
      // every option violated a user override: ignore overrides for this group
      for (const st of beam)
        for (const fingers of COMBOS[k]) {
          const slots = st.slots.slice();
          fingers.forEach((f, i) => (slots[f] = { X: g.notes[i].X, black: g.notes[i].black, start: g.notes[i].note.start, end: g.notes[i].note.end }));
          next.push({ ...st, slots, cost: st.cost + 50, parent: st, assign: fingers, prev: fingers.map((f, i) => ({ f, X: g.notes[i].X, black: g.notes[i].black, end: g.notes[i].note.end })), prevT: g.time, sig2: fingers.join('') });
        }
    }
    next.sort((a, b) => a.cost - b.cost);
    const seen = new Set<string>();
    beam = [];
    for (const s of next) {
      const held = s.slots.map((sl, f) => (sl && sl.end > g.time + HELD_SLACK ? f : '')).join('');
      const sig = s.sig2 + '|' + held;
      if (seen.has(sig)) continue;
      seen.add(sig);
      beam.push(s);
      if (beam.length >= beamWidth) break;
    }
  }

  const fingers = new Map<number, Finger>();
  const stretch = new Set<number>();
  const unreachable = new Set<number>();
  const path: FState[] = [];
  for (let s: FState | null = beam[0]; s && s.assign; s = s.parent) path.push(s);
  path.reverse();
  path.forEach((st, gi) => {
    const g = groups[gi];
    st.assign!.forEach((f, i) => fingers.set(g.notes[i].note.id, f as Finger));
    // diagnose the chosen hand shape: simultaneous spans only
    for (let i = 0; i < g.notes.length; i++)
      for (let j = i + 1; j < g.notes.length; j++) {
        const v = pairCost(st.assign![i], st.assign![j], g.notes[j].X - g.notes[i].X);
        if (v.impractical) {
          unreachable.add(g.notes[i].note.id);
          unreachable.add(g.notes[j].note.id);
        } else if (v.stretch) {
          stretch.add(g.notes[i].note.id);
          stretch.add(g.notes[j].note.id);
        }
      }
  });
  // overflow notes: give them the finger of their nearest neighbour for display
  for (const id of overflow) {
    const n = notes.find((x) => x.id === id)!;
    let best: Finger = 3;
    let bd = Infinity;
    for (const m of notes) {
      const f = fingers.get(m.id);
      if (!f || Math.abs(m.start - n.start) > 0.1) continue;
      const d = Math.abs(m.midi - n.midi);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    fingers.set(id, best);
  }
  return { fingers, overflow, stretch, unreachable };
}
