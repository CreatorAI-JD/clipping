// Review Queue + record view (inspection board, why chosen, ledger, edit captions, revision request, compare),
// production analytics on Stats, and the learning layer (needs 6 videos, normalises by median, never changes settings).
// Run: node tests/review-insights.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, r));
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.stack)); page.on('dialog', (d) => d.accept());
await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => window.FX && FX.recordExtras && FX.learn);
// seed: 2 videos waiting for approval with inspections, and 7 published videos with stats
await page.evaluate(async () => {
  const mk = async (id, extra) => { const r = { id, created: Date.now() - 2 * 864e5, updated: Date.now(), type: 'clips', stage: 'approval', status: 'awaiting_approval', reports: {}, reportHistory: [], history: [], revisions: [], costs: [{ usd: 0.01 }], attempts: {}, metricsHistory: [], channelVersion: 1, ...extra }; await FX.db.prod.put(r); return r; };
  const board = (s) => Array.from({ length: 10 }, (_, i) => ({ n: i + 1, name: FX.CHECKERS[i][1], agent: FX.CHECKERS[i][2], status: i === 1 ? s : 'pass', score: i === 1 && s === 'fail' ? 40 : 95, method: 'test', tickets: [] }));
  const cues = [{ start: 0.5, end: 1.4, text: 'he did not' }, { start: 1.4, end: 2.2, text: 'see the pier' }];
  await mk('VID-A', { idea: { topic: 'Pier crash', description: 'complete story with payoff', rank: 8.2, rankPos: 1, of: 4, method: '10-dimension AI scoring', scores: { opening: 8, interest: 9, story: 9, context: 8, entertainment: 8, conversation: 6, emotion: 7, pacing: 8, ending: 9, clarity: 8 }, transcript: 'he did not see the pier' }, clip: { vodName: 'stream.mp4', start: 600, len: 20, outLen: 18, cuts: [1], hook: 'He did NOT see it' },
    inspection: { round: 1, summary: '9 passed', board: board('pass'), tickets: [], resolved: [], overall: 91, viral: 74 }, viral: { score: 74, parts: { hook: 90, clarity: 95, pacing: 80, story: 90, audience: 60 }, note: 'Estimate' }, captions: { cues, method: 'whisper' }, export: { duration: 18 }, publishPrep: { platforms: { youtube: { title: 'Pier crash', titles: ['Pier crash'], description: 'd' } } },
    ledger: { trends: { status: 'completed', agent: 'intel', firstStart: Date.now() - 6e4, lastEnd: Date.now() - 5e4, ms: 1e4, score: 100, output: 'picked', errors: [], runs: [{ status: 'completed', score: 100 }] }, finalqc: { status: 'completed', agent: 'qa', firstStart: Date.now() - 2e4, lastEnd: Date.now() - 1e4, ms: 1e4, score: 91, output: 'ok', errors: [], runs: [{ status: 'sent_back', score: 40 }, { status: 'completed', score: 91, revision: true, reason: 'sync' }] } } });
  await mk('VID-B', { idea: { topic: 'Bridge jump', rank: 6, scores: { opening: 6 } }, inspection: { round: 1, summary: '1 failed', board: board('fail'), tickets: [{ n: 2, checker: 'Caption synchronization', problem: 'Captions are out of sync by about 1.20s', severity: 'medium', at: '00:01.0–00:03.0', action: 'Re-time the captions', agent: 'captions', status: 'Noted' }], resolved: [], overall: 70, viral: 55 }, export: { duration: 25 } });
  const fmts = ['story', 'story', 'story', 'reaction', 'reaction', 'reaction', 'reaction'], views = [9000, 12000, 10000, 2000, 1500, 2500, 1800];
  for (let i = 0; i < 7; i++) await FX.db.prod.put({ id: 'VID-P' + i, type: 'clips', created: Date.now() - 5 * 864e5, updated: Date.now(), stage: 'monitor', status: 'live', idea: { style: fmts[i], scores: { story: fmts[i] === 'story' ? 9 : 3, emotion: 5 + (i % 3) } }, export: { duration: 30 }, captions: { style: { preset: 'bold' } }, publish: { at: Date.now() - 3 * 864e5, scheduledFor: Date.now() - 3 * 864e5, platforms: ['youtube'] }, metricsHistory: [{ at: Date.now(), views: views[i], likes: views[i] / 20, comments: 5, shares: 2, yt: { avgViewPct: 60 + i } }], reports: {}, history: [], revisions: [], costs: [{ usd: 0.02 }], attempts: {}, ledger: { edit: { ms: 30000, runs: [{ agent: 'visual', status: 'completed', ms: 30000 }] } } });
});
// record view
await page.evaluate(() => FX.openRecordById('VID-A')); await page.waitForTimeout(400);
const rv = await page.evaluate(() => ({ txt: document.querySelector('#fxRecord').innerText, chk: document.querySelectorAll('#fxRecord .rv-chk').length, dims: document.querySelectorAll('#fxRecord .rv-dims div').length, ledger: document.querySelectorAll('#fxRecord .lg-row').length }));
check('record shows the 10-checker board and scores', rv.chk === 10 && /Viral est\./.test(rv.txt) && /Quality/.test(rv.txt));
check('record explains why the AI chose the clip (10 scores, rank, source + timestamps)', rv.dims === 10 && /#1 of 4 candidates/.test(rv.txt) && /stream\.mp4 · 10:00–10:20/.test(rv.txt), rv.txt.match(/Why the AI[^\n]*/)?.[0]);
check('record shows the production ledger with revision history', rv.ledger === 2 && /Production ledger/.test(rv.txt));
// edit captions -> re-render queued
await page.evaluate(() => { document.querySelector('#rvEdit').open = true; });
await page.fill('#rvCaps', '0.40-1.30 he did NOT\n1.30-2.20 see the pier');
await page.click('[data-rv="saveCaps"]'); await page.waitForTimeout(300);
const ec = await page.evaluate(async () => { const r = await FX.db.prod.get('VID-A'); return { stage: r.stage, status: r.status, cue: r.captions.cues[0], note: r.revisionNote?.reason }; });
check('editing captions saves them and sends the video to re-render', ec.stage === 'edit' && ec.status === 'queued' && ec.cue.text === 'he did NOT' && ec.cue.start === 0.4, JSON.stringify(ec));
// revision request on VID-B
await page.evaluate(() => FX.openRecordById('VID-B')); await page.waitForTimeout(300);
await page.evaluate(() => { document.querySelector('#rvEdit').open = true; });
await page.fill('#rvReq', 'start 2 seconds later'); await page.selectOption('#rvTo', 'script'); await page.click('[data-rv="request"]'); await page.waitForTimeout(300);
const rq = await page.evaluate(async () => { const r = await FX.db.prod.get('VID-B'); return { stage: r.stage, rep: r.reports.you?.items?.[0]?.issue, from: r.revisionNote?.from }; });
check('a revision request reaches the agent as a report it reads', rq.stage === 'script' && rq.rep === 'start 2 seconds later' && rq.from === 'you', JSON.stringify(rq));
// Review Queue: cards with scores + compare
await page.evaluate(async () => { for (const id of ['VID-A', 'VID-B']) { const r = await FX.db.prod.get(id); r.stage = 'approval'; r.status = 'awaiting_approval'; await FX.db.prod.put(r); } document.querySelector('#fxRecord').hidden = true; document.body.classList.remove('modal-open'); });
await page.click('nav button[data-tab="queue"]'); await page.waitForTimeout(600);
check('Review Queue cards show quality, hook, captions, context and viral scores', await page.locator('#fxNeeds .need-card .rv-scores').count() === 2);
await page.check('[data-cmp="VID-A"]'); await page.check('[data-cmp="VID-B"]'); await page.click('[data-rv="compare"]'); await page.waitForTimeout(400);
check('two clips can be compared side by side', await page.locator('#rvCompare .rv-col').count() === 2);
// learning
const L = await page.evaluate(async () => { const before = JSON.stringify(FX.channel()); const l = await FX.learn(); return { n: l.n, f: l.findings.map((x) => `${x.feature}:${x.value}:${x.vsOthers}`), w: l.dimWeights, fw: l.formatWeights, same: before === JSON.stringify(FX.channel()) }; });
check('learning uses only published videos with stats (7 here)', L.n === 7, String(L.n));
check('it finds that story clips beat reaction clips on this channel', L.f.some((x) => x.startsWith('Format / style:story:') && +x.split(':')[2] > 2), JSON.stringify(L.f));
check('scout dimension weights follow the data (story up)', L.w.story > 1, JSON.stringify(L.w));
check('learning never changes your settings', L.same);
const small = await page.evaluate(async () => { for (let i = 0; i < 4; i++) await FX.db.prod.del('VID-P' + i); const l = await FX.learn(); return { n: l.n, note: l.note, w: Object.keys(l.dimWeights).length }; });
check('with fewer than 6 videos nothing is re-weighted', small.n === 3 && small.w === 0 && /6 needed/.test(small.note));
// stats
await page.click('nav button[data-tab="stats"]'); await page.waitForTimeout(600);
const st = await page.evaluate(() => document.querySelector('#prodStats')?.innerText || '');
check('Stats shows production analytics from the records', /Production analytics/.test(st) && /Videos produced/.test(st) && /Agent success rates/.test(st), st.slice(0, 200));
await page.selectOption('#psStatus', 'live'); await page.waitForTimeout(300);
check('filters change the numbers', /3\s*\n?\s*Videos produced/.test(await page.evaluate(() => document.querySelector('#prodStats').innerText)));
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
check('phone: no sideways scrolling on Stats', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
