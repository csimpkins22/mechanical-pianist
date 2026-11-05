// How much the heap grows per call of the drummer's performance (evaluate, pose) and of the IK alone, measured in
// a node of its own with --expose-gc (as the robot's IK was measured):
//   node tools/drummer-alloc.cjs [src/music/drums/groove-funk-102.mid]     prints JSON (bytes per call)
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
(async () => {
  const file = path.resolve(process.argv[2] || 'src/music/drums/groove-funk-102.mid');
  const bundle = path.join(os.tmpdir(), `drummer-alloc-${process.pid}.cjs`);
  const { build } = require('rolldown');
  await build({ input: path.join(__dirname, 'drummer-alloc-entry.ts'), platform: 'node', logLevel: 'silent', output: { file: bundle, format: 'cjs' } });
  const out = execFileSync(process.execPath, ['--expose-gc', '-e', `console.log(JSON.stringify(require(${JSON.stringify(bundle)}).measure(${JSON.stringify(file)})))`], { encoding: 'utf8' });
  require('node:fs').rmSync(bundle, { force: true });
  process.stdout.write(out);
})();
