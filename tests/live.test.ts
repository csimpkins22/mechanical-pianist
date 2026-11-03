import { describe, expect, it } from 'vitest';
import { LOWEST_MIDI } from '../src/core/keyboard';
import { len, sub } from '../src/core/handGeometry';
import { LivePerformer, STEP, TAKEOVER } from '../src/live/LivePerformer';

type Ev = { t: number; on?: [number, number]; off?: number; pedal?: boolean };

/** a little of everything: a melody, a chord, fast repeats, a leap, both hands, the pedal */
const SCRIPT: Ev[] = (() => {
  const ev: Ev[] = [];
  const note = (t: number, midi: number, dur: number, vel = 0.65) => {
    ev.push({ t, on: [midi, vel] });
    ev.push({ t: t + dur, off: midi });
  };
  [60, 62, 64, 65, 67].forEach((m, i) => note(0.6 + i * 0.22, m, 0.18));
  for (const m of [60, 64, 67]) note(1.9, m, 0.6, 0.8); // a chord
  for (let i = 0; i < 4; i++) note(2.7 + i * 0.12, 72, 0.07); // fast repeats
  note(3.4, 48, 0.9, 0.7); // the left hand
  note(3.45, 84, 0.4); // and a leap up in the right
  ev.push({ t: 3.3, pedal: true });
  note(3.9, 43, 0.3);
  ev.push({ t: 4.4, pedal: false });
  return ev.sort((a, b) => a.t - b.t);
})();

const DELAY = 0.35;

/** play the script into a performer, advancing it as the app would, up to `until` */
function perform(p: LivePerformer, script: Ev[], until: number, from = 0) {
  let i = script.findIndex((e) => e.t > from);
  if (i < 0) i = script.length;
  for (let t = from; t <= until + 1e-9; t += 1 / 120) {
    while (i < script.length && script[i].t <= t) {
      const e = script[i++];
      if (e.on) p.noteOn(e.t, e.on[0], e.on[1]);
      if (e.off !== undefined) p.noteOff(e.t, e.off);
      if (e.pedal !== undefined) p.setPedal(e.t, e.pedal);
    }
    p.update(t);
  }
}

describe('playing live', () => {
  it('plays every note the player plays, the delay later, with a fingertip on the key', () => {
    const p = new LivePerformer(DELAY, { keep: Infinity });
    perform(p, SCRIPT, 6);
    for (const e of SCRIPT) {
      if (!e.on) continue;
      const [midi] = e.on;
      const strike = e.t + DELAY;
      const f = p.evaluate(strike + 0.03);
      expect(f.keys[midi - LOWEST_MIDI], `key ${midi} down at ${strike.toFixed(2)}`).toBeGreaterThan(0.6);
      // the key is up a little before it was pressed (unless the same key was just played)
      const repeat = SCRIPT.some((x) => x.on && x.on[0] === midi && x.t < e.t && x.t > e.t - 0.3);
      if (!repeat) expect(p.evaluate(strike - 0.12).keys[midi - LOWEST_MIDI]).toBeLessThan(0.5);
      // some finger of some hand is on that key, and on it
      const onKey = (['L', 'R'] as const).flatMap((h) => f.hands[h].states.slice(1).filter((s) => s.note?.note.midi === midi));
      expect(onKey.length, `a finger on ${midi}`).toBeGreaterThan(0);
      expect(Math.min(...onKey.map((s) => len(sub(s.tip, s.target)))), `contact on ${midi}`).toBeLessThan(0.004);
    }
    expect(p.evaluate(3.3 + DELAY + 0.5).pedal).toBeGreaterThan(0.9);
    expect(p.evaluate(4.4 + DELAY + 0.3).pedal).toBeLessThan(0.1);
  });

  it('never jumps: the wrists move smoothly through every takeover', () => {
    const p = new LivePerformer(DELAY, { keep: Infinity });
    perform(p, SCRIPT, 6);
    let worstStep = 0;
    let worstAcc = 0;
    let prev: number[] | null = null;
    let prev2: number[] | null = null;
    for (let t = 0.2; t < 5.8; t += 1 / 240) {
      const f = p.evaluate(t);
      const w = [...f.hands.L.wrist, ...f.hands.R.wrist];
      if (prev) worstStep = Math.max(worstStep, ...w.map((v, i) => Math.abs(v - prev![i])));
      if (prev && prev2) worstAcc = Math.max(worstAcc, ...w.map((v, i) => Math.abs(v - 2 * prev![i] + prev2![i])));
      prev2 = prev;
      prev = w;
    }
    // at most 2.5 m/s, and no corner sharper than a few hundred m/s² (a jump of 1 mm in a step is 2400 m/s²)
    expect(worstStep).toBeLessThan(2.5 / 240);
    expect(worstAcc * 240 * 240).toBeLessThan(400);
  });

  it('never changes what has been shown', () => {
    const a = new LivePerformer(DELAY, { keep: Infinity });
    const T1 = 2.0;
    perform(a, SCRIPT, T1);
    const shown = [];
    for (let t = 0.1; t <= T1; t += 0.05) shown.push(a.stateHash(t));
    perform(a, SCRIPT, 6, T1);
    const again = [];
    for (let t = 0.1; t <= T1; t += 0.05) again.push(a.stateHash(t));
    expect(again).toEqual(shown);
  });

  it('is the same robot for the same playing', () => {
    const a = new LivePerformer(DELAY, { keep: Infinity });
    const b = new LivePerformer(DELAY, { keep: Infinity });
    perform(a, SCRIPT, 6);
    perform(b, SCRIPT, 6);
    for (let t = 0.3; t < 6; t += 0.137) expect(b.stateHash(t)).toBe(a.stateHash(t));
  });

  it('keeps the hand and finger of a note once it is being played', () => {
    const p = new LivePerformer(DELAY, { keep: Infinity });
    perform(p, SCRIPT, 6);
    // every note committed, and each sounding with the committed finger in the window that played it
    const ids = p.notes.map((n) => n.id);
    for (const id of ids) expect(p.commits.has(id)).toBe(true);
    for (const n of p.notes) {
      const c = p.commits.get(n.id)!;
      const at = n.on + n.delay + 0.02;
      const w = p.windowAt(at);
      const pn = w.plan.perf.notes.find((x) => x.id === n.id);
      expect(pn, `note ${n.id} in the window at its strike`).toBeTruthy();
      expect([pn!.hand, pn!.finger]).toEqual([c.hand, c.finger]);
    }
  });

  it('plans on the grid and takes over a moment later', () => {
    const p = new LivePerformer(DELAY, { keep: Infinity });
    p.noteOn(1.0, 60, 0.6);
    p.update(1.0 + STEP);
    const w = p.windowAt(1.0 + STEP + TAKEOVER + 0.01);
    expect(w.plan.perf.notes.map((n) => n.midi)).toEqual([60]);
    // before the takeover, the window on screen does not know the note yet
    expect(p.windowAt(1.0 + 0.01).plan.perf.notes.length).toBe(0);
  });
});
