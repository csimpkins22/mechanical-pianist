// Stills of the drummer lab (dev server running: npx vite --port 5193):
//   node tools/drummer-shot.cjs out.png "pose=groove&view=front" [width height]
//   SHOTS="a.png|pose=snare&view=left;b.png|pose=tom1" node tools/drummer-shot.cjs   (several, one browser)
// Rendered at deviceScaleFactor 2 (SCALE to change), with SwiftShader.
const { chromium } = require('playwright');
(async () => {
  const base = process.env.BASE || 'http://127.0.0.1:5193/drummer-lab.html';
  const w = parseInt(process.argv[4] || process.env.W || '1280', 10);
  const h = parseInt(process.argv[5] || process.env.H || '720', 10);
  const shots = process.env.SHOTS
    ? process.env.SHOTS.split(';').filter(Boolean).map((s) => s.split('|'))
    : [[process.argv[2] || 'lab.png', process.argv[3] || '']];
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: parseFloat(process.env.SCALE || '2') });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  for (const [out, query] of shots) {
    await page.goto(`${base}?ui=0&still=1&${query}`);
    try {
      await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    } catch (e) {
      console.log(logs.join('\n'));
      throw e;
    }
    if (process.env.EVAL) await page.evaluate(process.env.EVAL);
    await page.evaluate(() => window.lab.renderNow());
    await page.screenshot({ path: out });
    console.log('wrote', out);
  }
  const errs = logs.filter((l) => /error|warn/i.test(l));
  if (errs.length) console.log(errs.slice(0, 20).join('\n'));
  await browser.close();
})();
