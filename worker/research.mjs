// AutoClipper background worker: RESEARCH DEPARTMENT + CONTENT DIRECTOR
// Runs on a schedule in GitHub Actions (.github/workflows/autoclipper-worker.yml), not in a browser.
//
// 1. Research agents pull real signals from public sources (and from APIs you give keys for):
//    Google Trends daily RSS, Google News RSS (your niche keywords), Wikipedia most-read, Hacker News,
//    Reddit (your subreddits), YouTube Data API (optional key), Twitch Helix top clips (optional app credentials),
//    Kick public clips.
// 2. Each candidate topic is cross-checked: how many independent sources mention it. Confidence is computed
//    from that evidence, never from the AI's opinion. Nothing without evidence becomes an opportunity.
// 3. With an OpenAI key, an analyst writes why/audience/format/hook/difficulty/risks for each opportunity,
//    and must cite the evidence ids it used; anything it cannot cite is dropped.
// 4. The Content Director turns the strongest opportunities into a 7-day plan, avoids repeating topics,
//    and replaces outdated ideas on every run.
// Output (committed to the autoclipper-data branch, read by the app): data/research.json, data/plan.json, data/status.json
// No video files are downloaded and nothing is published from here.
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set('the a an and or of to in on for with at by from is are was were be been it its this that these those as about into over after before new how why what who when your you we our their his her they them not no yes vs more most than out up off all can will just get got has have had do does did best top day days week year 2024 2025 2026 2027 video videos official live stream full news update'.split(' '));
const kw = (s) => [...new Set(String(s || '').toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (xml, t) => [...xml.matchAll(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'g'))].map((m) => decode(m[1]));
const items = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

export function config(env = process.env) {
  const list = (v, d) => String(v ?? d).split(',').map((x) => x.trim()).filter(Boolean);
  return {
    niche: env.AC_NICHE || 'GTA 6, Grand Theft Auto, GTA Online, streamers',
    keywords: list(env.AC_KEYWORDS, 'GTA 6,GTA VI,Grand Theft Auto,Rockstar Games,GTA Online,Kai Cenat,xQc'),
    subreddits: list(env.AC_SUBREDDITS, 'GTA6,GTA,LivestreamFail'),
    games: list(env.AC_GAMES, 'Grand Theft Auto VI,Grand Theft Auto V,Just Chatting'),
    channelType: env.AC_CHANNEL_TYPE || 'clips', // clips | faceless | both
    perDay: Math.max(1, Math.min(20, +env.AC_PER_DAY || 3)),
    geo: env.AC_GEO || 'US',
    openai: env.OPENAI_API_KEY || '', model: env.AC_MODEL || 'gpt-4o-mini',
    youtube: env.YOUTUBE_API_KEY || '',
    twitchId: env.TWITCH_CLIENT_ID || '', twitchSecret: env.TWITCH_CLIENT_SECRET || '',
    maxUsd: Math.max(0, +env.AC_MAX_USD_PER_DAY || 0.25),
    everyHours: Math.max(1, +env.AC_EVERY_HOURS || 6),
    outDir: env.AC_OUT || 'data',
  };
}

/* ---------------- research agents (one per source) ---------------- */
async function get(fetch, url, opts = {}, kind = 'json') {
  const r = await fetch(url, { headers: { 'User-Agent': 'AutoClipper-research-worker/1.0 (+https://github.com)', ...(opts.headers || {}) }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''}`.trim());
  return kind === 'json' ? r.json() : r.text();
}
const AGENTS = {
  async googleTrends({ fetch, cfg }) {
    const xml = await get(fetch, `https://trends.google.com/trending/rss?geo=${cfg.geo}`, {}, 'text');
    return items(xml).map((x) => ({ title: tag(x, 'title')[0], metric: tag(x, 'ht:approx_traffic')[0] || '', url: tag(x, 'ht:news_item_url')[0] || tag(x, 'link')[0], date: tag(x, 'pubDate')[0], publisher: tag(x, 'ht:news_item_source')[0] || 'Google Trends' })).filter((x) => x.title);
  },
  async googleNews({ fetch, cfg }) {
    const out = [];
    for (const q of cfg.keywords.slice(0, 6)) {
      const xml = await get(fetch, `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:3d&hl=en-US&gl=US&ceid=US:en`, {}, 'text');
      out.push(...items(xml).slice(0, 12).map((x) => ({ title: tag(x, 'title')[0], url: tag(x, 'link')[0], date: tag(x, 'pubDate')[0], publisher: tag(x, 'source')[0] || 'Google News', query: q })));
    }
    return out;
  },
  async wikipedia({ fetch, now }) {
    const d = new Date(now - 864e5), y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
    const j = await get(fetch, `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${dd}`);
    return (j.items?.[0]?.articles || []).filter((a) => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:)/.test(a.article)).slice(0, 40).map((a) => ({ title: a.article.replace(/_/g, ' '), metric: a.views + ' views', views: a.views, url: `https://en.wikipedia.org/wiki/${a.article}`, publisher: 'Wikipedia most-read', date: `${y}-${m}-${dd}` }));
  },
  async hackerNews({ fetch }) {
    const j = await get(fetch, 'https://hn.algolia.com/api/v1/search?tags=front_page');
    return (j.hits || []).map((h) => ({ title: h.title, metric: h.points + ' points', views: h.points, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, publisher: 'Hacker News', date: h.created_at }));
  },
  async reddit({ fetch, cfg }) {
    const out = [];
    for (const sub of cfg.subreddits.slice(0, 5)) {
      const j = await get(fetch, `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=day&limit=15`);
      out.push(...(j.data?.children || []).map((c) => c.data).filter((p) => !p.stickied && !p.over_18).map((p) => ({ title: p.title, metric: p.score + ' upvotes', views: p.score, url: 'https://www.reddit.com' + p.permalink, publisher: 'r/' + sub, date: new Date(p.created_utc * 1000).toISOString() })));
    }
    return out;
  },
  async youtube({ fetch, cfg, now }) {
    if (!cfg.youtube) return { skipped: 'no YOUTUBE_API_KEY' };
    const after = new Date(now - 7 * 864e5).toISOString(), ids = new Set();
    for (const q of cfg.keywords.slice(0, 4)) {
      const j = await get(fetch, `https://www.googleapis.com/youtube/v3/search?part=id&type=video&order=viewCount&maxResults=15&publishedAfter=${after}&q=${encodeURIComponent(q)}&key=${cfg.youtube}`);
      (j.items || []).forEach((i) => i.id?.videoId && ids.add(i.id.videoId));
    }
    if (!ids.size) return [];
    const v = await get(fetch, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${[...ids].slice(0, 50).join(',')}&key=${cfg.youtube}`);
    return (v.items || []).map((x) => ({ title: x.snippet.title, metric: x.statistics.viewCount + ' views', views: +x.statistics.viewCount, url: 'https://www.youtube.com/watch?v=' + x.id, publisher: 'YouTube · ' + x.snippet.channelTitle, date: x.snippet.publishedAt, format: /PT([0-5]?\d)S$|PT1M$/.test(x.contentDetails?.duration || '') ? 'short' : 'long' }));
  },
  async twitch({ fetch, cfg, now }) {
    if (!cfg.twitchId || !cfg.twitchSecret) return { skipped: 'no TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET' };
    const tok = await get(fetch, `https://id.twitch.tv/oauth2/token?client_id=${cfg.twitchId}&client_secret=${cfg.twitchSecret}&grant_type=client_credentials`, { method: 'POST' });
    const h = { headers: { 'Client-Id': cfg.twitchId, Authorization: 'Bearer ' + tok.access_token } };
    const since = new Date(now - 864e5).toISOString(), out = [];
    for (const name of cfg.games.slice(0, 4)) {
      const g = (await get(fetch, `https://api.twitch.tv/helix/games?name=${encodeURIComponent(name)}`, h)).data?.[0];
      if (!g) continue;
      const c = await get(fetch, `https://api.twitch.tv/helix/clips?game_id=${g.id}&first=20&started_at=${since}`, h);
      out.push(...(c.data || []).map((x) => ({ title: x.title, metric: x.view_count + ' clip views', views: x.view_count, url: x.url, publisher: 'Twitch · ' + x.broadcaster_name, creator: x.broadcaster_name, platform: 'twitch', game: g.name, date: x.created_at, clip: true })));
    }
    return out;
  },
  async kick({ fetch }) {
    const j = await get(fetch, 'https://kick.com/api/v2/clips?sort=view&time=day');
    return (j.clips || []).map((c) => ({ title: c.title, metric: (c.views ?? c.view_count) + ' clip views', views: c.views ?? c.view_count, url: `https://kick.com/${c.channel?.slug}/clips/${c.id}`, publisher: 'Kick · ' + (c.channel?.username || ''), creator: c.channel?.username, platform: 'kick', game: c.category?.name, date: c.created_at, clip: true }));
  },
};

/* ---------------- evidence: cross-source checking ---------------- */
export function buildCandidates(results, cfg) {
  const all = [];
  for (const [src, list] of Object.entries(results)) if (Array.isArray(list)) list.forEach((x, i) => x?.title && all.push({ ...x, src, eid: `${src}:${i}`, kw: kw(x.title) }));
  const nicheKw = new Set(cfg.keywords.flatMap(kw).concat(kw(cfg.niche)));
  const sameStory = (a, b) => { const A = new Set(a.kw); const shared = b.kw.filter((w) => A.has(w)); return shared.length >= 2 || (shared.length === 1 && shared[0].length >= 6 && (a.kw.length <= 3 || b.kw.length <= 3)); };
  const cands = [];
  const seeds = all.filter((x) => !x.clip).sort((a, b) => (b.views || 0) - (a.views || 0));
  const used = new Set();
  for (const s of seeds) {
    if (used.has(s.eid)) continue;
    const group = all.filter((x) => !x.clip && !used.has(x.eid) && (x.eid === s.eid || sameStory(s, x)));
    group.forEach((x) => used.add(x.eid));
    const sources = [...new Set(group.map((x) => x.src))];
    const niche = group.some((x) => x.kw.some((w) => nicheKw.has(w)) || x.query);
    cands.push({ seed: s.title, evidence: group.slice(0, 8).map((x) => ({ id: x.eid, source: x.src, title: x.title, url: x.url, publisher: x.publisher, date: x.date, metric: x.metric })), sources, niche, strength: group.reduce((a, x) => a + Math.log10(1 + (x.views || 1)), 0) });
  }
  // clip opportunities: creators whose clips are taking off (needs your permission before clipping them)
  const byCreator = new Map();
  for (const c of all.filter((x) => x.clip && x.creator)) { const k = `${c.platform}:${String(c.creator).toLowerCase()}`; const o = byCreator.get(k) || { creator: c.creator, platform: c.platform, game: c.game, views: 0, clips: [] }; o.views += c.views || 0; o.clips.push(c); byCreator.set(k, o); }
  const creators = [...byCreator.values()].sort((a, b) => b.views - a.views).slice(0, 12);
  return { cands, creators, nicheKw };
}
export function confidence(c) {
  // independent sources are what counts; the volume of one source adds a little
  const n = c.sources.length; const base = n >= 3 ? 0.8 : n === 2 ? 0.6 : 0.35;
  return Math.round(Math.min(0.95, base + Math.min(0.15, c.strength / 60)) * 100) / 100;
}
const RISKY = /\b(death|dies|died|dead|killed|shooting|murder|suicide|war|attack|election|trump|biden|harris|vaccine|lawsuit|arrest|crash|tragedy|abuse|minor|child|porn|nsfw)\b/i;

async function analyst({ fetch, cfg }, cands, creators, spendLeft) {
  if (!cfg.openai) return { ops: null, usd: 0, note: 'no OPENAI_API_KEY: rule-based opportunities only' };
  if (spendLeft <= 0) return { ops: null, usd: 0, note: 'daily worker budget used up: rule-based opportunities only' };
  const top = cands.slice(0, 30);
  const evid = top.map((c, i) => `C${i} [sources: ${c.sources.join(', ')}]\n` + c.evidence.map((e) => `  ${e.id} | ${e.publisher} | ${e.title} | ${e.metric || ''} | ${e.date || ''}`).join('\n')).join('\n');
  const body = {
    model: cfg.model, temperature: 0.2, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: `You are the research analyst for a short-video channel about: ${cfg.niche}. Channel type: ${cfg.channelType}. You only use the evidence given. Never invent facts, statistics, trends or sources. If the evidence does not support a claim, leave it out.` },
      { role: 'user', content: `Evidence clusters:\n${evid}\n\nPick up to 15 clusters that are real content opportunities for this channel (faceless explainers/facts/lists/stories about the topic, or reaction/clip angles). For each return JSON {"opportunities":[{"cluster":"C<n>","topic": short topic,"why": why it is interesting now (from the evidence),"evidence": [evidence ids you used, at least one],"audience": who,"format": educational|facts|story|history|technology|sports|explainer|list|reaction,"hook": a hook line that makes no claim beyond the evidence,"difficulty": 1-5,"risks": [content risks: tragedy, politics, rights, speculation, etc.]}]}` }],
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.openai }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('OpenAI ' + r.status);
  const j = await r.json();
  const usd = ((j.usage?.prompt_tokens || 0) * 0.15 + (j.usage?.completion_tokens || 0) * 0.6) / 1e6;
  let out = {}; try { out = JSON.parse(j.choices?.[0]?.message?.content || '{}'); } catch {}
  const ops = [];
  for (const o of out.opportunities || []) {
    const c = top[+String(o.cluster).replace(/\D/g, '')]; if (!c) continue;
    const ids = (o.evidence || []).filter((id) => c.evidence.some((e) => e.id === id));
    if (!ids.length) continue; // uncited = dropped
    ops.push({ c, topic: String(o.topic || c.seed).slice(0, 120), why: String(o.why || '').slice(0, 400), audience: o.audience || '', format: o.format || 'explainer', hook: String(o.hook || '').slice(0, 120), difficulty: Math.max(1, Math.min(5, +o.difficulty || 3)), risks: (o.risks || []).slice(0, 5), cited: ids });
  }
  return { ops, usd, note: `AI analyst (${cfg.model}) wrote ${ops.length} opportunities with citations` };
}

/* ---------------- content director: 7-day plan ---------------- */
export function plan(ops, prevPlan, cfg, now) {
  const day = (k) => new Date(now + k * 864e5).toISOString().slice(0, 10);
  const recent = new Set((prevPlan?.days || []).flatMap((d) => d.slots.map((s) => s.key)));
  const kept = [];
  // keep earlier plans' slots for today onwards if their opportunity still has fresh evidence
  const live = new Map(ops.map((o) => [o.key, o]));
  const days = [];
  const taken = new Set();
  for (let k = 0; k < 7; k++) {
    const d = day(k), slots = [];
    const prev = (prevPlan?.days || []).find((x) => x.date === d);
    for (const s of prev?.slots || []) if (live.has(s.key) && !taken.has(s.key) && slots.length < cfg.perDay) { slots.push({ ...s, status: 'kept' }); taken.add(s.key); kept.push(s.key); }
    days.push({ date: d, slots });
  }
  const pool = ops.filter((o) => !taken.has(o.key) && o.confidence >= 0.35).sort((a, b) => b.score - a.score);
  const sim = (a, b) => { const A = new Set(kw(a)); const B = kw(b); const i = B.filter((w) => A.has(w)).length; return i / Math.max(1, Math.min(A.size, B.length)); };
  for (const o of pool) {
    for (const d of days) {
      if (d.slots.length >= cfg.perDay) continue;
      // no near-identical topics within 3 days of each other
      const near = days.filter((x) => Math.abs(days.indexOf(x) - days.indexOf(d)) <= 3).flatMap((x) => x.slots);
      if (near.some((s) => sim(s.topic, o.topic) >= 0.6)) continue;
      d.slots.push({ key: o.key, topic: o.topic, kind: o.kind, format: o.format, hook: o.hook, confidence: o.confidence, score: o.score, why: o.why, status: recent.has(o.key) ? 'kept' : 'new' });
      break;
    }
  }
  return { at: new Date(now).toISOString(), days, replaced: (prevPlan?.days || []).flatMap((d) => d.slots).filter((s) => !live.has(s.key)).map((s) => ({ topic: s.topic, reason: 'evidence went stale or a stronger opportunity replaced it' })), kept: kept.length };
}

/* ---------------- run ---------------- */
export async function run({ fetch = globalThis.fetch, env = process.env, now = Date.now(), outDir } = {}) {
  const cfg = config(env); const dir = outDir || cfg.outDir;
  fs.mkdirSync(dir, { recursive: true });
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 1));
  const spend = read('spend.json', {}); const today = new Date(now).toISOString().slice(0, 10); if (spend.day !== today) { spend.day = today; spend.usd = 0; }
  const status = { at: new Date(now).toISOString(), ok: true, next: new Date(now + cfg.everyHours * 3600e3).toISOString(), sources: [], errors: [], usd: 0 };
  const results = {};
  for (const [name, fn] of Object.entries(AGENTS)) {
    const t0 = Date.now();
    try {
      const r = await fn({ fetch, cfg, now });
      if (r && !Array.isArray(r) && r.skipped) { status.sources.push({ name, ok: true, skipped: r.skipped, count: 0 }); continue; }
      results[name] = r; status.sources.push({ name, ok: true, count: r.length, ms: Date.now() - t0 });
    } catch (e) { status.sources.push({ name, ok: false, error: String(e.message).slice(0, 200) }); }
  }
  const ok = status.sources.filter((s) => s.ok && s.count).length;
  if (!ok) { status.ok = false; status.errors.push('No research source returned data'); }
  const { cands, creators } = buildCandidates(results, cfg);
  cands.sort((a, b) => (b.niche - a.niche) || (b.sources.length - a.sources.length) || (b.strength - a.strength));
  let ai = { ops: null, usd: 0, note: '' };
  try { ai = await analyst({ fetch, cfg }, cands, creators, cfg.maxUsd - spend.usd); } catch (e) { status.errors.push('Analyst: ' + e.message); ai.note = 'AI analyst failed: rule-based opportunities only'; }
  spend.usd = Math.round((spend.usd + ai.usd) * 1e5) / 1e5; status.usd = ai.usd;
  const key = (t) => kw(t).slice(0, 5).sort().join('-');
  const mk = (c, extra) => {
    const conf = confidence(c), risks = [...new Set([...(extra?.risks || []), ...(RISKY.test(c.seed + ' ' + (extra?.topic || '')) ? ['sensitive topic: check before covering'] : [])])];
    const o = {
      key: key(extra?.topic || c.seed), kind: 'faceless', topic: extra?.topic || c.seed, why: extra?.why || `Trending on ${c.sources.join(', ')} (${c.evidence[0].metric || 'recent'})`,
      sources: c.evidence.filter((e) => !extra || extra.cited.includes(e.id) || c.evidence.indexOf(e) < 3).map(({ id, ...e }) => e), researched: new Date(now).toISOString(),
      evidence: { independentSources: c.sources.length, sources: c.sources, items: c.evidence.length }, audience: extra?.audience || '', format: extra?.format || (c.sources.includes('wikipedia') ? 'facts' : 'explainer'),
      hook: extra?.hook || '', difficulty: extra?.difficulty || (c.sources.length >= 2 ? 2 : 3), risks, confidence: conf, niche: c.niche,
      method: extra ? 'cross-source evidence + AI analyst (cited)' : 'cross-source evidence (rule-based)',
    };
    o.score = Math.round((o.confidence * 60 + (o.niche ? 30 : 0) + (6 - o.difficulty) * 2 - (o.risks.length ? 10 : 0)) * 10) / 10;
    return o;
  };
  let ops = ai.ops ? ai.ops.map((x) => mk(x.c, x)) : cands.filter((c) => c.niche || c.sources.length >= 2).slice(0, 25).map((c) => mk(c));
  // faceless and clip opportunities are both recorded; the plan follows your channel type
  ops.push(...creators.map((cr) => ({
    key: 'creator-' + cr.platform + '-' + String(cr.creator).toLowerCase(), kind: 'clip', topic: `${cr.creator} (${cr.platform}${cr.game ? ', ' + cr.game : ''})`, why: `${cr.clips.length} clip(s) with ${cr.views.toLocaleString('en-US')} views in the last day`,
    sources: cr.clips.slice(0, 3).map((c) => ({ source: c.src, title: c.title, url: c.url, publisher: c.publisher, date: c.date, metric: c.metric })), researched: new Date(now).toISOString(),
    evidence: { independentSources: 1, sources: [cr.platform], items: cr.clips.length }, audience: `${cr.game || 'stream'} viewers`, format: 'clip', hook: '', difficulty: 2,
    risks: ['clipping rights: only clip this creator with permission (your own channel, a clipping campaign, or written permission)'], confidence: confidence({ sources: [cr.platform], strength: Math.log10(1 + cr.views) * 3 }), niche: true, creator: cr.creator, platform: cr.platform, method: 'platform clip data',
    score: 0,
  })));
  ops.forEach((o) => { if (o.kind === 'clip') o.score = Math.round((o.confidence * 50 + 20) * 10) / 10; });
  const dedup = new Map(); for (const o of ops) if (!dedup.has(o.key) || dedup.get(o.key).score < o.score) dedup.set(o.key, o);
  ops = [...dedup.values()].sort((a, b) => b.score - a.score);
  const research = { at: status.at, niche: cfg.niche, channelType: cfg.channelType, analyst: ai.note, investigated: cands.length + creators.length, opportunities: ops };
  const prevPlan = read('plan.json', null);
  const forPlan = ops.filter((o) => cfg.channelType === 'both' || o.kind === (cfg.channelType === 'clips' ? 'clip' : 'faceless'));
  const p = plan(forPlan, prevPlan, cfg, now);
  const log = read('log.json', []); log.unshift({ at: status.at, ok: status.ok, investigated: research.investigated, opportunities: ops.length, planned: p.days.reduce((a, d) => a + d.slots.length, 0), usd: ai.usd, errors: status.errors.length });
  status.summary = `${research.investigated} topics investigated, ${ops.length} opportunities, ${p.days.reduce((a, d) => a + d.slots.length, 0)} planned`;
  write('research.json', research); write('plan.json', p); write('status.json', status); write('spend.json', spend); write('log.json', log.slice(0, 120));
  return { research, plan: p, status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(({ status }) => { console.log(status.summary); for (const s of status.sources) console.log(`${s.ok ? 'ok ' : 'ERR'} ${s.name}: ${s.skipped || s.error || s.count + ' items'}`); if (!status.ok) process.exitCode = 1; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
