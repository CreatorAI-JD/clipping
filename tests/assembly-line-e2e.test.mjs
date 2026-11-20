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
  if (key === 'audio/transcriptions' && (route.request().postDataBuffer() || Buffer.alloc(0)).toString('latin1').includes('export-check')) {
    // the inspection listens to the finished video: the "true" speech times are the captions shifted by S.syncShift (fixed per video)
    const truth = await page.evaluate(async (shift) => {
      const r = (await FX.db.prod.all()).find((x) => x.stage === 'finalqc' && x.status === 'working'); if (!r) return [];
      window.__truth ||= {}; if (!window.__truth[r.id]) { const w = []; for (const q of r.captions.cues) { const ws = q.text.split(/\s+/), d = (q.end - q.start) / ws.length; ws.forEach((x, i) => w.push({ word: x, start: q.start + shift + i * d, end: q.start + shift + (i + 1) * d })); } window.__truth[r.id] = w; }
      return window.__truth[r.id];
    }, S.syncShift || 0);
    S.exportChecks = (S.exportChecks || 0) + 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: truth.map((w) => w.word).join(' '), words: truth }) });
  }
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
// AutoClipper 2.0: stage ledger, agents and activity feed come from the real run
const led = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); const st = await FX.agentStatus(); return { stages: Object.fromEntries(Object.entries(r.ledger || {}).map(([k, L]) => [k, { status: L.status, agent: L.agent, start: !!L.firstStart, end: !!L.lastEnd, score: L.score, runs: L.runs.length }])), agents: Object.keys(st).length, feed: FX.feed().length, feedAgents: [...new Set(FX.feed().map((e) => e.agent))] }; }, a.id);
check('every stage has a ledger entry with agent, start, end and score', ['trends', 'factcheck', 'script', 'captions', 'edit', 'audioqc', 'visualqc', 'finalqc', 'prep'].every((k) => led.stages[k]?.agent && led.stages[k].start && led.stages[k].end && typeof led.stages[k].score === 'number'), JSON.stringify(led.stages));
check('20 agents report a status', led.agents === 20);
const ins = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); return { n: r.inspection?.board?.length, st: r.inspection?.board?.map((b) => b.n + ':' + b.status), heard: !!r.inspection?.heard, viral: r.viral?.score, tickets: r.inspection?.tickets?.map((t) => t.n + ' ' + t.severity + ' ' + t.problem) }; }, a.id);
check('10 independent checkers inspected the rendered video', ins.n === 10 && ins.heard && S.exportChecks >= 1, JSON.stringify(ins.st));
check('captions match and are in sync with the final audio', ['1:pass', '2:pass'].every((x) => ins.st.includes(x)) || ins.st.some((x) => /^[12]:warn/.test(x)), JSON.stringify(ins.tickets));
check('viral potential estimate recorded', typeof ins.viral === 'number');
check('activity feed logged real assignments and results', led.feed > 20 && ['manager', 'intel', 'captions', 'visual', 'qa'].every((a) => led.feedAgents.includes(a)), JSON.stringify(led.feedAgents));
const n0 = S.uploads.length;
const pub = await page.evaluate(async (id) => { await FX.approve(id, { note: 'e2e' }); const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status, gate: r.gate, publish: r.publish }; }, a.id);
check('approved clip passed the publish gate', pub.gate?.ok === true, JSON.stringify(pub.gate?.why));
check('approved clip was uploaded once', S.uploads.length === n0 + 1, `uploads=${S.uploads.length - n0}`);
check('upload used private test mode platforms only', JSON.stringify(pub.publish?.platforms) === '["youtube","tiktok"]', JSON.stringify(pub.publish?.platforms));

// Run 3 (2.0): captions are 1.2 s out of sync in the render -> Caption Specialist re-times them -> re-render -> passes
S.syncShift = 1.2; S.said = 'wait wait he jumped the bridge with the bike and landed on a boat no way';
const c3 = await runToApproval('out-of-sync');
const r3 = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); return { stage: r.stage, status: r.status, revs: r.revisions.map((x) => x.from + '>' + x.to), rounds: r.inspection?.round, res: (r.inspection?.resolved || []).map((t) => t.checker), method: r.captions?.method, led: r.ledger?.finalqc?.runs?.map((x) => x.status) }; }, c3.id);
check('out-of-sync captions were caught by the inspection and sent to the Caption Specialist', r3.revs.includes('finalqc>captions'), JSON.stringify(r3));
check('captions were re-timed to the final audio, re-rendered, and passed on the next round', r3.stage === 'approval' && r3.rounds >= 2 && /re-timed/.test(r3.method) && r3.res.includes('Caption synchronization'), JSON.stringify(r3));
S.syncShift = 0;

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
