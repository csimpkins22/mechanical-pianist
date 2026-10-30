import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** a hash of everything that shapes a planned performance: cached plans from older code are not reused */
function planVersion() {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|json)$/.test(f)) h.update(f).update(readFileSync(p));
    }
  };
  for (const d of ['src/core', 'src/interpretation', 'src/performance']) walk(d);
  h.update(readFileSync('src/app/plan.ts'));
  return h.digest('hex').slice(0, 16);
}

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5174 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  assetsInclude: ['**/*.mid'],
  define: { __PLAN_VERSION__: JSON.stringify(planVersion()) },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
