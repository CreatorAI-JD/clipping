/* AutoClipper — CLIP SCOUT
   Hunts the internet for clips that are blowing up right now, so you know which streamers,
   games and moments are hot before you go clip them yourself.

   Where it looks:
   - Kick: public top clips (overall, per category, per channel). No setup.
   - Twitch: top clips per game/category or channel (uses the Twitch connection from Live Watch).
   - YouTube: most-viewed recent Shorts for your search words (optional YouTube API key).

   Every clip gets a "heat" score: views per hour since it was made, so a 2-hour-old clip with
   40k views ranks above a 6-day-old one with 200k. What you can do with a find:
   - watch the streamer live (adds them to Live Watch),
   - jump to the moment in the Twitch VOD and mark it, so when you drop that VOD into the
     Stream Clipper / Assembly Line the Moment Scout ranks that spot first,
   - save it to your list.
   Clip Scout never downloads or reposts anyone's clip. Only post clips of channels you're
   allowed to clip (your own, a clipping campaign, or written permission). */
'use strict';
(function (FX) {
  const S = FX.scout = { KICK: 'https://kick.com/api', TW: 'https://api.twitch.tv/helix', YT: 'https://www.googleapis.com/youtube/v3', timer: null, busy: false, clock: null };
  const T = () => (S.clock ? S.clock() : Date.now());
  const DEF = {
    games: 'Grand Theft Auto VI, Just Chatting', channels: '', words: 'gta 6 clip, streamer funny moment',
    win: '24h', minViews: 1000, sort: 'heat', kick: true, twitch: true, youtube: true, auto: false, every: 20, alertHeat: 5000, ytKey: '',
  };
  const cfg = () => ({ ...DEF, ...(ls.get('fx_scoutCfg', {}) || {}) });
  const setCfg = (p) => ls.set('fx_scoutCfg', { ...cfg(), ...p });
  const WIN = { '6h': 6, '24h': 24, '7d': 168, '30d': 720 };
  const KICK_TIME = { '6h': 'day', '24h': 'day', '7d': 'week', '30d': 'month' };
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n || 0)));
  const ago = (t) => { const h = (T() - t) / 36e5; return h < 1 ? Math.max(1, Math.round(h * 60)) + 'm ago' : h < 48 ? Math.round(h) + 'h ago' : Math.round(h / 24) + 'd ago'; };
  const hms = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m${s % 60}s`; };
  const slug = (x) => String(x || '').toLowerCase().replace(/^.*(twitch\.tv|kick\.com)\//, '').replace(/[^a-z0-9_-]/g, '');
  // views per hour since posted; the first hour counts as a full hour so brand-new clips don't explode
  const heat = (views, created) => Math.round((views || 0) / Math.max(1, (T() - created) / 36e5));

  S.results = ls.get('fx_scoutResults', []);
  S.saved = ls.get('fx_scoutSaved', []);
  S.marks = ls.get('fx_scoutMarks', []);
  S.seen = new Set(ls.get('fx_scoutSeen', []));
  S.errors = [];
  S.lastRun = ls.get('fx_scoutAt', 0);
  const saveAll = () => {
    ls.set('fx_scoutResults', S.results.slice(0, 200));
    ls.set('fx_scoutSaved', S.saved.slice(0, 200));
    ls.set('fx_scoutMarks', S.marks.slice(0, 300));
    ls.set('fx_scoutSeen', [...S.seen].slice(-2000));
  };

  async function getJSON(url, opts = {}, who) {
    let r;
    try { r = await fetch(url, { credentials: 'omit', ...opts }); } catch (e) { throw new Error(`${who}: couldn't reach it (${e.message})`); }
    if (!r.ok) { let m = ''; try { const j = await r.json(); m = j.message || j.error?.message || ''; } catch {} const e = new Error(`${who} ${r.status}${m ? ': ' + m : ''}`); e.code = r.status; throw e; }
    return r.json();
  }

  /* ---------------- Kick (public, no login) ---------------- */
  let kickCats = null;
  async function kickCategory(name) {
    const n = name.toLowerCase();
    if (!kickCats) {
      kickCats = [];
      for (let p = 1; p <= 2; p++) { const j = await getJSON(`${S.KICK}/v1/subcategories?limit=100&page=${p}`, {}, 'Kick'); kickCats.push(...(j.data || [])); }
    }
    const words = n.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return kickCats.find((c) => c.name.toLowerCase() === n || c.slug === n.replace(/[^a-z0-9]+/g, '-'))
      || kickCats.find((c) => words.length && words.every((w) => c.name.toLowerCase().includes(w))) || null;
  }
  const fromKick = (c) => ({
    src: 'kick', id: 'k_' + c.id, title: c.title || '(untitled)', views: c.views ?? c.view_count ?? 0, created: Date.parse(c.created_at),
    dur: c.duration || 0, channel: c.channel?.username || c.channel?.slug || '', login: c.channel?.slug || '', game: c.category?.name || '',
    thumb: c.thumbnail_url || '', url: `https://kick.com/${c.channel?.slug}/clips/${c.id}`, channelUrl: `https://kick.com/${c.channel?.slug}`,
  });
  async function huntKick(c, out) {
    const t = KICK_TIME[c.win] || 'day', q = `sort=view&time=${t}`;
    const urls = [];
    for (const g of list(c.games)) {
      const cat = await kickCategory(g).catch(() => null);
      if (cat) urls.push(`${S.KICK}/v2/categories/${cat.slug}/clips?${q}`);
    }
    for (const ch of list(c.channels)) urls.push(`${S.KICK}/v2/channels/${slug(ch)}/clips?${q}`);
    if (!urls.length) urls.push(`${S.KICK}/v2/clips?${q}`);
    for (const u of urls) {
      try {
        let j = await getJSON(u, {}, 'Kick'); out.push(...(j.clips || []).map(fromKick));
        if (j.nextCursor) { j = await getJSON(u + '&cursor=' + encodeURIComponent(j.nextCursor), {}, 'Kick'); out.push(...(j.clips || []).map(fromKick)); }
      } catch (e) { if (e.code !== 404) S.errors.push(e.message); }
    }
  }

  /* ---------------- Twitch (needs the Twitch connection) ---------------- */
  const twToken = () => ls.get('fx_twToken', null)?.token || null;
  const twReady = () => !!(twToken() && FX.autoCfg?.().twClient);
  const tw = (path) => getJSON(S.TW + path, { headers: { 'Client-Id': FX.autoCfg().twClient, Authorization: 'Bearer ' + twToken() } }, 'Twitch');
  async function twGame(name) {
    const cache = ls.get('fx_twGames', {}), k = name.toLowerCase();
    if (cache[k]) return cache[k];
    let g = (await tw('/games?name=' + encodeURIComponent(name))).data?.[0];
    if (!g) g = (await tw('/search/categories?first=1&query=' + encodeURIComponent(name))).data?.[0];
    if (g) { cache[k] = { id: g.id, name: g.name }; ls.set('fx_twGames', cache); }
    return g ? cache[k] : null;
  }
  async function twUser(login) {
    const ids = ls.get('fx_twIds', {});
    if (!(login in ids)) { const u = await tw('/users?login=' + encodeURIComponent(login)); ids[login] = u.data?.[0]?.id || null; ls.set('fx_twIds', ids); }
    return ids[login];
  }
  const fromTwitch = (c, gameName) => ({
    src: 'twitch', id: 't_' + c.id, title: c.title || '(untitled)', views: c.view_count || 0, created: Date.parse(c.created_at),
    dur: c.duration || 0, channel: c.broadcaster_name, login: String(c.broadcaster_name || '').toLowerCase(), game: gameName || '',
    _g: gameName ? undefined : c.game_id, thumb: c.thumbnail_url || '', url: c.url, channelUrl: 'https://www.twitch.tv/' + String(c.broadcaster_name || '').toLowerCase(),
    vod: c.video_id && c.vod_offset != null ? { id: c.video_id, offset: c.vod_offset, url: `https://www.twitch.tv/videos/${c.video_id}?t=${hms(c.vod_offset - 5)}` } : null,
  });
  async function huntTwitch(c, out) {
    if (!twReady()) { S.errors.push('Twitch: not connected (Live Watch → Connections → Set up Twitch).'); return; }
    const since = new Date(T() - (WIN[c.win] || 24) * 36e5).toISOString();
    const jobs = [];
    for (const g of list(c.games)) jobs.push(async () => { const gm = await twGame(g); if (!gm) return S.errors.push(`Twitch: no category called "${g}"`); const j = await tw(`/clips?game_id=${gm.id}&first=50&started_at=${since}`); out.push(...(j.data || []).map((x) => fromTwitch(x, gm.name))); });
    for (const ch of list(c.channels)) jobs.push(async () => { const id = await twUser(slug(ch)); if (!id) return; const j = await tw(`/clips?broadcaster_id=${id}&first=30&started_at=${since}`); out.push(...(j.data || []).map((x) => fromTwitch(x))); });
    if (!jobs.length) jobs.push(async () => { const top = (await tw('/games/top?first=3')).data || []; for (const gm of top) { const j = await tw(`/clips?game_id=${gm.id}&first=30&started_at=${since}`); out.push(...(j.data || []).map((x) => fromTwitch(x, gm.name))); } });
    for (const r of await Promise.allSettled(jobs.map((f) => f()))) if (r.status === 'rejected') {
      if (r.reason?.code === 401) { S.errors.push('Twitch sign-in expired. Reconnect it on Live Watch.'); break; }
      S.errors.push(r.reason?.message || 'Twitch error');
    }
    // fill in game names Twitch left out
    const missing = [...new Set(out.filter((x) => x.src === 'twitch' && !x.game && x._g).map((x) => x._g))];
    if (missing.length) try { const j = await tw('/games?' + missing.slice(0, 100).map((i) => 'id=' + i).join('&')); for (const x of out) if (x._g) x.game = j.data?.find((g) => g.id === x._g)?.name || ''; } catch {}
    for (const x of out) delete x._g;
  }

  /* ---------------- YouTube Shorts (optional API key) ---------------- */
  const fromYt = (v) => ({
    src: 'youtube', id: 'y_' + v.id, title: v.snippet?.title || '', views: +(v.statistics?.viewCount || 0), created: Date.parse(v.snippet?.publishedAt),
    dur: 0, channel: v.snippet?.channelTitle || '', login: '', game: '', thumb: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || '',
    url: `https://www.youtube.com/shorts/${v.id}`, channelUrl: `https://www.youtube.com/channel/${v.snippet?.channelId}`,
  });
  async function huntYoutube(c, out) {
    const key = c.ytKey; if (!key) return;
    const words = list(c.words).slice(0, 5); if (!words.length) return;
    const after = new Date(T() - (WIN[c.win] || 24) * 36e5).toISOString();
    const ids = new Set();
    for (const w of words) {
      try {
        const j = await getJSON(`${S.YT}/search?part=id&type=video&videoDuration=short&order=viewCount&maxResults=25&publishedAfter=${after}&q=${encodeURIComponent(w)}&key=${encodeURIComponent(key)}`, {}, 'YouTube');
        (j.items || []).forEach((i) => i.id?.videoId && ids.add(i.id.videoId));
      } catch (e) { S.errors.push(e.code === 403 ? 'YouTube: key refused or daily quota used up.' : e.message); break; }
    }
    const all = [...ids];
    for (let i = 0; i < all.length; i += 50) {
      try { const j = await getJSON(`${S.YT}/videos?part=snippet,statistics&id=${all.slice(i, i + 50).join(',')}&key=${encodeURIComponent(key)}`, {}, 'YouTube'); out.push(...(j.items || []).map(fromYt)); }
      catch (e) { S.errors.push(e.message); }
    }
  }

  /* ---------------- the hunt ---------------- */
  S.hunt = async ({ quiet = false } = {}) => {
    if (S.busy) return S.results;
    S.busy = true; S.errors = []; render();
    const c = cfg(), out = [];
    try {
      const jobs = [];
      if (c.kick) jobs.push(huntKick(c, out));
      if (c.twitch) jobs.push(huntTwitch(c, out));
      if (c.youtube && c.ytKey) jobs.push(huntYoutube(c, out));
      await Promise.allSettled(jobs);
      const maxAge = (WIN[c.win] || 24) * 36e5, byId = new Map();
      for (const x of out) {
        if (!x.created || T() - x.created > maxAge || x.views < (+c.minViews || 0)) continue;
        x.heat = heat(x.views, x.created);
        if (!byId.has(x.id) || byId.get(x.id).views < x.views) byId.set(x.id, x);
      }
      const fresh = [...byId.values()];
      const hot = fresh.filter((x) => !S.seen.has(x.id) && x.heat >= (+c.alertHeat || 5000));
      S.results = fresh.sort((a, b) => b.heat - a.heat).slice(0, 200);
      fresh.forEach((x) => S.seen.add(x.id));
      S.lastRun = T(); ls.set('fx_scoutAt', S.lastRun);
      saveAll();
      if (hot.length && S.hadRun) alertHot(hot);
      S.hadRun = true;
      log(`Clip Scout: ${S.results.length} clips found${S.errors.length ? ' (' + S.errors.length + ' problem' + (S.errors.length > 1 ? 's' : '') + ')' : ''}`);
      if (!quiet) toast(S.results.length ? `Clip Scout found ${S.results.length} clips` : 'Clip Scout found nothing for those settings. Try a longer time window or lower minimum views.');
      FX.audit?.('clip scout: hunt', `${S.results.length} clips`, null, quiet ? 'clip scout' : 'you')?.catch?.(() => {});
    } finally { S.busy = false; render(); }
    return S.results;
  };
  function alertHot(hot) {
    const top = hot.sort((a, b) => b.heat - a.heat)[0];
    const msg = `${hot.length} clip${hot.length > 1 ? 's' : ''} blowing up: ${top.channel} "${top.title.slice(0, 50)}" (${num(top.heat)} views/hour)`;
    toast(msg);
    try { if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('AutoClipper Clip Scout', { body: msg }); } catch {}
    const b = document.querySelector('nav button[data-tab="scout"] .pill'); if (b) { b.hidden = false; b.textContent = hot.length; }
  }
  S.setAuto = (on) => {
    clearInterval(S.timer); S.timer = null;
    if (on) S.timer = setInterval(() => S.hunt({ quiet: true }).catch(() => {}), Math.max(5, +cfg().every || 20) * 60e3);
  };

  // streamers whose clips are hottest right now
  function onFire() {
    const by = new Map();
    for (const x of S.results) {
      const k = x.src + ':' + (x.login || x.channel);
      const o = by.get(k) || { src: x.src, login: x.login, channel: x.channel, url: x.channelUrl, heat: 0, clips: 0, game: x.game };
      o.heat += x.heat; o.clips++; by.set(k, o);
    }
    return [...by.values()].sort((a, b) => b.heat - a.heat).slice(0, 10);
  }

  /* ---------------- VOD markers: a hot Twitch clip marks its moment in the VOD ---------------- */
  const prevMarkers = FX.vodMarkers;
  FX.vodMarkers = (entry, file, dur) => {
    const out = prevMarkers ? prevMarkers(entry, file, dur) : [];
    const mine = S.marks.filter((m) => file.name.includes(m.vodId) && m.offset <= dur);
    for (const m of mine) out.push({ start: Math.max(0, m.offset - 5), views: Math.max(50, Math.round(m.views / 100)), title: 'Hot clip: ' + m.title });
    if (mine.length) log(`${file.name}: ${mine.length} hot clip spot(s) from Clip Scout added`);
    return out;
  };

  /* =====================================================================
     CLIP SCOUT TAB
     ===================================================================== */
  const sec = document.getElementById('scout');
  let view = 'found', playing = null;
  const SRC = { kick: 'Kick', twitch: 'Twitch', youtube: 'YouTube' };
  function player(x) {
    const host = encodeURIComponent(location.hostname || 'localhost');
    if (x.src === 'twitch') return `<iframe src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(x.id.slice(2))}&parent=${host}&autoplay=true" allow="autoplay; fullscreen" allowfullscreen title="${esc(x.title)}"></iframe>`;
    if (x.src === 'youtube') return `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(x.id.slice(2))}?autoplay=1" allow="autoplay; fullscreen; encrypted-media" allowfullscreen title="${esc(x.title)}"></iframe>`;
    return '';
  }
  function card(x) {
    const saved = S.saved.some((s) => s.id === x.id), marked = x.vod && S.marks.some((m) => m.id === x.id);
    const key = liveKey(x), isLive = key && liveList().includes(key);
    const fire = x.heat >= (+cfg().alertHeat || 5000);
    return `<div class="sc-card" data-id="${esc(x.id)}">
      <div class="sc-thumb ${playing === x.id ? 'playing' : ''}">${playing === x.id && player(x) ? player(x)
        : `<button class="sc-play" data-sc="play" data-id="${esc(x.id)}" aria-label="Play ${esc(x.title)}">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="sc-pi">${ico('play')}</span></button>`}
        <span class="sc-src ${x.src}">${SRC[x.src]}</span>${x.dur ? `<span class="sc-dur">${Math.round(x.dur)}s</span>` : ''}</div>
      <div class="sc-body">
        <div class="sc-title" title="${esc(x.title)}">${esc(x.title)}</div>
        <div class="small muted"><a href="${esc(x.channelUrl)}" target="_blank" rel="noopener">${esc(x.channel)}</a>${x.game ? ' · ' + esc(x.game) : ''}</div>
        <div class="sc-stats"><span class="chip ${fire ? 'hype' : ''}" title="views per hour since it was posted">${fire ? '🔥 ' : ''}${num(x.heat)}/h</span><span class="small muted">${num(x.views)} views · ${ago(x.created)}</span></div>
        <div class="sc-acts">
          <a class="btnlike" href="${esc(x.url)}" target="_blank" rel="noopener">${ico('eye')}Open</a>
          ${key ? (isLive ? '<span class="chip on">In Live Watch</span>' : `<button data-sc="watch" data-login="${esc(key)}" title="Add ${esc(x.channel)} to Live Watch">${ico('radio')}Watch live</button>`) : ''}
          ${x.vod ? `<a class="btnlike" href="${esc(x.vod.url)}" target="_blank" rel="noopener" title="The same moment in the full stream">${ico('film')}VOD ${hms(x.vod.offset)}</a>
            <button data-sc="mark" data-id="${esc(x.id)}" ${marked ? 'disabled' : ''} title="When you drop this VOD into the Stream Clipper, this spot is ranked first">${ico('flag')}${marked ? 'Marked' : 'Mark spot'}</button>` : ''}
          <button data-sc="save" data-id="${esc(x.id)}" title="${saved ? 'Remove from saved' : 'Save'}">${ico(saved ? 'check' : 'heart')}${saved ? 'Saved' : 'Save'}</button>
        </div></div></div>`;
  }
  function render() {
    if (!sec) return;
    const c = cfg(), twOk = twReady();
    const fe = document.activeElement, focused = sec.contains(fe) ? fe.id : null, typed = focused && fe.type !== 'checkbox' ? fe.value : null;
    const openSet = sec.querySelector('details[data-k="set"]')?.open;
    const items = view === 'saved' ? S.saved : [...S.results].sort((a, b) => c.sort === 'views' ? b.views - a.views : c.sort === 'new' ? b.created - a.created : b.heat - a.heat);
    const shown = items.filter((x) => !S.filterSrc || x.src === S.filterSrc);
    const fire = onFire();
    sec.innerHTML = `
      <h2>Clip Scout</h2>
      <p class="muted">Searches Kick, Twitch and YouTube for clips that are blowing up right now and ranks them by <b>views per hour</b>, so you see which streamers and moments are hot while there's still time to clip them. It never downloads or reposts anyone's clip; only post clips of channels you're allowed to clip.</p>
      <div class="card">
        <div class="row"><h3>${ico('search')}What to hunt</h3>
          <span class="chip ${c.kick ? 'on' : ''}">Kick${c.kick ? ' ✓' : ' off'}</span>
          <span class="chip ${c.twitch && twOk ? 'on' : ''}">Twitch${!c.twitch ? ' off' : twOk ? ' ✓' : ': connect'}</span>
          <span class="chip ${c.youtube && c.ytKey ? 'on' : ''}">YouTube${!c.youtube ? ' off' : c.ytKey ? ' ✓' : ': add key'}</span></div>
        <div class="grid2">
          <label>Games / categories (comma separated)<input id="scGames" value="${esc(c.games)}" placeholder="Grand Theft Auto VI, Just Chatting"></label>
          <label>Streamers (optional, comma separated)<input id="scChannels" value="${esc(c.channels)}" placeholder="kaicenat, xqc, adinross"></label>
          <label>Time window
            <select id="scWin">${Object.keys(WIN).map((k) => `<option value="${k}" ${c.win === k ? 'selected' : ''}>Last ${k.replace('h', ' hours').replace('d', ' days')}</option>`).join('')}</select></label>
          <label>Minimum views<input type="number" id="scMin" min="0" step="100" value="${esc(c.minViews)}"></label>
        </div>
        <div class="row"><button class="primary" data-sc="hunt" ${S.busy ? 'disabled' : ''}>${ico('search')}${S.busy ? 'Hunting…' : 'Hunt now'}</button>
          <label class="check sc-auto"><input type="checkbox" id="scAuto" ${c.auto ? 'checked' : ''}> Keep hunting every <input type="number" id="scEvery" min="5" max="240" value="${esc(c.every)}" style="width:64px"> min and alert me when a clip passes <input type="number" id="scAlert" min="100" step="500" value="${esc(c.alertHeat)}" style="width:90px"> views/hour</label>
          <span class="muted small">${S.lastRun ? 'Last hunt ' + ago(S.lastRun) : 'Not run yet'}</span></div>
        ${S.errors.length ? `<div class="small bad-text">${S.errors.map(esc).join('<br>')}</div>` : ''}
        <details data-k="set" ${openSet ? 'open' : ''}><summary class="small">Sources</summary>
          <div class="grid3" style="margin-top:10px">
            <label class="check"><input type="checkbox" id="scKick" ${c.kick ? 'checked' : ''}> Kick (no setup)</label>
            <label class="check"><input type="checkbox" id="scTwitch" ${c.twitch ? 'checked' : ''}> Twitch ${twOk ? '' : `<button data-sc="twSetup" class="linkish">connect</button>`}</label>
            <label class="check"><input type="checkbox" id="scYoutube" ${c.youtube ? 'checked' : ''}> YouTube Shorts</label>
          </div>
          <div class="grid2" style="margin-top:10px">
            <label>YouTube search words (comma separated)<input id="scWords" value="${esc(c.words)}" placeholder="gta 6 clip, kai cenat"></label>
            <label>YouTube Data API key (optional)<input type="password" id="scYtKey" value="${esc(c.ytKey)}" placeholder="AIza…" autocomplete="off" spellcheck="false"></label>
          </div>
          <p class="muted small">YouTube key: <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">enable YouTube Data API v3</a> in a Google Cloud project, then Credentials → Create credentials → API key. Free quota covers about 90 searches a day. The key stays in this browser.</p>
        </details>
      </div>
      ${fire.length && view === 'found' ? `<div class="card"><h3>${ico('trending')}Streamers on fire</h3><div class="sc-fire">${fire.map((f) => `<div class="sc-f"><a href="${esc(f.url)}" target="_blank" rel="noopener"><b>${esc(f.channel)}</b></a><span class="small muted">${SRC[f.src]}${f.game ? ' · ' + esc(f.game) : ''} · ${f.clips} clip${f.clips > 1 ? 's' : ''} · ${num(f.heat)}/h</span>${liveKey(f) ? (liveList().includes(liveKey(f)) ? '<span class="chip on">In Live Watch</span>' : `<button data-sc="watch" data-login="${esc(liveKey(f))}">${ico('radio')}Watch live</button>`) : ''}</div>`).join('')}</div></div>` : ''}
      <div class="row sc-tabs">
        <button data-sc="view" data-v="found" class="${view === 'found' ? 'active' : ''}">Found <span class="pill">${S.results.length}</span></button>
        <button data-sc="view" data-v="saved" class="${view === 'saved' ? 'active' : ''}">Saved <span class="pill">${S.saved.length}</span></button>
        <select id="scSrc" aria-label="Only show"><option value="">All sources</option>${Object.entries(SRC).map(([k, v]) => `<option value="${k}" ${S.filterSrc === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select id="scSort" aria-label="Sort by"><option value="heat" ${c.sort === 'heat' ? 'selected' : ''}>Blowing up (views/hour)</option><option value="views" ${c.sort === 'views' ? 'selected' : ''}>Most views</option><option value="new" ${c.sort === 'new' ? 'selected' : ''}>Newest</option></select>
        ${S.marks.length ? `<span class="muted small">${S.marks.length} VOD spot${S.marks.length > 1 ? 's' : ''} marked</span>` : ''}
      </div>
      <div class="sc-grid">${shown.map(card).join('') || emptyBot(view === 'saved' ? 'Nothing saved yet. Press Save on a clip to keep it here.' : S.busy ? 'Hunting…' : 'Press Hunt now to find clips that are blowing up.')}</div>`;
    if (focused) { const el = document.getElementById(focused); if (el && typed != null) el.value = typed; el?.focus(); }
  }
  S.render = render;
  const find = (id) => S.results.find((x) => x.id === id) || S.saved.find((x) => x.id === id);
  const readForm = () => {
    const g = (id) => document.getElementById(id);
    setCfg({
      games: g('scGames')?.value || '', channels: g('scChannels')?.value || '', win: g('scWin')?.value || '24h',
      minViews: Math.max(0, +g('scMin')?.value || 0), auto: !!g('scAuto')?.checked, every: Math.min(240, Math.max(5, +g('scEvery')?.value || 20)),
      alertHeat: Math.max(100, +g('scAlert')?.value || 5000), kick: !!g('scKick')?.checked, twitch: !!g('scTwitch')?.checked, youtube: !!g('scYoutube')?.checked,
      words: g('scWords')?.value || '', ytKey: (g('scYtKey')?.value || '').trim(), sort: g('scSort')?.value || 'heat',
    });
  };
  sec?.addEventListener('change', (e) => {
    if (!e.target.id?.startsWith('sc')) return;
    if (e.target.id === 'scSrc') { S.filterSrc = e.target.value; return render(); }
    readForm();
    if (e.target.id === 'scAuto' || e.target.id === 'scEvery') { S.setAuto(cfg().auto); if (cfg().auto && !S.results.length) S.hunt({ quiet: true }); }
    if (['scSort', 'scKick', 'scTwitch', 'scYoutube', 'scAuto'].includes(e.target.id)) render();
  });
  sec?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sc]'); if (!b) return;
    const act = b.dataset.sc, x = b.dataset.id && find(b.dataset.id);
    if (act === 'hunt') { readForm(); await S.hunt(); }
    else if (act === 'view') { view = b.dataset.v; render(); }
    else if (act === 'play') { playing = x && player(x) ? x.id : null; if (x && !player(x)) window.open(x.url, '_blank', 'noopener'); render(); }
    else if (act === 'save') {
      if (!x) return;
      const i = S.saved.findIndex((s) => s.id === x.id);
      if (i >= 0) S.saved.splice(i, 1); else S.saved.unshift({ ...x, savedAt: T() });
      saveAll(); render();
    }
    else if (act === 'mark') {
      if (!x?.vod) return;
      S.marks.unshift({ id: x.id, vodId: x.vod.id, offset: x.vod.offset, views: x.views, title: x.title.slice(0, 60), channel: x.channel, at: T() });
      saveAll(); render();
      toast(`Marked ${hms(x.vod.offset)} in ${x.channel}'s VOD (v${x.vod.id}). Drop that VOD into the Stream Clipper and this spot is checked first.`);
    }
    else if (act === 'watch') S.watchLive(b.dataset.login);
    else if (act === 'twSetup') { e.preventDefault(); openTab('live'); setTimeout(() => { const d = document.getElementById('lvTwBox'); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); } document.getElementById('lvTwClient')?.focus(); }, 150); }
  });
  // Live Watch channel keys: "name" for Twitch, "kick:name" for Kick
  const clean = (x) => (FX.live?.cleanLogin ? FX.live.cleanLogin(x) : slug(x));
  const liveList = () => String((ls.get('fx_live', {}) || {}).channels || '').split(/[,\n]+/).map(clean).filter(Boolean);
  const liveKey = (x) => (x.src === 'twitch' && x.login ? x.login : x.src === 'kick' && x.login ? 'kick:' + x.login : '');
  // add a streamer to Live Watch (restarts watching if it was on)
  S.watchLive = (login) => {
    login = clean(login); if (!login) return;
    const lv = ls.get('fx_live', {}) || {}, cur = liveList();
    if (cur.includes(login)) { toast(`${login} is already in Live Watch.`); return; }
    if (cur.length >= 8) { toast('Live Watch already has 8 channels. Remove one first.'); return; }
    ls.set('fx_live', { ...lv, channels: [...cur, login].join(', ') });
    if (FX.live?.watching) FX.live.start(); else FX.live?.render?.();
    toast(`Added ${login} to Live Watch${FX.live?.watching ? '' : '. Open Live Watch and press Start watching'}.`);
    render();
  };
  document.querySelector('nav button[data-tab="scout"]')?.addEventListener('click', () => { const b = document.querySelector('nav button[data-tab="scout"] .pill'); if (b) b.hidden = true; render(); });
  render();
  if (cfg().auto) { S.setAuto(true); setTimeout(() => S.hunt({ quiet: true }).catch(() => {}), 4000); }
})(window.FX);
