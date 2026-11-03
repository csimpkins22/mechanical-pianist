import { describe, expect, test } from 'vitest';
import { FINGERS, REST_FINGER_POSES, REST_TIPS, REST_THUMB_POSE, THUMB, TIP_RADIUS, fingerFK, thumbFK, len, sub, type V3 } from '../src/core/handGeometry';
import { KEY_COUNT, LOWEST_MIDI, keySurfacePoint, noteName } from '../src/core/keyboard';
import type { Hand } from '../src/core/types';
import { solveFinger, solveThumb } from '../src/performance/HandIK';
import { PerformanceTimeline } from '../src/performance/PerformanceTimeline';
import { RATE, give } from '../src/performance/MotionPlanner';
import { Signal } from '../src/core/math';
import { handOverlap } from '../src/performance/HandCollision';
import { planPerformance } from '../src/interpretation/PerformancePlanner';
import { buildScore, defaultTrackSelection, readMidi } from '../src/interpretation/MidiEngine';
import { readFileSync } from 'node:fs';
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
  test('keys bottom out exactly at each onset, are up again after release and bounce only slightly', () => {
    const tl = demoTimeline();
    for (const n of tl.perf.notes) {
      if (n.flags.includes('chord-overflow')) continue;
      expect(tl.keys.depression(n.midi, n.start)).toBeCloseTo(1, 5);
      const next = tl.perf.notes.find((m) => m.midi === n.midi && m.start > n.start);
      if (!next || next.start > n.keyEnd + 0.3) {
        expect(Math.abs(tl.keys.depression(n.midi, n.keyEnd + 0.1))).toBeLessThan(0.04);
        expect(tl.keys.depression(n.midi, n.keyEnd + 0.26)).toBe(0);
      }
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

  test('no fingertip ends up inside its key as the key comes back up and dips at its rest stop', () => {
    const tl = demoTimeline();
    let worst = 0;
    let where = '';
    for (const n of tl.perf.notes) {
      if (n.flags.includes('chord-overflow')) continue;
      // from the release, through the key's return and its dips below rest
      for (let t = n.keyEnd; t < n.keyEnd + 0.2; t += 0.002) {
        const s = tl.evaluate(t);
        for (const hand of ['L', 'R'] as const)
          for (let f = 1; f <= 5; f++) {
            const st = s.hands[hand].states[f];
            if (!st.note) continue;
            // the target is the fingertip's centre resting on the key's surface: never below it
            const into = st.target[1] - st.tip[1];
            if (into > worst) {
              worst = into;
              where = `${hand}${f} ${noteName(st.note.note.midi)} at ${t.toFixed(3)} (${st.phase})`;
            }
          }
      }
    }
    expect(worst, where).toBeLessThan(0.0005);
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

describe('mechanical give', () => {
  test('a fast leap carries on a little past its end and settles; steady motion is untouched', () => {
    // a minimum-jerk leap of 30 cm in a quarter of a second, then rest
    const n = RATE * 2;
    const data = new Float32Array(n);
    const t0 = 0.5;
    const T = 0.25;
    for (let k = 0; k < n; k++) {
      const u = Math.min(1, Math.max(0, (k / RATE - t0) / T));
      data[k] = 0.3 * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5);
    }
    const sig = new Signal(0, RATE, data.slice());
    give(sig, 7, 0.42, 0.6, 0.0025);
    const out = sig.data as Float32Array;
    let over = 0;
    for (let k = Math.round((t0 + T) * RATE); k < n; k++) over = Math.max(over, out[k] - 0.3);
    expect(over).toBeGreaterThan(0.0004);
    expect(over).toBeLessThan(0.0026);
    expect(Math.abs(out[Math.round((t0 + T + 0.45) * RATE)] - 0.3)).toBeLessThan(0.0001);
    // constant velocity: no acceleration, no deviation
    const ramp = new Signal(0, RATE, Float32Array.from({ length: n }, (_, k) => 0.2 * (k / RATE)));
    give(ramp, 7, 0.42, 0.6, 0.0025);
    expect(Math.abs((ramp.data as Float32Array)[RATE] - 0.2)).toBeLessThan(1e-6);
  });
});

describe('hands playing close together', { timeout: 120000 }, () => {
  test('the thumbs tuck and one hand rides over: the hands barely touch', () => {
    // near the end of Chopin's Raindrop prelude the hands play close together
    // (without the tucking and riding over, about a tenth of it has them interpenetrating)
    const parsed = readMidi(new Uint8Array(readFileSync('src/music/chopin-raindrop-prelude.mid')), 'raindrop.mid');
    const full = buildScore(parsed, defaultTrackSelection(parsed.tracks));
    const [a, b] = [218, 223];
    const notes = full.notes.filter((n) => n.start >= a && n.start < b).map((n, id) => ({ ...n, id, start: n.start - a, end: Math.min(n.end, b) - a }));
    const score = { ...full, notes, pedal: full.pedal.filter((p) => p.time >= a && p.time < b).map((p) => ({ ...p, time: p.time - a })), duration: b - a + 1 };
    const { timeline: tl } = planChecked(score);
    let deep = 0;
    let n = 0;
    let worst = 0;
    for (let t = 0; t < score.duration - 1; t += 1 / 60) {
      const f = tl.evaluate(t);
      const o = handOverlap(f.hands.L, f.hands.R);
      n++;
      if (o.depth > 0.001) deep++;
      worst = Math.max(worst, o.depth);
    }
    expect(deep / n).toBeLessThan(0.05);
    expect(worst).toBeLessThan(0.025);
  });
});
