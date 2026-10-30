import { describe, expect, test } from 'vitest';
import { FINGERS, REST_FINGER_POSES, REST_TIPS, REST_THUMB_POSE, THUMB, fingerFK, thumbFK, len, sub, type V3 } from '../src/core/handGeometry';
import { KEY_COUNT, LOWEST_MIDI, noteName } from '../src/core/keyboard';
import { solveFinger, solveThumb } from '../src/performance/HandIK';
import { PerformanceTimeline } from '../src/performance/PerformanceTimeline';
import { planPerformance } from '../src/interpretation/PerformancePlanner';
import { buildScore, readMidi } from '../src/interpretation/MidiEngine';
import { composeNocturne, composePhrase, midiBytes } from '../src/interpretation/demoPiece';
import { line, scoreOf } from './helpers';

const demoTimeline = (() => {
  let tl: PerformanceTimeline | null = null;
  return () => (tl ??= new PerformanceTimeline(planPerformance(buildScore(readMidi(midiBytes(composeNocturne()), 'demo.mid')))));
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
