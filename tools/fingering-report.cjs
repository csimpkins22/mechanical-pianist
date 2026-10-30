// Fingering report: the engine's choices next to conventional fingerings,
// as an image.   node tools/fingering-report.cjs [out.png]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'screenshots', 'fingering-report.png');
  const { build } = require('rolldown');
  const tmp = path.join(os.tmpdir(), `fingering-report-${process.pid}.cjs`);
  await build({ input: path.join(__dirname, 'fingering-report-data.ts'), platform: 'node', output: { file: tmp, format: 'cjs' }, logLevel: 'silent' });
  const rows = require(tmp).report();
  fs.unlinkSync(tmp);

  let total = 0;
  let match = 0;
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let body = '';
  for (const [g, rs] of groups) {
    body += `<h2>${esc(g)}</h2><table>`;
    for (const r of rs) {
      let ok = 0;
      let n = 0;
      const cells = r.notes
        .map((x) => {
          const judged = !!x.want;
          const good = judged && x.want.includes(x.got);
          if (judged) {
            n++;
            if (good) ok++;
          }
          const cls = !judged ? 'nj' : good ? 'ok' : 'bad';
          const alt = judged && !good ? `<i>${x.want.join('/')}</i>` : '<i>&nbsp;</i>';
          const black = x.name.includes('#') || x.name.includes('♯') || x.name.includes('b') && x.name.length > 2;
          return `<td class="${cls}${black ? ' blk' : ''}"><b>${x.got}</b>${alt}<s>${esc(x.name)}</s></td>`;
        })
        .join('');
      total += n;
      match += ok;
      const score = n ? `${ok}/${n}` : '—';
      body += `<tr><th>${esc(r.name)}<em>${r.hand === 'R' ? 'right hand' : 'left hand'}</em></th><td class="score ${n && ok === n ? 'full' : ''}">${score}</td>${cells}</tr>`;
    }
    body += '</table>';
  }
  const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:28px 32px;background:#14110e;color:#e9dfcf;font:13px/1.3 Inter,system-ui,sans-serif}
  h1{font:italic 500 30px 'Cormorant Garamond',Georgia,serif;margin:0 0 4px;color:#f2e6d2}
  .sub{color:#a89880;margin-bottom:14px}
  h2{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#a89880;margin:22px 0 8px;font-weight:500}
  table{border-collapse:separate;border-spacing:2px}
  th{text-align:left;font-weight:500;padding-right:10px;white-space:nowrap;width:118px}
  th em{display:block;font-style:normal;font-size:10px;color:#7d705f}
  td{width:26px;text-align:center;border-radius:4px;padding:3px 0 2px;vertical-align:top}
  td b{display:block;font-size:14px}
  td i{display:block;font-style:normal;font-size:10px;color:#ffb3a3;height:12px}
  td s{display:block;text-decoration:none;font-size:8.5px;color:#8b7d6a}
  td.ok{background:#1f3326}
  td.ok b{color:#9fe0b0}
  td.bad{background:#4a2019}
  td.bad b{color:#ffcfbf}
  td.nj{background:#24201b}
  td.blk{box-shadow:inset 0 -3px 0 #000}
  td.score{width:44px;color:#a89880;font-variant-numeric:tabular-nums}
  td.score.full{color:#9fe0b0}
  .legend span{display:inline-block;padding:2px 8px;border-radius:4px;margin-right:6px}
  </style>
  <h1>Fingering report</h1>
  <div class="sub">The engine's finger (large) on each note against conventional pedagogical fingering (red, when it differs). Black keys are underlined in black. Overall: <b>${match}/${total}</b> notes match convention (${((100 * match) / total).toFixed(1)}%).</div>
  ${body}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1520, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(`${match}/${total} notes match convention (${((100 * match) / total).toFixed(1)}%) -> ${out}`);
  for (const r of rows) {
    const bad = r.notes.filter((x) => x.want && !x.want.includes(x.got)).length;
    const n = r.notes.filter((x) => x.want).length;
    if (bad) console.log(`  ${r.hand} ${r.name}: ${n - bad}/${n}  ` + r.notes.map((x) => `${x.name}:${x.got}${x.want && !x.want.includes(x.got) ? "(" + x.want.join("/") + ")" : ""}`).join(" "));
  }
})();
