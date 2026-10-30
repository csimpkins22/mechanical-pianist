// Renders a stretch of the performance frame by frame (exact times, so the
// result is the same however slow the machine) and encodes it with ffmpeg.
//   node tools/render-video.cjs out.mp4 "?demo=phrase" t0 t1 [fps] [w] [h]
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
(async () => {
  const [, , out, query = '', t0s = '0', t1s = '5', fpsS = '30', wS = '960', hS = '540'] = process.argv;
  const fps = +fpsS;
  const base = process.env.BASE || 'http://127.0.0.1:5174/';
  // frames go to a folder named after the output, so an interrupted render resumes
  const dir = path.join(require('os').tmpdir(), 'frames-' + path.basename(out).replace(/\W/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: +wS, height: +hS } });
  await page.goto(base + query + (query.includes('?') ? '&' : '?') + 'ui=0');
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  const n = Math.round((+t1s - +t0s) * fps);
  for (let i = 0; i <= n; i++) {
    const t = +t0s + i / fps;
    const file = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
    if (fs.existsSync(file)) continue;
    await page.evaluate((t) => window.app.renderAt(t), t);
    await page.screenshot({ path: file, timeout: 180000 });
    if (i % 30 === 0) console.log(`frame ${i}/${n}`);
  }
  await browser.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out]);
  fs.rmSync(dir, { recursive: true });
  console.log('wrote', out);
})();
