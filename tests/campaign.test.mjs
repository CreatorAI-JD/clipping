// Campaign tests: TJR clipping campaign preset, required #TJR tag + disclaimer, finance hype checks, no-AI and no-logo rules.
// Run from the repo root:  node tests/campaign.test.mjs
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

// 0. picking the TJR campaign sets the clipper up for it
{
  const r = await page.evaluate(async () => {
    await FX.setCampaign('tjr');
    return { cp: FX.campaign()?.id, tags: val('hashtags'), clipTag: val('clipTag'), ch: FX.channel(), hooks: FX.hooks.cfg().apply, ui: document.getElementById('campaignBox').textContent };
  });
  check('TJR campaign is active', r.cp === 'tjr');
  check('hashtags field has #TJR', /#TJR/.test(r.tags), r.tags);
  check('name tag cleared', r.clipTag === '');
  check('Assembly Line: AI intros, AI images, stock and music off', r.ch.introCommentary === false && r.ch.useAiImages === false && r.ch.music === false && r.ch.useStock === false);
  check('Assembly Line: streamer TJR with campaign permission', r.ch.streamer === 'TJR' && r.ch.streamerRelation === 'permission');
  check('split-screen filler off', r.hooks === 'off');
  check('campaign card shows rules', /30 minutes/.test(r.ui) && /No AI-generated/.test(r.ui));
  check('brand tag is not drawn', await page.evaluate(() => { let drew = false; const g = { save() { drew = true; }, restore() {}, fillText() { drew = true; }, measureText: () => ({ width: 10 }), canvas: { width: 1080, height: 1920 } }; try { FX.hooks.drawTag(g, 'Nuggiez Clips', 'blur'); } catch { drew = true; } return !drew; }));
}
// 1. a clean TJR clip: #TJR and the disclaimer get added, it passes (warnings only) and posts
{
  const id = await mkClip({ title: 'TJR on why he stopped revenge trading', caption: 'This changed his whole trading game 📈 #trading', transcript: 'the day I stopped revenge trading was the day my account started growing again' });
  const n = uploadsNow();
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); await putClip(c); c.gateAck = { at: Date.now(), gateAt: g.at }; await putClip(c); let err = ''; try { await postClip(c); } catch (e) { err = e.message; } return { v: g.verdict, cap: c.caption, err, items: g.items.filter((i) => i.sev !== 'low').map((i) => i.sev + ':' + i.issue) }; }, id);
  check('caption got #TJR', /(^|\s)#TJR\b/.test(r.cap), r.cap);
  check('caption got the disclaimer', /Not financial advice/.test(r.cap));
  check('clean TJR clip is not blocked', ['PASS', 'WARNING'].includes(r.v), r.v + ' ' + r.items.join(' | '));
  check('clean TJR clip posts', uploadsNow() === n + 1, r.err);
}
// 2. our caption promises profits → BLOCK until edited
{
  const id = await mkClip({ title: 'Guaranteed profits with this setup', caption: 'Risk-free strategy, you literally can\'t lose 🤑 #TJR', transcript: 'this is the setup I use every morning' });
  const n = uploadsNow();
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); await putClip(c); c.gateAck = { at: Date.now(), gateAt: g.at }; await putClip(c); let err = ''; try { await postClip(c); } catch (e) { err = e.message; } return { v: g.verdict, s: g.summary, err, why: g.items.filter((i) => i.sev === 'block').map((i) => i.issue) }; }, id);
  check('profit promise in caption → BLOCK', r.v === 'BLOCK', r.why.join(' | '));
  check('block says to edit the caption', /Edit it/.test(r.s), r.s);
  check('blocked clip is not uploaded, even after OK', uploadsNow() === n && /Publish gate/.test(r.err), r.err);
}
// 3. editing the caption clears it
{
  const r = await page.evaluate(async () => {
    const all = await allClips(); const c = all.find((x) => /Guaranteed profits/.test(x.title));
    c.title = 'His morning setup, explained'; c.caption = 'The setup he checks every morning 📈'; c.gate = null; await putClip(c);
    const g = await FX.gateClip(c); return { v: g.verdict, cap: c.caption };
  });
  check('after rewriting, it is no longer blocked', r.v !== 'BLOCK', r.v);
  check('rewritten caption still gets #TJR + disclaimer', /#TJR/.test(r.cap) && /Not financial advice/.test(r.cap), r.cap);
}
// 4. TJR himself says something hype → needs a person, not a block
{
  const id = await mkClip({ caption: 'He went off 😂', transcript: 'bro this is guaranteed money, you cannot lose on this one' });
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); return { v: g.verdict, why: g.items.filter((i) => i.where.startsWith('Finance')).map((i) => i.sev + ':' + i.issue) }; }, id);
  check('creator hype in speech → HUMAN_REVIEW', r.v === 'HUMAN_REVIEW', r.why.join(' | '));
  check('finance checker caught it', r.why.some((w) => w.startsWith('high:The creator')), r.why.join(' | '));
}
// 5. buy/sell call in our hook → high
{
  const id = await mkClip({ title: 'Buy this now before it moons', caption: 'This stock will 10x 🚀' });
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); return { v: g.verdict }; }, id);
  check('buy/sell call + 10x hype in our text → HUMAN_REVIEW', r.v === 'HUMAN_REVIEW', r.v);
}
// 6. non-English caption → high
{
  const id = await mkClip({ caption: 'トレードの神 #TJR' });
  const r = await page.evaluate(async (id) => { const c = await getClip(id); const g = await FX.gateClip(c); return g.items.some((i) => /non-English/.test(i.issue)); }, id);
  check('Japanese caption is flagged', r);
}
// 7. finance checker unit cases
{
  const r = await page.evaluate(() => ({
    a: FX.financeHits('guaranteed 20% returns every month').map((h) => h.kind),
    b: FX.financeHits('100% win rate strategy').map((h) => h.kind),
    c: FX.financeHits('he lost 5k on this trade and learned a lesson').length,
    d: FX.financeHits('risk management is the whole game').length,
    e: FX.campaignCaption('hi #tjr', FX.campaign()),
  }));
  check('"guaranteed returns" is a promise', r.a.includes('promise'), JSON.stringify(r.a));
  check('"100% win rate" is a promise', r.b.includes('promise'), JSON.stringify(r.b));
  check('normal trading talk is not flagged', r.c === 0 && r.d === 0);
  check('existing #tjr is not doubled', (r.e.match(/#tjr/ig) || []).length === 1, r.e);
}
// 8. clearing the campaign restores the old settings
{
  const r = await page.evaluate(async () => { await FX.setCampaign(''); return { cp: FX.campaign(), tags: val('hashtags'), ch: FX.channel().streamer }; });
  check('campaign cleared', r.cp === null);
  check('hashtags restored', !/#TJR/.test(r.tags), r.tags);
  check('channel restored', r.ch === 'TestStreamer', r.ch);
}

await browser.close(); server.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
