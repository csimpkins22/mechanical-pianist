// Determinism test: renders the same timestamps after visiting the timeline
// in different orders (forward, backward, shuffled, with random wandering in
// between) and checks that the complete performance state (every key, every
// joint) and the rendered pixels are identical each time.
//
//   npm run dev                      (in another terminal)
//   node tools/determinism-test.cjs [http://127.0.0.1:5174/]
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:5174/';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(base + '?demo=nocturne&quality=low&ui=0');
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });

  const result = await page.evaluate(() => {
    const app = window.app;
    const gl = app.view.renderer.getContext();
    const pixels = () => {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let x = 2166136261 >>> 0;
      for (let i = 0; i < buf.length; i++) x = Math.imul(x ^ buf[i], 16777619) >>> 0;
      return x.toString(16);
    };
    const probe = (t) => {
      app.renderAt(t);
      return { state: app.stateHash(t), px: pixels() };
    };
    const D = app.duration;
    // mid-chord, mid-transition, mid-press, during the scale, the leap, the release
    const PROBES = [0.031, 1.012, 12.4, 26.95, 33.3, 41.17, 49.45, 51.5, 62.06, 66.3, 79.07, 85.0];
    let s = 4242;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const orders = {
      forward: PROBES.slice(),
      backward: PROBES.slice().reverse(),
      shuffled: PROBES.slice().sort(() => rnd() - 0.5),
    };
    const out = {};
    for (const [name, order] of Object.entries(orders)) {
      for (const t of order) {
        for (let k = 0; k < 3; k++) app.renderAt(rnd() * D);
        app.renderAt(t % 2 < 1 ? 0 : D);
        (out[t] ||= {})[name] = probe(t);
      }
    }
    // repeated seeks to the very same timestamp
    const same = [];
    for (let k = 0; k < 5; k++) {
      app.renderAt(rnd() * D);
      same.push(probe(49.45));
    }
    return { out, same };
  });

  let ok = true;
  for (const [t, byOrder] of Object.entries(result.out)) {
    const vals = Object.values(byOrder);
    const st = new Set(vals.map((v) => v.state));
    const px = new Set(vals.map((v) => v.px));
    const good = st.size === 1 && px.size === 1;
    ok &&= good;
    console.log(`t=${t.padEnd(6)} state ${[...st].join('/')}  pixels ${[...px].join('/')}  ${good ? 'OK' : 'MISMATCH'}`);
  }
  const sameOk = new Set(result.same.map((v) => v.state + v.px)).size === 1;
  ok &&= sameOk;
  console.log(`5 seeks to t=49.45 from random places: ${sameOk ? 'identical' : 'DIFFERENT'}`);
  console.log(ok ? 'DETERMINISTIC' : 'NOT DETERMINISTIC');
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
