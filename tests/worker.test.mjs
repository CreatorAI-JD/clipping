// Background worker: research agents, cross-source evidence, cited AI analyst, Content Director 7-day plan.
// Runs the real worker code with fake HTTP responses (no network). Run: node tests/worker.test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { run } from '../worker/research.mjs';
let failed = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };
const NOW = Date.parse('2026-11-19T12:00:00Z');
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.t}</title><link>${i.u}</link><pubDate>${i.d || 'Wed, 18 Nov 2026 10:00:00 GMT'}</pubDate>${i.src ? `<source>${i.src}</source>` : ''}${i.tr ? `<ht:approx_traffic>${i.tr}</ht:approx_traffic>` : ''}</item>`).join('')}</channel></rss>`;
const calls = []; let aiBody = null;
const fakeFetch = async (url, opts = {}) => {
  calls.push(url);
  const ok = (body, type = 'json') => ({ ok: true, status: 200, json: async () => body, text: async () => (type === 'json' ? JSON.stringify(body) : body) });
  if (url.includes('trends.google.com')) return ok(rss([{ t: 'GTA 6 trailer 3', u: 'https://news.example/gta6-trailer', tr: '500K+' }, { t: 'World Cup final', u: 'https://news.example/wc', tr: '2M+' }]), 'text');
  if (url.includes('news.google.com')) return ok(rss([{ t: 'Rockstar confirms GTA 6 trailer 3 date', u: 'https://ign.example/gta6', src: 'IGN' }, { t: 'GTA 6 trailer 3 breaks records', u: 'https://polygon.example/gta6', src: 'Polygon' }]), 'text');
  if (url.includes('wikimedia.org')) return ok({ items: [{ articles: [{ article: 'Main_Page', views: 9e6 }, { article: 'Grand_Theft_Auto_VI', views: 420000 }, { article: 'Killing_of_someone', views: 300000 }] }] });
  if (url.includes('hn.algolia.com')) return ok({ hits: [{ title: 'Show HN: a compiler', points: 300, objectID: '1' }] });
  if (url.includes('reddit.com')) return { ok: false, status: 403, statusText: 'Blocked', json: async () => ({}) };
  if (url.includes('kick.com')) return ok({ clips: [{ id: 'c1', title: 'insane chase', views: 50000, created_at: '2026-11-19T08:00:00Z', channel: { slug: 'n3on', username: 'N3ON' }, category: { name: 'GTA VI' } }] });
  if (url.includes('api.openai.com')) {
    aiBody = JSON.parse(opts.body);
    const content = { opportunities: [
      { cluster: 'C0', topic: 'GTA 6 trailer 3: what we know', why: 'Rockstar confirmed the date; multiple outlets report it', evidence: ['googleNews:0', 'googleTrends:0'], audience: 'GTA fans', format: 'explainer', hook: 'Trailer 3 has a date', difficulty: 2, risks: ['speculation'] },
      { cluster: 'C1', topic: 'Made up topic', why: 'no evidence', evidence: ['nope:9'], format: 'facts' },
    ] };
    return ok({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 2000, completion_tokens: 500 } });
  }
  return { ok: false, status: 404, statusText: 'Not found', json: async () => ({}) };
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-worker-'));
const env = { OPENAI_API_KEY: 'sk-test', AC_CHANNEL_TYPE: 'faceless', AC_PER_DAY: '2', AC_KEYWORDS: 'GTA 6,Rockstar', AC_NICHE: 'GTA 6 news' };
const out = await run({ fetch: fakeFetch, env, now: NOW, outDir: dir });
const st = out.status, ops = out.research.opportunities;
check('every research agent ran and reported its result', ['googleTrends', 'googleNews', 'wikipedia', 'hackerNews', 'reddit', 'youtube', 'twitch', 'kick'].every((n) => st.sources.some((s) => s.name === n)), JSON.stringify(st.sources.map((s) => s.name + ':' + (s.ok ? s.count ?? s.skipped : s.error))));
check('a blocked source is recorded as an error, not hidden', st.sources.find((s) => s.name === 'reddit')?.ok === false);
check('missing API keys are reported as skipped', /YOUTUBE_API_KEY/.test(st.sources.find((s) => s.name === 'youtube')?.skipped || ''));
const gta = ops.find((o) => /trailer 3/i.test(o.topic));
check('a topic seen in several independent sources becomes an opportunity with high confidence', gta && gta.evidence.independentSources >= 2 && gta.confidence >= 0.6, JSON.stringify(gta?.evidence));
check('each opportunity records topic, why, sources, date, evidence, audience, format, hook, difficulty, risks, confidence', gta && ['topic', 'why', 'sources', 'researched', 'evidence', 'audience', 'format', 'hook', 'difficulty', 'risks', 'confidence'].every((k) => gta[k] !== undefined) && gta.sources.length >= 1);
check('the AI analyst cannot add an opportunity it cannot cite', !ops.some((o) => o.topic === 'Made up topic'));
check('the analyst only saw real evidence lines', /googleNews:0/.test(aiBody.messages[1].content));
check('clip opportunities say clipping needs permission', ops.some((o) => o.kind === 'clip' && /permission/.test(o.risks.join())));
const p = out.plan;
check('Content Director made a 7-day plan within the per-day target', p.days.length === 7 && p.days.every((d) => d.slots.length <= 2) && p.days[0].slots.length >= 1, JSON.stringify(p.days.map((d) => d.slots.length)));
check('plan only uses the channel type (faceless)', p.days.flatMap((d) => d.slots).every((s) => s.kind === 'faceless'));
check('files written for the app', ['research.json', 'plan.json', 'status.json', 'log.json'].every((f) => fs.existsSync(path.join(dir, f))));
check('worker spend tracked', JSON.parse(fs.readFileSync(path.join(dir, 'spend.json'))).usd > 0);
// second run a day later: the stale topic is replaced, nothing repeated within 3 days
const out2 = await run({ fetch: async (u, o) => (u.includes('trends.google') || u.includes('news.google') ? { ok: true, status: 200, text: async () => rss([{ t: 'Rockstar announces GTA Online winter update', u: 'https://x.example/a', src: 'IGN' }, { t: 'GTA Online winter update patch notes', u: 'https://x.example/b', src: 'Polygon' }]) } : fakeFetch(u, o)), env: { ...env, OPENAI_API_KEY: '' }, now: NOW + 864e5, outDir: dir });
check('without an AI key the worker still produces rule-based opportunities', out2.research.analyst.includes('no OPENAI_API_KEY') && out2.research.opportunities.length > 0);
const topics = out2.plan.days.flatMap((d) => d.slots.map((s) => s.topic));
check('outdated plan slots are replaced on the next run', out2.plan.replaced.length >= 1 && !topics.some((t) => /trailer 3/i.test(t)), JSON.stringify(out2.plan.replaced));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
