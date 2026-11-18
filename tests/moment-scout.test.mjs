// Moment Scout upgrades (fx-scout.js): footage frames go to the AI ranking, every moment gets a
// retention scorecard, and the Ideas & VODs pane can search moments by words or with the AI.
// Run from the repo root:  node tests/moment-scout.test.mjs   (needs ffmpeg)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-scout-'));
const VOD = path.join(TMP, 'vod.webm');
// two loud bursts (at ~20s and ~55s) in a quiet 70s "stream"
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=70', '-f', 'lavfi', '-i', "aevalsrc='(0.04+0.85*(between(t\\,20\\,24)+between(t\\,55\\,59)))*sin(2*PI*(300+200*sin(t))*t)':s=44100:d=70", '-c:v', 'libvpx', '-b:v', '300k', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', VOD]);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/__vod.webm') { res.writeHead(200, { 'Content-Type': 'video/webm' }); return fs.createReadStream(VOD).pipe(res); }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const S = { rankImages: -1, rankPrompt: '', n: 0 };
const SAID = ['oh no the cops are right behind me', 'he flipped the car off the pier into the water chat'];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('https://www.reddit.com/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { children: [] } }) }));
await page.route('https://api.openai.com/**', async (route) => {
  const key = route.request().url().split('/v1/')[1];
  if (key === 'audio/transcriptions') {
    const said = SAID[S.n++ % 2];
    const words = said.split(' ').map((w, i) => ({ word: w, start: 7 + i * 0.4, end: 7.3 + i * 0.4 }));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: said, words }) });
  }
  const j = JSON.parse(route.request().postData() || '{}'), user = j.messages?.[1]?.content;
  const text = Array.isArray(user) ? user[0].text : user || '';
  let out = {};
  if (/hookScore/.test(text)) {
    S.rankImages = Array.isArray(user) ? user.filter((p) => p.type === 'image_url').length : 0; S.rankPrompt = text;
    const ids = [...text.matchAll(/#(\d+) at/g)].map((m) => +m[1]);
    out = { moments: ids.map((i, k) => ({ i, hype: 8, standalone: 7, trending: 6, see: k ? 'A car flips off a pier into the ocean' : 'Police cars chase a sports car through traffic', hookScore: k ? 9 : 4, story: 7, payoff: k ? 9 : 4, retentionTips: ['Open on the flip'], title: k ? 'Pier flip' : 'Cop chase', hook: 'He did NOT see that coming', concerns: [], skip: false, why: 'test' })) };
  } else if (/You search a library/.test(j.messages?.[0]?.content || '')) {
    const id = (text.match(/(mom_\S+) \|[^\n]*Pier flip/) || [])[1];
    out = { matches: id ? [{ id, why: 'car goes into the water' }] : [] };
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
});
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  const s = (k, v) => localStorage.setItem('ac_' + k, JSON.stringify(v));
  s('f_apiKey', 'sk-test');
  s('fx_channel', { streamer: 'TestStreamer', streamerRelation: 'me', clipLen: 12, momentsPerVod: 2, subreddits: 'gaming' });
  s('fx_channelv', 1);
});
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.scoutVod && FX.scout);

let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };

// unit checks
const u = await page.evaluate(() => {
  const lively = Array.from({ length: 30 }, (_, i) => ({ word: 'w', start: 0.3 + i * 0.35, end: 0.6 + i * 0.35 }));
  const quiet = [{ word: 'so', start: 4, end: 4.3 }, { word: 'yeah', start: 9, end: 9.3 }];
  return { lively: FX.scout.pacing(lively, 0, 12), quiet: FX.scout.pacing(quiet, 0, 12), none: FX.scout.pacing([], 0, 12),
    ret: FX.scout.retention({ hookScore: 3, story: 4, payoff: 8 }, FX.scout.pacing(quiet, 0, 12)),
    m1: FX.scout.match({ topic: 'Pier flip', transcript: 'into the water' }, 'pier wat'), m0: FX.scout.match({ topic: 'Pier flip' }, 'pier police') };
});
check('lively talk scores high on pacing', u.lively.score >= 8, JSON.stringify(u.lively));
check('long silences score low on pacing', u.quiet.score <= 4 && u.quiet.deadAir > 0.5, JSON.stringify(u.quiet));
check('no words gives no pacing score', u.none.score === null);
check('retention gives tips for a weak hook and slow start', u.ret.tips.length >= 2 && u.ret.score < 60, JSON.stringify(u.ret));
check('search matches every word by prefix', u.m1 > 0 && u.m0 === 0);

// full scout run on a VOD
const ideas = await page.evaluate(async () => {
  const b = await (await fetch('/__vod.webm')).blob();
  const f = new File([b], 'scout_vod.webm', { type: 'video/webm', lastModified: Date.now() - 3600e3 });
  const e = FX.addVod(f) || FX.vodInbox().at(-1);
  const out = await FX.scoutVod(null, FX.vodInbox().find((x) => x.name === 'scout_vod.webm'), () => {});
  return out.map((i) => ({ id: i.id, topic: i.topic, see: i.see, retention: i.retention, rank: i.rank, method: i.method }));
});
check('scout found 2 moments', ideas.length === 2, JSON.stringify(ideas.map((i) => i.topic)));
check('footage frames were sent with the ranking call', S.rankImages >= 4, `images=${S.rankImages}`);
check('every moment has an on-screen description', ideas.every((i) => i.see), JSON.stringify(ideas.map((i) => i.see)));
check('every moment has a retention scorecard', ideas.every((i) => i.retention && i.retention.score > 0 && i.retention.pace), JSON.stringify(ideas.map((i) => i.retention?.score)));
const flip = ideas.find((i) => i.topic === 'Pier flip'), chase = ideas.find((i) => i.topic === 'Cop chase');
check('stronger hook + payoff ranks higher', flip && chase && flip.rank > chase.rank, `${flip?.rank} vs ${chase?.rank}`);
check('method names the new signals', /footage frames/.test(ideas[0]?.method) && /retention/.test(ideas[0]?.method), ideas[0]?.method);

// Ideas & VODs pane: retention card + search
await page.evaluate(() => { openTab('line'); return FX.openSub('ideas'); });
await page.waitForSelector('#fxScoutQ');
check('retention scorecard shows on moment cards', await page.locator('.idea .rt-s').count() >= 2);
await page.fill('#fxScoutQ', 'police');
await page.waitForTimeout(400);
const vis = async () => page.$$eval('.idea[data-hay]', (els) => els.filter((e) => !e.hidden).map((e) => e.querySelector('b').textContent));
let v = await vis();
check('keyword search matches what is on screen', v.length === 1 && v[0] === 'Cop chase', JSON.stringify(v));
check('typing keeps focus in the search box', await page.evaluate(() => document.activeElement?.id === 'fxScoutQ'));
await page.fill('#fxScoutQ', 'car into the ocean');
await page.click('[data-act="scoutAsk"]');
await page.waitForFunction(() => /AI search/.test(document.getElementById('fxScoutCount')?.textContent || ''));
v = await vis();
check('AI search returns the matching moment', v.length === 1 && v[0] === 'Pier flip', JSON.stringify(v));
await page.screenshot({ path: path.join(process.env.SHOT_DIR || TMP, 'moment-scout.png'), fullPage: false });
await page.click('[data-act="scoutClear"]');
await page.waitForTimeout(300);
check('clear shows everything again', (await vis()).length === 2);
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
