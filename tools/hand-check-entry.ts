// Bundled and run by hand-check.cjs (in Node): plan a MIDI file exactly as
// the app's planner worker does, then sample both hands as displayed and
// measure where any part of a hand goes into the piano.
import { Midi } from '@tonejs/midi';
import { planChecked } from '../src/app/plan';
import { LIBRARY } from '../src/app/library';
import { buildScore, defaultTrackSelection, readMidi } from '../src/interpretation/MidiEngine';
import { KEY_COUNT } from '../src/core/keyboard';
import type { V3 } from '../src/core/handGeometry';
import type { Hand } from '../src/core/types';
import { poseHand, type HandPose } from '../src/performance/HandPoser';
import { penetration } from '../src/performance/HandClearance';
import type { PerformanceTimeline } from '../src/performance/PerformanceTimeline';

export interface Frame {
  t: number;
  hand: Hand;
  /** deepest penetration into the piano (m), the part and what it went into */
  pen: number;
  part: string;
  into: string;
  /** deepest penetration of the palm, knuckles or thumb base: the hand itself sunk into the piano (m) */
  body: number;
  wristY: number;
  /** how far the contact compliance moved the wrist from its plan (m) */
  comply: number;
  /** worst fingertip miss of a finger on a key (m) */
  miss: number;
  /** wrist speed (m/s) and fastest joint (rad/s) since the previous sample */
  speed: number;
  jointRate: number;
}

function anglesOf(p: HandPose): number[] {
  const a: number[] = [];
  for (const f of p.fingers) a.push(f.abduction, ...f.angles);
  a.push(p.thumb.swing, p.thumb.twist, ...p.thumb.angles);
  for (let i = 0; i < 9; i++) a.push(p.rot[i]);
  return a;
}

export function sample(timeline: PerformanceTimeline, rate: number, from = 0, to = timeline.duration): Frame[] {
  const frames: Frame[] = [];
  const prev: Record<Hand, { w: V3; a: number[] } | null> = { L: null, R: null };
  const keys = new Float32Array(KEY_COUNT);
  for (let i = Math.ceil(from * rate); i / rate <= to; i++) {
    const t = i / rate;
    timeline.keys.evaluate(t, keys);
    for (const hand of ['L', 'R'] as Hand[]) {
      const track = timeline.plan.hands[hand];
      const pose = poseHand(track, timeline.keys, t);
      const { depth: pen, part, into, body } = penetration(pose, keys);
      const planned: V3 = [track.x.at(t), track.y.at(t), track.z.at(t)];
      const comply = Math.hypot(pose.wrist[0] - planned[0], pose.wrist[1] - planned[1], pose.wrist[2] - planned[2]);
      let miss = 0;
      for (let f = 1; f <= 5; f++) {
        const st = pose.states[f];
        if (st.note && (st.phase === 'attack' || st.phase === 'hold')) miss = Math.max(miss, Math.hypot(st.tip[0] - st.target[0], st.tip[1] - st.target[1], st.tip[2] - st.target[2]));
      }
      const a = anglesOf(pose);
      let speed = 0;
      let jointRate = 0;
      const pv = prev[hand];
      if (pv) {
        speed = Math.hypot(pose.wrist[0] - pv.w[0], pose.wrist[1] - pv.w[1], pose.wrist[2] - pv.w[2]) * rate;
        for (let k = 0; k < a.length; k++) jointRate = Math.max(jointRate, Math.abs(a[k] - pv.a[k]) * rate);
      }
      prev[hand] = { w: pose.wrist, a };
      frames.push({ t, hand, pen, part, into, body, wristY: pose.wrist[1], comply, miss, speed, jointRate });
    }
  }
  return frames;
}

/** bar and beat at time t, from the file's own time signatures */
function barOf(midi: Midi, t: number): string {
  const tick = midi.header.secondsToTicks(t);
  const sigs = midi.header.timeSignatures.length ? midi.header.timeSignatures : [{ ticks: 0, timeSignature: [4, 4], measures: 0 }];
  const ppq = midi.header.ppq;
  let bar = 1;
  let at = 0;
  let num = 4;
  let den = 4;
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    if (s.ticks > tick) break;
    const len0 = (num * 4 * ppq) / den;
    bar += Math.floor((s.ticks - at) / len0 + 1e-6);
    at = s.ticks;
    [num, den] = s.timeSignature as [number, number];
  }
  const barLen = (num * 4 * ppq) / den;
  const beatLen = (4 * ppq) / den;
  const into = tick - at;
  bar += Math.floor(into / barLen);
  const beat = 1 + Math.floor((into % barLen) / beatLen);
  return `bar ${bar} beat ${beat}`;
}

export function check(bytes: Uint8Array, name: string, rate = 60) {
  const t0 = Date.now();
  const parsed = readMidi(bytes, name);
  const tracks = defaultTrackSelection(parsed.tracks);
  const score = buildScore(parsed, tracks);
  const { perf, timeline } = planChecked(score, new Map());
  const planMs = Date.now() - t0;
  const frames = sample(timeline, rate);
  const midi = new Midi(bytes);
  // events: runs of frames (per hand) where a part goes more than 3 mm into the piano
  const TOL = 0.003;
  const events: { hand: Hand; t0: number; t1: number; pen: number; tWorst: number; part: string; into: string; wristY: number; comply: number; bar: string }[] = [];
  for (const hand of ['L', 'R'] as Hand[]) {
    let cur: (typeof events)[number] | null = null;
    for (const f of frames) {
      if (f.hand !== hand) continue;
      if (f.pen > TOL) {
        if (!cur || f.t - cur.t1 > 0.1) {
          cur = { hand, t0: f.t, t1: f.t, pen: f.pen, tWorst: f.t, part: f.part, into: f.into, wristY: f.wristY, comply: f.comply, bar: '' };
          events.push(cur);
        }
        cur.t1 = f.t;
        if (f.pen > cur.pen) Object.assign(cur, { pen: f.pen, tWorst: f.t, part: f.part, into: f.into, wristY: f.wristY, comply: f.comply });
      }
    }
  }
  for (const e of events) e.bar = barOf(midi, e.tWorst);
  events.sort((a, b) => b.pen - a.pen);
  const stat = (hand: Hand, key: keyof Frame) => {
    const v = frames.filter((f) => f.hand === hand).map((f) => f[key] as number).sort((a, b) => a - b);
    return { p50: v[Math.floor(v.length / 2)], p99: v[Math.floor(v.length * 0.99)], max: v[v.length - 1], min: v[0] };
  };
  const summary = {
    name,
    duration: timeline.duration,
    notes: perf.notes.length,
    planMs,
    framesOver3mm: frames.filter((f) => f.pen > TOL).length,
    framesOver10mm: frames.filter((f) => f.pen > 0.01).length,
    /** the hand itself (palm, knuckles, thumb base) in the piano: the collapse */
    bodyFrames: frames.filter((f) => f.body > TOL).length,
    bodyWorst: Math.max(...frames.map((f) => f.body)),
    /** the wrist below 3 cm (ordinary playing keeps it near 6) */
    lowWristFrames: frames.filter((f) => f.wristY < 0.03).length,
    events: events.length,
    worst: events.slice(0, 15),
    stats: Object.fromEntries((['L', 'R'] as Hand[]).map((h) => [h, { pen: stat(h, 'pen'), body: stat(h, 'body'), wristY: stat(h, 'wristY'), comply: stat(h, 'comply'), miss: stat(h, 'miss'), speed: stat(h, 'speed'), jointRate: stat(h, 'jointRate') }])),
    flags: Object.fromEntries(['unreachable', 'stretch', 'early-release', 'chord-overflow'].map((fl) => [fl, perf.notes.filter((n) => n.flags.includes(fl as never)).length])),
  };
  return { summary, frames, perf, timeline };
}

/** the app's own library: ids, and a piece's MIDI bytes */
export const libraryIds = () => LIBRARY.map((e) => e.id);
export const libraryBytes = (id: string) => LIBRARY.find((e) => e.id === id)!.bytes();

