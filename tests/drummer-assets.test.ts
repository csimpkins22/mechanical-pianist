// The exported robot drummer (public/assets/robot_drummer.glb, built by
// tools/blender/build_drummer.py) has every joint the rig drives where the
// shared drummer spec puts it, with an identity rest rotation, and its hands
// are the robot hand, on the hand spec's joints (mirrored for the left).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DRUMMER, JOINTS } from '../src/drums/DrummerSpec';
import { FINGERS, THUMB } from '../src/core/handGeometry';

interface GltfNode {
  name: string;
  translation?: number[];
  rotation?: number[];
}

function glbNodes(path: string): Map<string, GltfNode> {
  const b = readFileSync(path);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { nodes: GltfNode[] };
  return new Map(json.nodes.map((n) => [n.name, n]));
}

describe('robot drummer model matches the shared drummer spec', () => {
  const nodes = glbNodes('public/assets/robot_drummer.glb');
  const at = (n: string) => nodes.get(n)?.translation ?? [0, 0, 0];
  const near = (a: number[], b: number[], what: string) => expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), what).toBeLessThan(2e-4);

  test('every joint the rig drives exists, at its offset from its parent, with an identity rest rotation', () => {
    expect(nodes.has('Drummer')).toBe(true);
    for (const j of JOINTS) {
      expect(nodes.has(j.name), j.name).toBe(true);
      near(at(j.name), j.offset, j.name);
      const q = nodes.get(j.name)!.rotation ?? [0, 0, 0, 1];
      expect(Math.abs(q[3]), `${j.name} rest rotation`).toBeGreaterThan(1 - 1e-6);
    }
  });

  test('the hands are the robot hand: its joints where the hand spec puts them, the left mirrored', () => {
    for (const [side, sx] of [['R', 1], ['L', -1]] as const) {
      const p = DRUMMER.hand.prefix[side];
      const m = (v: number[]) => [sx * v[0], v[1], v[2]];
      for (const n of ['WristCore', 'WristRing1', 'WristRing2']) expect(nodes.has(p + n), p + n).toBe(true);
      for (const f of FINGERS) {
        near(at(`${p}F${f.id}_0`), m(f.mcp), `${p}F${f.id}_0`);
        near(at(`${p}F${f.id}_1`), [0, 0, -f.segments[0]], `${p}F${f.id}_1`);
        near(at(`${p}F${f.id}_2`), [0, 0, -f.segments[1]], `${p}F${f.id}_2`);
        near(at(`${p}F${f.id}_tip`), [0, 0, -f.segments[2]], `${p}F${f.id}_tip`);
      }
      near(at(`${p}T_0`), m(THUMB.cmc), `${p}T_0`);
      near(at(`${p}T_1`), [0, 0, -THUMB.segments[0]], `${p}T_1`);
    }
  });

  test("the sticks sit in each hand at the grip's fulcrum", () => {
    near(at('StickR'), DRUMMER.grip.fulcrum, 'StickR');
    near(at('StickL'), [-DRUMMER.grip.fulcrum[0], DRUMMER.grip.fulcrum[1], DRUMMER.grip.fulcrum[2]], 'StickL');
  });
});
