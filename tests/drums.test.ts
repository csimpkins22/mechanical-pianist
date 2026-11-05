import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CC4_CLOSED, DRUM_MAP, drumMidiBytes, inferPedal, pedalAt, readDrumMidi, scanAftertouch } from '../src/drums/DrumScore';
import { KitMotion, SWING } from '../src/drums/KitMotion';
import * as THREE from 'three';
import { CYMBAL_PROFILES, DRUMS, FOOTBOARD_TOP, PEDALS, PEDAL_BOARDS, PEDAL_TRAVEL, SPOTS, cymbalTop, footboardAt, surfaceNormal, type DrumId } from '../src/drums/KitLayout';
import { orientation } from '../src/presentation/DrumKitModel';
import { articulationFor } from '../src/drums/DrumAudio';

const groove = (name: string) => readDrumMidi(new Uint8Array(readFileSync(`src/music/drums/${name}.mid`)), name);

describe('drum MIDI mapping', () => {
  it('maps General MIDI drums onto the kit', () => {
    const want: [number, string, string][] = [
      [35, 'kick', 'head'],
      [36, 'kick', 'head'],
      [38, 'snare', 'head'],
      [37, 'snare', 'crossStick'],
      [42, 'hihat', 'bow'],
      [44, 'hihat', 'pedal'],
      [46, 'hihat', 'bow'],
      [49, 'crash', 'bow'],
      [51, 'ride', 'bow'],
      [53, 'ride', 'bell'],
      [41, 'floorTom', 'head'],
      [43, 'floorTom', 'head'],
      [45, 'tom2', 'head'],
      [48, 'tom1', 'head'],
    ];
    for (const [k, piece, zone] of want) expect(DRUM_MAP[k], `key ${k}`).toMatchObject({ piece, zone });
  });

  it("maps the Roland TD-11 variants the Groove MIDI Dataset uses", () => {
    const want: [number, string, string][] = [
      [22, 'hihat', 'edge'], // closed edge
      [26, 'hihat', 'edge'], // open edge
      [40, 'snare', 'rim'], // rimshot
      [50, 'tom1', 'rim'],
      [47, 'tom2', 'rim'],
      [58, 'floorTom', 'rim'],
      [55, 'crash', 'edge'],
      [57, 'crash', 'bow'], // crash 2 plays the one crash
      [52, 'crash', 'edge'],
      [59, 'ride', 'edge'],
    ];
    for (const [k, piece, zone] of want) expect(DRUM_MAP[k], `key ${k}`).toMatchObject({ piece, zone });
    // every mapped piece is in the kit layout
    for (const m of Object.values(DRUM_MAP)) expect(DRUMS[m.piece]).toBeTruthy();
  });

  it('reads a drum file: hits in order, unknown keys dropped, chokes from aftertouch', () => {
    const bytes = drumMidiBytes(
      [
        { t: 0, midi: 36, velocity: 0.9 },
        { t: 0, midi: 49, velocity: 1 },
        { t: 0.5, midi: 38, velocity: 0.7 },
        { t: 0.75, midi: 54, velocity: 0.5 }, // tambourine: not in this kit
        { t: 1, midi: 42, velocity: 0.4 },
      ],
      { aftertouch: [{ t: 0.4, midi: 49 }] },
    );
    expect(scanAftertouch(bytes)).toHaveLength(1);
    const p = readDrumMidi(bytes);
    expect(p.hits.map((h) => h.piece)).toEqual(['kick', 'crash', 'snare', 'hihat']);
    expect(p.hits.every((h, i) => i === 0 || h.t >= p.hits[i - 1].t)).toBe(true);
    expect(p.chokes).toHaveLength(1);
    expect(p.chokes[0].piece).toBe('crash');
    expect(p.chokes[0].t).toBeCloseTo(0.4, 2);
  });

  it('reads the bundled Groove performances', () => {
    for (const name of ['groove-rock-87', 'groove-funk-102', 'groove-jazz-93']) {
      const p = groove(name);
      expect(p.hits.length).toBeGreaterThan(300);
      expect(p.hihatFromCC).toBe(true);
      expect(p.duration).toBeGreaterThan(40);
      const pieces = new Set(p.hits.map((h) => h.piece));
      for (const k of ['kick', 'snare', 'hihat']) expect(pieces.has(k as never)).toBe(true);
    }
  });
});

describe('the hi-hat', () => {
  it('follows CC4: 0 open, the TD-11 maximum (90) closed', () => {
    const bytes = drumMidiBytes([{ t: 0.5, midi: 46, velocity: 0.6 }], {
      cc4: [
        { t: 0, value: 90 },
        { t: 0.3, value: 90 },
        { t: 0.45, value: 0 },
        { t: 0.8, value: 0 },
        { t: 1.0, value: 90 },
        { t: 1.2, value: 127 },
        { t: 1.4, value: 45 },
      ],
    });
    const p = readDrumMidi(bytes);
    expect(p.hihatFromCC).toBe(true);
    expect(pedalAt(p.hihat, 0.1)).toBeCloseTo(1, 5);
    expect(pedalAt(p.hihat, 0.6)).toBeCloseTo(0, 5);
    expect(pedalAt(p.hihat, 1.2)).toBe(1); // beyond the TD-11's closed value is still closed
    expect(pedalAt(p.hihat, 1.45)).toBeCloseTo(45 / 127 / CC4_CLOSED, 3);
    // between events the pedal moves linearly
    expect(pedalAt(p.hihat, 0.375)).toBeCloseTo(0.5, 2);
  });

  it('is inferred from the notes without CC4: open for an open hit, closed again on the next closed or pedal note', () => {
    const pts = inferPedal([
      { t: 1, midi: 42 },
      { t: 2, midi: 46 },
      { t: 2.5, midi: 46 },
      { t: 3, midi: 42 },
      { t: 4, midi: 46 },
      { t: 5, midi: 44 },
      { t: 6, midi: 44 },
    ]);
    expect(pedalAt(pts, 1)).toBe(1);
    expect(pedalAt(pts, 2)).toBeLessThan(0.3);
    expect(pedalAt(pts, 2.7)).toBeLessThan(0.3);
    expect(pedalAt(pts, 3)).toBe(1);
    expect(pedalAt(pts, 4.5)).toBeLessThan(0.3);
    expect(pedalAt(pts, 5)).toBe(1); // the chick: the cymbals meet on the pedal note
    // a pedal note while closed: a lift, then pressed on the note
    expect(pedalAt(pts, 5.92)).toBeLessThan(1);
    expect(pedalAt(pts, 6)).toBe(1);
    // the gap follows the pedal
    const k = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 2, midi: 46, velocity: 0.6 }, { t: 3, midi: 42, velocity: 0.6 }])));
    expect(k.evaluate(2.2).hihatGap).toBeGreaterThan(0.015);
    expect(k.evaluate(3.1).hihatGap).toBe(0);
  });

  it('picks the sample by openness: closed, loose, quarter, half, open; edge and pedal', () => {
    expect(articulationFor('hihat', 'bow', 1, 0.5)).toBe('hhClosed');
    expect(articulationFor('hihat', 'bow', 0.9, 0.5)).toBe('hhLoose');
    expect(articulationFor('hihat', 'bow', 0.75, 0.5)).toBe('hhQuarter');
    expect(articulationFor('hihat', 'bow', 0.5, 0.5)).toBe('hhHalf');
    expect(articulationFor('hihat', 'bow', 0.1, 0.5)).toBe('hhOpen');
    expect(articulationFor('hihat', 'edge', 1, 0.5)).toBe('hhEdge');
    expect(articulationFor('hihat', 'pedal', 1, 0.5)).toBe('hhPedal');
    expect(articulationFor('ride', 'bell', 1, 0.5)).toBe('rideBell');
    expect(articulationFor('snare', 'rim', 1, 0.5)).toBe('rimshot');
    expect(articulationFor('snare', 'crossStick', 1, 0.5)).toBe('crossStick');
  });
});

describe('the kit moving', () => {
  const perf = groove('groove-rock-87');
  const kit = new KitMotion(perf);

  it('is a pure function of t: any visiting order gives the same state', () => {
    const probes = [0.5, 3.21, 7.77, 12.04, 19.9, 25.5, 33.33, 41.0, 50.2];
    const forward = probes.map((t) => kit.stateHash(t));
    let s = 99;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const shuffled = probes.slice().sort(() => rnd() - 0.5);
    const fresh = new KitMotion(perf);
    for (let k = 0; k < 20; k++) fresh.evaluate(rnd() * perf.duration);
    const again = new Map(shuffled.map((t) => [t, fresh.stateHash(t)]));
    expect(probes.map((t) => again.get(t))).toEqual(forward);
  });

  it('rocks a crash after a hit, struck side down, and settles', () => {
    const k = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 1, midi: 49, velocity: 1 }])));
    const before = k.cymbal('crash', 0.99);
    expect(Math.hypot(before.x, before.z)).toBe(0);
    // peak about a fifth of a period after the hit, near 10 degrees for a full-strength hit near the edge
    const T = SWING.crash.period;
    let peak = 0;
    let at = 0;
    for (let t = 1; t < 1 + T; t += 0.002) {
      const c = k.cymbal('crash', t);
      const m = Math.hypot(c.x, c.z);
      if (m > peak) [peak, at] = [m, t - 1];
    }
    expect(at / T).toBeGreaterThan(0.15);
    expect(at / T).toBeLessThan(0.3);
    expect(peak).toBeGreaterThan(0.08);
    expect(peak).toBeLessThan(0.22);
    // long after, still
    const late = k.cymbal('crash', 6);
    expect(Math.hypot(late.x, late.z)).toBeLessThan(0.002);
  });

  it('stops a choked cymbal', () => {
    const free = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 1, midi: 49, velocity: 1 }])));
    const held = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 1, midi: 49, velocity: 1 }], { aftertouch: [{ t: 1.3, midi: 49 }] })));
    const a = free.cymbal('crash', 1.8);
    const b = held.cymbal('crash', 1.8);
    expect(Math.hypot(b.x, b.z)).toBeLessThan(0.05 * Math.max(0.01, Math.hypot(a.x, a.z)));
  });

  it('swings the beater to the head exactly on each kick, and back to rest', () => {
    const kicks = perf.hits.filter((h) => h.piece === 'kick');
    for (const h of kicks.slice(0, 40)) {
      expect(kit.evaluate(h.t).beater).toBeCloseTo(1, 6);
      expect(kit.evaluate(h.t - 0.2).beater).toBeLessThan(1);
    }
    const quiet = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 1, midi: 36, velocity: 0.8 }])));
    expect(quiet.evaluate(0.5).beater).toBe(0);
    expect(quiet.evaluate(0.97).beater).toBeGreaterThan(0.05);
    expect(Math.abs(quiet.evaluate(2).beater)).toBeLessThan(0.002);
    // it springs a little past rest on the way back
    let low = 0;
    for (let t = 1; t < 1.4; t += 0.002) low = Math.min(low, quiet.evaluate(t).beater);
    expect(low).toBeLessThan(-0.03);
    expect(low).toBeGreaterThan(-0.15);
  });

  it('shimmers the heads only after their hits', () => {
    const k = new KitMotion(readDrumMidi(drumMidiBytes([{ t: 1, midi: 38, velocity: 0.9 }])));
    expect(k.evaluate(0.9).heads.snare).toBe(0);
    expect(k.evaluate(1.02).heads.snare).toBeGreaterThan(0.3);
    expect(k.evaluate(1.02).buzz).toBeGreaterThan(0.3);
    expect(k.evaluate(2.5).heads.snare).toBeLessThan(0.001);
  });
});

describe('the kit layout contract', () => {
  it("puts the cymbals' strike spots on their metal, as the model turns it", () => {
    for (const id of ['crash', 'ride', 'hihat'] as const) {
      const d = DRUMS[id];
      const n = surfaceNormal(d);
      const p = CYMBAL_PROFILES[id];
      const R = d.diameter / 2;
      for (const [name, r] of [['bell', 0.12], ['head', 0.55], ['edge', 0.97]] as const) {
        const s = SPOTS[name as 'bell' | 'head' | 'edge'](d);
        // its height above the reference plane, along the normal
        const h = (s[0] - d.centre[0]) * n[0] + (s[1] - d.centre[1]) * n[1] + (s[2] - d.centre[2]) * n[2];
        expect(h, `${id} ${name}`).toBeCloseTo(cymbalTop(p, R, r * R), 6);
      }
      // the bell stands above the bow, the edge below it
      expect(cymbalTop(p, R, 0.12 * R)).toBeGreaterThan(0.01);
      expect(cymbalTop(p, R, 0.97 * R)).toBeLessThan(-0.008);
    }
  });

  it("lines the hi-hat pedal up under its column: the ball of the foot behind it, on the footboard", () => {
    const hp = PEDALS.hihatPedal;
    const c = DRUMS.hihat.centre;
    // the footboard runs from the heel to the column's foot
    const dx = c[0] - hp.heel[0];
    const dz = c[2] - hp.heel[2];
    const len = Math.hypot(dx, dz);
    const along = ((hp.ball[0] - hp.heel[0]) * dx + (hp.ball[2] - hp.heel[2]) * dz) / len;
    const off = Math.abs((hp.ball[0] - hp.heel[0]) * dz - (hp.ball[2] - hp.heel[2]) * dx) / len;
    expect(off).toBeLessThan(0.03);
    expect(len - along).toBeGreaterThan(0.04);
    expect(PEDAL_TRAVEL).toBeGreaterThan(0.05);
    expect(PEDAL_TRAVEL).toBeLessThan(0.3);
  });
});

describe('the kit model on the layout contract', () => {
  it("seats the hi-hat's top cymbal on KitLayout's centre (the column under its tilted head)", async () => {
    const { DrumKitModel } = await import('../src/presentation/DrumKitModel');
    const kit = new DrumKitModel();
    kit.root.updateMatrixWorld(true);
    const top = kit.root.getObjectByName('hihat-top')!;
    const p = top.getWorldPosition(new THREE.Vector3());
    const c = DRUMS.hihat.centre;
    expect(Math.hypot(p.x - c[0], p.y - c[1], p.z - c[2])).toBeLessThan(1e-4);
  });

  it("turns the footboards exactly as footboardAt says, at every press (the foot stands on the same board)", async () => {
    const { DrumKitModel } = await import('../src/presentation/DrumKitModel');
    const { restState } = await import('../src/presentation/DrumStage');
    const kit = new DrumKitModel();
    const s = restState();
    const o = { point: [0, 0, 0], along: [0, 0, 0], normal: [0, 0, 0] };
    for (const press of [-0.2, -0.05, 0, 0.3, 0.7, 1]) {
      s.beater = press;
      s.hihatClosed = Math.max(0, press);
      kit.update(s);
      kit.root.updateMatrixWorld(true);
      for (const [id, name, pr] of [['kickPedal', 'kick-footboard', press], ['hihatPedal', 'hihat-footboard', Math.max(0, press)]] as const) {
        const board = kit.root.getObjectByName(name)!.parent!;
        const b = PEDAL_BOARDS[id];
        for (const along of [0.05, b.ballAlong, b.length - 0.02]) {
          // the board's top surface, `along` from its hinge, in the board's own frame (built along -z)
          const w = new THREE.Vector3(0, FOOTBOARD_TOP, -along).applyMatrix4(board.matrixWorld);
          footboardAt(id, pr, along, o);
          expect(Math.hypot(w.x - o.point[0], w.y - o.point[1], w.z - o.point[2]), `${id} press ${pr} at ${along}`).toBeLessThan(1e-6);
        }
      }
    }
  });
});

/** a drum as its shell (with its hoops at the ends), a cymbal as a disc 7 cm thick around its bow: inside test and surface samples */
function solid(d: (typeof DRUMS)[DrumId]) {
  const q = orientation(d);
  const inv = q.clone().invert();
  const c = new THREE.Vector3(...d.centre);
  const R = d.diameter / 2 + (d.kind === 'drum' ? 0.022 : 0);
  const y0 = d.kind === 'drum' ? -d.depth - 0.015 : -0.035;
  const y1 = d.kind === 'drum' ? 0.012 : 0.035;
  return {
    inside(p: THREE.Vector3) {
      const l = p.clone().sub(c).applyQuaternion(inv);
      if (!(l.y > y0 && l.y < y1)) return false;
      const atHoop = d.kind !== 'drum' || l.y > -0.014 || l.y < -d.depth + 0.014;
      return Math.hypot(l.x, l.z) < (atHoop ? R : d.diameter / 2 + 0.004);
    },
    samples() {
      const out: THREE.Vector3[] = [];
      for (let a = 0; a < 96; a++)
        for (const y of [y0, (y0 + y1) / 2, y1])
          for (const rr of [R, R * 0.6]) out.push(new THREE.Vector3(Math.sin((a / 96) * 2 * Math.PI) * rr, y, Math.cos((a / 96) * 2 * Math.PI) * rr).applyQuaternion(q).add(c));
      return out;
    },
  };
}

describe('the kit model', () => {
  it('has no two drums or cymbals in each other (shells, hoops, cymbals)', () => {
    const ids = Object.keys(DRUMS) as DrumId[];
    const hits: string[] = [];
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const A = solid(DRUMS[a]);
        const B = solid(DRUMS[b]);
        if (A.samples().some((p) => B.inside(p)) || B.samples().some((p) => A.inside(p))) hits.push(`${a} and ${b}`);
      }
    expect(hits).toEqual([]);
  });

  it('stands every tripod and the floor tom clear of the pedals, the kick, the stool and each other', async () => {
    const { DrumKitModel } = await import('../src/presentation/DrumKitModel');
    const kit = new DrumKitModel();
    expect(kit.legClearance.length).toBe(5); // floor tom, snare, hi-hat, crash, ride
    for (const c of kit.legClearance) expect(c.clear, `legs at ${c.at.map((v) => v.toFixed(2))}`).toBeGreaterThan(0);
  });
});
