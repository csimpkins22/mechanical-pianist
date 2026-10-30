// Copies the Salamander Grand Piano samples (CC BY 3.0, Alexander Holm) from
// node_modules into public/samples, renaming "#" to "s" so URLs stay plain.
// Runs automatically before `npm run dev` and `npm run build`.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'samples');
const layers = { v4: 'piano-mp3-velocity4', v9: 'piano-mp3-velocity9', v15: 'piano-mp3-velocity15', rel: 'piano-mp3-release' };
let n = 0;
for (const [dir, pkg] of Object.entries(layers)) {
  const src = path.join(root, 'node_modules', '@audio-samples', pkg, 'audio');
  if (!fs.existsSync(src)) {
    console.warn(`samples: ${pkg} is not installed; the built-in synthesized piano will be used`);
    continue;
  }
  fs.mkdirSync(path.join(out, dir), { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const dst = path.join(out, dir, f.replace('#', 's'));
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(src, f), dst);
      n++;
    }
  }
}
if (n) console.log(`samples: copied ${n} files to public/samples`);
