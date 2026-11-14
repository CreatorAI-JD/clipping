// Publish-gate tests: every upload path must pass the guideline / rights / safety checks.
// Run from the repo root:  node tests/publish-gate.test.mjs
// Uses Playwright + Chromium and fake OpenAI / Upload-Post / Twitch servers (no real keys, nothing is posted).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // global install works too
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const state = { uploads: [], modDown: false, modCalls: 0 };
const results = []; let failed = 0;
const check = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => results.push('PAGE ERROR ' + e.message));
page.on('dialog', (d) => d.accept()); // confirm() in the Review Queue = "I watched it"

// ---- fake services ----
await page.route('https://api.openai.com/**', async (route) => {
  const url = route.request().url(), body = route.request().postData() || '';
  if (url.endsWith('/moderations')) {
    state.modCalls++;
    if (state.modDown) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'billing hard limit' } }) });
    const j = JSON.parse(body), inputs = Array.isArray(j.input) ? j.input : [j.input];
    const one = (x) => {
      const t = typeof x === 'string' ? x : '';
      const cats = { hate: /SLURWORD/.test(t), 'sexual/minors': /MINORTEST/.test(t), 'violence/graphic': /GOREWORD/.test(t), violence: /shoot/i.test(t) };
      return { flagged: Object.values(cats).some(Boolean), categories: cats, category_scores: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v ? 0.93 : 0.01])) };
    };
    const isImage = inputs.some((x) => typeof x === 'object');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: isImage ? [one('')] : inputs.map(one) }) });
  }
  if (url.endsWith('/chat/completions')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
  return route.fulfill({ contentType: 'application/json', body: '{}' });
});
await page.route('https://api.upload-post.com/**', async (route) => {
  const req = route.request(), url = req.url();
  if (url.includes('/uploadposts/users')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, plan: 'basic', profiles: [{ username: 'autoclipper', social_accounts: { tiktok: { display_name: 'nuggiez_clips' }, youtube: { display_name: 'Nuggiez Clips' }, instagram: { display_name: 'nuggiezclips' } } }] }) });
  if (url.endsWith('/upload')) {
    const raw = (req.postDataBuffer() || Buffer.alloc(0)).toString('latin1');
    const field = (n) => [...raw.matchAll(new RegExp(`name="${n.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)`, 'g'))].map((m) => m[1]);
    state.uploads.push({ idem: req.headers()['idempotency-key'], platforms: field('platform[]'), privacyStatus: field('privacyStatus')[0], privacy_level: field('privacy_level')[0], ai: field('is_ai_generated')[0], external: field('external_id')[0], category: field('categoryId')[0] });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, request_id: 'req_' + state.uploads.length }) });
  }
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
});
await page.route('https://api.twitch.tv/**', (r) => {
  const u = r.request().url(); state.twitchAuth = r.request().headers()['client-id'] && r.request().headers().authorization;
  const data = u.includes('/users') ? [{ id: '42', login: 'teststreamer' }]
    : u.includes('/videos') ? [{ id: 'v1', title: 'GTA RP day 3', created_at: new Date(Date.now() - 5 * 3600e3).toISOString(), duration: '3h2m10s', url: 'https://twitch.tv/videos/v1' }]
    : u.includes('/clips') ? [{ video_id: 'v1', vod_offset: 3600, view_count: 250, title: 'LMAO the pier', duration: 30 }] : [];
  return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
});
await page.route('https://id.twitch.tv/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ client_id: 'x', login: 'test' }) }));

await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  const s = (k, v) => localStorage.setItem('ac_' + k, JSON.stringify(v));
  s('f_apiKey', 'sk-test'); s('f_upKey', 'up-test'); s('pt_tiktok', true); s('pt_youtube', true); s('pt_instagram', true);
  s('fx_channel', { streamer: 'TestStreamer', streamerRelation: 'me', platforms: ['youtube', 'tiktok', 'instagram'] }); s('fx_channelv', 1);
});
await page.goto(BASE);
await page.waitForFunction(() => window.FX && FX.gateClip && FX.moderate);
await page.evaluate(async () => { await refreshAccounts(true); });

// helper inside the page: a legacy clip with a real (tiny) video blob
const mkClip = (o) => page.evaluate(async (o) => {
  const blob = await (await fetch('tests/fixture.webm')).blob();
  const clip = { id: 't' + Math.random().toString(36).slice(2), kind: 'clip', title: 'Insane getaway', caption: 'He did NOT see that coming 😳 #gtarp', transcript: 'ok go go go we are getting away from the cops', blob, score: 8, status: 'pending', created: Date.now(), ...o };
  await putClip(clip); return clip.id;
}, o);
const uploadsNow = () => state.uploads.length;

// 1. a clean clip from your own stream passes and posts, with an idempotency key
{
  const id = await mkClip({});
  const n = uploadsNow();
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); await putClip(c); try { await postClip(c); } catch {} return { v: g.verdict, items: g.items.map((i) => i.sev + ':' + i.where + ':' + i.issue) }; }, id);
  check('clean own-stream clip passes the gate', r.v === 'PASS', JSON.stringify(r.items));
  check('clean clip was uploaded', uploadsNow() === n + 1);
  check('upload carries an Idempotency-Key', !!state.uploads.at(-1)?.idem, state.uploads.at(-1)?.idem);
  check('normal mode posts YouTube as public', state.uploads.at(-1)?.privacyStatus === 'public');
}
// 2. hate speech in the stream audio: needs review, Autopilot will not auto-post, direct post refused
{
  const id = await mkClip({ transcript: 'you are a SLURWORD lol' });
  const n = uploadsNow();
  const r = await page.evaluate(async (id) => {
    document.getElementById('apOn').checked = true; document.getElementById('apAutoApprove').checked = true; document.getElementById('apAutoPost').checked = false;
    const c = await getClip(id); await onNewVideo(c); const after = await getClip(id);
    let err = ''; try { await postClip(after); } catch (e) { err = e.message; }
    return { v: after.gate.verdict, status: after.status, err };
  }, id);
  check('hate speech → HUMAN_REVIEW', r.v === 'HUMAN_REVIEW');
  check('Autopilot left it pending', r.status === 'pending', r.status);
  check('postClip refused it', /Publish gate/.test(r.err), r.err);
  check('nothing uploaded', uploadsNow() === n);
}
// 3. sexual/minors: blocked forever, even after a human "OK"
{
  const id = await mkClip({ transcript: 'MINORTEST' });
  const n = uploadsNow();
  const r = await page.evaluate(async (id) => { const c = await getClip(id); await FX.gateClip(c); c.gateAck = { at: Date.now(), gateAt: c.gate.at }; let err = ''; try { await postClip(c); } catch (e) { err = e.message; } return { v: c.gate.verdict, err, ok: await confirmGate(c) }; }, id);
  check('sexual/minors → BLOCK', r.v === 'BLOCK');
  check('blocked even with a human OK', /Publish gate/.test(r.err) && r.ok === false, r.err);
  check('nothing uploaded', uploadsNow() === n);
}
// 4. safety scan can't run (OpenAI down / no credit) → must not auto-post
{
  state.modDown = true;
  const id = await mkClip({});
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); return { v: g.verdict, why: g.items.filter((i) => i.sev === 'high').map((i) => i.issue) }; }, id);
  state.modDown = false;
  check('moderation down → HUMAN_REVIEW', r.v === 'HUMAN_REVIEW', r.why.join(' | '));
}
// 5. a human reviews warnings in the queue, then it can post
{
  const id = await mkClip({ transcript: 'you are a SLURWORD lol' });
  const n = uploadsNow();
  await page.evaluate(async (id) => { const c = await getClip(id); await FX.gateClip(c); await putClip(c); const ok = await confirmGate(c); if (ok) await postClip(await getClip(id)); }, id);
  check('after the human confirms, the reviewed clip posts', uploadsNow() === n + 1);
}
// 6. low-level upload functions refuse anything that skipped the gate
{
  const r = await page.evaluate(async () => {
    const blob = new Blob(['x'], { type: 'video/webm' }); const out = [];
    try { await upUpload({ id: 'sneaky', blob, caption: 'x', title: 'x' }, ['tiktok']); out.push('upUpload sent'); } catch (e) { out.push(e.message); }
    try { await ytUpload({ id: 'sneaky', blob, caption: 'x', title: 'x' }); out.push('ytUpload sent'); } catch (e) { out.push(e.message); }
    return out;
  });
  check('upUpload refuses ungated video', /Publish gate/.test(r[0]), r[0]);
  check('ytUpload refuses ungated video', /Publish gate/.test(r[1]), r[1]);
}
// 7. private test mode: TikTok "Only me" → YouTube private, Instagram skipped
{
  const id = await mkClip({});
  await page.evaluate(async (id) => { document.getElementById('tiktokPrivacy').value = 'SELF_ONLY'; const c = await getClip(id); await FX.gateClip(c); await postClip(c); document.getElementById('tiktokPrivacy').value = 'PUBLIC_TO_EVERYONE'; }, id);
  const u = state.uploads.at(-1);
  check('test mode: YouTube private', u.privacyStatus === 'private', u.privacyStatus);
  check('test mode: TikTok SELF_ONLY', u.privacy_level === 'SELF_ONLY');
  check('test mode: Instagram skipped', !u.platforms.includes('instagram') && u.platforms.includes('tiktok'), u.platforms.join(','));
}
// 8. streams of someone else with no permission / not set
{
  const r = await page.evaluate(async () => {
    const out = {};
    for (const rel of ['', 'none', 'permission']) {
      localStorage.setItem('ac_fx_channel', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_channel')), streamerRelation: rel }));
      const blob = await (await fetch('tests/fixture.webm')).blob();
      const g = await FX.gateClip({ id: 'r' + rel, kind: 'clip', title: 't', caption: 'c', transcript: 'nice one', blob });
      out[rel || 'unset'] = g.verdict;
    }
    localStorage.setItem('ac_fx_channel', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_channel')), streamerRelation: 'me' }));
    return out;
  });
  check('rights not set → HUMAN_REVIEW', r.unset === 'HUMAN_REVIEW');
  check('no permission → HUMAN_REVIEW', r.none === 'HUMAN_REVIEW');
  check('permission, no commentary → WARNING (reused-content risk)', r.permission === 'WARNING');
}
// 9. keyword rules match whole words only
{
  const r = await page.evaluate(() => [FX.ruleHits('he is dead already', ['tiktok']).length, FX.ruleHits('use code nuggiez for 10% off', ['tiktok']).length, FX.ruleHits('graphics are insane', ['tiktok']).length]);
  check('"dead already" no longer trips the "ad" rule', r[0] === 0, String(r[0]));
  check('gambling promo code is caught', r[1] > 0);
  check('"graphics" no longer trips "graphic content"', r[2] === 0);
}
// 10. saved (old) policy checklists get the new 2026 rules merged in and must be re-reviewed
{
  const r = await page.evaluate(() => {
    localStorage.setItem('ac_fx_policy_youtube', JSON.stringify({ platform: 'youtube', name: 'YouTube Shorts', links: [], rules: [{ id: 'yt-hate', text: 'x', severity: 'block', keywords: [] }], version: 3, reviewedAt: Date.now() }));
    const p = FX.policy('youtube'); return { ids: p.rules.map((x) => x.id), reviewed: p.reviewedAt };
  });
  check('old checklist gets yt-reused / yt-contentid / yt-inauthentic', ['yt-reused', 'yt-contentid', 'yt-inauthentic'].every((x) => r.ids.includes(x)));
  check('…and is marked for re-review', r.reviewed === null);
}
// 11. assembly line: Guidelines QC runs the safety scan; serious flags stop the line; sexual/minors rejects
const mkRec = (o) => page.evaluate(async (o) => {
  const r = await FX.newRecord({ idea: { id: 'idea_' + Math.random(), topic: 'Getaway', type: 'moment', transcript: o.said, originality: { score: 7 } } });
  r.type = 'clips';
  r.script = { title: 'Insane getaway', hookStyle: 'cold open', format: 'stream clip', scenes: [{ n: 1, vo: o.said, onScreen: 'He did not see that coming', footage: { kind: 'stream' }, streamAudio: true, claims: [] }], duration: o.len || 35 };
  r.clip = { vodKey: o.vod || 'vod1', start: o.start ?? 100, len: o.len || 35, outLen: o.len || 35, intro: o.intro || '' };
  r.edit = { duration: o.len || 35 }; r.reports.edit = { verdict: 'PASS', at: Date.now() - 5000 };
  r.reports.visualqc = { verdict: 'PASS', data: { frames: {} } };
  await FX.saveRecord(r); return r.id;
}, o);
{
  const out = {};
  for (const [k, said] of [['clean', 'we got away from the cops lets go'], ['hate', 'SLURWORD'], ['minor', 'MINORTEST']]) {
    const id = await mkRec({ said });
    out[k] = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); const rep = await FX.RUN.guidelines(r, () => {}, {}); return { v: rep.verdict, ran: r.moderation?.ran, method: rep.method }; }, id);
  }
  check('Guidelines QC ran the safety scan', out.clean.ran === true, out.clean.method);
  check('clean clip is not stopped by Guidelines QC', ['PASS', 'WARNING'].includes(out.clean.v), out.clean.v);
  check('hate speech → Guidelines HUMAN_REVIEW', out.hate.v === 'HUMAN_REVIEW', out.hate.v);
  check('sexual/minors → REJECTED', out.minor.v === 'REJECTED', out.minor.v);
}
// 12. monetization QC for clips (current YouTube / TikTok / Instagram rules)
{
  const id1 = await mkRec({ said: 'lets go', len: 75, vod: 'vodM' });
  const r1 = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); r.reports.copyright = { verdict: 'HUMAN_REVIEW', items: [{ sev: 'high', where: 'Music', issue: 'music' }] }; const rep = await FX.RUN.monetization(r, () => {}, {}); await FX.saveRecord(r); return { level: rep.data.level, items: rep.items.map((i) => i.where) }; }, id1);
  check('75s Short with music → YouTube Shorts length flagged', r1.items.includes('YouTube Shorts length'), r1.items.join(','));
  const id2 = await mkRec({ said: 'lets go again', len: 30, vod: 'vodM', start: 105 });
  const r2 = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); const rep = await FX.RUN.monetization(r, () => {}, {}); return { level: rep.data.level, items: rep.items.map((i) => i.where) }; }, id2);
  check('same VOD moment twice → Duplicate flagged', r2.items.includes('Duplicate'), r2.items.join(','));
  check('30s clip → TikTok Creator Rewards note', r2.items.includes('TikTok Creator Rewards'));
  const r3 = await page.evaluate(async () => { localStorage.setItem('ac_fx_channel', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_channel')), streamerRelation: '' })); return true; });
  const id3 = await mkRec({ said: 'brand new moment', vod: 'vodZ' });
  const r4 = await page.evaluate(async (id) => { const r = await FX.db.prod.get(id); const rep = await FX.RUN.monetization(r, () => {}, {}); localStorage.setItem('ac_fx_channel', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_channel')), streamerRelation: 'me' })); return rep.verdict; }, id3);
  check('rights not set → monetization HUMAN_REVIEW', r4 === 'HUMAN_REVIEW', r4);
}
// 13. assembly line publish gate: unresolved review / stale reports / no approval never upload
{
  const n = uploadsNow();
  const id = await mkRec({ said: 'clean', vod: 'vodP' });
  const res = await page.evaluate(async (id) => {
    const out = {}, r = await FX.db.prod.get(id), t = Date.now();
    r.reports.copyright = { verdict: 'WARNING', at: t }; r.reports.monetization = { verdict: 'PASS', at: t }; r.reports.finalqc = { verdict: 'PASS', at: t };
    r.reports.guidelines = { verdict: 'HUMAN_REVIEW', at: t, summary: 'flagged' };
    r.final = { decision: 'APPROVED' }; r.approval = { approved: true, by: 'you', at: t }; r.export = { fileId: 'nope' };
    r.publishPrep = { platforms: { tiktok: { title: 'Insane getaway', description: 'gg #gtarp' }, youtube: { title: 'Insane getaway', description: 'gg', youtubeCategoryId: '20' } } };
    r.stage = 'publish';
    out.unresolved = await FX.RUN.publish(r, () => {}, {});
    r.reports.guidelines.verdict = 'PASS'; r.approval = { approved: true, by: 'you', at: t };
    r.reports.edit.at = Date.now() + 1000; // re-edited after inspection
    out.stale = await FX.RUN.publish(r, () => {}, {});
    r.reports.edit.at = t - 5000; r.approval = null;
    out.noApproval = await FX.RUN.publish(r, () => {}, {});
    r.approval = { approved: true, by: 'you', at: t };
    r.publishPrep.platforms.tiktok.description = 'SLURWORD clip'; // metadata edited after Guidelines QC
    out.badMeta = await FX.RUN.publish(r, () => {}, {});
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { v: v.verdict, s: v.summary, to: v.sendBackTo }]));
  }, id);
  check('unresolved Guidelines review blocks upload', res.unresolved.v === 'FAIL' && res.unresolved.to === 'guidelines', JSON.stringify(res.unresolved));
  check('video re-edited after inspection blocks upload', res.stale.v === 'FAIL' && /re-edited/.test(res.stale.s), res.stale.s);
  check('no approval blocks upload', res.noApproval.v === 'FAIL', res.noApproval.s);
  check('flagged final caption blocks upload', res.badMeta.v === 'FAIL' && /flagged/.test(res.badMeta.s), res.badMeta.s);
  check('nothing uploaded by blocked records', uploadsNow() === n);
}
// 14. Twitch watcher: finds new VODs and the clips viewers made (fake Helix API)
{
  const r = await page.evaluate(async () => {
    localStorage.setItem('ac_fx_auto', JSON.stringify({ ...JSON.parse(localStorage.getItem('ac_fx_auto') || '{}'), twitch: true, twClient: 'cid', twLogins: 'https://twitch.tv/TestStreamer' }));
    localStorage.setItem('ac_fx_twToken', JSON.stringify({ token: 'tok', at: Date.now() }));
    localStorage.setItem('ac_fx_twSince', JSON.stringify(Date.now() - 864e5));
    await FX.auto.twPoll({ force: true });
    const v = FX.auto.twVods().v1; return v ? { title: v.title, dur: v.durSec, clips: v.clips.length, offset: v.clips[0]?.offset } : null;
  });
  check('Twitch watcher found the new VOD', r?.title === 'GTA RP day 3' && r.dur === 10930, JSON.stringify(r));
  check('Twitch watcher read the viewer clips as hype markers', r?.clips === 1 && r.offset === 3600);
  check('Twitch calls send Client-Id + Bearer token', !!state.twitchAuth);
}

if (process.env.SHOT) { // optional screenshot of the Review Queue with the gate results
  await page.setViewportSize({ width: 1200, height: 1100 });
  await page.evaluate(async () => { for (const c of await allClips()) if (c.status !== 'pending') { c.status = 'pending'; await putClip(c); } document.querySelector('[data-tab=queue]').click(); await renderQueue(); });
  await page.waitForTimeout(800); await page.screenshot({ path: process.env.SHOT, fullPage: false });
}
console.log(results.join('\n'));
console.log(`\n${results.filter((x) => x.startsWith('PASS')).length} passed, ${failed} failed (moderation calls: ${state.modCalls}, uploads: ${state.uploads.length})`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
