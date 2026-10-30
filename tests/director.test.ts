import { describe, expect, test } from 'vitest';
import { planChecked } from '../src/app/plan';
import { buildScore, readMidi } from '../src/interpretation/MidiEngine';
import { composeEtudes, composeNocturne, midiBytes } from '../src/interpretation/demoPiece';
import { CinematicCamera } from '../src/presentation/CinematicCamera';

const cams = (() => {
  const make = (m: ReturnType<typeof composeNocturne>, name: string) => {
    const score = buildScore(readMidi(midiBytes(m), name));
    const { timeline, perf } = planChecked(score);
    return { cam: new CinematicCamera(timeline.plan, score.duration, score.tempos), perf, duration: score.duration };
  };
  let cache: ReturnType<typeof make>[] | null = null;
  return () => (cache ??= [make(composeNocturne(), 'nocturne.mid'), make(composeEtudes(), 'etudes.mid')]);
})();

describe('director', { timeout: 120000 }, () => {
  test('the edit opens wide, ends on the pull-back, and never repeats a shot back to back', () => {
    for (const { cam, duration } of cams()) {
      const segs = cam.director.segments;
      expect(segs.length).toBeGreaterThan(5);
      expect(segs[0].a).toBe(0);
      expect(segs[segs.length - 1].b).toBeCloseTo(duration, 6);
      expect(segs[0].shot.id).toBe('establishing');
      expect(segs[segs.length - 1].shot.id).toBe('pullback');
      for (let i = 1; i < segs.length; i++) {
        expect(segs[i].a).toBeCloseTo(segs[i - 1].b, 9);
        expect(segs[i].shot.id).not.toBe(segs[i - 1].shot.id);
        if (i < segs.length - 1) {
          const len = segs[i].b - segs[i].a;
          expect(len).toBeGreaterThanOrEqual(2.2);
          expect(len).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  test('cuts land just before an attack', () => {
    for (const { cam, perf } of cams()) {
      for (const s of cam.director.segments.slice(1)) {
        const near = perf.notes.some((n) => n.start - s.a > 0 && n.start - s.a < 0.08);
        expect(near, `cut at ${s.a.toFixed(2)}`).toBe(true);
      }
    }
  });

  test('every camera mode stays finite and out of the piano, at any time', () => {
    for (const { cam, duration } of cams()) {
      for (const mode of ['cinematic', 'follow', 'overhead', 'macro'] as const) {
        for (let t = 0; t <= duration; t += 0.25) {
          const s = cam.evaluate(mode, t);
          const p = s.position;
          for (const v of [p.x, p.y, p.z, s.target.x, s.focus, s.focalLength, s.fstop]) expect(Number.isFinite(v)).toBe(true);
          // the cabinet: behind the key slip, from the floor to above the lid
          const insideCase = p.z < -0.15 && p.z > -0.7 && p.y > -0.72 && p.y < 0.62 && Math.abs(p.x) < 0.72;
          // the keys and key slip
          const insideKeys = p.z < 0.08 && p.z > -0.16 && p.y < 0.025 && p.y > -0.1 && Math.abs(p.x) < 0.68;
          expect(insideCase || insideKeys, `${mode} at ${t}: ${p.toArray().map((v) => v.toFixed(3))}`).toBe(false);
          expect(s.focus).toBeGreaterThan(0.05);
        }
      }
    }
  });

  test('the edit is the same every time it is made', () => {
    const score = buildScore(readMidi(midiBytes(composeNocturne()), 'nocturne.mid'));
    const { timeline } = planChecked(score);
    const a = new CinematicCamera(timeline.plan, score.duration, score.tempos).director.segments.map((s) => `${s.a.toFixed(4)}:${s.shot.id}:${s.hand}`);
    const b = cams()[0].cam.director.segments.map((s) => `${s.a.toFixed(4)}:${s.shot.id}:${s.hand}`);
    expect(a).toEqual(b);
  });
});

describe('forearm ends', { timeout: 300000 }, () => {
  test('are never in the picture, in any camera mode, at any time, on any screen shape', () => {
    for (const { cam, duration } of cams()) {
      for (const mode of ['cinematic', 'follow', 'overhead', 'macro'] as const)
        for (const aspect of [16 / 9, 21 / 9, 4 / 3, 1, 9 / 16]) {
        for (let t = 0; t <= duration; t += 0.2) {
          const s = cam.evaluate(mode, t, undefined, aspect);
          const fw = s.target.clone().sub(s.position).normalize();
          const upRef = s.position.clone().set(Math.sin(s.roll), Math.cos(s.roll), 0);
          const rt = fw.clone().cross(upRef).normalize();
          const up = rt.clone().cross(fw);
          // the frame's half-slopes (three.js, 36 mm film gauge across the longer side)
          const Sx = (18 * Math.min(aspect, 1)) / s.focalLength;
          const Sy = 18 / Math.max(aspect, 1) / s.focalLength;
          for (const e of cam.armEnds(t)) {
            const v = e.clone().sub(s.position);
            const z = v.dot(fw);
            if (z <= 0) continue;
            const x = Math.abs(v.dot(rt) / z);
            const y = Math.abs(v.dot(up) / z);
            // the end's cross-section is about 4 cm across: all of it must be outside
            const r = 0.045 / z;
            expect(x - r > Sx || y - r > Sy, `${mode} at ${t.toFixed(1)} s, aspect ${aspect.toFixed(2)}`).toBe(true);
          }
        }
      }
    }
  });
});
