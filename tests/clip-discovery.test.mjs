// Clip discovery 2.0: whole-VOD deep analysis, 10-dimension scoring, style-weighted ranking, near-duplicate removal.
// Run from the repo root:  node tests/clip-discovery.test.mjs   (needs ffmpeg; fake OpenAI)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-disc-'));
const VOD = path.join(TMP, 'vod.webm');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=150', '-f', 'lavfi', '-i', "aevalsrc='(0.05+0.85*between(mod(t\\,50)\\,30\\,34))*sin(2*PI*300*t)':s=22050:d=150", '-c:v', 'libvpx', '-b:v', '100k', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', VOD]);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/__vod.webm') { res.writeHead(200, { 'Content-Type': 'video/webm' }); return fs.createReadStream(VOD).pipe(res); }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const calls = { deep: 0, moment: 0, pick: 0, score: 0 };
// a story told quietly at 60-80 s (no loudness peak) and loud shouting at 30-34 s / 80-84 s / 130-134 s
const STORY = 'so I took the cop car to the airport and the pilot was my friend from school and he flew us right into the bank'.split(' ');
await page.route('https://api.openai.com/**', async (route) => {
  const key = route.request().url().split('/v1/')[1], buf = (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1');
  if (key === 'audio/transcriptions') {
    if (buf.includes('deep.wav')) {
      calls.deep++;
      const words = STORY.map((w, i) => ({ word: w, start: 60 + i * 0.8, end: 60.6 + i * 0.8 }));
      ['AAAH', 'NO', 'WAY'].forEach((w, i) => { words.push({ word: w, start: 30 + i, end: 30.5 + i }); words.push({ word: w, start: 80 + i, end: 80.5 + i }); words.push({ word: w, start: 130 + i, end: 130.5 + i }); });
      words.sort((a, b) => a.start - b.start);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: '', words: calls.deep === 1 ? words : [] }) });
    }
    calls.moment++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'aaah no way', words: [] }) });
  }
  const body = route.request().postData() || '';
  let out = {};
  if (/Read the WHOLE stream transcript/.test(body)) { calls.pick++; out = { moments: [{ start: 59, end: 82, why: 'Complete story: cop car, pilot friend, flies into the bank' }] }; }
  else if (/Score each 1-10 on: opening/.test(body)) {
    calls.score++;
    const ids = [...body.matchAll(/#(\d+) at/g)].map((m) => +m[1]);
    out = { moments: ids.map((i) => { const story = /cop car/.test(body.split('#' + i + ' at')[1]?.split('\\n#')[0] || ''); return story
      ? { i, opening: 7, interest: 9, story: 10, context: 9, entertainment: 8, conversation: 8, emotion: 6, pacing: 8, ending: 9, clarity: 9, trending: 6, style: 'story', title: 'The pilot was his friend', hook: 'He called his pilot friend', concerns: [], skip: false, why: 'complete story' }
      : { i, opening: 6, interest: 4, story: 2, context: 3, entertainment: 6, conversation: 2, emotion: 7, pacing: 6, ending: 4, clarity: 7, trending: 5, style: 'reaction', title: 'Screaming', hook: 'NO WAY', concerns: [], skip: false, why: 'loud but no context' }; }) };
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
});
await page.route(/^https?:\/\/(?!localhost)(?!api\.openai\.com)/, (r) => r.abort());
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  const s = (k, v) => localStorage.setItem('ac_' + k, JSON.stringify(v));
  s('f_apiKey', 'sk-test'); s('fx_channel', { streamer: 'T', streamerRelation: 'me', clipLen: 25, clipMin: 10, momentsPerVod: 3, deepAnalysis: true, deepMaxMin: 30, discoveryStyle: 'story' }); s('fx_channelv', 1);
});
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.scoutVod);
const res = await page.evaluate(async () => {
  const b = await (await fetch('/__vod.webm')).blob(); FX.addVod(new File([b], 'disc.webm', { type: 'video/webm' }));
  const e = FX.vodInbox().at(-1); const r = { id: 'T1', costs: [] };
  const out = await FX.scoutVod(r, e, () => {});
  return { out: out.map((i) => ({ topic: i.topic, rank: i.rank, status: i.status, why: i.rejectReason, found: i.found, start: Math.round(i.start), dims: Object.keys(i.scores).length, scores: i.scores, method: i.method, pos: i.rankPos })), cost: r.costs.length };
});
const ok = res.out.filter((x) => x.status === 'new');
check('deep analysis transcribed the whole VOD in pieces', calls.deep >= 1 && calls.moment === 0, JSON.stringify(calls));
check('Clip Scout read the full transcript and found the quiet story', res.out.some((x) => /transcript/.test(x.found) && x.topic === 'The pilot was his friend' && x.start >= 50 && x.start <= 60), JSON.stringify(res.out.map((x) => [x.topic, x.found, x.start])));
check('every candidate has all 10 dimension scores', res.out.every((x) => ['opening', 'interest', 'story', 'context', 'entertainment', 'conversation', 'emotion', 'pacing', 'ending', 'clarity'].every((k) => typeof x.scores[k] === 'number')));
check('the story outranks the loud moments (story style)', ok[0]?.topic === 'The pilot was his friend' && ok[0].pos === 1, JSON.stringify(ok.map((x) => [x.topic, x.rank])));
check('near-duplicate moments are removed, not clipped twice', res.out.some((x) => x.status === 'rejected' && /Near-duplicate/.test(x.why)), JSON.stringify(res.out.map((x) => [x.topic, x.status, x.why])));
check('whisper cost recorded for the deep pass', res.cost >= 1);
// ranking without AI: only measurable dimensions, nothing invented
const noai = await page.evaluate(() => { const s = { entertainment: 8, pacing: 5, clarity: 5, loudness: 8 }; return { rank: FX.rankMoment(s, FX.discovery()), has: Object.keys(s) }; });
check('without AI, rank uses only measured dimensions', noai.rank > 0 && noai.rank <= 10, JSON.stringify(noai));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
