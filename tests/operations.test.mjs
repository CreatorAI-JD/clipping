// Autonomous Operations: modes, budget cap stops paid calls, health monitor pauses the line on a dead key,
// notifications only for things that need you, Autopilot approves only fully-checked videos, daily report from real records.
// Run from the repo root:  node tests/operations.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, r));
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept());
await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => window.FX && FX.ops && FX.dailyReport);

// 1. budget: once today's estimated spend reaches the cap, paid calls throw a limit error (stage pauses, not fails)
const b = await page.evaluate(() => {
  FX.setOps({ budget: 0.05 });
  FX.cost({ costs: [] }, 'test', 'openai:test', 1, 0.06);
  let threw = null; try { FX.use('openai'); } catch (e) { threw = { limit: !!e.limit, msg: e.message }; }
  let free = 'ok'; try { FX.use('stock'); } catch (e) { free = e.message; }
  return { threw, free, spent: FX.spentToday() };
});
check('budget cap stops paid AI calls with a limit (pause) error', b.threw?.limit && /Daily budget reached/.test(b.threw.msg), JSON.stringify(b));
check('free calls are not blocked by the budget', b.free === 'ok');

// 2. health monitor pauses a running line when the OpenAI key fails, and notifies
const h = await page.evaluate(async () => {
  FX.setOps({ budget: 0 });
  await FX.setRunning(true);
  const r = await FX.newRecord({ who: 'test' }); r.errors = [{ at: Date.now(), dept: 'script', message: 'OpenAI 401: Incorrect API key provided' }]; r.status = 'error'; await FX.saveRecord(r);
  await FX.health();
  return { running: FX.manager.running, pause: JSON.parse(localStorage.getItem('ac_fx_opsPause')), notes: FX.notes().map((n) => n.level + ': ' + n.text) };
});
check('dead API key pauses the line', h.running === false && /OpenAI key stopped working/.test(h.pause?.reason || ''), JSON.stringify(h.pause));
check('a critical notification was raised', h.notes.some((n) => /^critical: Production paused/.test(n)), JSON.stringify(h.notes));

// 3. Autopilot approves only fully-checked videos, and only after auto-publishing is switched on
const ap = await page.evaluate(async () => {
  const r = await FX.newRecord({ who: 'test' });
  Object.assign(r, { reports: { finalqc: { verdict: 'PASS' }, copyright: { verdict: 'PASS' }, guidelines: { verdict: 'PASS' } }, inspection: { overall: 88, viral: 70, tickets: [], board: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, name: 'C' + (i + 1), status: 'pass' })) } });
  connected = { youtube: true, tiktok: true, instagram: true, facebook: true, x: true, threads: true }; document.querySelectorAll('#postTo input[type=checkbox]').forEach((x) => (x.checked = true));
  const cp = canPost();
  FX.setOps({ mode: 'assisted', autoPublish: false }); const a = await FX.autopilotCheck(r);
  FX.setOps({ mode: 'autopilot', autoPublish: false }); const b = await FX.autopilotCheck(r);
  FX.setOps({ mode: 'autopilot', autoPublish: true, minOverall: 70 }); const c = await FX.autopilotCheck(r);
  r.inspection.board[0].status = 'unverified'; const d = await FX.autopilotCheck(r);
  r.inspection.board[0].status = 'pass'; r.inspection.tickets = [{ severity: 'high', status: 'Needs revision' }]; const e = await FX.autopilotCheck(r);
  r.inspection.tickets = []; r.reports.copyright.verdict = 'HUMAN_REVIEW'; const f = await FX.autopilotCheck(r);
  return { cp, a: a.ok, b: b.ok, bWhy: b.why, c: c.ok, cWhy: c.why, d: d.ok, dWhy: d.why, e: e.ok, f: f.ok };
});
check('Assisted mode never auto-approves', ap.a === false);
check('Autopilot waits until auto-publishing is explicitly on', ap.b === false && ap.bWhy.includes('auto-publishing is off'));
check('Autopilot approves a video that passed every check', ap.c === true, JSON.stringify(ap.cWhy));
check('a "not verified" checker blocks auto-approval', ap.d === false && /not verified/.test(ap.dWhy.join()));
check('open must-fix tickets block auto-approval', ap.e === false);
check('unclear rights block auto-approval', ap.f === false);

// 4. daily report counts real records; the Operations page renders it
await page.click('nav button[data-tab="ops"]'); await page.waitForTimeout(500);
const rep = await page.evaluate(async () => { const r = await FX.dailyReport(); return { started: r.production.started, txt: document.querySelector('#opReport')?.innerText || '' }; });
check('daily report counts the videos actually started today', rep.started === 2 && /2 videos started/.test(rep.txt), JSON.stringify(rep));
check('Operations shows mode cards, status, budget and notifications', await page.locator('.op-mode').count() === 3 && /Notifications/.test(await page.textContent('#ops')));
await page.click('.op-mode[data-v="autonomous"]'); await page.waitForTimeout(200);
check('mode switch is saved', await page.evaluate(() => FX.ops().mode) === 'autonomous');
check('nav pill shows unread notifications', await page.evaluate(() => !document.querySelector('nav button[data-tab="ops"] .pill').hidden));
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
check('phone: no sideways scrolling', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
