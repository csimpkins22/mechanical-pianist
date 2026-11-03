// Where do the hands go into the piano? Plans each MIDI file as the app does,
// samples both hands as displayed (60 Hz) and measures how far any part of a
// hand (palm, finger or thumb, as spheres: src/performance/HandClearance.ts)
// is in the keys, the key slip or the nameboard. Per piece: frames where the
// hand itself (palm, knuckles) is in the piano, frames with the wrist sunk
// below 3 cm, and moments any part is more than 3 mm in, worst first, with
// the bar each falls in.
//
//   node tools/hand-check.cjs [--out dir] [--jobs n] [--library] a.mid b.mid ...
//
// (--library: also every piece in the app's library; lib:<id> names one)
//
// Writes <out>/<name>.json (summary and events) and <name>.frames.json.
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bundle = path.join(os.tmpdir(), `hand-check-${process.pid}`, 'entry.cjs');

if (process.argv[2] === '--one') {
  const [, , , b, file, out] = process.argv;
  const { check, libraryBytes } = require(b);
  const lib = file.startsWith('lib:');
  const name = lib ? file.slice(4) : path.basename(file, '.mid');
  const { summary, frames } = check(lib ? libraryBytes(name) : new Uint8Array(fs.readFileSync(file)), name);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(out, `${name}.frames.json`), JSON.stringify(frames));
  process.send(summary);
  return;
}

(async () => {
  const args = process.argv.slice(2);
  let out = path.join(root, 'hand-check');
  let jobs = Math.max(1, os.cpus().length - 1);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--jobs') jobs = +args[++i];
    else if (args[i] === '--library') files.push('--library');
    else files.push(args[i].startsWith('lib:') ? args[i] : path.resolve(args[i]));
  }
  fs.mkdirSync(out, { recursive: true });
  const { build } = require('rolldown');
  await build({
    input: path.join(__dirname, 'hand-check-entry.ts'),
    platform: 'node',
    logLevel: 'silent',
    output: { file: bundle, format: 'cjs' },
    plugins: [
      require('./extra-music.cjs').extraMusic(root),
      {
        name: 'mid-inline',
        resolveId(source, importer) {
          if (source.endsWith('.mid?inline')) return path.resolve(path.dirname(importer), source.slice(0, -'?inline'.length)) + '?inline';
        },
        load(id) {
          if (!id.endsWith('.mid?inline')) return;
          const b = fs.readFileSync(id.slice(0, -'?inline'.length));
          return `export default ${JSON.stringify(`data:audio/midi;base64,${b.toString('base64')}`)};`;
        },
      },
    ],
  });
  if (files.includes('--library')) files.splice(files.indexOf('--library'), 1, ...require(bundle).libraryIds().map((id) => `lib:${id}`));
  const queue = files.slice();
  const run = () =>
    new Promise((resolve) => {
      const next = () => {
        const f = queue.shift();
        if (!f) return resolve();
        const c = fork(__filename, ['--one', bundle, f, out]);
        c.on('message', (s) => {
          const w = s.worst[0];
          console.log(
            `${s.name.slice(0, 28).padEnd(28)}  hand in piano ${String(s.bodyFrames).padStart(5)} frames (worst ${(Math.max(0, s.bodyWorst) * 1000).toFixed(0).padStart(3)} mm), wrist < 3 cm ${String(s.lowWristFrames).padStart(5)}` +
              `  | any part >3 mm ${String(s.framesOver3mm).padStart(4)} frames, >10 mm ${String(s.framesOver10mm).padStart(4)}` +
              (w ? `; worst ${(w.pen * 1000).toFixed(0)} mm ${w.hand} ${w.part} into ${w.into} at ${w.tWorst.toFixed(2)} s (${w.bar})` : ''),
          );
        });
        c.on('exit', next);
      };
      next();
    });
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, run));
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
})();
