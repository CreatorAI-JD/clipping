// Content Director: reads the worker's files, builds a 7-day plan, feeds planned ideas to the line in order,
// expires stale research, keeps clip slots honest about sources. Run: node tests/director.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const now = Date.now();
const DATA = {
  'status.json': { at: new Date(now - 3600e3).toISOString(), ok: true, next: new Date(now + 5 * 3600e3).toISOString(), summary: '40 topics investigated, 3 opportunities, 3 planned', sources: [{ name: 'googleNews', ok: true, count: 20 }, { name: 'reddit', ok: false, error: '403' }], errors: [] },
  'research.json': { at: new Date(now).toISOString(), opportunities: [
    { key: 'a', kind: 'faceless', topic: 'How GTA 6 maps were built', why: 'Covered by IGN and Polygon this week', sources: [{ publisher: 'IGN', title: 't', url: 'https://ign.example/x' }], confidence: 0.8, format: 'explainer', hook: 'The map took 10 years', risks: [], score: 80 },
    { key: 'b', kind: 'faceless', topic: 'Rockstar history in 60 seconds', why: 'Wikipedia most-read', sources: [{ publisher: 'Wikipedia', title: 'Rockstar Games' }], confidence: 0.6, format: 'history', hook: '', risks: [], score: 60 },
    { key: 'c', kind: 'clip', topic: 'N3ON (kick)', why: 'clips taking off', creator: 'N3ON', platform: 'kick', sources: [], confidence: 0.5, format: 'clip', risks: ['clipping rights'], score: 40 } ] },
  'plan.json': { at: new Date(now).toISOString(), days: [{ date: new Date(now).toISOString().slice(0, 10), slots: [{ key: 'a', topic: 'How GTA 6 maps were built', kind: 'faceless', format: 'explainer', confidence: 0.8, score: 80 }, { key: 'b', topic: 'Rockstar history in 60 seconds', kind: 'faceless', format: 'history', confidence: 0.6, score: 60 }] }] },
  'log.json': [{ at: new Date(now - 3600e3).toISOString(), ok: true, investigated: 40, opportunities: 3 }],
};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/__data/')) { const f = u.slice(8); if (!DATA[f]) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(DATA[f])); }
  const f = path.join(ROOT, u.replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
await page.addInitScript((base) => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', 1); const s = (k, v) => localStorage.setItem('ac_' + k, JSON.stringify(v)); s('fx_director', { dataUrl: base + '__data/' }); s('fx_channel', { type: 'faceless', name: 'Facts', niche: 'GTA history', videosPerDay: 2 }); s('fx_channelv', 1); s('f_apiKey', 'sk-test'); }, BASE);
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.director);
const r = await page.evaluate(async () => {
  const pull = await FX.director.pullWorker();
  // an old research idea that should expire
  await FX.db.ideas.put({ id: 'res_old', type: 'research', status: 'new', created: Date.now() - 9 * 864e5, topic: 'Old news', rank: 9 });
  const plan = await FX.director.buildPlan();
  const ideas = await FX.db.ideas.all();
  return { pull: pull.ok, w: JSON.parse(localStorage.getItem('ac_fx_workerStatus')), slots: plan.days.flatMap((d) => d.slots.map((s) => ({ topic: s.topic, kind: s.kind, ideaId: s.ideaId }))), ideas: ideas.map((i) => ({ id: i.id, status: i.status, priority: i.priority, sources: (i.sources || []).length })), log: JSON.parse(localStorage.getItem('ac_fx_researchLog')) };
});
check('worker status, research and plan were read from the data branch', r.pull && r.w.ok && /40 topics/.test(r.w.summary));
check('worker research runs count in the research log', r.log.some((x) => x.by === 'worker' && x.investigated === 40));
check('plan uses only faceless opportunities for a faceless channel', r.slots.length === 2 && r.slots.every((s) => s.kind === 'faceless'), JSON.stringify(r.slots));
check('planned topics became ideas with their sources and a priority', r.ideas.filter((i) => i.priority).length === 2 && r.ideas.find((i) => i.priority === 1)?.sources >= 1, JSON.stringify(r.ideas));
check('stale research expires', r.ideas.find((i) => i.id === 'res_old')?.status === 'expired');
// the line picks the Director's first slot
const pick = await page.evaluate(async () => { const rec = await FX.newRecord({ who: 'test' }); await FX.step(rec.id); const x = await FX.db.prod.get(rec.id); return x.idea?.topic; });
check('the Assembly Line produces the Director\'s first planned topic', pick === 'How GTA 6 maps were built', pick);
await page.click('nav button[data-tab="plan"]'); await page.waitForTimeout(500);
check('Content plan page shows 7 days and the worker status', await page.locator('.pl-day').count() === 7 && /40 topics investigated/.test(await page.textContent('#plan')));
check('Operations "Open the 7-day plan" goes to the plan', await page.evaluate(() => { document.querySelector('nav button[data-tab="ops"]').click(); return true; }) && (await page.waitForTimeout(400), await page.click('[data-op="goPlan"]'), await page.evaluate(() => document.querySelector('#plan').classList.contains('active'))));
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
check('phone: no sideways scrolling', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
