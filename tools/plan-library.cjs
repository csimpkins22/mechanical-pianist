// Prepare the library's performances at build time, so that visitors
// download a finished plan instead of computing one (which takes 10 to 40
// seconds a piece). Writes public/plans/<id>.bin (gzipped, see
// src/app/planCodec.ts) and public/plans/manifest.json. A plan is redone only
// when the planner's code (its version hash) or the piece's MIDI changes;
// pieces are planned in parallel, one process per core.
//
//   node tools/plan-library.cjs [--force]
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { planVersion } = require('./plan-version.cjs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'public/plans');
const bundle = path.join(root, 'node_modules/.cache/plan-library/entry.cjs');

/** the entry, bundled for Node (MIDI files inlined as the app's build does) */
async function build() {
  const { build } = require('rolldown');
  await build({
    input: path.join(__dirname, 'plan-library-entry.ts'),
    platform: 'node',
    logLevel: 'silent',
    output: { file: bundle, format: 'cjs' },
    plugins: [
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
}

// child: plan one piece and write it
if (process.argv[2] === '--one') {
  const [, , , id, file] = process.argv;
  const t = Date.now();
  const bytes = require(bundle).plan(id);
  fs.writeFileSync(file, zlib.gzipSync(bytes, { level: 9 }));
  process.send({ id, ms: Date.now() - t });
  return;
}

(async () => {
  const t0 = Date.now();
  const force = process.argv.includes('--force');
  const version = planVersion(root);
  await build();
  const pieces = require(bundle).pieces();
  fs.mkdirSync(outDir, { recursive: true });
  const manifestFile = path.join(outDir, 'manifest.json');
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {}
  const manifest = { version, plans: {} };
  const todo = [];
  for (const p of pieces) {
    const file = `${p.id}.bin`;
    const prev = old?.version === version ? old.plans[p.id] : null;
    const fresh = !force && prev && prev.midi === p.midi && fs.existsSync(path.join(outDir, file));
    manifest.plans[p.id] = { file, midi: p.midi, tracks: p.tracks };
    if (!fresh) todo.push(p);
  }
  // remove plans of pieces no longer in the library
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.bin') && !pieces.some((p) => `${p.id}.bin` === f)) fs.rmSync(path.join(outDir, f));
  if (!todo.length) {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    console.log(`plans: all ${pieces.length} library pieces up to date (planner ${version})`);
    return;
  }
  console.log(`plans: preparing ${todo.length} of ${pieces.length} library pieces (planner ${version})…`);
  const queue = [...todo];
  const workers = Math.max(1, Math.min(queue.length, (os.availableParallelism?.() ?? os.cpus().length) || 1));
  let failed = false;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length && !failed) {
        const p = queue.shift();
        const file = path.join(outDir, `${p.id}.bin`);
        await new Promise((resolve) => {
          const child = fork(__filename, ['--one', p.id, file], { execArgv: ['--max-old-space-size=3072'] });
          child.on('message', (m) => console.log(`  ${m.id}: ${(m.ms / 1000).toFixed(1)} s, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`));
          child.on('exit', (code) => {
            if (code !== 0) {
              failed = true;
              console.error(`  ${p.id}: planning failed (exit ${code})`);
            }
            resolve();
          });
        });
      }
    }),
  );
  if (failed) process.exit(1);
  // the manifest last: it only ever lists plans that exist
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
  console.log(`plans: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
