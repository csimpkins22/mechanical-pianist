// Write a solved drummer pose as node rotations, for Blender's preview renders:
//   node tools/drummer-pose.cjs groove out.json      (or `all`: every pose and the sweep, for --check-torso)
//   python tools/blender/build_drummer.py out.glb --pose out.json --preview render.png
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const [name = 'groove', out = 'pose.json'] = process.argv.slice(2);
  const bundle = path.join(os.tmpdir(), `drummer-pose-${process.pid}.cjs`);
  const { build } = require('rolldown');
  await build({ input: path.join(__dirname, 'drummer-pose-entry.ts'), platform: 'node', logLevel: 'silent', output: { file: bundle, format: 'cjs' } });
  const { poseJson, allPosesJson } = require(bundle);
  // `all`: every named pose and the sweep, as a list (for build_drummer.py --check-torso)
  fs.writeFileSync(out, JSON.stringify(name === 'all' ? allPosesJson() : poseJson(name)));
  fs.rmSync(bundle, { force: true });
  console.log('wrote', out);
})();
