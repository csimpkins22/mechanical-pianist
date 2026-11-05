// Bundled by tools/drummer-pose.cjs: solve a named drummer pose and return its node rotations.
import { FINGER_NODES, createPose, solveDrummer } from '../src/drums/DrummerIK';
import { namedPoses } from '../src/drums/DrummerPoses';
import { JOINTS } from '../src/drums/DrummerSpec';

export function poseJson(name: string) {
  const np = namedPoses().find((p) => p.name === name);
  if (!np) throw new Error(`no pose ${name}; poses: ${namedPoses().map((p) => p.name).join(', ')}`);
  const p = solveDrummer(np.targets, createPose());
  const nine = (a: Float64Array, i: number) => Array.from(a.subarray(i * 9, i * 9 + 9));
  return {
    pose: name,
    root: Array.from(p.root),
    local: Object.fromEntries(JOINTS.map((j, i) => [j.name, nine(p.local, i)])),
    fingers: Object.fromEntries((['R', 'L'] as const).map((s) => [s, Object.fromEntries(FINGER_NODES.map((n, k) => [n, nine(p.fingers[s], k)]))])),
    error: p.error,
  };
}
