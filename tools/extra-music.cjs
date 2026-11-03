// Optional extra music, kept out of the repository. Put MIDI files in
// extra/music/ and describe them in extra/library.json (the folder is
// gitignored; MP_EXTRA=<dir> points elsewhere) to build the app with more
// pieces; without them it is built from the repository's own library alone.
//
//   extra/library.json
//   {
//     "defaultPiece": "an-id",            (optional: opens first)
//     "pieces": [
//       { "id": "an-id", "title": "…", "artist": "…", "year": "1999",
//         "group": "Songs", "blurb": "…", "file": "a-file.mid" }
//     ]
//   }
//
// A Rollup-style plugin providing `virtual:extra-music`, used by both the
// app's build (vite.config.ts) and the build-time planner (plan-library.cjs),
// so the prepared plans cover the extra pieces too.
const fs = require('node:fs');
const path = require('node:path');

const ID = 'virtual:extra-music';

function extraDir(root) {
  return process.env.MP_EXTRA ? path.resolve(process.env.MP_EXTRA) : path.join(root, 'extra');
}

function extraMusic(root = path.join(__dirname, '..')) {
  const dir = extraDir(root);
  return {
    name: 'extra-music',
    resolveId(id) {
      if (id === ID) return `\0${ID}`;
    },
    load(id) {
      if (id !== `\0${ID}`) return;
      const file = path.join(dir, 'library.json');
      if (!fs.existsSync(file)) return 'export default { defaultPiece: null, pieces: [] };';
      this.addWatchFile?.(file);
      const lib = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pieces = (lib.pieces ?? []).map(({ file: f, ...p }) => {
        const mid = path.join(dir, 'music', f);
        this.addWatchFile?.(mid);
        return { ...p, data: `data:audio/midi;base64,${fs.readFileSync(mid).toString('base64')}` };
      });
      return `export default ${JSON.stringify({ defaultPiece: lib.defaultPiece ?? null, pieces })};`;
    },
  };
}

module.exports = { extraMusic, extraDir };
