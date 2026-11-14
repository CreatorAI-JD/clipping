// End-to-end: a GTA "VOD" goes through all assembly-line departments, waits for approval, passes the
// publish gate and is handed to (fake) Upload-Post. A second run shows a flagged moment never reaches upload.
// Run from the repo root:  node tests/assembly-line-e2e.test.mjs   (needs ffmpeg; takes a few minutes)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-'));
const VOD = path.join(TMP, 'vod.webm'), TTS = path.join(TMP, 'tts.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=70', '-f', 'lavfi', '-i', "aevalsrc='(0.05+0.85*between(mod(t\\,35)\\,20\\,25))*sin(2*PI*(300+200*sin(t))*t)':s=44100:d=70", '-c:v', 'libvpx', '-b:v', '300k', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', VOD]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', TTS]);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/__vod.webm') { res.writeHead(200, { 'Content-Type': 'video/webm' }); return fs.createReadStream(VOD).pipe(res); }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const S = { said: 'oh my god he crashed the car into the pier lets go chat that was insane', uploads: [], calls: {} };
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.route('https://api.openai.com/**', async (route) => {
  const url = route.request().url(), key = url.split('/v1/')[1]; S.calls[key] = (S.calls[key] || 0) + 1;
  if (key === 'audio/transcriptions') {
    const words = S.said.split(' ').map((w, i) => ({ word: w, start: 2 + i * 0.45, end: 2.4 + i * 0.45 }));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: S.said, words, segments: [{ start: 2, end: 2 + words.length * 0.45, text: S.said }] }) });
  }
  if (key === 'audio/speech') return route.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(TTS) });
  if (key === 'moderations') {
    const j = JSON.parse(route.request().postData()), inputs = Array.isArray(j.input) ? j.input : [j.input];
    const one = (t) => { const hate = typeof t === 'string' && /SLURWORD/.test(t); return { flagged: hate, categories: { hate }, category_scores: { hate: hate ? 0.9 : 0.01 } }; };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: inputs.some((x) => typeof x === 'object') ? [one('')] : inputs.map(one) }) });
  }
  // chat: answer the few departments that need structure, '{}' for the rest (each department has a fallback)
  const body = route.request().postData() || '';
  let out = {};
  if (/trimStart/.test(body)) out = { trimStart: 1, trimEnd: 9, hook: 'He did NOT see the pier', title: 'Pier crash getaway', intro: '' };
  else if (/standalone/.test(body)) out = { standalone: 8, contextNeeded: '', realWorldClaims: [], personalInfo: false };
  else if (/advertiserFriendly/.test(body)) out = { advertiserFriendly: 'yes', reasons: [], valueAdded: 7, notes: '' };
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
});
await page.route('https://api.upload-post.com/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/uploadposts/users')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, plan: 'basic', profiles: [{ username: 'autoclipper', social_accounts: { tiktok: { display_name: 'nuggiez_clips' }, youtube: { display_name: 'Nuggiez Clips' } } }] }) });
  if (url.endsWith('/upload')) { S.uploads.push(route.request().headers()['idempotency-key']); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, request_id: 'req_e2e' }) }); }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, status: 'pending' }) });
});
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  const s = (k, v) => localStorage.setItem('ac_' + k, JSON.stringify(v));
  s('f_apiKey', 'sk-test'); s('f_upKey', 'up-test'); s('f_tiktokPrivacy', 'SELF_ONLY');
  s('fx_channel', { streamer: 'TestStreamer', streamerRelation: 'me', gamePolicyAck: true, platforms: ['youtube', 'tiktok'], clipLen: 12, momentsPerVod: 1, introCommentary: false });
  s('fx_channelv', 1);
  for (const p of ['youtube', 'tiktok', 'instagram']) s('fx_policy_' + p, null);
});
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.recordGate);
await page.evaluate(async () => { await refreshAccounts(true); for (const p of ['youtube', 'tiktok']) { const pol = FX.policy(p); pol.reviewedAt = Date.now(); await FX.savePolicy(pol); } });

async function runToApproval(label) {
  await page.evaluate(async () => { const b = await (await fetch('/__vod.webm')).blob(); FX.addVod(new File([b], 'vod_' + Date.now() + '.webm', { type: 'video/webm', lastModified: Date.now() - 3600e3 })); });
  const id = await page.evaluate(async () => (await FX.newRecord({ who: 'test' })).id);
  const trail = [];
  for (let i = 0; i < 60; i++) {
    const r = await page.evaluate(async (id) => { await FX.step(id); const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status, why: r.humanReason || r.blocked || r.error || '', last: r.history.at(-1)?.detail }; }, id);
    trail.push(`${r.stage}:${r.status}`);
    if (!['queued'].includes(r.status)) { console.log(`[${label}] stopped at ${r.stage} (${r.status}) ${r.why || r.last}`); break; }
  }
  return { id, trail };
}

let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };

// Run 1: clean moment → all departments → approval → gate → upload
const a = await runToApproval('clean');
const ra = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status, reports: Object.fromEntries(Object.entries(r.reports).map(([k, v]) => [k, v.verdict])), decision: r.final?.decision, scan: r.moderation?.ran }; }, a.id);
console.log('reports:', JSON.stringify(ra.reports));
check('clean clip reached Human Approval', ra.stage === 'approval' && ra.status === 'awaiting_approval', `${ra.stage}/${ra.status}`);
check('every inspection department ran', ['audioqc', 'visualqc', 'copyright', 'guidelines', 'monetization', 'finalqc'].every((k) => ra.reports[k]), Object.keys(ra.reports).join(','));
check('safety scan ran in Guidelines QC', ra.scan === true);
const n0 = S.uploads.length;
const pub = await page.evaluate(async (id) => { await FX.approve(id, { note: 'e2e' }); const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status, gate: r.gate, publish: r.publish }; }, a.id);
check('approved clip passed the publish gate', pub.gate?.ok === true, JSON.stringify(pub.gate?.why));
check('approved clip was uploaded once', S.uploads.length === n0 + 1, `uploads=${S.uploads.length - n0}`);
check('upload used private test mode platforms only', JSON.stringify(pub.publish?.platforms) === '["youtube","tiktok"]', JSON.stringify(pub.publish?.platforms));

// Run 2: streamer says a slur → line stops for a person at Guidelines QC; nothing uploads
S.said = 'SLURWORD get out of my car';
const n1 = S.uploads.length;
const b = await runToApproval('flagged');
const rb = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status }; }, b.id);
check('flagged clip stopped at Guidelines QC for a person', rb.stage === 'guidelines' && rb.status === 'needs_human', `${rb.stage}/${rb.status}`);
const sneak = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); r.stage = 'publish'; r.approval = { approved: true, by: 'you', at: Date.now() }; await FX.saveRecord(r); await FX.runStage(r); const x = await FX.db.prod.get(id); return x.history.at(-1)?.detail; }, b.id);
check('forcing it to Publishing is refused by the gate', S.uploads.length === n1, sneak);
check('no page errors', !errors.length, errors.join(' | '));
console.log('OpenAI calls:', JSON.stringify(S.calls));
await browser.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
