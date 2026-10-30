import { defineConfig } from 'vite';
import { createRequire } from 'node:module';

/** a hash of everything that shapes a planned performance: cached and prepared plans from other code are not reused */
const { planVersion } = createRequire(import.meta.url)('./tools/plan-version.cjs') as { planVersion(): string };

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5174 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  assetsInclude: ['**/*.mid'],
  define: { __PLAN_VERSION__: JSON.stringify(planVersion()) },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
