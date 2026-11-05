// Bundled by tools/drummer-pose.cjs: solve a named drummer pose and return its node rotations.
import { FINGER_NODES, createPose, solveDrummer } from '../src/drums/DrummerIK';
import { SWEEP, blendTargets, emptyTargets, namedPoses } from '../src/drums/DrummerPoses';
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

/** every named pose, then the slow sweep between spots at `steps` per move (for the torso's overlap check) */
export function allPosesJson(steps = 24) {
  const out = namedPoses().map((p) => poseJson(p.name));
  const poses = namedPoses();
  const by = (n: string) => poses.find((p) => p.name === n)!;
  const t = emptyTargets();
  const p = createPose();
  for (let k = 0; k < SWEEP.length; k++)
    for (let i = 0; i < steps; i++) {
      blendTargets(by(SWEEP[k]).targets, by(SWEEP[(k + 1) % SWEEP.length]).targets, i / steps, t);
      solveDrummer(t, p);
      const nine = (a: Float64Array, j: number) => Array.from(a.subarray(j * 9, j * 9 + 9));
      out.push({
        pose: `sweep ${SWEEP[k]}>${SWEEP[(k + 1) % SWEEP.length]} ${i}/${steps}`,
        root: Array.from(p.root),
        local: Object.fromEntries(JOINTS.map((j, q) => [j.name, nine(p.local, q)])),
        fingers: {},
        error: p.error,
      } as ReturnType<typeof poseJson>);
    }
  return out;
}
