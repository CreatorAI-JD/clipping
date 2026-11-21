// Cloud studio against the REAL AutoClipper server (python -m autoclipper api) and a database made by
// server/tools/test_reels.py: connect, review grid, editor (caption overlay, cue edit), save, approve.
// Run: python3 server/tools/test_reels.py /tmp/acfx/reels && node tests/cloud-studio.test.mjs /tmp/acfx/reels/data
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.argv[2] || '/tmp/acfx/reels/data';
if (!fs.existsSync(path.join(DATA, 'autoclipper.db')) && !fs.readdirSync(DATA).some((f) => f.endsWith('.db'))) { console.log('SKIP  no reels database at ' + DATA); process.exit(0); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const site = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => site.listen(0, r));
const PORT = 18000 + Math.floor(Math.random() * 1000), TOKEN = 'test-token-123';
const api = spawn('python3', ['-m', 'autoclipper', 'api'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, AC_DATA_DIR: DATA, AC_ADMIN_TOKEN: TOKEN, PORT: String(PORT), AC_ALLOWED_ORIGINS: '*', OPENAI_API_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
let apiErr = ''; api.stderr.on('data', (d) => { apiErr += d; });
const URL_ = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_ + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.stack)); page.on('dialog', (d) => d.accept());
await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
try {
  await page.goto(`http://localhost:${site.address().port}/`);
  await page.waitForFunction(() => window.ACCloud);
  await page.click('nav button[data-tab="cloud"]'); await page.waitForTimeout(300);
  await page.fill('#clUrl', URL_); await page.fill('#clTok', TOKEN);
  await page.click('[data-cl="connect"]'); await page.waitForTimeout(1200);
  const txt = await page.locator('section#cloud').innerText();
  check('connects to the real server and shows its version', /Connected · server v3\./.test(txt), txt.match(/Connected[^\n]*|Not connected[^\n]*/)?.[0]);
  check('overview shows workers / review counts', /In review/.test(txt) && /Workers running/.test(txt));
  await page.click('[data-cl="tab"][data-tab="review"]').catch(() => page.evaluate(() => [...document.querySelectorAll('[data-cl="tab"]')].find((b) => /Review/.test(b.textContent))?.click()));
  await page.waitForTimeout(800);
  const cards = await page.locator('section#cloud [data-cl="open"]').count();
  check('review grid lists the produced clips with thumbnails', cards >= 3 && (await page.locator('section#cloud [data-cl="open"] img').count()) >= 3, 'cards=' + cards);
  await page.locator('section#cloud [data-cl="open"]').first().click(); await page.waitForTimeout(1500);
  const ed = await page.evaluate(() => ({ cues: document.querySelectorAll('#ceCues [data-f="text"]').length, vid: document.querySelector('#ceVid')?.src || '', cap: !!document.querySelector('#ceCap'), title: document.querySelector('#ceTitle')?.value }));
  check('editor opens with the clean video (signed URL), caption overlay and cue list', ed.cues > 0 && /\/api\/media\/.+sig=/.test(ed.vid) && ed.cap, JSON.stringify(ed));
  const vidOk = await page.evaluate(async () => { const v = document.querySelector('#ceVid'); for (let i = 0; i < 40 && v.readyState < 2; i++) await new Promise((r) => setTimeout(r, 100)); return v.readyState >= 2 && v.videoWidth === 1080; });
  check('signed media URL actually plays (1080 wide)', vidOk);
  await page.locator('#ceCues [data-f="text"]').first().fill('EDITED BY TEST');
  await page.fill('#ceTitle', 'Test title from browser');
  await page.click('[data-ce="save"]'); await page.waitForTimeout(800);
  const clips = await (await fetch(URL_ + '/api/clips', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const list = clips.clips || clips; const edited = list.find((c) => c.title === 'Test title from browser');
  const full = edited && await (await fetch(URL_ + '/api/clips/' + edited.id, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  check('Save writes title and edited caption to the server', !!edited && JSON.stringify(full.captions || full).includes('EDITED BY TEST'));
  await page.click('[data-ce="approve"]'); await page.waitForTimeout(800);
  const after = await (await fetch(URL_ + '/api/clips/' + edited.id, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  check('Approve marks it approved on the server (publishing off: no upload)', (after.clip || after).status === 'approved', (after.clip || after).status);
  // campaign: grant + watch several streamers in one go
  await page.evaluate(() => [...document.querySelectorAll('[data-cl="tab"]')].find((x) => /Creators/.test(x.textContent)).click()); await page.waitForTimeout(800);
  await page.fill('#clCampUrl', 'https://contentrewards.com/campaigns/test-camp'); await page.fill('#clCampList', 'streamer_a\nkick:streamer_b, https://www.twitch.tv/Streamer_C');
  await page.click('[data-cl="addCampaign"]'); await page.waitForTimeout(800);
  const cr = await (await fetch(URL_ + '/api/creators?permitted=1', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const camp = cr.filter((c) => c.permission_proof === 'https://contentrewards.com/campaigns/test-camp');
  check('campaign form grants and watches every streamer, proof = campaign page', camp.length === 3 && camp.every((c) => c.monitor === 1) && camp.some((c) => c.platform === 'kick'), JSON.stringify(camp.map((c) => c.platform + ':' + c.login)));
  await fetch(URL_ + '/api/creators', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'twitch', login: 'zz_not_permitted' }) });
  const order = (await (await fetch(URL_ + '/api/creators', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).map((c) => ['own', 'granted'].includes(c.permission));
  check('permitted creators are listed first in Creators', order.indexOf(false) > 0 && !order.slice(order.indexOf(false)).includes(true), order.join(','));
  // faceless: make one now + settings
  await page.evaluate(() => [...document.querySelectorAll('[data-cl="tab"]')].find((x) => /Overview/.test(x.textContent)).click()); await page.waitForTimeout(600);
  await page.click('[data-cl="makeFaceless"]'); await page.waitForTimeout(600);
  const jl = await (await fetch(URL_ + '/api/jobs', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  check('"Make a faceless reel now" queues a faceless job on the server', (jl.jobs || jl).some((j) => j.kind === 'faceless'));
  await page.evaluate(() => [...document.querySelectorAll('[data-cl="tab"]')].find((x) => /Settings/.test(x.textContent)).click()); await page.waitForTimeout(1000);
  await page.fill('#cs_fl_per', '5'); await page.fill('#cs_fl_niche', 'GTA RP funny moments explained'); await page.click('[data-cl="saveSettings"]'); await page.waitForTimeout(600);
  const st = await (await fetch(URL_ + '/api/settings', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  check('faceless settings save on the server', st.faceless.per_day === 5 && st.faceless.niche === 'GTA RP funny moments explained', JSON.stringify(st.faceless));
  // gameplay background upload (needs the confirmation box)
  const bgVid = fs.readdirSync(path.join(DATA, '..', 'src')).map((f) => path.join(DATA, '..', 'src', f)).find((f) => f.endsWith('.mp4'));
  if (bgVid) {
    await page.evaluate(() => [...document.querySelectorAll('[data-cl="tab"]')].find((x) => /Add source/.test(x.textContent)).click()); await page.waitForTimeout(800);
    await page.setInputFiles('#clBgFile', bgVid); await page.click('[data-cl="bgUpload"]'); await page.waitForTimeout(500);
    const refused = (await (await fetch(URL_ + '/api/backgrounds', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).length === 0;
    await page.check('#clBgAttest'); await page.click('[data-cl="bgUpload"]'); await page.waitForTimeout(2500);
    const bgs = await (await fetch(URL_ + '/api/backgrounds', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    check('gameplay backgrounds: refused without the confirmation, uploaded with it, listed', refused && bgs.length === 1 && /#\d+ ·/.test(await page.locator('#clBgList').innerText()), JSON.stringify(bgs.map((x) => x.status)));
  }
  const unauth = await fetch(URL_ + '/api/clips');
  check('server refuses requests without the admin token', unauth.status === 401);
  check('no page errors', errors.length === 0, errors[0]);
} finally { await browser.close(); site.close(); api.kill(); }
if (failed) console.log(apiErr.slice(-1500));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0);
