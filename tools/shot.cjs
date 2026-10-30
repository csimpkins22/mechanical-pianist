// Screenshot helper: node tools/shot.cjs out.png "?demo=phrase&t=2" [width height]
//   needs `npm run dev` running (http://127.0.0.1:5174)
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2] || 'shot.png';
  const query = process.argv[3] || '';
  const w = parseInt(process.argv[4] || '1280', 10);
  const h = parseInt(process.argv[5] || '720', 10);
  const base = process.env.BASE || 'http://127.0.0.1:5174/';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(base + query);
  try {
    await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
  } catch (e) {
    console.log(logs.join('\n'));
    throw e;
  }
  if (process.env.WAIT) await page.waitForTimeout(parseInt(process.env.WAIT, 10));
  if (process.env.EVAL) await page.evaluate(process.env.EVAL);
  const times = (process.env.TIMES || '').split(',').filter(Boolean).map(Number);
  if (times.length) {
    for (const t of times) {
      await page.evaluate((t) => window.app.renderAt(t), t);
      await page.screenshot({ path: out.replace('.png', `_${t}.png`) });
    }
  } else {
    await page.evaluate(() => window.app.renderNow());
    await page.screenshot({ path: out });
  }
  const errs = logs.filter((l) => /error|warn/i.test(l));
  if (errs.length) console.log(errs.slice(0, 20).join('\n'));
  await browser.close();
})();
