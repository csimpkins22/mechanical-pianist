// A hash of everything that shapes a planned performance. The app embeds it
// (vite.config.ts) and so do the plans prepared at build time
// (plan-library.cjs): a plan from other planner code is never used.
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

function planVersion(root = join(__dirname, '..')) {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|json)$/.test(f)) h.update(f).update(readFileSync(p));
    }
  };
  for (const d of ['src/core', 'src/interpretation', 'src/performance']) walk(join(root, d));
  h.update(readFileSync(join(root, 'src/app/plan.ts')));
  return h.digest('hex').slice(0, 16);
}

module.exports = { planVersion };
