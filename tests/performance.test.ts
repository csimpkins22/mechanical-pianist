import { describe, expect, test } from 'vitest';
import { FINGERS, REST_FINGER_POSES, REST_TIPS, REST_THUMB_POSE, THUMB, TIP_RADIUS, fingerFK, thumbFK, len, sub, type V3 } from '../src/core/handGeometry';
import { KEY_COUNT, LOWEST_MIDI, keySurfacePoint, noteName } from '../src/core/keyboard';
import type { Hand } from '../src/core/types';
import { solveFinger, solveThumb } from '../src/performance/HandIK';
import { PerformanceTimeline } from '../src/performance/PerformanceTimeline';
import { planPerformance } from '../src/interpretation/PerformancePlanner';
import { buildScore, readMidi } from '../src/interpretation/MidiEngine';
import { composeNocturne, composePhrase, midiBytes } from '../src/interpretation/demoPiece';
import { line, scoreOf } from './helpers';
import { planChecked } from '../src/app/plan';

const demoTimeline = (() => {
  let tl: PerformanceTimeline | null = null;
  return () => (tl ??= planChecked(buildScore(readMidi(midiBytes(composeNocturne()), 'demo.mid'))).timeline);
})();

describe('IK', () => {
  test('rest targets give the rest pose back', () => {
    FINGERS.forEach((f, i) => {
      const sol = solveFinger(i, REST_TIPS[f.id]);
      expect(sol.error).toBeLessThan(1e-6);
      sol.angles.forEach((a, k) => expect(a).toBeCloseTo(REST_FINGER_POSES[i].angles[k], 4));
    });
    const th = solveThumb(REST_TIPS[1]);
    expect(th.error).toBeLessThan(1e-5);
    expect(len(sub(thumbFK(THUMB, th)[3], thumbFK(THUMB, REST_THUMB_POSE)[3]))).toBeLessThan(1e-5);
  });

  test('reachable targets (forward kinematics within joint limits) are reached exactly', () => {
    let worst = 0;
    const wave = (k: number, a: number) => Math.sin(k * a) * 0.5 + 0.5;
    for (let k = 0; k < 400; k++) {
      // fingers: random poses near the playing range
      FINGERS.forEach((f, i) => {
        // (the playing range: fingertips stay ahead of the knuckles)
        const pose = { abduction: (wave(k, 1.3) - 0.5) * 0.4, angles: [0.0 + wave(k, 1.7) * 0.6, 0.3 + wave(k, 2.3) * 0.8, 0.1 + wave(k, 0.9) * 0.45] as V3 };
        const q = fingerFK(f, pose)[3];
        worst = Math.max(worst, len(sub(fingerFK(f, solveFinger(i, q))[3], q)));
      });
      const tp = { swing: (wave(k, 1.1) - 0.5) * 0.5, twist: (wave(k, 1.45) - 0.5) * 0.6, angles: [wave(k, 1.9) * 0.5, wave(k, 2.9) * 0.6, wave(k, 0.7) * 0.7] as V3 };
      const q = thumbFK(THUMB, tp)[3];
      worst = Math.max(worst, len(sub(thumbFK(THUMB, solveThumb(q))[3], q)));
    }
    // fingers are exact; the thumb's plane-turning (twist) has a limit, so it is within a millimetre
    expect(worst).toBeLessThan(0.001);
  });
});

describe('timeline', { timeout: 120000 }, () => {
  test('keys bottom out exactly at each onset and are up again after release', () => {
    const tl = demoTimeline();
    for (const n of tl.perf.notes) {
      if (n.flags.includes('chord-overflow')) continue;
      expect(tl.keys.depression(n.midi, n.start)).toBeCloseTo(1, 5);
      const next = tl.perf.notes.find((m) => m.midi === n.midi && m.start > n.start);
      if (!next || next.start > n.keyEnd + 0.2) expect(tl.keys.depression(n.midi, n.keyEnd + 0.1)).toBe(0);
    }
  });

  test('every key that is going down or held down has its fingertip on it', () => {
    const tl = demoTimeline();
    let worst = 0;
    let where = '';
    for (let t = 0; t < tl.duration; t += 1 / 30) {
      const s = tl.evaluate(t);
      for (let k = 0; k < KEY_COUNT; k++) {
        const stroke = tl.keys.strokes[k].find((st) => st.contact <= t && t <= st.release);
        if (!stroke) continue;
        const n = stroke.note;
        const st = s.hands[n.hand].states[n.finger];
        const d = st.note?.note === n ? len(sub(st.tip, st.target)) : Infinity;
        if (d > worst) {
          worst = d;
          where = `${n.hand}${n.finger} ${noteName(n.midi)} at ${t.toFixed(2)} (${st.phase})`;
        }
      }
    }
    expect(worst, where).toBeLessThan(0.002);
  });

  test('the same time always gives the same state, in any visiting order', () => {
    const tl = demoTimeline();
    const probes = [0.5, 3.21, 12.9, 26.04, 33.5, 41.7, 47.3, 55.55, 63.0, 79.9];
    const ref = probes.map((t) => tl.stateHash(t));
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let round = 0; round < 3; round++) {
      const order = probes.map((t, i) => ({ t, i })).sort(() => rnd() - 0.5);
      for (const { t, i } of order) {
        tl.evaluate(rnd() * tl.duration); // wander elsewhere first
        expect(tl.stateHash(t)).toBe(ref[i]);
      }
    }
  });

  test('the five-note phrase: fingers land, hold and lift cleanly', () => {
    const tl = new PerformanceTimeline(planPerformance(buildScore(readMidi(midiBytes(composePhrase()), 'p.mid'))));
    for (const n of tl.perf.byHand.R) {
      const s = tl.evaluate(n.start + 0.05);
      const st = s.hands.R.states[n.finger];
      expect(st.phase).toBe('hold');
      expect(len(sub(st.tip, st.target))).toBeLessThan(0.0015);
    }
    expect([...tl.contactError.values()].every((e) => e < 0.0015)).toBe(true);
  });

  test('wide leaps, chords and fast scales stay within reach', () => {
    const s = scoreOf(
      line('C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6', { step: 0.12 }),
      line('C2+G2+C3 r r r', { step: 0.5, start: 2.5 }),
      line('C5+E5+G5+C6 r C7 r C3', { step: 0.6, start: 4.5 }),
    );
    const tl = new PerformanceTimeline(planPerformance(s));
    const errs = [...tl.contactError.values()];
    expect(Math.max(...errs)).toBeLessThan(0.002);
  });
});

/** the drawn wrist over [a, b]: peak speed (m/s) and peak acceleration (m/s²) at 120 Hz */
function wristMotion(tl: PerformanceTimeline, hand: Hand, a: number, b: number) {
  const dt = 1 / 120;
  let prev: V3 | null = null;
  let prevV: V3 | null = null;
  let speed = 0;
  let accel = 0;
  for (let t = a; t <= b; t += dt) {
    const w = tl.evaluate(t).hands[hand].wrist;
    if (prev) {
      const v: V3 = [(w[0] - prev[0]) / dt, (w[1] - prev[1]) / dt, (w[2] - prev[2]) / dt];
      speed = Math.max(speed, Math.hypot(...v));
      if (prevV) accel = Math.max(accel, Math.hypot(v[0] - prevV[0], v[1] - prevV[1], v[2] - prevV[2]) / dt);
      prevV = v;
    }
    prev = w;
  }
  return { speed, accel };
}

describe('motion', { timeout: 120000 }, () => {
  test('a repeated note comes back up and is struck again', () => {
    // repeats written to end just before the next strike, slow then fast, in
    // the right hand; a held bass in the left
    const s = scoreOf(
      line('G4 G4 G4 G4', { step: 0.45, dur: 0.44, vel: 0.6 }),
      line('D5 D5 D5 D5 D5 D5', { step: 0.16, dur: 0.155, start: 2.2, vel: 0.55 }),
      line('C2', { step: 3.5, track: 1 }),
    );
    const tl = new PerformanceTimeline(planPerformance(s));
    let pairs = 0;
    for (const strokes of tl.keys.strokes) {
      for (let i = 1; i < strokes.length; i++) {
        const a = strokes[i - 1];
        const b = strokes[i];
        pairs++;
        const fast = b.bottom - a.bottom < 0.25;
        // the key rises most of the way between the strikes
        let lowest = 1;
        for (let t = a.bottom; t <= b.bottom; t += 0.002) lowest = Math.min(lowest, tl.keys.depression(a.note.midi, t));
        expect(1 - lowest, `key rise before ${noteName(b.note.midi)} at ${b.bottom.toFixed(2)}`).toBeGreaterThan(fast ? 0.7 : 0.9);
        // and the fingertip lifts off the key before striking it again
        const track = tl.plan.hands[b.note.hand];
        const pn = track.notes.find((p) => p.note === b.note)!;
        let lift = 0;
        for (let t = a.bottom; t <= b.contact; t += 0.002) {
          const st = tl.evaluate(t).hands[b.note.hand].states[b.note.finger];
          const surface = keySurfacePoint(pn.key, pn.cz, tl.keys.depression(b.note.midi, t), [0, 0, 0], pn.cx);
          lift = Math.max(lift, st.tip[1] - TIP_RADIUS[b.note.finger] - surface[1]);
        }
        expect(lift, `fingertip lift before ${noteName(b.note.midi)} at ${b.bottom.toFixed(2)}`).toBeGreaterThan(fast ? 0.003 : 0.004);
        // the earlier sound ends when the key is struck again
        expect(tl.releaseOf(a.note)).toBeLessThanOrEqual(b.note.start + 1e-9);
      }
    }
    expect(pairs).toBe(8);
  });

  test('leaps take time: no jumps, no unnatural speed, onsets unchanged', () => {
    const s = scoreOf(
      // right hand: two-octave leaps every half second
      line('E5 r C7 r E5 r C7', { step: 0.25, vel: 0.6 }),
      // left hand: a long note, then the same hand an octave and more away
      line('C4', { step: 2.0, track: 1 }),
      line('A2 E3 A3', { step: 0.22, start: 2.05, track: 1 }),
    );
    const onsets = s.notes.map((n) => n.start).sort((a, b) => a - b);
    const tl = new PerformanceTimeline(planPerformance(s));
    expect(tl.perf.notes.map((n) => n.start).sort((a, b) => a - b)).toEqual(onsets);
    for (const hand of ['L', 'R'] as Hand[]) {
      const { speed, accel } = wristMotion(tl, hand, 0, tl.duration);
      expect(speed, `${hand} peak wrist speed`).toBeLessThan(2.5);
      expect(accel, `${hand} peak wrist acceleration`).toBeLessThan(200);
    }
    expect(Math.max(...tl.contactError.values())).toBeLessThan(0.002);
  });

  test('the Nocturne: the left hand travels to its low A without jumping', () => {
    const tl = demoTimeline();
    // a C4 held by the little finger, then the same finger on A2 (around 25.3 s)
    const near = wristMotion(tl, 'L', 24.8, 25.6);
    expect(near.speed).toBeLessThan(2);
    expect(near.accel).toBeLessThan(100);
    for (const hand of ['L', 'R'] as Hand[]) {
      const m = wristMotion(tl, hand, 0, tl.duration);
      expect(m.speed, `${hand} peak wrist speed`).toBeLessThan(2.5);
      expect(m.accel, `${hand} peak wrist acceleration`).toBeLessThan(150);
    }
  });
});
