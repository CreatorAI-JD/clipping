// Single approval inbox: Review Queue lists Assembly Line videos waiting on you, "Approve all" asks first,
// and auto-approve can't run without an OpenAI key.
// Run from the repo root:  node tests/approval-inbox.test.mjs   (Playwright + Chromium, no real keys, nothing is posted)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack));
await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
// an old saved "Needs you" sub-tab must not break the Assembly Line
await page.addInitScript(() => { if (!sessionStorage.seeded) { localStorage.setItem('fx_sub', JSON.stringify('needs')); sessionStorage.seeded = 1; } });
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.renderNeeds && FX.db);

// 1. no OpenAI key -> auto-approve switch disabled, and onNewVideo leaves clips pending
const disabled = await page.evaluate(() => { updateCount(); return document.getElementById('apAutoApprove').disabled; });
check('auto-approve disabled without an OpenAI key', disabled);
const left = await page.evaluate(async () => {
  document.getElementById('apOn').checked = true; document.getElementById('apAutoApprove').disabled = false; document.getElementById('apAutoApprove').checked = true;
  const clip = { id: 'c1', kind: 'clip', title: 'Test clip', blob: new Blob(['x'], { type: 'video/webm' }), caption: 'hi', score: 9, status: 'pending', created: Date.now(), gate: { verdict: 'PASS', at: 1, items: [] } };
  await putClip(clip); await onNewVideo(clip);
  document.getElementById('apOn').checked = false;
  const st = (await getClip('c1')).status;
  const c = await getClip('c1'); c.gate = { verdict: 'PASS', at: 1, items: [], summary: 'ok' }; await putClip(c); // pretend the checks passed
  return st;
});
check('no key: new clip stays pending even with auto-approve ticked', left === 'pending', left);

// 2. Approve all asks first; dismissing approves nothing
await page.evaluate(() => document.querySelector('nav button[data-tab=queue]').click());
let asked = '';
page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
await page.click('#approveAll');
await page.waitForTimeout(300);
const afterCancel = await page.evaluate(async () => (await getClip('c1')).status);
check('Approve all asks before approving', /Approve 1 pending video/.test(asked), asked.split('\n')[0]);
check('cancelling Approve all approves nothing', afterCancel === 'pending', afterCancel);
page.once('dialog', (d) => d.accept());
await page.click('#approveAll');
for (let i = 0; i < 30 && (await page.evaluate(async () => (await getClip('c1')).status)) === 'pending'; i++) await page.waitForTimeout(100);
const st1 = await page.evaluate(async () => (await getClip('c1')).status); check('confirming Approve all approves', st1 === 'approved', st1);
check('Approve all disabled when nothing is pending', await page.evaluate(async () => { await updateCount(); return document.getElementById('approveAll').disabled; }));

// 3. Assembly Line record waiting on you shows in the Review Queue, counts on the tab, and opens its record
await page.evaluate(async () => {
  await FX.db.prod.put({ id: 'V-TEST', type: 'clips', status: 'awaiting_approval', stage: 'approval', created: Date.now(), updated: Date.now(), reports: {}, history: [], revisions: [], costs: [], idea: { topic: 'Wild police chase' } });
  await updateCount(); await renderQueue();
});
await page.waitForSelector('#fxNeeds .need-card');
check('Review Queue lists the Assembly Line video', (await page.textContent('#fxNeeds')).includes('V-TEST'));
check('Review Queue tab count includes it', (await page.textContent('#qcount')).trim() === '1', await page.textContent('#qcount'));
await page.click('#fxNeeds .need-card');
await page.waitForSelector('#fxRecord:not([hidden])');
check('clicking it opens the record dialog', true);
await page.keyboard.press('Escape');

// 4. Assembly Line no longer has a second "Needs you" inbox
await page.evaluate(() => document.querySelector('nav button[data-tab=line]').click());
await page.waitForSelector('#fxSubnav button');
const subs = await page.$$eval('#fxSubnav button', (b) => b.map((x) => x.dataset.sub));
check('Assembly Line has no "Needs you" sub-tab', !subs.includes('needs'), subs.join(','));
check('old saved "needs" sub falls back to Videos', (await page.getAttribute('#fxSubnav button.active', 'data-sub')) === 'videos');

check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
