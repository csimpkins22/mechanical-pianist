import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FINGERS, THUMB } from '../src/core/handGeometry';

/** the nodes of a .glb, by name, with their translations */
function glbNodes(path: string): Map<string, number[]> {
  const b = readFileSync(path);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { nodes: { name: string; translation?: number[] }[] };
  return new Map(json.nodes.map((n) => [n.name, n.translation ?? [0, 0, 0]]));
}

describe('robot hand model matches the shared hand spec', () => {
  const nodes = glbNodes('public/assets/robot_hand.glb');
  const near = (a: number[], b: number[]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(2e-4);

  test('every joint the rig drives exists', () => {
    for (const n of ['Hand', 'Palm', 'Forearm', 'WristCore', 'WristRing1', 'WristRing2', 'T_0', 'T_1', 'T_2', 'T_tip']) expect(nodes.has(n), n).toBe(true);
  });

  test('finger joints sit where the IK expects them', () => {
    for (const f of FINGERS) {
      near(nodes.get(`F${f.id}_0`)!, f.mcp);
      near(nodes.get(`F${f.id}_1`)!, [0, 0, -f.segments[0]]);
      near(nodes.get(`F${f.id}_2`)!, [0, 0, -f.segments[1]]);
      near(nodes.get(`F${f.id}_tip`)!, [0, 0, -f.segments[2]]);
    }
  });

  test('thumb joints sit where the IK expects them', () => {
    near(nodes.get('T_0')!, THUMB.cmc);
    near(nodes.get('T_1')!, [0, 0, -THUMB.segments[0]]);
    near(nodes.get('T_2')!, [0, 0, -THUMB.segments[1]]);
    near(nodes.get('T_tip')!, [0, 0, -THUMB.segments[2]]);
  });
});
