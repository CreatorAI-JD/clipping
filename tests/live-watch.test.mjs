// Live Watch (chat-spike detection, Twitch clip + VOD timestamp, tab recording -> Review Queue)
// and the navigation helpers (search, number keys, back button, Assembly Line links, phone menu, setup checklist).
// Run from the repo root:  node tests/live-watch.test.mjs   (Playwright + Chromium; fake Twitch chat + API, nothing real is touched)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack));
page.on('dialog', (d) => d.accept());

// anything else outside localhost is blocked (registered first: later routes win)
await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());

/* ---------- fake Twitch chat (IRC over WebSocket) ---------- */
const irc = { sockets: [], sent: [] };
await page.routeWebSocket(/irc-ws\.chat\.twitch\.tv/, (ws) => {
  irc.sockets.push(ws);
  ws.onMessage((m) => {
    irc.sent.push(String(m));
    const j = String(m).match(/^JOIN #(\w+)/);
    if (j) { ws.send(`:justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN #${j[1]}`); ws.send(`@emote-only=0 :tmi.twitch.tv ROOMSTATE #${j[1]}`); }
  });
});
const say = (user, text) => irc.sockets.at(-1).send(`@badge-info=;color=#FF0000;display-name=${user} :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #gtastreamer :${text}`);

/* ---------- fake Twitch Helix API ---------- */
const STREAM_START = Date.parse('2026-11-17T18:00:00Z');
const tw = { clipPosts: 0, scopes: '' };
await page.route('https://api.twitch.tv/helix/**', async (route) => {
  const req = route.request(), u = new URL(req.url()), j = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.pathname.endsWith('/users')) return j({ data: [{ id: '777', login: 'gtastreamer' }] });
  if (u.pathname.endsWith('/streams')) return j({ data: [{ user_id: '777', user_login: 'gtastreamer', started_at: new Date(STREAM_START).toISOString(), title: 'GTA 6 day 1', game_name: 'Grand Theft Auto VI', viewer_count: 4321 }] });
  if (u.pathname.endsWith('/videos')) return j({ data: [{ id: 'v555', created_at: new Date(STREAM_START + 5000).toISOString(), duration: '2h0m0s', title: 'GTA 6 day 1' }] });
  if (u.pathname.endsWith('/clips') && req.method() === 'POST') { tw.clipPosts++; return j({ data: [{ id: 'FunnyClip123', edit_url: 'https://clips.twitch.tv/FunnyClip123/edit' }] }, 202); }
  if (u.pathname.endsWith('/clips')) return j({ data: [{ id: 'FunnyClip123', url: 'https://clips.twitch.tv/FunnyClip123', thumbnail_url: '', title: 'LMAO', video_id: 'v555', vod_offset: 3590 }] });
  return j({ data: [] });
});
await page.addInitScript(() => {
  try { if (location.hostname !== 'localhost' || sessionStorage.seeded) return; sessionStorage.seeded = 1; } catch { return; }
  localStorage.setItem('ac_fx_auto', JSON.stringify({ twClient: 'abc123' }));
  localStorage.setItem('ac_fx_twToken', JSON.stringify({ token: 'tok', at: Date.now() }));
});
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.live && FX.nav);

/* =============== LIVE WATCH: detection =============== */
await page.evaluate(() => { window.__t = Date.parse('2026-11-17T19:00:00Z'); FX.live.clock = () => window.__t; FX.live.clipWait = 0; });
await page.click('nav button[data-tab="live"]');
await page.fill('#lvChannels', 'https://twitch.tv/GTAStreamer, ');
await page.dispatchEvent('#lvChannels', 'change');
await page.click('[data-live="start"]');
await page.waitForFunction(() => FX.live.chans.get('gtastreamer')?.status === 'watching');
check('joins the channel chat anonymously', irc.sent.some((m) => m === 'JOIN #gtastreamer') && irc.sent.some((m) => /^NICK justinfan\d+/.test(m)), irc.sent.join(' | '));
check('channel name cleaned from a URL', await page.evaluate(() => [...FX.live.chans.keys()].join()) === 'gtastreamer');
await page.evaluate(() => clearInterval(FX.live.timer)); // we drive the clock by hand from here

// learning: a normal chat pace for 5 minutes (about 1 message a second from a handful of people)
const advance = (s) => page.evaluate((s) => { window.__t += s * 1000; FX.live.tick(); }, s);
for (let s = 0; s < 300; s++) {
  if (s % 2 === 0) say('regular' + (s % 6), 'nice drive');
  if (s % 3 === 0) say('regular' + (s % 5), 'hello chat');
  await page.waitForTimeout(2);
  await advance(1);
}
let st = await page.evaluate(() => { const s = FX.live.chans.get('gtastreamer'); return { base: s.base, state: s.state, total: s.total, moments: FX.live.moments.length }; });
check('learned a normal pace from calm chat', st.base > 0 && st.state !== 'learning', JSON.stringify(st));
check('calm chat makes no moments', st.moments === 0);

// one person spamming is not a moment
for (let i = 0; i < 40; i++) say('spammer', 'KEKW KEKW');
await page.waitForTimeout(150); await advance(1);
check('one spammer alone does not trigger', await page.evaluate(() => FX.live.moments.length) === 0);
await advance(12);

// the hype: 25 different people, emotes and "clip it" inside a few seconds
const HYPE = ['KEKW', 'CLIP IT', 'NO WAY', 'LMAOOO', 'clip that', 'OMEGALUL', 'W', '???', 'HOLY', 'KEKW'];
for (let s = 0; s < 4; s++) { for (let i = 0; i < 18; i++) say('viewer' + ((i + s * 7) % 25), HYPE[(i + s) % HYPE.length]); await page.waitForTimeout(60); await advance(1); }
await page.waitForFunction(() => FX.live.moments.length > 0, null, { timeout: 5000 }).catch(() => {});
await page.waitForFunction(() => FX.live.moments[0]?.clip?.vodId, null, { timeout: 5000 }).catch(() => {});
const m = await page.evaluate(() => FX.live.moments[0]);
check('chat spike becomes a moment', !!m, m ? `×${m.strength}, ${m.users} chatters, ${m.top.join(', ')}` : 'none');
check('moment keeps what chat said', m?.sample?.length > 0 && m.top.length > 0);
check('made a Twitch clip right away', tw.clipPosts === 1 && m?.clip?.url === 'https://clips.twitch.tv/FunnyClip123', `posts ${tw.clipPosts}`);
check('read the clip\'s VOD offset', m?.clip?.vodId === 'v555' && m.clip.offset === 3590);
check('saved the VOD timestamp', m?.vod?.id === 'v555' && Math.abs(m.vod.offset - ((m.at - Date.parse('2026-11-17T18:00:00Z')) / 1000 - 8)) < 1 && /videos\/v555\?t=/.test(m.vod.url), JSON.stringify(m?.vod));
await page.waitForTimeout(200);
check('moment shows in the list with links', await page.locator('.live-moment a[href*="clips.twitch.tv"]').count() === 1 && await page.locator('.live-moment a[href*="videos/v555"]').count() === 1);

// cooldown: more hype right after doesn't make a second moment
for (let i = 0; i < 40; i++) say('viewer' + (i % 25), 'KEKW');
await page.waitForTimeout(100); await advance(1);
check('cooldown stops back-to-back duplicates', await page.evaluate(() => FX.live.moments.length) === 1);

// live moments become Moment Scout markers when that VOD is dropped in
const marks = await page.evaluate(() => FX.vodMarkers({ key: 'k1' }, { name: 'GTA6_day1_v555.mp4' }, 7200));
check('VOD dropped later gets the live moment as a hype marker', marks.some((x) => /Live chat spike/.test(x.title) && Math.abs(x.start - 3570) < 1), JSON.stringify(marks));

// "Test a spike" button works on its own
await page.evaluate(() => { FX.live.chans.get('gtastreamer').lastSpike = 0; window.__t += 200e3; });
await page.click('[data-live="sim"]');
await page.waitForFunction(() => FX.live.moments.length === 2, null, { timeout: 3000 }).catch(() => {});
check('"Test a spike" button makes a moment', await page.evaluate(() => FX.live.moments.length) === 2);
await page.waitForTimeout(300);
check('a test spike never makes a real Twitch clip', tw.clipPosts === 1 && await page.evaluate(() => FX.live.moments[0].test === true), `posts ${tw.clipPosts}`);

// stop
await page.click('[data-live="stop"]');
check('Stop watching closes chat', await page.evaluate(() => FX.live.chans.size === 0 && !FX.live.watching));

/* =============== LIVE WATCH: recording this tab -> 9:16 clip =============== */
await page.evaluate(() => {
  FX.live.clock = null; FX.live.spawnEvery = 4000; FX.live.postWait = 1500;
  localStorage.setItem('ac_fx_live', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_live')), preRoll: 10, postRoll: 3, twClip: false, mark: false, grab: true, sound: false }));
});
await page.click('[data-live="start"]');
await page.waitForFunction(() => FX.live.chans.get('gtastreamer')?.status === 'watching');
await page.evaluate(async () => {
  // a fake "stream": an animated canvas + a tone, standing in for the shared tab
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 }), x = c.getContext('2d');
  const t0 = performance.now();
  setInterval(() => { const t = (performance.now() - t0) / 1000; x.fillStyle = `hsl(${t * 40},70%,40%)`; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '40px sans-serif'; x.fillText('LIVE ' + t.toFixed(1), 30, 60); }, 33);
  const ac = getAudioCtx(); await ac.resume(); const o = ac.createOscillator(), d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const s = new MediaStream([...c.captureStream(30).getVideoTracks(), ...d.stream.getAudioTracks()]);
  await FX.live.startGrab('gtastreamer', s);
});
check('recording button switches to "Stop recording"', await page.locator('[data-live="stopGrab"]').count() === 1);
await page.waitForTimeout(12500); // let the rolling recorders run past the pre-roll
await page.evaluate(() => FX.live.simulate('gtastreamer'));
await page.waitForFunction(() => FX.live.moments[0]?.grab?.status === 'done' || FX.live.moments[0]?.grab?.status === 'failed', null, { timeout: 90000 }).catch(() => {});
const g = await page.evaluate(async () => { const m = FX.live.moments[0]; const c = m.grab?.clipId ? await getClip(m.grab.clipId) : null; return { grab: m.grab, errs: m.errs, clip: c && { status: c.status, source: c.source, size: c.blob.size, type: c.blob.type, title: c.title } }; });
check('moment recorded and cut into a clip', g.grab?.status === 'done', JSON.stringify(g.grab) + ' ' + g.errs.join(';'));
check('clip waits in the Review Queue', g.clip?.status === 'pending' && g.clip.source === 'live' && g.clip.size > 20000, JSON.stringify(g.clip));
check('raw recording kept for download', await page.evaluate(async () => !!(await kvGet('live_' + FX.live.moments[0].id))));
const dims = await page.evaluate(async () => { const c = await getClip(FX.live.moments[0].grab.clipId); const v = document.createElement('video'); v.src = URL.createObjectURL(c.blob); await new Promise((r) => (v.onloadedmetadata = r)); return [v.videoWidth, v.videoHeight]; });
check('clip is vertical 1080×1920', dims[0] === 1080 && dims[1] === 1920, dims.join('×'));
await page.click('[data-live="stopGrab"]');
await page.click('[data-live="stop"]');
check('nav badge counts new moments', await page.evaluate(() => document.querySelector('nav button[data-tab="live"] .pill').textContent) !== '');

/* =============== NAVIGATION =============== */
await page.click('nav button[data-tab="queue"]'); await page.waitForTimeout(800);
const fixes = await page.locator('#queue .fix-btn').count();
if (fixes) { await page.locator('#queue .fix-btn').first().click(); await page.waitForFunction(() => document.activeElement?.id === 'ch_streamerRelation', null, { timeout: 4000 }).catch(() => {}); }
check('queue warning has a "Fix it" button that goes there', fixes > 0 && await page.evaluate(() => document.querySelector('#line').classList.contains('active') && document.activeElement?.id === 'ch_streamerRelation'), `buttons ${fixes}`);

await page.click('nav button[data-tab="workshop"]');
check('setup checklist shows on the Workshop', await page.locator('#setupCard .setup-step').count() === 6);
const doneBefore = await page.locator('#setupCard .setup-step.done').count();
await page.keyboard.press('Control+k');
check('Ctrl+K opens Jump to', await page.locator('.cmdk:not([hidden]) #cmdkInput').count() === 1);
await page.keyboard.type('policies');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('search jumps into an Assembly Line section', await page.evaluate(() => document.querySelector('#line').classList.contains('active') && document.querySelector('#line [data-sub="policies"]').classList.contains('active') && location.hash === '#line/policies'), await page.evaluate(() => location.hash));
await page.keyboard.press('Control+k'); await page.keyboard.type('openai key'); await page.keyboard.press('Enter'); await page.waitForTimeout(600);
check('search action focuses the right field', await page.evaluate(() => document.activeElement?.id === 'apiKey' && document.querySelector('#settings').classList.contains('active')));
await page.fill('#apiKey', 'sk-test'); await page.dispatchEvent('#apiKey', 'change');
await page.locator('body').click({ position: { x: 600, y: 5 } });
await page.keyboard.press('Escape');
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('4');
check('number key 4 opens Live Watch (2 Operations, 3 Content plan)', await page.evaluate(() => document.querySelector('#live').classList.contains('active')));
await page.goBack(); await page.waitForTimeout(300);
check('Back button returns to the previous page', await page.evaluate(() => document.querySelector('#settings').classList.contains('active')), await page.evaluate(() => location.hash));
await page.keyboard.press('1'); await page.waitForTimeout(400);
check('checklist ticks off finished steps', await page.locator('#setupCard .setup-step.done').count() === doneBefore + 1);
await page.keyboard.press('?');
check('? shows the shortcuts', await page.locator('.help-box').isVisible());
await page.keyboard.press('Escape');
check('page title follows the page', await page.evaluate(() => { document.querySelector('nav button[data-tab="queue"]').click(); return document.title; }) === 'Review Queue · AutoClipper');

// deep link straight into an Assembly Line section
const p2 = await browser.newPage();
await p2.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
await p2.goto(BASE + '#line/costs'); await p2.waitForTimeout(1200);
check('link to #line/costs opens that section', await p2.evaluate(() => document.querySelector('#line').classList.contains('active') && document.querySelector('#line [data-sub="costs"]')?.classList.contains('active')));
await p2.close();

// phone: menu button
const ph = await browser.newPage({ viewport: { width: 390, height: 844 } });
ph.on('pageerror', (e) => errors.push(e.stack));
await ph.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
await ph.goto(BASE); await ph.waitForTimeout(600);
check('phone: tabs tucked behind Menu', !(await ph.locator('nav button[data-tab="queue"]').isVisible()) && await ph.locator('#navMenu').isVisible());
await ph.click('#navMenu');
check('phone: Menu shows grouped pages', await ph.locator('nav button[data-tab="queue"]').isVisible() && await ph.locator('.nav-group').first().isVisible());
await ph.click('nav button[data-tab="live"]');
check('phone: picking a page opens it and closes the menu', await ph.evaluate(() => document.querySelector('#live').classList.contains('active') && !document.body.classList.contains('menu-open')));
check('phone: no sideways scrolling', await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await ph.close();

check('no page errors', errors.length === 0, errors.join('\n').slice(0, 800));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
