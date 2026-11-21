/* AutoClipper 3.0 — CLOUD CONTROL PANEL
   The website is the control panel; the work runs on your AutoClipper cloud server (server/ in this repo).
   This page connects to it with your server address + admin token (kept in this browser only), shows what the
   cloud is doing, manages creators and their clipping permission, and is where you review finished clips:
   live caption editing on the preview, facecam adjustment, AI revision requests, approve / reject. */
'use strict';
(function () {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cfg = () => { try { return JSON.parse(localStorage.getItem('ac_cloud') || '{}'); } catch { return {}; } };
  const setCfg = (p) => { try { localStorage.setItem('ac_cloud', JSON.stringify({ ...cfg(), ...p })); } catch {} };
  const ago = (t) => { if (!t) return 'never'; const s = Date.now() / 1000 - t; return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const fmtS = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
  const tsS = (s) => (s == null ? '–' : s.toFixed(2));

  const C = window.ACCloud = {
    url: () => (cfg().url || '').replace(/\/+$/, ''),
    async api(path, opts = {}) {
      const base = C.url(); if (!base) throw new Error('Not connected: add your server address on the Cloud page');
      const headers = { Authorization: 'Bearer ' + (cfg().token || ''), ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
      const r = await fetch(base + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
      let j = null; try { j = await r.json(); } catch {}
      if (!r.ok) throw new Error((j && (j.error || j.message)) || `Server ${r.status}`);
      return j;
    },
    media: (rel) => (rel ? C.url() + rel : ''),
  };
  const page = document.querySelector('section#cloud');
  const S = { status: null, creators: [], clips: [], events: [], research: null, skills: [], report: null, tab: 'overview', err: '' };

  /* ---------------- data ---------------- */
  async function load(parts = ['status', 'clips', 'events']) {
    if (!C.url()) return;
    try {
      const want = new Set(parts);
      const jobs = [];
      if (want.has('status')) jobs.push(C.api('/api/status').then((x) => (S.status = x)));
      if (want.has('clips')) jobs.push(C.api('/api/clips').then((x) => (S.clips = x)));
      if (want.has('events')) jobs.push(C.api('/api/events').then((x) => (S.events = x)));
      if (want.has('creators')) jobs.push(C.api('/api/creators').then((x) => (S.creators = x)));
      if (want.has('research')) jobs.push(C.api('/api/research').then((x) => (S.research = x)));
      if (want.has('skills')) jobs.push(C.api('/api/skills').then((x) => (S.skills = x)));
      if (want.has('report')) jobs.push(C.api('/api/report').then((x) => (S.report = x)));
      if (want.has('notes')) jobs.push(C.api('/api/notifications').then((x) => (S.notes = x)));
      await Promise.all(jobs);
      S.err = '';
    } catch (e) { S.err = e.message; }
  }

  /* ---------------- Cloud page ---------------- */
  const TABS = [['overview', 'Overview'], ['review', 'Review'], ['creators', 'Creators'], ['sources', 'Add source'], ['research', 'Research'], ['skills', 'Skills'], ['settings', 'Settings']];
  function connectCard() {
    const c = cfg();
    return `<div class="card"><h3>${ico('link')}Connect to your cloud server</h3>
      <p class="muted small">Production runs on your AutoClipper server (see CLOUD.md), not in this browser. The address and admin token are stored only in this browser.</p>
      <div class="grid2"><label>Server address<input id="clUrl" value="${esc(c.url || '')}" placeholder="https://autoclipper-yourname.fly.dev"></label>
        <label>Admin token<input id="clTok" type="password" value="${esc(c.token || '')}" placeholder="the AC_ADMIN_TOKEN you set on the server" autocomplete="off"></label></div>
      <div class="row"><button class="primary" data-cl="connect">${ico('link')}Connect</button><span class="small ${S.err ? 'bad-text' : 'muted'}">${esc(S.err || (S.status ? 'Connected · server v' + S.status.version : 'Not connected'))}</span></div></div>`;
  }
  function overview() {
    const s = S.status; if (!s) return '';
    const alive = s.workers.filter((w) => w.alive);
    const b = s.budget, cl = s.clips || {};
    const kv = (l, v) => `<div class="op-kv"><span>${esc(l)}</span><b>${v}</b></div>`;
    const ev = S.events.slice(0, 40);
    return `<div class="op-stats">${[['Workers running', alive.length], ['Live streams watched', s.sessions.length], ['Creators with permission', s.creators.ok || 0], ['In review', cl.review || 0], ['Needs you (exceptions)', cl.exception || 0], ['Producing', (cl.producing || 0) + (cl.revising || 0)], ['Approved', cl.approved || 0], ['Published', cl.published || 0]].map(([l, v]) => `<div class="op-stat ${/exception/.test(l) && v ? 'bad' : ''}"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      <div class="grid2"><div class="card"><h3>${ico('bolt')}Cloud status</h3>
        ${kv('Workers', alive.length ? alive.map((w) => `${esc(w.worker)} · ${ago(w.last_seen)}`).join('<br>') : '<span class="bad-text">No worker running</span>')}
        ${kv('Watching live', s.sessions.length ? s.sessions.map((x) => esc(x.name || x.login) + ' (' + esc(x.platform) + ')').join(', ') : 'nobody live right now')}
        ${kv('Jobs', Object.entries(s.jobs).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none')}
        ${kv('Next live check', s.next.check_live ? ago(s.next.check_live).replace(' ago', '') : '–')}
        ${kv('Integrations', Object.entries(s.integrations).filter(([k, v]) => typeof v === 'boolean').map(([k, v]) => `${v ? '✓' : '✕'} ${k}`).join(' · '))}
        <p class="muted small">This keeps running when this page, your browser or your computer is off.</p>
        <div class="row"><button data-cl="makeFaceless">${ico('film')}Make a faceless reel now</button><button data-cl="job" data-kind="discover">Discover creators now</button></div></div>
        <div class="card"><h3>${ico('coins')}Budget</h3>${kv('Today', `$${b.today.toFixed(2)} of $${b.daily.toFixed(2)}`)}<div class="bar"><i style="width:${Math.min(100, (b.today / (b.daily || 1)) * 100)}%"></i></div>
          ${kv('This month', `$${b.month.toFixed(2)} of $${b.monthly.toFixed(2)}`)}<div class="bar"><i style="width:${Math.min(100, (b.month / (b.monthly || 1)) * 100)}%"></i></div>
          ${b.paused ? '<p class="bad-text small">Budget reached: paid work is paused.</p>' : '<p class="muted small">Paid steps pause by themselves at the cap.</p>'}</div></div>
      <div class="card"><h3>${ico('message')}Cloud activity</h3><div class="ac-log">${ev.map((e) => `<div class="ac-ev ${esc(e.kind)}"><time>${new Date(e.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><b>${esc(FX?.agent?.(e.agent)?.name || e.agent)}</b><span>${esc(e.text)}</span></div>`).join('') || '<p class="muted small">No activity yet.</p>'}</div></div>`;
  }
  function clipCard(c) {
    const s = c.scores || {}, q = c.qc || {};
    const chip = (l, v) => `<span class="rv-score ${v == null ? 'c-unv' : v >= 80 ? 'c-ok' : v >= 60 ? 'c-warn' : 'c-bad'}"><b>${v == null ? '–' : Math.round(v)}</b>${l}</span>`;
    return `<button class="cl-clip ${esc(c.status)}" data-cl="open" data-id="${esc(c.id)}">${c.media.thumb ? `<img src="${esc(C.media(c.media.thumb))}" alt="" loading="lazy">` : '<div class="cl-noimg"></div>'}
      <div class="cl-body"><div class="nc-top"><b>${esc(c.id)}</b><span class="sb s-${esc(c.status)}">${esc(c.status)}</span></div><div class="nc-t">${esc(c.title)}</div>
      <div class="small muted">${esc(c.creator?.name || 'upload')} · ${esc(c.source?.kind || '')} ${fmtS(c.start)}–${fmtS(c.end)} · ${(c.end - c.start).toFixed(0)}s</div>
      <div class="rv-scores">${chip('Quality', q.overall)}${chip('Hook', s.hook_qc)}${chip('Captions', s.caption_qc)}${chip('Facecam', s.facecam_qc)}</div></div></button>`;
  }
  function review() {
    const list = S.clips.filter((c) => ['review', 'exception'].includes(c.status));
    const other = S.clips.filter((c) => !['review', 'exception'].includes(c.status)).slice(0, 12);
    return `<div class="card"><h3>${ico('inbox')}Finished clips waiting for you <span class="muted small">${list.length}</span></h3><div class="cl-grid">${list.map(clipCard).join('') || '<p class="muted small">Nothing to review right now.</p>'}</div></div>
      ${other.length ? `<div class="card"><h3>Recent</h3><div class="cl-grid">${other.map(clipCard).join('')}</div></div>` : ''}`;
  }
  function creators() {
    const rows = S.creators;
    return `<div class="card"><div class="row"><h3>${ico('radio')}Creators</h3><span class="muted small">Discovered automatically; only creators with permission are watched or clipped.</span><button data-cl="job" data-kind="discover" class="small-btn">Discover now</button></div>
      <div class="cl-camp"><h4>${ico('check')}Add a clipping campaign you joined</h4>
        <p class="muted small">Paste the campaign page (Content Rewards, Whop, Discord…) and its streamers. They all get permission "granted" with the campaign page as proof and are watched 24/7.</p>
        <div class="row"><input id="clCampUrl" placeholder="https://contentrewards.com/campaigns/…"><input id="clCampName" placeholder="campaign name (optional)"></div>
        <textarea id="clCampList" rows="3" placeholder="streamers, one per line or comma separated: name, kick:name, or channel links"></textarea>
        <div class="row"><button class="primary" data-cl="addCampaign">${ico('check')}Grant + watch</button><span id="clCampMsg" class="small muted"></span></div></div>
      <div class="row"><select id="clNewPlat"><option>twitch</option><option>kick</option><option>youtube</option><option value="custom">custom (stream URL)</option></select><input id="clNewLogin" placeholder="channel name / id"><input id="clNewCat" placeholder="category (gaming, irl, podcast…)"><button data-cl="addCreator">${ico('check')}Add</button></div>
      <div class="cl-table"><div class="cl-tr h"><span>Creator</span><span>Platform</span><span>Category</span><span>Audience</span><span>Live</span><span>Score</span><span>Permission</span><span>Watch</span></div>
      ${rows.map((c) => `<div class="cl-tr" data-cid="${c.id}"><span><a href="${esc(c.url || '#')}" target="_blank" rel="noopener">${esc(c.name || c.login)}</a></span><span>${esc(c.platform)}</span><span>${esc(c.category || '')}</span><span>${c.viewers ? c.viewers.toLocaleString() + ' viewers' : ''}${c.metrics?.clip_views_7d ? `<br><small>${c.metrics.clip_views_7d.toLocaleString()} clip views/7d</small>` : ''}</span>
        <span>${c.live ? '<span class="chip on">LIVE</span>' : c.last_live_at ? '<small>' + ago(c.last_live_at) + '</small>' : ''}</span><span>${(c.score || 0).toFixed(1)}</span>
        <span><select data-perm="${c.id}">${['none', 'requested', 'granted', 'own', 'denied'].map((p) => `<option ${c.permission === p ? 'selected' : ''}>${p}</option>`).join('')}</select><input data-proof="${c.id}" value="${esc(c.permission_proof || '')}" placeholder="proof link"></span>
        <span><label class="check"><input type="checkbox" data-mon="${c.id}" ${c.monitor ? 'checked' : ''} ${['granted', 'own'].includes(c.permission) ? '' : 'disabled title="Needs permission first"'}> watch</label>${c.platform === 'custom' || c.source_url ? `<input data-src="${c.id}" value="${esc(c.source_url || '')}" placeholder="stream URL (HLS/RTMP)">` : ''}</span></div>`).join('') || '<p class="muted small">No creators yet. Press Discover now (needs Twitch/YouTube keys on the server) or add one.</p>'}</div></div>`;
  }
  function sources() {
    const ok = S.creators.filter((c) => ['granted', 'own'].includes(c.permission));
    return `<div class="card"><h3>${ico('upload')}Send a video to the cloud</h3>
      <p class="muted small">A VOD or recording. The cloud analyses the whole video, finds and ranks moments, produces clips, checks them and puts them in Review.</p>
      <label>Video file<input type="file" id="clFile" accept="video/*"></label>
      <label>Creator<select id="clSrcCreator"><option value="">(none: my own upload)</option>${ok.map((c) => `<option value="${c.id}">${esc(c.name || c.login)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="clAttest"> I own this video or have permission to clip and post it</label>
      <div class="row"><button class="primary" data-cl="upload">${ico('upload')}Upload</button><span id="clUpMsg" class="small muted"></span></div></div>
      <div class="card"><h3>${ico('film')}Gameplay backgrounds for faceless reels</h3>
        <p class="muted small">Upload your own gameplay recordings (for example driving around Vice City). Faceless reels play on top of a random stretch of them: the webcam is found and blurred, the picture is cropped to vertical gameplay only, and the game sound is removed. Without any, reels use an animated background.</p>
        <label>Video file(s)<input type="file" id="clBgFile" accept="video/*" multiple></label>
        <label class="check"><input type="checkbox" id="clBgAttest"> I recorded this myself (or am allowed to use it)</label>
        <div class="row"><button class="primary" data-cl="bgUpload">${ico('upload')}Upload backgrounds</button><span id="clBgMsg" class="small muted"></span></div>
        <div id="clBgList">${(S.backgrounds || []).map((x) => `<div class="small">#${x.id} · ${Math.round(x.duration || 0)}s · ${esc(x.meta?.filename || '')} · ${x.status === 'ready' ? (x.meta?.cam ? 'webcam blurred, ' : '') + 'ready' : 'checking…'}${x.meta?.has_person ? ' · <b>a person is visible: check it</b>' : ''} <button class="small-btn" data-cl="bgDel" data-id="${x.id}">Remove</button></div>`).join('') || '<p class="muted small">No backgrounds yet.</p>'}</div></div>
      <div class="card"><h3>Import from a link</h3><p class="muted small">A direct video or HLS link for a creator with permission.</p><input id="clImpUrl" placeholder="https://…/video.mp4 or .m3u8"><select id="clImpCreator">${ok.map((c) => `<option value="${c.id}">${esc(c.name || c.login)}</option>`).join('')}</select><button data-cl="import">Import</button></div>`;
  }
  function research() {
    const r = S.research; if (!r) return '<p class="muted">Loading…</p>';
    return `<div class="grid2"><div class="card"><h3>${ico('bulb')}Editing techniques</h3>${r.techniques.map((t) => `<div class="pl-slot"><b>${esc(t.name)}</b><span class="small">${esc(t.description)}</span><span class="small muted">${esc(t.why)} · ${esc(t.category)} · confidence ${Math.round((t.confidence || 0) * 100)}% · ${esc(t.evidence?.source || '')}</span></div>`).join('')}</div>
      <div class="card"><h3>${ico('chart')}Benchmarks (measured)</h3>${r.benchmarks.length ? `<div class="cl-table">${r.benchmarks.map((b) => `<div class="cl-tr"><span>${esc(b.metric)}</span><span>${esc(b.category)}</span><span>${b.value}</span><span><small>n=${b.n} · ${esc(b.source)}</small></span></div>`).join('')}</div>` : '<p class="muted small">Benchmarks appear after the research worker reads public clip data (needs Twitch keys) or after you add reference videos.</p>'}
        <h4>Reference videos</h4><p class="muted small">Upload successful clips you are allowed to analyse; the cloud measures length, layout, cut rate and loudness and compares our clips against them.</p>
        <input type="file" id="clRefFile" accept="video/*"><input id="clRefCat" placeholder="category" value="gaming"><button data-cl="ref">Analyse reference</button>
        ${r.references.map((x) => `<div class="small">${esc(x.title)}: ${x.metrics.duration?.toFixed?.(0)}s · ${esc(x.metrics.layout)} · ${x.metrics.cuts_per_10s} cuts/10s · ${x.metrics.lufs?.toFixed?.(1)} LUFS</div>`).join('')}</div></div>
      <div class="card"><h3>Top public clips studied</h3><div class="cl-table">${r.clips.slice(0, 20).map((x) => `<div class="cl-tr"><span>${esc(x.title)}</span><span>${esc(x.platform)}</span><span>${(x.metrics.views || 0).toLocaleString()} views</span><span>${x.metrics.duration ? x.metrics.duration + 's' : ''}</span></div>`).join('') || '<p class="muted small">None yet.</p>'}</div></div>`;
  }
  function skills() {
    return `<div class="card"><div class="row"><h3>${ico('wrench')}Skill registry</h3><span class="muted small">Versioned components. Discovery reads metadata only; nothing is installed without review and testing.</span><button data-cl="job" data-kind="skills_discover" class="small-btn">Check for new skills</button></div>
      <div class="cl-table"><div class="cl-tr h"><span>Component</span><span>Skill</span><span>Version</span><span>Status</span><span>Licence</span><span>Notes</span></div>${S.skills.map((k) => `<div class="cl-tr"><span>${esc(k.component)}</span><span>${k.source_url ? `<a href="${esc(k.source_url)}" target="_blank" rel="noopener">${esc(k.name)}</a>` : esc(k.name)}</span><span>${esc(k.version)}</span><span>${esc(k.status)}${k.status === 'approved' ? ` <button data-cl="activate" data-id="${k.id}" class="small-btn">Activate</button>` : ''}</span><span>${esc(k.license || '')}</span><span><small>${esc(k.decision || k.notes || '')}</small></span></div>`).join('')}</div></div>`;
  }
  function settings() {
    return `<div class="card"><h3>${ico('sliders')}Cloud settings</h3><p class="muted small">Saved on the server.</p><div id="clSettings">Loading…</div></div>`;
  }
  async function render() {
    if (!page || !page.classList.contains('active')) return;
    page.innerHTML = `<h2>Cloud studio</h2><p class="muted">Your AI clipping company in the cloud: it finds creators, watches permitted streams, produces and checks clips around the clock. You review and approve.</p>
      ${connectCard()}${C.url() && S.status ? `<div class="row sc-tabs">${TABS.map(([k, l]) => `<button data-cl="tab" data-t="${k}" class="${S.tab === k ? 'active' : ''}">${l}${k === 'review' ? ` <span class="pill">${S.clips.filter((c) => ['review', 'exception'].includes(c.status)).length}</span>` : ''}</button>`).join('')}</div>
      <div id="clBody">${({ overview, review, creators, sources, research, skills, settings })[S.tab]()}</div>` : ''}`;
    if (S.tab === 'settings' && S.status) paintSettings();
  }
  async function paintSettings() {
    const s = await C.api('/api/settings');
    const p = s.production || {}, l = s.live || {}, pub = s.publishing || {}, b = s.budget || {}, d = s.discovery || {}, f = s.faceless || {};
    $('#clSettings').innerHTML = `<div class="grid3">
      <label>Max clip length (s)<input type="number" id="cs_clip_len" value="${p.clip_len ?? 40}"></label><label>Min clip length (s)<input type="number" id="cs_min_len" value="${p.min_len ?? 12}"></label>
      <label>Clips per source<input type="number" id="cs_clips_per_source" value="${p.clips_per_source ?? 3}"></label><label>Quality threshold (rank 1–10)<input type="number" step="0.1" id="cs_threshold" value="${p.threshold ?? 5.5}"></label>
      <label class="check"><input type="checkbox" id="cs_deep" ${p.deep ? 'checked' : ''}> Deep analysis (whole-video transcript)</label>
      <label>Live: audio burst ×<input type="number" step="0.1" id="cs_burst" value="${l.burst ?? 2.2}"></label><label>Live: chat spike ×<input type="number" step="0.1" id="cs_chat" value="${l.chat ?? 3}"></label><label>Live: seconds between moments<input type="number" id="cs_cooldown" value="${l.cooldown ?? 90}"></label>
      <label>Daily budget ($)<input type="number" step="0.5" id="cs_daily" value="${b.daily ?? S.status.budget.daily}"></label><label>Monthly budget ($)<input type="number" step="1" id="cs_monthly" value="${b.monthly ?? S.status.budget.monthly}"></label>
      <label>Discovery categories (comma)<input id="cs_games" value="${esc((d.games || ['Grand Theft Auto V', 'Just Chatting']).join(', '))}"></label>
      <label class="check"><input type="checkbox" id="cs_fl_on" ${f.enabled ? 'checked' : ''}> Make faceless reels automatically (AI script + voice, no one else's footage)</label>
      <label>Faceless reels per day<input type="number" id="cs_fl_per" value="${f.per_day ?? 3}"></label><label>Faceless niche<input id="cs_fl_niche" value="${esc(f.niche || '')}"></label>
      <label>Voice<select id="cs_fl_voice">${['onyx', 'alloy', 'echo', 'fable', 'nova', 'shimmer'].map((x) => `<option ${f.voice === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="cs_pub" ${pub.enabled ? 'checked' : ''}> Publish clips after I approve them (Upload-Post key on the server)</label>
      <label>Platforms (comma)<input id="cs_plats" value="${esc((pub.platforms || ['tiktok', 'youtube', 'instagram']).join(', '))}"></label></div>
      <div class="row"><button class="primary" data-cl="saveSettings">Save</button></div>`;
  }
  page?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cl]'); if (!b) return;
    const a = b.dataset.cl;
    try {
      if (a === 'connect') { setCfg({ url: $('#clUrl').value.trim(), token: $('#clTok').value.trim() }); await load(['status', 'clips', 'events', 'creators']); }
      else if (a === 'tab') { S.tab = b.dataset.t; if (S.tab === 'sources') S.backgrounds = await C.api('/api/backgrounds').catch(() => []); await load({ creators: ['creators'], research: ['research'], skills: ['skills'], sources: ['creators'], review: ['clips'], overview: ['status', 'events'], settings: [] }[S.tab] || []); }
      else if (a === 'open') return openEditor(b.dataset.id);
      else if (a === 'job') { await C.api('/api/jobs', { method: 'POST', body: { kind: b.dataset.kind } }); toast('Queued on the server'); }
      else if (a === 'addCampaign') {
        const streamers = $('#clCampList').value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
        const r = await C.api('/api/campaigns', { method: 'POST', body: { url: $('#clCampUrl').value.trim(), name: $('#clCampName').value.trim(), streamers } });
        toast(`${r.added.length} streamer(s) granted and watched`); await load(['creators']);
      }
      else if (a === 'bgUpload') {
        const fs = [...$('#clBgFile').files]; if (!fs.length) return toast('Pick a video');
        if (!$('#clBgAttest').checked) return toast('Confirm it is your own recording');
        let n = 0; for (const f of fs) { $('#clBgMsg').textContent = `Uploading ${++n}/${fs.length}…`; const fd = new FormData(); fd.append('file', f); fd.append('attest', '1'); await C.api('/api/backgrounds', { method: 'POST', body: fd }); }
        $('#clBgMsg').textContent = `${fs.length} uploaded. The server checks each one for a webcam.`; S.backgrounds = await C.api('/api/backgrounds');
      }
      else if (a === 'bgDel') { await C.api('/api/backgrounds/' + b.dataset.id, { method: 'DELETE' }); S.backgrounds = await C.api('/api/backgrounds'); }
      else if (a === 'makeFaceless') { await C.api('/api/jobs', { method: 'POST', body: { kind: 'faceless' } }); toast('Writing a faceless reel on the server: it lands in Review in a few minutes'); }
      else if (a === 'addCreator') { await C.api('/api/creators', { method: 'POST', body: { platform: $('#clNewPlat').value, login: $('#clNewLogin').value.trim(), category: $('#clNewCat').value.trim() || 'gaming' } }); await load(['creators']); }
      else if (a === 'upload') {
        const f = $('#clFile').files[0]; if (!f) return toast('Pick a video');
        const fd = new FormData(); fd.append('file', f); if ($('#clSrcCreator').value) fd.append('creator_id', $('#clSrcCreator').value); if ($('#clAttest').checked) fd.append('attest', '1');
        $('#clUpMsg').textContent = 'Uploading…'; const r = await C.api('/api/sources', { method: 'POST', body: fd }); $('#clUpMsg').textContent = `Uploaded (source #${r.source_id}). The cloud is analysing it.`; return;
      }
      else if (a === 'import') { await C.api('/api/sources/url', { method: 'POST', body: { url: $('#clImpUrl').value.trim(), creator_id: +$('#clImpCreator').value } }); toast('Import queued'); }
      else if (a === 'ref') { const f = $('#clRefFile').files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); fd.append('category', $('#clRefCat').value); fd.append('label', f.name); await C.api('/api/research/reference', { method: 'POST', body: fd }); toast('Reference queued for analysis'); }
      else if (a === 'activate') { await C.api(`/api/skills/${b.dataset.id}/activate`, { method: 'POST' }); await load(['skills']); }
      else if (a === 'saveSettings') {
        const v = (id) => $('#' + id), n = (id) => +v(id).value;
        await C.api('/api/settings', { method: 'PUT', body: { production: { clip_len: n('cs_clip_len'), min_len: n('cs_min_len'), clips_per_source: n('cs_clips_per_source'), threshold: n('cs_threshold'), deep: v('cs_deep').checked }, live: { burst: n('cs_burst'), chat: n('cs_chat'), cooldown: n('cs_cooldown') }, budget: { daily: n('cs_daily'), monthly: n('cs_monthly') }, discovery: { games: v('cs_games').value.split(',').map((x) => x.trim()).filter(Boolean) }, faceless: { enabled: v('cs_fl_on').checked, per_day: n('cs_fl_per'), niche: v('cs_fl_niche').value.trim(), voice: v('cs_fl_voice').value }, publishing: { enabled: v('cs_pub').checked, platforms: v('cs_plats').value.split(',').map((x) => x.trim()).filter(Boolean) } } });
        toast('Saved on the server'); await load(['status']);
      }
    } catch (err) { toast(err.message); S.err = err.message; }
    render();
  });
  page?.addEventListener('change', async (e) => {
    const t = e.target, id = t.dataset.perm || t.dataset.mon || t.dataset.src || t.dataset.proof;
    if (!id) return;
    try {
      const body = t.dataset.perm ? { permission: t.value, permission_proof: $(`[data-proof="${id}"]`)?.value || undefined } : t.dataset.mon ? { monitor: t.checked } : t.dataset.src ? { source_url: t.value.trim() } : { permission_proof: t.value.trim() };
      await C.api(`/api/creators/${id}`, { method: 'PATCH', body });
      await load(['creators']); render();
    } catch (err) { toast(err.message); await load(['creators']); render(); }
  });

  /* ---------------- clip editor (Review) ---------------- */
  const E = { clip: null, sel: 0, raf: 0, dirty: false, fc: null, drag: null };
  const FONTMAP = { Anton: 'Anton, Impact, sans-serif', Montserrat: 'Montserrat, sans-serif', Inter: 'Inter, sans-serif', Poppins: 'Poppins, sans-serif', 'Archivo Black': '"Archivo Black", sans-serif' };
  async function openEditor(id) {
    E.clip = await C.api('/api/clips/' + id); E.sel = 0; E.dirty = false; E.fc = { ...(E.clip.layout?.facecam || {}) }; E.layout = E.clip.layout?.layout || 'blur';
    const box = document.getElementById('fxRecord'); box.hidden = false; document.body.classList.add('modal-open');
    paintEditor();
  }
  function closeEditor() { cancelAnimationFrame(E.raf); E.clip = null; const box = document.getElementById('fxRecord'); box.hidden = true; document.body.classList.remove('modal-open'); }
  function paintEditor() {
    const c = E.clip, q = c.qc || {}, B = q.board || {}, r = c.research || {};
    const presets = ['bold', 'karaoke', 'clean', 'neon', 'minimal', 'bounce'];
    const box = document.getElementById('fxRecord');
    box.innerHTML = `<div class="rec cl-editor">
      <div class="rec-head"><div><div class="station-kicker">${esc(c.id)} · ${esc(c.creator?.name || 'upload')} · ${esc(c.source?.kind || '')} ${fmtS(c.start)}–${fmtS(c.end)} · ${(c.end - c.start).toFixed(1)}s · ${esc(c.status)}</div><h2>${esc(c.title)}</h2></div><button class="station-x" data-ce="close" aria-label="Close">✕</button></div>
      <div class="cl-ed-grid">
        <div class="cl-stage"><div class="cl-player"><video id="ceVid" src="${esc(C.media(c.media.clean || c.media.final))}" playsinline controls preload="auto"></video><canvas id="ceCap" width="540" height="960"></canvas></div>
          <div class="row small"><label class="check"><input type="checkbox" id="ceFinal"> Show the rendered final (with burned-in captions)</label></div>
          <h4>Facecam & layout</h4>
          <div class="row"><select id="ceLayout">${['facecam_top', 'facecam_bottom', 'track', 'split', 'blur'].map((l) => `<option ${E.layout === l ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="small muted">${esc(c.layout?.reason || '')}</span></div>
          ${c.media.source_frame ? `<div class="cl-fc"><img id="ceFrame" src="${esc(C.media(c.media.source_frame))}" alt="source frame"><div id="ceBox" class="cl-fc-box"><i class="h"></i></div></div><p class="small muted">Drag the box onto the webcam; drag the corner to resize. Layout preview:</p><canvas id="ceLay" width="270" height="480" class="cl-lay"></canvas>` : ''}
        </div>
        <div class="cl-side">
          <div class="rv-scores">${[['Quality', q.overall], ['Hook', c.scores?.hook_qc], ['Captions', c.scores?.caption_qc], ['Facecam', c.scores?.facecam_qc]].map(([l, v]) => `<span class="rv-score ${v == null ? 'c-unv' : v >= 80 ? 'c-ok' : v >= 60 ? 'c-warn' : 'c-bad'}"><b>${v ?? '–'}</b>${l}</span>`).join('')}</div>
          <label>Title<input id="ceTitle" value="${esc(c.title || '')}"></label><label>Description<textarea id="ceDesc" rows="2">${esc(c.description || '')}</textarea></label>
          <div class="row"><b class="small">Captions</b><select id="cePreset">${presets.map((p) => `<option ${c.caption_style?.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select><button data-ce="addCue" class="small-btn">+ caption</button></div>
          <div class="cl-cues" id="ceCues"></div>
          <div class="row"><button data-ce="save">${ico('check')}Save</button><button class="primary" data-ce="rerender">${ico('film')}Save & re-render</button></div>
          <label>Ask the AI for a revision<input id="ceReq" placeholder="e.g. start 2 seconds later, captions karaoke"></label><button data-ce="revise">${ico('repeat')}Request revision</button>
          <div class="row" style="margin-top:12px"><button class="ok" data-ce="approve" ${['review', 'exception'].includes(c.status) ? '' : 'disabled'}>${ico('check')}Approve</button><button class="no" data-ce="reject">${ico('x')}Reject</button></div>
          <details open><summary><b>Quality checkers</b> <span class="muted small">round ${q.round || 0} · ${q.unverified?.length || 0} not verified</span></summary><div class="rv-board">${Object.entries(B).map(([k, b]) => `<div class="rv-chk c-${b.status === 'pass' ? 'ok' : b.status === 'warn' ? 'warn' : b.status === 'fail' ? 'bad' : 'unv'}"><b>${esc(k.replace('_', ' '))}</b><span class="rv-st">${esc(b.status)}${b.score != null ? ' · ' + b.score : ''}</span><small>${esc(b.notes || b.method || '')}</small></div>`).join('')}</div>
            ${(q.tickets || []).map((t) => `<div class="rv-t sev-${t.severity}"><b>${esc(t.name)}:</b> ${esc(t.problem)} <span class="small muted">${esc(t.at || '')} · ${esc(t.action)} · ${esc(FX?.agent?.(t.agent)?.name || t.agent)}</span></div>`).join('')}</details>
          <details><summary><b>Research notes</b></summary><p class="small">${esc(r.why || '')}</p><p class="small muted">Rank ${r.rank ?? '–'}${r.rank_position ? ` · #${r.rank_position} of ${r.of}` : ''} · ${esc(r.method || '')}</p><pre class="small">${esc(JSON.stringify(r.signals || {}, null, 1))}</pre>
            <div class="rv-dims">${Object.entries(c.scores || {}).filter(([k, v]) => typeof v === 'number' && !/_qc|quality/.test(k)).map(([k, v]) => `<div><span>${esc(k)}</span><i style="width:${v * 10}%"></i><b>${v}</b></div>`).join('')}</div></details>
          <details><summary><b>Production ledger</b></summary>${(c.ledger || []).map((l) => `<div class="small">${esc(l.stage)} · ${esc(l.agent)} · ${esc(l.status)} · ${((l.ms || 0) / 1000).toFixed(1)}s · ${esc(l.output || l.error || '')}</div>`).join('')}</details>
        </div></div></div>`;
    paintCues(); wireStage(); paintLayout();
  }
  function paintCues() {
    const c = E.clip, host = $('#ceCues'); if (!host) return;
    host.innerHTML = (c.captions || []).map((q, i) => `<div class="cl-cue ${i === E.sel ? 'sel' : ''}" data-i="${i}">
      <input class="ce-t" data-i="${i}" data-f="text" value="${esc(q.text)}">
      <span class="ce-tm"><input type="number" step="0.05" data-i="${i}" data-f="start" value="${tsS(q.start)}">–<input type="number" step="0.05" data-i="${i}" data-f="end" value="${tsS(q.end)}"></span>
      ${i === E.sel ? `<div class="ce-more"><label>Color<input type="color" data-i="${i}" data-s="color" value="${esc(q.style?.color || '#ffffff')}"></label><label>Font<select data-i="${i}" data-s="font">${['', ...Object.keys(FONTMAP)].map((f) => `<option value="${f}" ${(q.style?.font || '') === f ? 'selected' : ''}>${f || 'preset'}</option>`).join('')}</select></label>
        <label>Animation<select data-i="${i}" data-s="anim">${['', 'pop', 'bounce', 'fade', 'slide', 'none'].map((a) => `<option value="${a}" ${(q.style?.anim || '') === a ? 'selected' : ''}>${a || 'preset'}</option>`).join('')}</select></label>
        <label>Height<input type="range" min="0.1" max="0.85" step="0.01" data-i="${i}" data-p="y" value="${q.pos?.y ?? ''}"></label><button data-ce="delCue" data-i="${i}" class="small-btn">Remove</button></div>` : ''}</div>`).join('');
  }
  const PRESET = { bold: { font: 'Anton', size: 124, color: '#FFFFFF', outline: '#000000', ow: 9, hl: '#FFD400', mode: 'keywords', upper: true }, karaoke: { font: 'Montserrat', size: 104, color: '#FFFFFF', outline: '#000000', ow: 6, hl: '#39FF88', mode: 'active', upper: true }, clean: { font: 'Inter', size: 80, color: '#FFFFFF', outline: '#000000', ow: 0, hl: '#7CF7D4', mode: 'keywords', upper: false, box: true }, neon: { font: 'Poppins', size: 106, color: '#FFFFFF', outline: '#7A2CFF', ow: 8, hl: '#00E5FF', mode: 'active', upper: true }, minimal: { font: 'Inter', size: 74, color: '#FFFFFF', outline: '#000000', ow: 3, hl: '#FFFFFF', mode: 'none', upper: false }, bounce: { font: 'Archivo Black', size: 148, color: '#FFE14D', outline: '#000000', ow: 10, hl: '#FF5C8A', mode: 'keywords', upper: true } };
  function wireStage() {
    const v = $('#ceVid'), cv = $('#ceCap'); if (!v || !cv) return;
    const g = cv.getContext('2d'), sc = cv.width / 1080;
    const capY = E.clip.research?.geometry?.caption_y ?? 0.66;
    const draw = () => {
      g.clearRect(0, 0, cv.width, cv.height);
      if (!$('#ceFinal')?.checked) {
        const t = v.currentTime, cues = E.clip.captions || [];
        const i = cues.findIndex((q) => t >= q.start && t < q.end);
        if (i >= 0) {
          const q = cues[i], P = { ...PRESET[$('#cePreset')?.value || 'bold'] }, st = q.style || {};
          const font = FONTMAP[st.font || P.font] || 'sans-serif', size = (P.size) * sc, x = (q.pos?.x ?? 0.5) * cv.width, y = (q.pos?.y ?? capY) * cv.height;
          g.font = `900 ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
          const words = (P.upper ? q.text.toUpperCase() : q.text).split(/\s+/);
          let active = -1; if (P.mode === 'active') { (q.words || []).forEach((w, k) => { if (t >= w.s) active = k; }); }
          const widths = words.map((w) => g.measureText(w + ' ').width), total = widths.reduce((a, b) => a + b, 0);
          if (P.box) { g.fillStyle = 'rgba(8,8,12,.78)'; g.fillRect(x - total / 2 - size * 0.3, y - size * 0.7, total + size * 0.6, size * 1.4); }
          let px = x - total / 2;
          const sc2 = st.anim === 'bounce' || (P.mode !== 'active' && st.anim !== 'none') ? 1 + 0.1 * Math.max(0, 1 - (t - q.start) / 0.12) : 1;
          g.save(); g.translate(x, y); g.scale(sc2, sc2); g.translate(-x, -y);
          words.forEach((w, k) => {
            const cx = px + widths[k] / 2;
            if (P.ow) { g.lineWidth = P.ow * sc * 2; g.strokeStyle = P.outline; g.strokeText(w, cx, y); }
            const hl = P.mode === 'active' ? k === active : P.mode === 'keywords' && q.words?.[k]?.hl;
            g.fillStyle = hl ? P.hl : (st.color || P.color); g.fillText(w, cx, y); px += widths[k];
          });
          g.restore();
          if (i !== E.playing) { E.playing = i; }
        }
      }
      E.raf = requestAnimationFrame(draw);
    };
    cancelAnimationFrame(E.raf); draw();
    cv.onclick = () => { const t = v.currentTime; const i = (E.clip.captions || []).findIndex((q) => t >= q.start && t < q.end); if (i >= 0) { E.sel = i; paintCues(); $(`.ce-t[data-i="${i}"]`)?.focus(); } else { v.paused ? v.play() : v.pause(); } };
    $('#ceFinal').onchange = (e) => { const t = v.currentTime; v.src = C.media(e.target.checked ? E.clip.media.final : (E.clip.media.clean || E.clip.media.final)); v.currentTime = t; };
    // facecam box drag
    const img = $('#ceFrame'), bx = $('#ceBox');
    if (img && bx) {
      const place = () => { const W = img.clientWidth, H = img.clientHeight; const f = E.fc.w ? E.fc : { x: 0.7, y: 0.03, w: 0.27, h: 0.33 }; Object.assign(bx.style, { left: f.x * W + 'px', top: f.y * H + 'px', width: f.w * W + 'px', height: f.h * H + 'px', display: E.layout.startsWith('facecam') ? 'block' : 'none' }); };
      img.onload = place; place();
      bx.onpointerdown = (ev) => { ev.preventDefault(); const resize = ev.target.classList.contains('h'); E.drag = { resize, sx: ev.clientX, sy: ev.clientY, f: { ...(E.fc.w ? E.fc : { x: 0.7, y: 0.03, w: 0.27, h: 0.33 }) } }; bx.setPointerCapture(ev.pointerId); };
      bx.onpointermove = (ev) => {
        if (!E.drag) return; const W = img.clientWidth, H = img.clientHeight, dx = (ev.clientX - E.drag.sx) / W, dy = (ev.clientY - E.drag.sy) / H, f = { ...E.drag.f };
        if (E.drag.resize) { f.w = Math.max(0.05, Math.min(1 - f.x, f.w + dx)); f.h = Math.max(0.05, Math.min(1 - f.y, f.h + dy)); } else { f.x = Math.max(0, Math.min(1 - f.w, f.x + dx)); f.y = Math.max(0, Math.min(1 - f.h, f.y + dy)); }
        E.fc = f; E.dirty = true; place(); paintLayout();
      };
      bx.onpointerup = () => { E.drag = null; };
      window.addEventListener('resize', place, { once: true });
    }
  }
  function paintLayout() {
    const cv = $('#ceLay'), img = $('#ceFrame'); if (!cv || !img || !img.complete || !img.naturalWidth) { if (img) img.addEventListener('load', paintLayout, { once: true }); return; }
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, sw = img.naturalWidth, sh = img.naturalHeight, f = E.fc.w ? E.fc : null;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (E.layout.startsWith('facecam') && f) {
      const th = Math.round(Math.min(860, Math.max(560, 1080 * f.h * sh / (f.w * sw))) * H / 1920), bh = H - th, top = E.layout === 'facecam_top';
      const aspect = W / th; let cw = f.w * sw, ch = f.h * sh, cx = f.x * sw, cy = f.y * sh;
      if (cw / ch < aspect) { const nh = cw / aspect; cy += (ch - nh) / 2; ch = nh; } else { const nw = ch * aspect; cx += (cw - nw) / 2; cw = nw; }
      g.drawImage(img, cx, cy, cw, ch, 0, top ? 0 : bh, W, th);
      let gh = sh, gw = gh * W / bh; if (gw > sw) { gw = sw; gh = gw * bh / W; }
      let gx = (sw - gw) / 2; const fx0 = f.x * sw, fx1 = (f.x + f.w) * sw; if (gx < fx1 && gx + gw > fx0) { if (fx0 - gw >= 0 && fx0 > sw / 2) gx = fx0 - gw; else if (fx1 + gw <= sw && fx1 < sw / 2) gx = fx1; }
      g.drawImage(img, gx, (sh - gh) / 2, gw, gh, 0, top ? th : 0, W, bh);
    } else if (E.layout === 'track') { const cw = sh * 9 / 16; g.drawImage(img, (sw - cw) / 2, 0, cw, sh, 0, 0, W, H); }
    else { const fh = W * sh / sw; g.filter = 'blur(8px) brightness(.8)'; g.drawImage(img, 0, 0, sw, sh, -W * 0.6, 0, W * 2.2, H); g.filter = 'none'; g.drawImage(img, 0, (H - fh) / 2, W, fh); }
  }
  const collect = () => ({ title: $('#ceTitle').value, description: $('#ceDesc').value, captions: E.clip.captions, caption_style: { preset: $('#cePreset').value, overrides: E.clip.caption_style?.overrides || {} }, layout: E.layout, ...(E.layout.startsWith('facecam') && E.fc.w ? { facecam: E.fc } : {}) });
  document.addEventListener('input', (e) => {
    if (!E.clip || !e.target.closest('.cl-editor')) return;
    const t = e.target, i = +t.dataset.i, q = E.clip.captions?.[i];
    if (q && t.dataset.f) { q[t.dataset.f] = t.dataset.f === 'text' ? t.value : +t.value; E.dirty = true; }
    if (q && t.dataset.s) { q.style = { ...(q.style || {}), [t.dataset.s]: t.value || undefined }; E.dirty = true; }
    if (q && t.dataset.p) { q.pos = { x: 0.5, ...(q.pos || {}), y: +t.value }; E.dirty = true; }
    if (t.id === 'ceLayout') { E.layout = t.value; E.dirty = true; paintLayout(); const bx = $('#ceBox'); if (bx) bx.style.display = E.layout.startsWith('facecam') ? 'block' : 'none'; }
  });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('.cl-cue'); if (!el || !E.clip) return; const i = +el.dataset.i; if (i !== E.sel) { E.sel = i; const v = $('#ceVid'); if (v) v.currentTime = E.clip.captions[i].start + 0.01; paintCues(); $(`.ce-t[data-i="${i}"]`)?.focus(); } });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ce]'); if (!b || !E.clip) return;
    const a = b.dataset.ce, id = E.clip.id;
    try {
      if (a === 'close') return closeEditor();
      if (a === 'addCue') { const v = $('#ceVid'), t = v ? v.currentTime : 0; E.clip.captions.push({ start: +t.toFixed(2), end: +(t + 1).toFixed(2), text: 'new caption' }); E.clip.captions.sort((x, y) => x.start - y.start); E.sel = E.clip.captions.findIndex((q) => q.text === 'new caption'); paintCues(); return; }
      if (a === 'delCue') { E.clip.captions.splice(+b.dataset.i, 1); E.sel = 0; paintCues(); return; }
      if (a === 'save' || a === 'rerender') { E.clip = await C.api('/api/clips/' + id, { method: 'PUT', body: collect() }); if (a === 'rerender') { await C.api(`/api/clips/${id}/rerender`, { method: 'POST' }); toast('Re-rendering on the server; every check runs again.'); closeEditor(); load(['clips']).then(render); return; } toast('Saved'); return paintEditor(); }
      if (a === 'revise') { const req = $('#ceReq').value.trim(); if (!req) return; const r = await C.api(`/api/clips/${id}/revise`, { method: 'POST', body: { request: req } }); toast('Revision sent: ' + JSON.stringify(r.plan)); closeEditor(); load(['clips']).then(render); return; }
      if (a === 'approve') { if (E.dirty) await C.api('/api/clips/' + id, { method: 'PUT', body: collect() }); const r = await C.api(`/api/clips/${id}/approve`, { method: 'POST' }); toast(r.publishing ? 'Approved: publishing queued' : 'Approved (publishing is off on the server)'); closeEditor(); load(['clips']).then(render); return; }
      if (a === 'reject') { if (!confirm('Reject this clip?')) return; await C.api(`/api/clips/${id}/reject`, { method: 'POST' }); closeEditor(); load(['clips']).then(render); return; }
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && E.clip) closeEditor(); });

  /* ---------------- Review Queue: cloud clips first ---------------- */
  const q = document.querySelector('section#queue');
  const host = document.createElement('div'); host.id = 'cloudNeeds';
  q?.querySelector('h2')?.after(host);
  async function paintQueue() {
    if (!q?.classList.contains('active') || !C.url()) { host.innerHTML = ''; return; }
    await load(['clips']);
    const list = S.clips.filter((c) => ['review', 'exception'].includes(c.status));
    host.innerHTML = list.length ? `<div class="card"><h3>${ico('inbox')}From your cloud studio <span class="muted small">${list.length} finished clip(s)</span></h3><div class="cl-grid">${list.map(clipCard).join('')}</div></div>` : '';
  }
  host.addEventListener('click', (e) => { const b = e.target.closest('[data-cl="open"]'); if (b) openEditor(b.dataset.id); });
  document.querySelector('nav button[data-tab="queue"]')?.addEventListener('click', () => setTimeout(paintQueue, 50));
  document.querySelector('nav button[data-tab="cloud"]')?.addEventListener('click', async () => { await load(['status', 'clips', 'events', 'creators']); render(); });
  setInterval(async () => { if (page?.classList.contains('active') && C.url() && !E.clip && !document.activeElement?.closest?.('#cloud input, #cloud select')) { await load(S.tab === 'creators' ? ['status', 'creators'] : ['status', 'clips', 'events']); render(); } }, 15000);
  C.load = load; C.render = render; C.openEditor = openEditor; C.S = S;
})();
