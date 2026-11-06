// The drummer's frame audit (tests/drummerMotionAudit.ts) over the library's grooves, one process per groove,
// as many at once as there are cores:
//   node tools/drummer-audit.cjs [--fps 120] [--json out.json] [groove-rock-87 ...]     (default: every groove)
// Prints a table: frames, the share with a contact, the deepest contact (and the deepest into the kit), joint
// limits overrun, hand-frames past 7 m/s and 400 m/s², stick tips past 20 m/s, NaNs, the feet, hits no hand played.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const fps = +opt('--fps', '120');
const jsonOut = opt('--json', null);
const root = path.join(__dirname, '..');
const names = args.length
  ? args
  : fs
      .readdirSync(path.join(root, 'src/music/drums'))
      .filter((f) => f.endsWith('.mid'))
      .map((f) => f.slice(0, -4))
      .sort();

(async () => {
  const bundle = path.join(os.tmpdir(), `drummer-audit-${process.pid}.cjs`);
  const { build } = require('rolldown');
  await build({ input: path.join(__dirname, 'drummer-audit-entry.ts'), platform: 'node', logLevel: 'silent', output: { file: bundle, format: 'cjs' } });
  const results = [];
  const queue = names.slice();
  const run = () =>
    new Promise((resolve) => {
      const next = () => {
        const name = queue.shift();
        if (!name) return resolve();
        execFile(
          process.execPath,
          ['-e', `console.log(JSON.stringify(require(${JSON.stringify(bundle)}).measure(${JSON.stringify(name)}, ${fps})))`],
          { cwd: root, maxBuffer: 64 << 20 },
          (err, out) => {
            if (err) console.error(name, err.message);
            else {
              const r = JSON.parse(out);
              results.push(r);
              console.error(`${name}: ${r.seconds} s`);
            }
            next();
          },
        );
      };
      next();
    });
  await Promise.all(Array.from({ length: Math.min(names.length, os.availableParallelism?.() ?? os.cpus().length) }, run));
  fs.rmSync(bundle, { force: true });
  results.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  const rows = [
    `| Groove | Length | Frames (${fps} fps) | With a contact | Deepest | Deepest into the kit | Joint limits | Hand > 7 m/s | Hand > 400 m/s² | Tip > 20 m/s | Dropped |`,
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results)
    rows.push(
      `| ${r.name} | ${r.duration} s | ${r.frames} | ${r.contactPct}% | ${r.deepestMm} mm (${r.deepestWhat || '-'}) | ${r.deepestKitMm} mm | ${r.limitFrames ? `${r.limitFrames} frames, ${r.limitWorstDeg}°` : '-'} | ${r.handOver} | ${r.accelOver} | ${r.tipOver} | ${r.dropped} |` +
        (r.nan || r.feetMm > 2 || r.board > 1e-9 ? ` NaN ${r.nan}, feet ${r.feetMm} mm, board ${r.board}` : ''),
    );
  console.log(rows.join('\n'));
})();
