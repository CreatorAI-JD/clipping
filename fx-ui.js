/* AutoClipper Assembly Line — screens: the live Workshop tab and the Assembly Line management tab. */
'use strict';
(function (FX) {
  const now = FX.now;
  const S = { sub: ls.get('fx_sub', 'videos') === 'needs' ? 'videos' : ls.get('fx_sub', 'videos'), open: null, station: null, urls: [], floorSig: '' };
  const VCLASS = { PASS: 'v-pass', WARNING: 'v-warn', FAIL: 'v-fail', HUMAN_REVIEW: 'v-human', REJECTED: 'v-fail', BLOCKED: 'v-block', 'APPROVED BY HUMAN': 'v-pass' };
  const STATUS_TXT = { queued: 'In line', working: 'Working', needs_human: 'Needs you', awaiting_approval: 'Awaiting your approval', blocked: 'Blocked', error: 'Error', scheduled: 'Scheduled', live: 'Live', rejected: 'Rejected', stopped: 'Stopped', practice_done: 'Practice done' };
  const badge = (v) => `<span class="vb ${VCLASS[v] || ''}">${esc(String(v).replace('_', ' '))}</span>`;
  const stBadge = (s) => `<span class="sb s-${s}">${esc(STATUS_TXT[s] || s)}</span>`;
  const sev = (x) => `<span class="sev sev-${x}">${{ high: 'Must fix', medium: 'Warning', low: 'Note' }[x] || x}</span>`;
  const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
  const title = (r) => r.script?.title || r.idea?.topic || (r.stage === 'trends' ? (r.type === 'clips' ? 'Waiting for a VOD / picking a moment' : 'Picking an idea') : 'Untitled');
  const needsYou = (r) => ['needs_human', 'awaiting_approval', 'error'].includes(r.status) || (r.status === 'blocked' && !/No VODs waiting/.test(r.blocked || ''));
  const dl = (blob, name) => { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  const track = (u) => (S.urls.push(u), u);

  /* ---------------- human actions ---------------- */
  FX.override = async (id, note) => {
    const r = await FX.db.prod.get(id), k = r.stage;
    (r.overrides ||= {})[k] = { who: 'you', at: now(), note };
    (r.assets || []).filter((a) => a.status === 'manual_review').forEach((a) => { r.overrides['asset:' + a.id] = { who: 'you', at: now(), note }; if (k === 'assets') { a.status = 'verified'; a.check = 'Approved by you: ' + note; } });
    if (r.reports[k]) { r.reports[k].overridden = { at: now(), note }; }
    FX.hist(r, k, 'human override', note);
    r.stage = FX.nextStage(k) || k; r.status = 'queued'; r.humanReason = null; r.error = null;
    await FX.saveRecord(r); await FX.audit(`override: approved ${FX.dept(k).name}`, note, id, 'you');
  };
  FX.humanSendBack = async (id, to, note) => {
    const r = await FX.db.prod.get(id);
    FX.sendBack(r, to, 'you', note || 'Sent back by you'); r.approval = null; r.humanReason = null; r.error = null;
    if (to === 'assets') (r.assets || []).forEach((a) => (a.redo = true));
    await FX.saveRecord(r); await FX.audit(`sent back to ${FX.dept(to).name}`, note, id, 'you');
  };
  FX.reject = async (id, note) => {
    const r = await FX.db.prod.get(id); r.status = 'rejected'; FX.hist(r, r.stage, 'rejected by you', note);
    await FX.saveRecord(r); await FX.audit('rejected', note, id, 'you');
  };

  /* ================= WORKSHOP TAB (full-page live view) ================= */
  function botSVG(d, cls = '') {
    return `<svg class="fbot ${cls}" viewBox="0 0 64 72" aria-hidden="true">
      <line x1="32" y1="8" x2="32" y2="16" stroke="${d.color}" stroke-width="3"/><circle class="fb-ant" cx="32" cy="7" r="4" fill="${d.color}"/>
      <rect x="12" y="16" width="40" height="28" rx="11" fill="${d.color}"/><rect x="17" y="21" width="30" height="16" rx="7" fill="#0f0d16"/>
      <g class="fb-eyes"><rect x="23" y="25" width="5" height="8" rx="2.5" fill="#7cf7d4"/><rect x="36" y="25" width="5" height="8" rx="2.5" fill="#7cf7d4"/></g>
      <path class="fb-shut" d="M22 30q3 2.5 6 0M35 30q3 2.5 6 0" stroke="#7cf7d4" stroke-width="2" fill="none" stroke-linecap="round"/>
      <rect x="16" y="46" width="32" height="20" rx="8" fill="${d.color}" opacity=".85"/>
      <use href="#i-${d.icon}" x="25" y="49" width="14" height="14" class="fb-ico"/>
      <rect class="fb-arm-l" x="5" y="48" width="10" height="5" rx="2.5" fill="${d.color}"/><rect class="fb-arm-r" x="49" y="48" width="10" height="5" rx="2.5" fill="${d.color}"/>
    </svg>`;
  }
  const DESC = {
    channel: 'Holds the channel rules every robot reads: niche, audience, platforms, tone, length, look, what is allowed and avoided, originality and monetization rules, and the streamer permission record.',
    trends: 'Clips: scans VODs for hype moments (audio), transcribes them and ranks them with what GTA communities are talking about. Faceless: pulls Wikipedia/Reddit/YouTube trend signals and invents original ideas. Keeps an idea database so nothing repeats.',
    factcheck: 'Clips: context check (personal info, real threats, claims about real people). Faceless: finds sources and only accepts a claim when the quoted sentence really exists in the source.',
    script: 'Clips: picks the tightest cut, the on-screen hook, the title and an optional commentary intro. Faceless: writes a scene-by-scene script using only verified facts.',
    scriptqc: 'Independent checker: hook, grammar, repetition, unsupported claims, originality, policy and advertiser risks, ending. PASS / WARNING / FAIL with the exact line to fix.',
    voice: 'Generates narration per scene (clips: the commentary intro), checks it with a transcription, and regenerates only the scenes that fail.',
    assets: 'Gets footage with a license record for every asset (source, creator, license, commercial use, attribution, date, link). Unverified assets are rejected or sent to you.',
    captions: 'Captions from the real audio (transcribed), corrected to the script spelling, timed, highlighted and placed in the safe zone.',
    edit: 'Builds the timeline, mixes audio and renders a 1080×1920 video with burned-in captions. Saves the edit project so fixes don\'t need a rebuild.',
    audioqc: 'Listens to the exported file: clipping, silence, music too loud under speech, abrupt endings, sync. Sends it back with timestamps.',
    visualqc: 'Watches the exported file start to finish: black frames, frozen picture, missing scenes, size/ratio, and (with a key) whether visuals fit the words.',
    copyright: 'Checks every license record, streamer permission and music risk. Unclear rights stop publishing until a person decides. Not a legal guarantee.',
    guidelines: 'Checks narration, on-screen text and visuals against a separate checklist per platform, and lists required disclosures.',
    monetization: 'Compares with all previous videos for repetition and reused content, checks advertiser-friendliness, and writes a risk report. Not a guarantee of ad eligibility.',
    finalqc: 'Combines every report into one decision: APPROVED, APPROVED WITH WARNING, NEEDS REVISION, HUMAN REVIEW or REJECTED.',
    prep: 'Writes different titles, descriptions and hashtags per platform, adds credits and AI disclosures, checks metadata for misleading claims, grabs a cover frame.',
    approval: 'You. Nothing is published until you approve it in the Review Queue (an optional auto rule only unlocks after your first approval).',
    publish: 'Uploads through Upload-Post and the YouTube API with AI-content flags, schedules into your posting window, and saves the result.',
    monitor: 'Tracks views, likes, comments, shares, watch time and retention (where the platform API provides them) over time.',
    analytics: 'Finds what works (hooks, lengths, times, formats) and feeds lessons back to research and scripting. Weekly reports.',
  };

  async function renderFloor() {
    const host = $('#fxFloor'); if (!host) return;
    const recs = await FX.db.prod.all(), w = FX.manager.working;
    const at = {}; recs.filter((r) => !['rejected'].includes(r.status)).forEach((r) => ((at[r.stage] ||= []).push(r)));
    const scores = await FX.department_scores();
    const sig = JSON.stringify([w?.key, w?.id, recs.map((r) => r.id + r.stage + r.status), FX.stopped(), FX.manager.running, S.station]);
    // the "now working" hero
    const d = w ? FX.dept(w.key) : null, pct = w ? +(String(w.text).match(/(\d+)%/) || [])[1] : NaN;
    const wr = w ? recs.find((r) => r.id === w.id) : null;
    $('#fxNow').innerHTML = d ? `
      <div class="now-bot">${botSVG(d, 'working big')}</div>
      <div class="now-txt"><div class="kicker">Station ${d.n} · ${esc(d.bot)} is working</div><h2>${esc(d.name)}</h2>
        <div class="now-line">${esc(w.text)}</div><div class="muted small">${esc(wr ? wr.id + ': ' + title(wr) : '')}</div>
        <div class="bar ${isNaN(pct) ? 'indet' : ''}"><i style="width:${isNaN(pct) ? 35 : pct}%"></i></div></div>`
      : `<div class="now-bot">${botSVG({ color: '#4b4366', icon: 'moon' }, 'asleep big')}</div>
      <div class="now-txt"><div class="kicker">${FX.stopped() ? 'Emergency stop is on' : FX.manager.running ? 'Line is running' : 'Line is paused'}</div><h2>${FX.stopped() ? 'Everything is paused' : FX.manager.running ? 'Waiting for work' : 'The crew is on break'}</h2>
        <div class="now-line">${FX.stopped() ? 'Nothing will be published until you release the stop.' : FX.manager.running ? (FX.isClips() ? 'Drop a VOD (Assembly Line → Ideas & VODs) or choose a folder on Autopilot, and the robots start.' : 'Starting the next video on the next check.') : 'Press Start line to let the robots work. You can also run one video step by step.'}</div>
        <div class="bar idle"><i style="width:0"></i></div></div>`;
    $('#fxRun').innerHTML = FX.manager.running ? ico('pause') + 'Pause line' : ico('play') + 'Start line';
    $('#fxRun').classList.toggle('primary', !FX.manager.running);
    $('#fxStop').innerHTML = FX.stopped() ? ico('play') + 'Release STOP' : ico('stop') + 'STOP';
    document.body.classList.toggle('fx-stopped', FX.stopped());
    if (sig === S.floorSig) return; S.floorSig = sig;
    host.innerHTML = FX.DEPTS.map((dd) => {
      const here = at[dd.key] || [], sc = scores[dd.key], busy = w?.key === dd.key;
      const flag = here.some((r) => needsYou(r)) ? 'need' : here.some((r) => r.status === 'blocked') ? 'block' : busy ? 'busy' : here.length ? 'has' : '';
      const count = dd.key === 'channel' ? (FX.channelReady() ? 'v' + FX.channelVersion() : 'set me up') : dd.key === 'analytics' ? (ls.get('fx_learnings', null)?.notes?.length || 0) + ' lessons' : here.length ? `${here.length} video${here.length > 1 ? 's' : ''}` : '';
      return `<button class="stn ${flag} ${S.station === dd.key ? 'sel' : ''}" data-st="${dd.key}" title="${esc(dd.name)}">
        <span class="stn-n">${dd.n}</span><span class="stn-ph" style="color:${dd.color}">${esc(dd.phase)}</span>${botSVG(dd, busy ? 'working' : here.length ? 'awake' : 'asleep')}
        <span class="stn-name">${esc(dd.name)}</span><span class="stn-bot">${esc(dd.bot)}</span>
        <span class="stn-c">${esc(count)}</span>${sc?.runs ? `<span class="stn-s" title="pass rate">${Math.round(((sc.pass + sc.warn) / sc.runs) * 100)}%</span>` : ''}
        <span class="belt"></span></button>`;
    }).join('');
    if (S.station) renderStation();
  }

  async function renderStation() {
    const k = S.station, d = FX.dept(k), box = $('#fxStation'); if (!d) { box.hidden = true; return; }
    const recs = (await FX.db.prod.all()).filter((r) => r.stage === k && r.status !== 'rejected');
    const sc = (await FX.department_scores())[k];
    const last = (await FX.db.prod.all()).filter((r) => r.reports?.[k]).sort((a, b) => b.reports[k].at - a.reports[k].at).slice(0, 5);
    let extra = '';
    if (k === 'channel') { const ch = FX.channelCheck(); extra = `<h4>Config check</h4>${ch.items.length ? items(ch.items) : '<p class="ok-line">✓ Complete (version ' + ch.version + ')</p>'}<div class="row"><button data-goto="channel">Open channel setup</button></div>`; }
    if (k === 'analytics') extra = `<div class="row"><button data-goto="analytics">Open analytics</button></div>`;
    if (k === 'approval') extra = `<div class="row"><button data-goto="needs">Open Review Queue</button></div>`;
    box.hidden = false;
    box.innerHTML = `<div class="station-head"><div><div class="station-kicker">Station ${d.n} · ${esc(d.bot)} · result: ${esc(d.result)}</div><h3>${ico(d.icon)}${esc(d.name)}</h3></div><button class="station-x" data-close aria-label="Close">✕</button></div>
      <p class="muted small">${esc(DESC[k])}</p>
      ${sc ? `<div class="facts">${fact('Runs', sc.runs)}${fact('Pass / warn', `${sc.pass} / ${sc.warn}`)}${fact('Fail / human', `${sc.fail} / ${sc.human}`)}${fact('Sent back here', sc.revisions)}${fact('AI cost', FX.money(sc.cost))}${fact('Avg time', sc.runs ? Math.round(sc.ms / sc.runs / 1000) + 's' : '–')}</div>` : ''}
      ${extra}
      ${k !== 'channel' && k !== 'analytics' ? `<h4>At this station now</h4>${recs.length ? recList(recs) : emptyBot('No videos here right now.')}` : ''}
      ${last.length ? `<h4>Latest reports</h4>${last.map((r) => `<div class="rep-mini" data-open="${r.id}"><b>${esc(r.id)}</b> ${badge(r.reports[k].verdict)} <span>${esc(r.reports[k].summary)}</span></div>`).join('')}` : ''}`;
  }

  /* ================= ASSEMBLY LINE TAB ================= */
  const SUBS = [['videos', 'Videos'], ['ideas', 'Ideas & VODs'], ['channel', 'Channel'], ['policies', 'Policies'], ['hooks', 'Hooks (ASMR)'], ['library', 'Library'], ['analytics', 'Analytics'], ['automation', 'Automation'], ['costs', 'Costs & limits'], ['audit', 'Audit & backups']];
  function recList(recs) {
    return `<div class="rtable"><div class="rr rh"><span>Video</span><span>Station</span><span>Status</span><span>Cost</span><span>Updated</span></div>${recs.map((r) => `<button class="rr" data-open="${r.id}"><span><b>${esc(r.id)}</b><small>${esc(title(r))}${r.practice ? ' · practice' : ''}${r.type === 'clips' ? ' · clip' : ''}</small></span><span>${FX.dept(r.stage).icon} ${esc(FX.dept(r.stage).name)}</span><span>${stBadge(r.status)}</span><span>${FX.money(FX.recCost(r))}</span><span>${when(r.updated)}</span></button>`).join('')}</div>`;
  }
  const items = (list) => list?.length ? `<div class="items">${list.map((i) => `<div class="it">${sev(i.sev)}<span class="it-w">${esc(i.where)}</span><span class="it-i">${esc(i.issue)}${i.fix ? `<em>→ ${esc(i.fix)}</em>` : ''}</span></div>`).join('')}</div>` : '<p class="ok-line">✓ No issues</p>';

  async function renderLine() {
    const pane = $('#fxPane'); if (!pane) return;
    $('#fxSubnav').innerHTML = SUBS.map(([k, l]) => `<button class="${S.sub === k ? 'active' : ''}" data-sub="${k}">${l}</button>`).join('');
    S.urls.forEach(URL.revokeObjectURL); S.urls = [];
    const fn = { videos: paneVideos, ideas: paneIdeas, channel: paneChannel, policies: panePolicies, library: paneLibrary, analytics: paneAnalytics, automation: () => FX.autoPane(), hooks: () => FX.hooks.pane(), costs: paneCosts, audit: paneAudit }[S.sub] || paneVideos;
    pane.innerHTML = await fn();
    updatePills();
    if (S.sub === 'channel') wireChannel();
    if (S.sub === 'hooks') FX.hooks.wire();
  }
  FX.renderLine = () => renderLine();
  FX.needCount = async () => (await FX.db.prod.all()).filter(needsYou).length;
  FX.renderNeeds = async (el) => { if (el) el.innerHTML = await paneNeeds(); };
  async function updatePills() {
    const n = (await FX.db.prod.all()).filter(needsYou).length;
    if (typeof updateCount === 'function') updateCount();
    if ($('#queue')?.classList.contains('active') && $('#fxNeeds') && !document.activeElement?.closest?.('#fxNeeds')) FX.renderNeeds($('#fxNeeds'));
    return n;
  }

  async function paneNeeds() {
    const recs = (await FX.db.prod.all()).filter(needsYou).sort((a, b) => (a.status === 'awaiting_approval' ? -1 : 1) - (b.status === 'awaiting_approval' ? -1 : 1) || b.updated - a.updated);
    const blocked = (await FX.db.prod.all()).filter((r) => r.status === 'blocked' && /No VODs waiting/.test(r.blocked || ''));
    if (!recs.length && !blocked.length) return '';
    return `<div class="card"><h3>From the Assembly Line <span class="muted small">${recs.length} waiting on you</span></h3>
      ${blocked.length ? `<div class="hint-card">${ico('inbox')}${blocked.length} video slot(s) are waiting for a stream VOD. <button data-sub="ideas">Add a VOD</button></div>` : ''}
      ${recs.length ? recs.map((r) => `<button class="need-card" data-open="${r.id}"><span class="nc-top"><b>${esc(r.id)}</b>${stBadge(r.status)}</span><span class="nc-t">${esc(title(r))}</span><span class="muted small">${esc(r.status === 'awaiting_approval' ? `Final QC: ${r.final?.decision || '–'} · monetization risk ${r.monetization?.level || '–'}` : r.humanReason || r.blocked || r.error || '')}</span><span class="nc-go">${r.status === 'awaiting_approval' ? 'Review & approve →' : 'Decide →'}</span></button>`).join('') : ''}</div>`;
  }
  async function paneVideos() {
    const recs = (await FX.db.prod.all()).sort((a, b) => b.created - a.created);
    return `<div class="row"><button class="primary" data-act="newVideo">＋ New video</button><button data-act="stepAll">Run one step</button><span class="muted small">${recs.length} production record(s). Every video has its own ID, reports, revisions, costs and history.</span></div>
      ${recs.length ? recList(recs) : emptyBot('No videos yet. Start the line on the Workshop tab, or press New video.')}`;
  }
  async function paneIdeas() {
    const ideas = (await FX.db.ideas.all()).sort((a, b) => (a.status === 'new' ? -1 : 1) - (b.status === 'new' ? -1 : 1) || b.rank - a.rank);
    const inbox = FX.vodInbox();
    const vodRows = [];
    for (const e of [...inbox].reverse()) vodRows.push(`<div class="vrow"><span>${ico('film')}<b>${esc(e.name)}</b> <small class="muted">${(e.size / 1e9).toFixed(2)} GB · ${e.from}</small></span><span>${e.status === 'new' ? 'Waiting to scan' : e.status === 'scanned' ? `${e.moments} moment(s) found` : esc(e.status)}</span><span>${(await FX.vodAvailable(e.key)) ? '<span class="ok-line">available</span>' : '<span class="muted">re-drop to use</span>'}</span></div>`);
    return `<div class="card"><h3>VOD inbox (GTA streams)</h3>
        <label class="drop" id="fxVodDrop"><input type="file" id="fxVodFile" accept="video/*" multiple hidden><span>${ico('folder')}Drop stream VODs here (MP4/WebM). The Moment Scout finds the hype moments.</span></label>
        <p class="muted small">Big VODs stay on your computer; the browser only remembers them for this session. For hands-off work, choose a VOD folder on the Autopilot tab and new recordings are picked up automatically.</p>
        ${vodRows.length ? `<div class="vlist">${vodRows.join('')}</div>` : ''}</div>
      <div class="row"><button data-act="genIdeas">${FX.isClips() ? ico('bulb') + 'Generate faceless ideas (for a faceless channel)' : ico('bulb') + 'Generate ideas now'}</button><span class="muted small">Idea database: ${ideas.length} entries. Duplicates are blocked automatically.</span></div>
      ${ideas.length ? `<div class="ideas">${ideas.slice(0, 80).map((i) => `<div class="idea ${i.status}"><div class="idea-h"><b>${esc(i.topic)}</b><span class="rank">${i.rank ?? '–'}</span></div>
        <div class="muted small">${esc(i.description || '')}</div>
        ${i.type === 'moment' ? `<div class="small">${ico('film')}${esc(i.vodName)} @ ${fmt(i.start)} · hook "${esc(i.hook)}"</div>${i.transcript ? `<div class="quote">"${esc(i.transcript.slice(0, 220))}"</div>` : ''}` : `<div class="small">Hook: "${esc(i.hook || '')}" · ${esc(i.format || '')}</div>`}
        ${(i.concerns || []).length ? `<div class="small warn-t">${ico('alert')}${esc(i.concerns.join('; '))}</div>` : ''}
        <div class="row"><span class="sb s-${i.status}">${esc(i.status)}${i.usedBy ? ' → ' + esc(i.usedBy) : ''}</span>${i.status === 'new' ? `<button data-produce="${i.id}">Produce this</button><button data-drop="${i.id}">Skip</button>` : ''}</div></div>`).join('')}</div>` : emptyBot('No ideas or moments yet.')}`;
  }

  /* ---------------- channel setup ---------------- */
  const F = (id, label, v, type = 'text', extra = '') => `<label>${label}<input id="ch_${id}" type="${type}" value="${esc(v ?? '')}" ${extra}></label>`;
  const T = (id, label, v, rows = 3) => `<label>${label}<textarea id="ch_${id}" rows="${rows}">${esc(v ?? '')}</textarea></label>`;
  const C = (id, label, v) => `<label class="check"><input id="ch_${id}" type="checkbox" ${v ? 'checked' : ''}> ${label}</label>`;
  async function paneChannel() {
    const c = FX.channel(), k = FX.keys(), chk = FX.channelCheck(), hist = ls.get('fx_channelHist', []);
    const clips = c.type === 'clips';
    return `<p class="muted">The permanent channel configuration. Every department reads this, so they all make content that fits. Saving creates a new version; each video remembers the version it was made with.</p>
      <div class="card"><div class="row"><b>Channel type</b>
        <label class="check"><input type="radio" name="chType" value="clips" ${clips ? 'checked' : ''}> Streamer clips (VODs → clips, any game or niche)</label>
        <label class="check"><input type="radio" name="chType" value="faceless" ${!clips ? 'checked' : ''}> Faceless researched videos</label></div>
        <p class="muted small">Switching type loads sensible defaults for that type; review them and save.</p></div>
      <div class="card"><h3>Identity</h3>${clips && FX.hooks ? FX.hooks.nicheRow() : ''}<div class="grid3">${F('name', 'Channel name', c.name)}${F('niche', 'Niche', c.niche)}${F('lengthSec', 'Average video length (sec)', c.lengthSec, 'number', 'min="10" max="180"')}</div>
        ${T('audience', 'Target audience', c.audience, 2)}<div class="grid3">${F('tone', 'Tone', c.tone)}${F('personality', 'Personality', c.personality)}${F('cta', 'Call to action', c.cta)}</div>${T('style', 'Style', c.style, 2)}
        <div class="row"><b class="small">Platforms</b>${['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'threads'].map((p) => `<label class="check"><input type="checkbox" data-plat="${p}" ${(c.platforms || []).includes(p) ? 'checked' : ''}> ${platName(p)}</label>`).join('')}</div></div>
      ${clips ? `<div class="card"><h3>Streams & rights</h3><div class="grid3">${F('streamer', 'Streamer name / channel', c.streamer, 'text', 'placeholder="e.g. your Twitch name"')}${F('game', 'Game', c.game)}
        <label>Whose streams are these?<select id="ch_streamerRelation"><option value="" ${!c.streamerRelation ? 'selected' : ''}>Not set yet (every clip waits for you)</option><option value="me" ${c.streamerRelation === 'me' ? 'selected' : ''}>My own streams</option><option value="permission" ${c.streamerRelation === 'permission' ? 'selected' : ''}>Another streamer: I have written permission</option><option value="none" ${c.streamerRelation === 'none' ? 'selected' : ''}>Another streamer: no permission yet</option></select></label></div>
        <div class="grid3">${F('permissionProof', 'Permission proof (link to message/contract)', c.permissionProof)}${F('permissionDate', 'Permission date', c.permissionDate, 'date')}<span></span></div>
        ${C('gamePolicyAck', 'I have read the game publisher\'s video / monetization policy for this game', c.gamePolicyAck)}
        <p class="muted small">Without your own streams or written permission, the Copyright robot stops every clip for your decision, and the Monetization robot rates it HIGH risk.</p>
        <div class="grid3">${F('clipLen', 'Max clip length (sec)', c.clipLen, 'number', 'min="8" max="90"')}${F('momentsPerVod', 'Moments to find per VOD', c.momentsPerVod, 'number', 'min="1" max="20"')}
        <label>Layout<select id="ch_layout"><option value="blur" ${c.layout === 'blur' ? 'selected' : ''}>Center + blurred background</option><option value="crop" ${c.layout === 'crop' ? 'selected' : ''}>Center crop</option><option value="split" ${c.layout === 'split' ? 'selected' : ''}>Facecam top / gameplay bottom</option><option value="hook" ${c.layout === 'hook' ? 'selected' : ''}>Split-screen hook (clip top, satisfying filler bottom)</option></select></label>
        ${F('clipTag', 'Name tag on clip', c.clipTag, 'text', 'placeholder="@streamer"')}</div>
        <div class="grid3"><label>Facecam corner (for the facecam layout)<select id="ch_camCorner">${[['tl', 'Top-left'], ['tr', 'Top-right'], ['bl', 'Bottom-left'], ['br', 'Bottom-right']].map(([v, l]) => `<option value="${v}" ${c.camCorner === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${F('camSize', 'Facecam width (% of the stream)', c.camSize, 'number', 'min="10" max="60"')}${F('camInset', 'Facecam gap from the edge (%)', c.camInset, 'number', 'step="0.5" min="0" max="20"')}</div>
        <div class="row"><button data-act="previewLayout">Preview layout on a VOD frame</button><span class="muted small" id="fxLayoutMsg">Drop a VOD on the line first, then check the facecam box sits on the face.</span></div>
        <canvas id="fxLayoutPreview" width="270" height="480" style="display:none;width:270px;max-width:100%;border-radius:12px;margin:8px 0;background:#000"></canvas>
        ${C('introCommentary', 'Add a short AI commentary intro when it helps (plays over the lead-in footage, adds context and originality)', c.introCommentary)}
        ${C('jumpCuts', 'Jump-cut dead air (quiet pauses with no game action)', c.jumpCuts)}${C('punchZoom', 'Punch-in zoom + shake on the hype peak', c.punchZoom)}</div>` : ''}
      <div class="card"><h3>Rules</h3>${T('allowed', 'Content the AI is allowed to make', c.allowed)}${T('avoid', 'Topics and material to avoid (comma or new line)', c.avoid)}${T('originality', 'Originality policy', c.originality)}${F('monetizationGoal', 'Monetization goals / programs', c.monetizationGoal)}</div>
      <div class="card"><h3>Look & sound</h3><div class="grid3">
        <label>Voice<select id="ch_voice">${['onyx', 'alloy', 'echo', 'fable', 'nova', 'shimmer'].map((v) => `<option ${c.voice === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${F('speed', 'Voice speed (0.8–1.3)', c.speed, 'number', 'step="0.05" min="0.5" max="2"')}${F('captionColor', 'Caption color', c.captionColor, 'color')}${F('highlightColor', 'Highlight color', c.highlightColor, 'color')}
        ${F('captionPos', 'Caption height (0.5–0.76 of screen)', c.captionPos, 'number', 'step="0.01" min="0.4" max="0.85"')}${F('captionSize', 'Caption size (px)', c.captionSize, 'number', 'min="40" max="140"')}
        ${F('musicVolume', 'Music volume (faceless, 0–0.5)', c.musicVolume, 'number', 'step="0.01" min="0" max="0.5"')}</div>
        ${C('music', 'Background music on faceless videos (original, generated in the app)', c.music)}${T('pronunciations', 'Pronunciations (one per line: word = how to say it)', c.pronunciations, 2)}</div>
      <div class="card"><h3>Research & assets (faceless)</h3>${F('subreddits', 'Subreddits to watch for trends', c.subreddits)}
        <div class="row">${C('useStock', 'Stock video (Pexels/Pixabay)', c.useStock)}${C('useOpenverse', 'Openverse images (CC, no key)', c.useOpenverse)}${C('useAiImages', 'AI images (OpenAI)', c.useAiImages)}${C('useMyBackgrounds', 'My uploaded backgrounds (needs your rights confirmation)', c.useMyBackgrounds)}</div>
        <div class="grid3"><label>Pexels API key (free)<input id="k_pexels" type="password" value="${esc(k.pexels)}" placeholder="pexels.com/api"></label><label>Pixabay API key (free)<input id="k_pixabay" type="password" value="${esc(k.pixabay)}" placeholder="pixabay.com/api/docs"></label></div></div>
      <div class="card"><h3>Production line</h3><div class="grid3">${F('videosPerDay', 'Videos to start per day', c.videosPerDay, 'number', 'min="0" max="50"')}${F('maxPerDay', 'Hard limit per 24h (mass-production guard)', c.maxPerDay, 'number', 'min="1" max="50"')}</div>
        ${C('autoPublish', `Earned auto-approve: let the line approve videos that look like ones you already approved (rules and progress on the Automation tab: you have approved ${ls.get('fx_humanApprovals', 0)} yourself so far)`, c.autoPublish)}</div>
      <div class="row"><button class="primary" data-act="saveChannel">Save channel config</button><span class="muted small">Version ${FX.channelVersion() || 'not saved yet'}${hist[0] ? ' · saved ' + when(hist[0].at) : ''}</span></div>
      ${chk.items.length ? `<h4>Config check</h4>${items(chk.items)}` : ''}`;
  }
  function wireChannel() {
    $$('input[name=chType]').forEach((r) => (r.onchange = async () => {
      const c = { ...FX.channel(), ...(r.value === 'faceless' ? FX.FACELESS_PRESET : { ...FX.DEFAULT_CHANNEL, platforms: FX.channel().platforms }) };
      ls.set('fx_channel', c); renderLine(); toast('Loaded defaults for this channel type. Review and save.');
    }));
  }
  async function saveChannel() {
    const c = FX.channel(); const num = new Set(['lengthSec', 'speed', 'captionPos', 'captionSize', 'musicVolume', 'videosPerDay', 'maxPerDay', 'clipLen', 'momentsPerVod', 'camSize', 'camInset']);
    $$('[id^=ch_]').forEach((el) => { const k = el.id.slice(3); c[k] = el.type === 'checkbox' ? el.checked : num.has(k) ? +el.value : el.value.trim(); });
    c.type = $('input[name=chType]:checked')?.value || c.type;
    c.platforms = $$('[data-plat]').filter((x) => x.checked).map((x) => x.dataset.plat);
    if (c.autoPublish && ls.get('fx_humanApprovals', 0) < (FX.autoCfg ? FX.autoCfg().minHuman : 1)) toast('Earned auto-approve stays inactive until you have approved enough videos yourself (see the Automation tab).');
    ls.set('fx_keys', { pexels: $('#k_pexels').value.trim(), pixabay: $('#k_pixabay').value.trim() });
    await FX.saveChannel(c);
    toast('Channel config saved (version ' + FX.channelVersion() + ')'); renderLine(); renderFloor();
  }

  async function panePolicies() {
    return `<p class="muted">One checklist per platform, stored separately so editing one never touches another. These are our own summaries; re-read the official pages and mark each checklist reviewed. Anything older than 30 days is flagged on every video.</p>
      ${['youtube', 'tiktok', 'instagram'].map((p) => { const pol = FX.policy(p), stale = FX.policyStale(pol); return `<div class="card"><div class="row"><h3>${esc(pol.name)}</h3><span class="sb ${stale ? 's-blocked' : 's-live'}">${stale ? (pol.reviewedAt ? 'Review due' : 'Not reviewed yet') : 'Reviewed ' + when(pol.reviewedAt)}</span><span class="muted small">v${pol.version}</span></div>
        <div class="small">Official pages: ${pol.links.map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l.replace(/^https?:\/\//, '').slice(0, 48))}</a>`).join(' · ')}</div>
        <label>Rules (one per line: id | block / review / warn | rule | keywords, comma separated)<textarea rows="${pol.rules.length + 1}" data-pol="${p}">${esc(pol.rules.map((r) => `${r.id} | ${r.severity} | ${r.text} | ${(r.keywords || []).join(', ')}`).join('\n'))}</textarea></label>
        <div class="row"><button data-savepol="${p}">Save checklist</button><button class="primary" data-reviewpol="${p}">${ico('check')}I re-read the official rules: mark reviewed</button></div></div>`; }).join('')}`;
  }
  async function paneLibrary() {
    const lib = (await FX.db.library.all()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return `<p class="muted">Licensed assets saved for reuse, each with its license record. The Asset robot checks here first (and avoids reusing the same asset in back-to-back videos).</p>
      <div class="card"><h3>Add your own file</h3><div class="grid3"><label>File<input type="file" id="libFile" accept="video/*,image/*"></label><label>Tags<input id="libTags" placeholder="gta, car chase, night"></label>
        <label>License<select id="libLic"><option>Owned by me (confirmed)</option><option>CC0</option><option>Pexels License</option><option>Pixabay Content License</option></select></label></div>
        <label class="check"><input type="checkbox" id="libConfirm"> I confirm I own this file or have a license that allows commercial use with edits</label><div class="row"><button data-act="libAdd">Add to library</button></div></div>
      ${lib.length ? `<div class="ltable"><div class="lr lh"><span>Asset</span><span>Source / creator</span><span>License</span><span>Commercial</span><span>Status</span><span></span></div>${lib.map((a) => `<div class="lr"><span>${esc(a.name)}<small>${esc((a.tags || []).slice(0, 5).join(', '))}</small></span><span>${esc(a.source || '')}${a.creator ? ' · ' + esc(a.creator) : ''}${a.pageUrl ? ` <a href="${esc(a.pageUrl)}" target="_blank" rel="noopener">page</a>` : ''}</span><span>${a.licenseUrl ? `<a href="${esc(a.licenseUrl)}" target="_blank" rel="noopener">${esc(a.license)}</a>` : esc(a.license)}</span><span>${a.commercial === true ? 'Yes' : esc(String(a.commercial))}</span><span>${esc(a.status)}</span><span><button data-libdel="${a.id}">Remove</button></span></div>`).join('')}</div>` : emptyBot('Library is empty. Assets get added as the line licenses them.')}`;
  }
  async function paneAnalytics() {
    const a = await FX.computeAnalytics(), reps = ls.get('fx_weekly', []), sc = await FX.department_scores(), L = ls.get('fx_learnings', null);
    const dim = (name, rows) => rows.length ? `<div class="dim"><h4>${esc(name)}</h4>${rows.slice(0, 6).map((x) => `<div class="dimr"><span>${esc(x.k)}</span><i style="width:${Math.max(4, (x.avg / (rows[0].avg || 1)) * 100)}%"></i><b>${fmtNum(Math.round(x.avg))}</b><small>n=${x.n}</small></div>`).join('')}</div>` : '';
    return `<div class="kpis">${[['Published with stats', a.n], ['Avg views', a.n ? fmtNum(Math.round(a.avgViews)) : '–'], ['Engagement', a.engagement != null ? (a.engagement * 100).toFixed(1) + '%' : '–'], ['50% drop-off', a.dropAvg ? Math.round(a.dropAvg) + 's' : '–'], ['Lessons in use', L?.notes?.length || 0]].map(([l, n]) => `<div class="kpi"><span class="kpi-n">${n}</span><span class="kpi-l">${l}</span></div>`).join('')}</div>
      ${a.n ? `<div class="dims">${dim('Hook style', a.dims.hook)}${dim('Format', a.dims.format)}${dim('Length', a.dims.length)}${dim('Publish hour', a.dims.hour)}${dim('Caption style', a.dims.captionStyle)}</div>` : emptyBot('No published videos with stats yet. Once videos are live, Monitoring collects numbers and this fills in.')}
      <div class="card"><h3>Lessons fed back to research & scripting</h3>${L?.notes?.length ? `<ul>${L.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="muted small">Needs at least 3 published videos per group before it draws conclusions.</p>'}</div>
      <div class="card"><div class="row"><h3>Weekly reports</h3><button data-act="weekly">Generate now</button></div>${reps.length ? reps.slice(0, 6).map((r) => `<details><summary><b>${esc(r.period)}</b> · ${r.produced} made · ${r.published} published · ${FX.money(r.cost)}</summary><p>${esc(r.summary)}</p>${r.experiments?.length ? `<p class="small"><b>Try next:</b> ${esc(r.experiments.join(' · '))}</p>` : ''}${r.ideas?.length ? `<p class="small"><b>New ideas added:</b> ${esc(r.ideas.join(' · '))}</p>` : ''}</details>`).join('') : '<p class="muted small">First report is generated automatically after a week, or press Generate now.</p>'}</div>
      <div class="card"><h3>Department performance</h3><div class="dtable"><div class="dr dh"><span>Department</span><span>Runs</span><span>Pass</span><span>Warn</span><span>Fail</span><span>Human</span><span>Sent back</span><span>AI cost</span></div>${FX.DEPTS.filter((d) => sc[d.key].runs).map((d) => { const s = sc[d.key]; return `<div class="dr"><span>${d.icon} ${esc(d.name)}</span><span>${s.runs}</span><span>${s.pass}</span><span>${s.warn}</span><span>${s.fail}</span><span>${s.human}</span><span>${s.revisions}</span><span>${FX.money(s.cost)}</span></div>`; }).join('') || '<div class="dr"><span class="muted">No runs yet</span></div>'}</div></div>`;
  }
  async function paneCosts() {
    const recs = await FX.db.prod.all(), u = FX.usage(), lim = FX.limits(), pr = FX.prices();
    const bySvc = {}; recs.forEach((r) => (r.costs || []).forEach((c) => (bySvc[c.service] = (bySvc[c.service] || 0) + c.usd)));
    const total = Object.values(bySvc).reduce((a, x) => a + x, 0), done = recs.filter((r) => r.export);
    return `<div class="kpis">${[['Total spent (est.)', FX.money(total)], ['Videos', recs.length], ['Avg per finished video', done.length ? FX.money(done.reduce((a, r) => a + FX.recCost(r), 0) / done.length) : '–'], ['OpenAI calls today', u.n.openai || 0], ['Uploads today', u.n.uploads || 0]].map(([l, n]) => `<div class="kpi"><span class="kpi-n">${n}</span><span class="kpi-l">${l}</span></div>`).join('')}</div>
      <p class="muted small">Costs are estimates from token counts and the prices below (edit them if your plan differs). Check your real bill in each provider's dashboard.</p>
      <div class="card"><h3>By service</h3>${Object.keys(bySvc).length ? Object.entries(bySvc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="sched"><b>${FX.money(v)}</b><span>${esc(k)}</span></div>`).join('') : '<p class="muted small">No paid calls yet.</p>'}</div>
      <div class="card"><h3>Daily API limits</h3><p class="muted small">When a limit is hit, the line pauses that video and alerts you instead of failing silently.</p><div class="grid3">${Object.entries(lim).map(([k, v]) => `<label>${esc(k)} (${u.n[k] || 0} used today)<input type="number" min="0" data-limit="${k}" value="${v}"></label>`).join('')}</div></div>
      <div class="card"><h3>Prices (USD)</h3><div class="grid3">${Object.entries(pr).map(([k, v]) => typeof v === 'object' ? `<label>${esc(k)} per 1M tokens in / out<span class="row"><input type="number" step="0.01" data-price="${k}.in" value="${v.in}"><input type="number" step="0.01" data-price="${k}.out" value="${v.out}"></span></label>` : `<label>${esc(k)}<input type="number" step="0.001" data-price="${k}" value="${v}"></label>`).join('')}</div><div class="row"><button data-act="savePrices">Save limits & prices</button></div></div>`;
  }
  async function paneAudit() {
    const a = (await FX.db.audit.all()).sort((x, y) => y.at - x.at).slice(0, 200), b = (await FX.db.backups.all()).sort((x, y) => y.at - x.at);
    return `<div class="card"><h3>Backups</h3><p class="muted small">Records, ideas, config, policies and the audit log. A copy is kept in this browser daily (last 7); download one to keep it safe. Video files stay in the browser and can be downloaded per video.</p>
        <div class="row"><button class="primary" data-act="export">${ico('download')}Download backup (.json)</button><label class="btnlike">${ico('upload')}Import backup<input type="file" id="fxImport" accept="application/json" hidden></label></div>
        ${b.map((x) => `<div class="sched"><b>${when(x.at)}</b><span>${x.data.records.length} records <button data-bk="${x.id}">Download</button></span></div>`).join('')}</div>
      <h3>Audit log</h3><p class="muted small">Approvals, overrides, rejections, config and policy changes, emergency stops and alerts.</p>
      ${a.length ? `<div class="log">${a.map((x) => esc(`[${when(x.at)}] ${x.who === 'you' ? 'You:' : 'Line:'} ${x.action}${x.recId ? ' · ' + x.recId : ''}${x.detail ? ': ' + x.detail : ''}`)).join('\n')}</div>` : emptyBot('Nothing recorded yet.')}`;
  }

  /* ---------------- record detail / publishing dashboard ---------------- */
  async function openRecord(id) {
    S.open = id; const r = await FX.db.prod.get(id); if (!r) return;
    const box = $('#fxRecord'); box.hidden = false; document.body.classList.add('modal-open');
    const vid = r.export?.fileId ? await FX.getFile(r.export.fileId) : null, cover = r.coverFile ? await FX.getFile(r.coverFile) : null;
    const stageIdx = FX.STAGES.indexOf(r.stage);
    const track1 = FX.STAGES.map((k, i) => { const rep = r.reports[k], d = FX.dept(k); const cls = r.overrides?.[k] ? 'v-pass' : rep ? VCLASS[rep.verdict] : i < stageIdx ? 'v-skip' : ''; return `<span class="tk ${cls} ${k === r.stage ? 'cur' : ''}" title="${esc(d.name)}${rep ? ': ' + rep.verdict : ''}">${d.icon}<small>${d.n}</small></span>`; }).join('');
    const awaiting = r.status === 'awaiting_approval', human = r.status === 'needs_human', pp = r.publishPrep?.platforms || {};
    const backOpts = FX.STAGES.slice(0, FX.STAGES.indexOf('approval')).map((k) => `<option value="${k}">${FX.dept(k).n}. ${esc(FX.dept(k).name)}</option>`).join('');
    const warnings = Object.entries(r.reports).flatMap(([k, rep]) => (rep.items || []).filter((i) => i.sev !== 'low').map((i) => ({ ...i, where: FX.dept(k).name + ' · ' + i.where })));
    const repHTML = FX.STAGES.filter((k) => r.reports[k]).map((k) => { const rep = r.reports[k]; return `<details class="rep" ${['finalqc', 'copyright', 'monetization'].includes(k) && awaiting ? 'open' : ''}><summary>${FX.dept(k).icon} <b>${esc(FX.dept(k).name)}</b> ${badge(rep.verdict)}${rep.overridden ? ' <span class="vb v-pass">overridden</span>' : ''} <span class="muted small">${esc(rep.summary)}</span></summary>
      ${rep.method ? `<p class="muted small">Method: ${esc(rep.method)}${rep.attempt > 1 ? ` · attempt ${rep.attempt}` : ''}</p>` : ''}${items(rep.items)}${rep.disclaimer ? `<p class="disc">ⓘ ${esc(rep.disclaimer)}</p>` : ''}
      ${k === 'visualqc' && rep.data?.frames ? `<div class="frames">${Object.values(rep.data.frames).map((f) => `<img src="${f}" alt="frame">`).join('')}</div>` : ''}
      ${k === 'copyright' && rep.data?.rows ? `<div class="ltable">${rep.data.rows.map((a) => `<div class="lr"><span>${esc(a.name)}</span><span>${esc(a.source || '')}</span><span>${a.licenseUrl ? `<a href="${esc(a.licenseUrl)}" target="_blank" rel="noopener">${esc(a.license)}</a>` : esc(a.license)}</span><span>${esc(String(a.commercial))}</span><span>${esc(a.status)}</span></div>`).join('')}</div>` : ''}
      ${k === 'guidelines' && rep.data?.platforms ? Object.entries(rep.data.platforms).map(([p, x]) => `<p class="small"><b>${platName(p)}</b>: ${esc(x.status)} · policy v${x.policyVersion}${x.disclosures?.length ? ' · disclose: ' + esc(x.disclosures.join(', ')) : ''}</p>`).join('') : ''}
      ${k === 'trends' && rep.data?.signals ? `<p class="small">Signals: ${rep.data.signals.map((s) => `${esc(s.source)} (${s.error ? 'unavailable' : s.count})`).join(' · ')}</p>` : ''}</details>`; }).join('');
    const m = r.metricsHistory?.[r.metricsHistory.length - 1];
    box.innerHTML = `<div class="rec">
      <div class="rec-head"><div><div class="station-kicker">${esc(r.id)} · ${r.type === 'clips' ? 'GTA clip' : 'faceless'}${r.practice ? ' · PRACTICE' : ''} · channel config v${r.channelVersion}</div><h2>${esc(title(r))}</h2><div class="row">${stBadge(r.status)}<span class="muted small">At ${esc(FX.dept(r.stage).name)} · created ${when(r.created)} · cost ${FX.money(FX.recCost(r))}</span></div></div><button class="station-x" data-closerec aria-label="Close">✕</button></div>
      <div class="track">${track1}</div>
      ${r.humanReason && human ? `<div class="alert-box">${ico('hand')}${esc(r.humanReason)}</div>` : ''}${r.status === 'blocked' ? `<div class="alert-box block">${ico('pause')}${esc(r.blocked || '')}</div>` : ''}${r.status === 'error' ? `<div class="alert-box">${ico('alert')}${esc(r.error || '')}</div>` : ''}
      <div class="rec-grid">
        <div class="rec-media">${vid ? `<video src="${track(URL.createObjectURL(vid))}" controls playsinline></video>` : `<div class="novid">${emptyBot('No video yet: it appears after Editing & Export.')}</div>`}
          ${cover ? `<div class="small muted">Cover frame</div><img class="cover" src="${track(URL.createObjectURL(cover))}" alt="cover">` : ''}
          <div class="row">${vid ? `<button data-dl="export">${ico('download')}Video</button>` : ''}${r.captions?.srtFile ? `<button data-dl="srt">${ico('download')}Captions</button>` : ''}${r.edit?.projectFile ? `<button data-dl="proj">${ico('download')}Edit project</button>` : ''}<button data-dl="json">${ico('download')}Record</button></div></div>
        <div class="rec-side">
          ${awaiting ? `<div class="card approve"><h3>${ico('hand')}Publishing dashboard</h3>
            <div class="facts">${fact('Final decision', esc(r.final?.decision || '–'))}${fact('Production', esc(r.approvals?.production || '–'))}${fact('Policy', esc(r.approvals?.policy || '–'))}${fact('Monetization risk', esc(r.monetization?.level || '–'))}</div>
            <p class="disc">ⓘ ${esc(r.final?.note || '')}</p>
            ${warnings.length ? `<h4>Outstanding warnings (${warnings.length})</h4>${items(warnings.slice(0, 12))}` : ''}
            ${Object.entries(pp).map(([p, x]) => `<div class="meta"><b>${platName(p)}</b>${x.connected ? '' : ' <span class="muted small">(not connected: will be skipped)</span>'}<label>Title<select data-meta="${p}.title">${[...new Set([x.title, ...(x.titles || [])])].map((t) => `<option ${t === x.title ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label><label>Description<textarea rows="4" data-meta="${p}.description">${esc(x.description)}</textarea></label>${x.disclosures?.length ? `<div class="small">Disclosures set automatically: ${esc(x.disclosures.join(', '))}</div>` : ''}</div>`).join('')}
            <label>Publish time (blank = smart scheduler picks the best time; turn it off on the Automation tab)<input type="datetime-local" id="fxWhen"></label><label>Note (saved to the audit log)<input id="fxNote" placeholder="optional"></label>
            ${r.practice ? '<p class="warn-t">Practice record: publishing is locked.</p>' : FX.stopped() ? '<p class="warn-t">Emergency stop is on.</p>' : ''}
            <div class="row"><button class="ok" data-act="approve" ${r.practice || FX.stopped() ? 'disabled' : ''}>${ico('check')}Approve & publish</button><select id="fxBackTo">${backOpts}</select><button data-act="sendback">↩ Send back</button><button class="no" data-act="reject">${ico('x')}Reject</button></div></div>` : ''}
          ${human || ['blocked', 'error', 'queued', 'stopped'].includes(r.status) ? `<div class="card"><h3>Your options</h3><label>Note<input id="fxNote" placeholder="why (saved to the audit log)"></label><div class="row">
            ${human ? `<button class="ok" data-act="override">${ico('check')}Approve this step & continue</button>` : ''}${['blocked', 'error', 'queued', 'stopped'].includes(r.status) ? `<button class="primary" data-act="step">${ico('play')}Run next step now</button>` : ''}
            <select id="fxBackTo">${backOpts}</select><button data-act="sendback">↩ Send back</button><button class="no" data-act="reject">${ico('x')}Reject</button></div></div>` : ''}
          ${r.publish ? `<div class="card"><h3>Publishing</h3><div class="facts">${fact('When', when(r.publish.scheduledFor))}${fact('Platforms', esc(r.publish.platforms.map(platName).join(', ')))}${fact('Views', m?.views != null ? fmtNum(m.views) : '–')}${fact('Likes', m?.likes != null ? fmtNum(m.likes) : '–')}</div>${Object.entries(r.urls || {}).map(([p, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${platName(p)} ↗</a>`).join(' · ')}${r.metricsHistory?.length > 1 ? spark(r.metricsHistory) : ''}${m?.yt ? `<p class="small">YouTube: avg view ${m.yt.avgViewDuration ?? '–'}s (${m.yt.avgViewPct ?? '–'}%) · +${m.yt.subsGained ?? 0} subs${m.yt.error ? ' · ' + esc(m.yt.error) : ''}</p>` : ''}<p class="muted small">Copyright claims and monetization status aren't available through the public APIs; check YouTube Studio / TikTok Studio.</p></div>` : ''}
        </div></div>
      <h3>Department reports</h3>${repHTML || '<p class="muted">No reports yet.</p>'}
      ${r.idea ? `<details class="rep"><summary><b>Idea</b> <span class="muted small">${esc(r.idea.topic)}</span></summary><pre>${esc(JSON.stringify({ ...r.idea, words: undefined }, null, 1).slice(0, 3000))}</pre></details>` : ''}
      ${r.research?.sources?.length ? `<details class="rep"><summary><b>Research & sources</b> <span class="muted small">${r.research.claims.length} claims</span></summary>${r.research.sources.map((s) => `<p class="small">[${s.id}] ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)} ${s.lastEdited ? '· edited ' + esc(s.lastEdited.slice(0, 10)) : ''}</p>`).join('')}${r.research.claims.map((c) => `<div class="it"><span class="sev sev-${c.status === 'confirmed' ? 'ok' : 'medium'}">${esc(c.status)}</span><span class="it-w">${esc(c.id)}</span><span class="it-i">${esc(c.text)}${c.quote ? `<em>“${esc(c.quote.slice(0, 200))}”</em>` : ''}</span></div>`).join('')}</details>` : ''}
      ${r.script ? `<details class="rep"><summary><b>Script v${r.script.version}</b> <span class="muted small">${r.script.scenes.length} scenes · ${esc(r.script.hookStyle || '')}</span></summary><div class="scenes">${r.script.scenes.map((s) => `<div class="scene"><b>Scene ${s.n}</b> <span class="muted small">${s.start ?? ''}${s.end ? '–' + s.end + 's' : ''} · ${esc(s.transition)} · sfx ${esc(s.sfx)}</span><div>${ico('mic', 'Voiceover')}${esc(s.vo)}</div><div>${ico('type', 'On-screen text')}${esc(s.onScreen)}</div><div class="muted small">${ico('film', 'Footage')}${esc(s.footage?.query || '')} (${esc(s.footage?.kind || '')})</div></div>`).join('')}</div></details>` : ''}
      ${r.assets?.length ? `<details class="rep"><summary><b>Asset license records</b> <span class="muted small">${r.assets.length}</span></summary><div class="ltable"><div class="lr lh"><span>Asset</span><span>Source / creator</span><span>License</span><span>Commercial</span><span>Status</span><span>Acquired</span></div>${r.assets.map((a) => `<div class="lr"><span>${a.scene ? 'S' + a.scene + ' · ' : ''}${esc(a.name)}</span><span>${esc(a.source || '')}${a.creator ? ' · ' + esc(a.creator) : ''}${a.pageUrl ? ` <a href="${esc(a.pageUrl)}" target="_blank" rel="noopener">page</a>` : ''}</span><span>${a.licenseUrl ? `<a href="${esc(a.licenseUrl)}" target="_blank" rel="noopener">${esc(a.license)}</a>` : esc(a.license)}${a.attribution === 'required' ? ' · credit required' : ''}</span><span>${esc(String(a.commercial))}</span><span>${esc(a.status)}</span><span>${esc((a.acquired || '').slice(0, 10))}</span></div>`).join('')}</div></details>` : ''}
      <details class="rep"><summary><b>History, revisions & costs</b> <span class="muted small">${r.history.length} events · ${r.revisions.length} revisions</span></summary><div class="log">${esc(r.history.map((h) => `[${when(h.at)}] ${FX.dept(h.dept)?.name || h.dept}: ${h.event}${h.detail ? ': ' + h.detail : ''}`).reverse().join('\n'))}</div>${r.costs.length ? `<div class="log">${esc(r.costs.map((c) => `${FX.dept(c.dept)?.name || c.dept}: ${c.service} × ${c.units} = ${FX.money(c.usd)}`).join('\n'))}</div>` : ''}</details>
    </div>`;
  }
  const spark = (h) => { const v = h.map((x) => x.views || 0), mx = Math.max(1, ...v); return `<svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none"><polyline fill="none" stroke="#ff8a65" stroke-width="2" points="${v.map((y, i) => `${(i / (v.length - 1)) * 200},${38 - (y / mx) * 36}`).join(' ')}"/></svg>`; };
  function closeRecord() { S.open = null; $('#fxRecord').hidden = true; document.body.classList.remove('modal-open'); }

  /* ---------------- events ---------------- */
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button, [data-open], .rep-mini'); if (!b || !e.target.closest('#workshop, #line, #fxRecord, #fxNeeds')) return;
    const ds = b.dataset;
    try {
      if (ds.st) { S.station = S.station === ds.st ? null : ds.st; S.floorSig = ''; if (!S.station) $('#fxStation').hidden = true; renderFloor(); return; }
      if (ds.close !== undefined) { S.station = null; $('#fxStation').hidden = true; S.floorSig = ''; renderFloor(); return; }
      if (ds.open) return openRecord(ds.open);
      if (ds.closerec !== undefined) return closeRecord();
      if (ds.sub === 'needs' || ds.goto === 'needs') { closeRecord(); return openTab('queue'); }
      if (ds.sub) { S.sub = ds.sub; ls.set('fx_sub', ds.sub); if (!e.target.closest('#line')) openTab('line'); return renderLine(); }
      if (ds.goto) { S.sub = ds.goto; ls.set('fx_sub', ds.goto); openTab('line'); return renderLine(); }
      if (ds.produce) { const i = await FX.db.ideas.get(ds.produce); const r = await FX.newRecord({ idea: i }); toast(`${r.id} created`); return renderLine(); }
      if (ds.drop) { const i = await FX.db.ideas.get(ds.drop); i.status = 'rejected'; i.rejectReason = 'Skipped by you'; await FX.db.ideas.put(i); return renderLine(); }
      if (ds.savepol || ds.reviewpol) {
        const p = ds.savepol || ds.reviewpol, pol = FX.policy(p), ta = $(`[data-pol="${p}"]`);
        pol.rules = ta.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0] && x[2]).map(([id, severity, text, kw]) => ({ id, severity: ['block', 'review', 'warn'].includes(severity) ? severity : 'review', text, keywords: (kw || '').split(',').map((x) => x.trim()).filter(Boolean) }));
        if (ds.reviewpol) pol.reviewedAt = now();
        await FX.savePolicy(pol); if (ds.reviewpol) await FX.audit('policy checklist marked reviewed', pol.name, null, 'you');
        toast('Saved'); return renderLine();
      }
      if (ds.libdel) { await FX.db.library.del(ds.libdel); return renderLine(); }
      if (ds.bk) { const x = await FX.db.backups.get(ds.bk); return dl(new Blob([JSON.stringify(x.data, null, 1)], { type: 'application/json' }), `autoclipper-backup-${new Date(x.at).toISOString().slice(0, 10)}.json`); }
      if (ds.dl) {
        const r = await FX.db.prod.get(S.open);
        if (ds.dl === 'export') { const f = await FX.getFile(r.export.fileId); return dl(f, `${r.id}.${r.export.container.toLowerCase()}`); }
        if (ds.dl === 'srt') return dl(await FX.getFile(r.captions.srtFile), r.id + '.srt');
        if (ds.dl === 'proj') return dl(await FX.getFile(r.edit.projectFile), r.id + '_edit.json');
        return dl(new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' }), r.id + '.json');
      }
      const act = ds.act; if (!act) return;
      if (act === 'run') { await FX.setRunning(!FX.manager.running); log(FX.manager.running ? 'Assembly line started' : 'Assembly line paused'); return renderFloor(); }
      if (act === 'stop') {
        if (FX.stopped()) { await FX.releaseStop(); return renderFloor(); }
        const why = prompt('EMERGENCY STOP: pauses the line and all publishing, and tries to pull back scheduled posts. Reason?', 'Manual stop'); if (why === null) return;
        const res = await FX.emergencyStop(why); toast(`Stopped. ${res.length} scheduled post(s) handled: details in the Activity log.`); return renderFloor();
      }
      if (act === 'previewLayout') { const c = { ...FX.channel() }; $$('[id^=ch_]').forEach((el) => { c[el.id.slice(3)] = el.type === 'checkbox' ? el.checked : el.value.trim(); }); try { $('#fxLayoutMsg').textContent = await FX.previewLayout(c, $('#fxLayoutPreview')); } catch (e) { $('#fxLayoutMsg').textContent = e.message; } return; }
      if (act === 'newVideo') { if (!FX.channelReady()) { toast('Save your channel config first (Channel tab).'); S.sub = 'channel'; return renderLine(); } const r = await FX.newRecord(); toast(`${r.id} created${r.practice ? ' as a practice run (no OpenAI key)' : ''}. Start the line or press Run.`); return openRecord(r.id); }
      if (act === 'stepAll') { const r = (await FX.db.prod.all()).find((x) => ['queued', 'blocked', 'error'].includes(x.status)); if (!r) return toast('Nothing waiting.'); b.disabled = true; await FX.step(r.id); return renderLine(); }
      if (act === 'step') { b.disabled = true; b.textContent = 'Working…'; await FX.step(S.open); return openRecord(S.open); }
      if (act === 'override') { await FX.override(S.open, $('#fxNote')?.value || 'Approved by you'); toast('Approved; the line will continue.'); return openRecord(S.open); }
      if (act === 'sendback') { await FX.humanSendBack(S.open, $('#fxBackTo').value, $('#fxNote')?.value || ''); toast('Sent back.'); return openRecord(S.open); }
      if (act === 'reject') { if (!confirm('Reject this video? It will not be published.')) return; await FX.reject(S.open, $('#fxNote')?.value || ''); return openRecord(S.open); }
      if (act === 'approve') { b.disabled = true; b.textContent = 'Publishing…'; const wv = $('#fxWhen').value; await FX.approve(S.open, { note: $('#fxNote').value, when: wv ? new Date(wv).toISOString() : null }); toast('Approved.'); return openRecord(S.open); }
      if (act === 'saveChannel') return saveChannel();
      if (act === 'genIdeas') { b.disabled = true; b.textContent = 'Researching…'; const g = await FX.generateIdeas(null); toast(`${g.made.length} new idea(s), ${g.dropped.length} duplicate(s) blocked.`); return renderLine(); }
      if (act === 'weekly') { b.disabled = true; await FX.weeklyReport({ force: true }); return renderLine(); }
      if (act === 'savePrices') {
        const lim = {}; $$('[data-limit]').forEach((x) => (lim[x.dataset.limit] = +x.value)); ls.set('fx_limits', lim);
        const pr = FX.prices(); $$('[data-price]').forEach((x) => { const [k, sub] = x.dataset.price.split('.'); if (sub) pr[k] = { ...pr[k], [sub]: +x.value }; else pr[k] = +x.value; }); ls.set('fx_prices', pr);
        toast('Saved'); return renderLine();
      }
      if (act === 'export') return dl(new Blob([JSON.stringify(await FX.exportJSON(), null, 1)], { type: 'application/json' }), `autoclipper-backup-${new Date().toISOString().slice(0, 10)}.json`);
      if (act === 'libAdd') {
        const f = $('#libFile').files[0]; if (!f) return toast('Pick a file');
        if (!$('#libConfirm').checked) return toast('Confirm your rights to the file first.');
        const id = await FX.saveFile(f, f.name, { role: 'library' });
        await FX.db.library.put({ id: 'lib_' + now(), name: f.name, kind: f.type.startsWith('video') ? 'video' : 'image', source: 'Your upload', creator: 'You', license: $('#libLic').value, licenseUrl: '', commercial: true, attribution: 'not required', acquired: new Date().toISOString(), fileId: id, tags: FX.keywords($('#libTags').value + ' ' + f.name), status: 'verified', addedAt: now() });
        await FX.audit('library asset added', `${f.name} (${$('#libLic').value})`, null, 'you'); return renderLine();
      }
    } catch (err) { toast('' + err.message); log('' + err.message); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset?.meta && S.open) { const r = await FX.db.prod.get(S.open); const [p, f] = t.dataset.meta.split('.'); r.publishPrep.platforms[p][f] = t.value; FX.hist(r, 'approval', 'metadata edited', `${p} ${f}`); await FX.saveRecord(r); }
    if (t.id === 'fxVodFile') { [...t.files].forEach((f) => FX.addVod(f)); renderLine(); }
    if (t.id === 'fxImport' && t.files[0]) { try { await FX.importJSON(JSON.parse(await t.files[0].text())); toast('Backup imported'); renderLine(); } catch (err) { toast('' + err.message); } }
  });
  document.addEventListener('dragover', (e) => { if (e.target.closest?.('#fxVodDrop')) { e.preventDefault(); e.target.closest('#fxVodDrop').classList.add('over'); } });
  document.addEventListener('drop', (e) => { const d = e.target.closest?.('#fxVodDrop'); if (!d) return; e.preventDefault(); d.classList.remove('over'); [...e.dataTransfer.files].filter((f) => f.type.startsWith('video') || /\.(mp4|mov|webm|m4v)$/i.test(f.name)).forEach((f) => FX.addVod(f)); renderLine(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) closeRecord(); });

  /* ---------------- live updates ---------------- */
  let pend = null;
  const refresh = () => { clearTimeout(pend); pend = setTimeout(async () => { renderFloor(); updatePills(); if ($('#line').classList.contains('active') && !['channel', 'policies', 'costs', 'automation', 'hooks'].includes(S.sub) && !document.activeElement?.closest?.('#fxPane')) renderLine(); if (S.open && !document.activeElement?.closest?.('#fxRecord')) { const st = $('#fxRecord').scrollTop; await openRecord(S.open); $('#fxRecord').scrollTop = st; } }, 250); };
  FX.on('records', refresh); FX.on('tick', refresh); FX.on('ideas', refresh); FX.on('vods', refresh); FX.on('analytics', refresh);
  FX.on('working', () => renderFloor());
  $$('nav button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'line') renderLine(); if (b.dataset.tab === 'workshop') { S.floorSig = ''; renderFloor(); } }));
  // the Autopilot folder also feeds the clip line
  if (typeof pickFolder === 'function') $('#pickFolder').addEventListener('click', () => setTimeout(() => ls.set('fx_folderSince', now()), 1500));

  /* ---------------- start ---------------- */
  (async function init() {
    await renderFloor(); updatePills();
    if (FX.manager.running && !FX.stopped()) { clearInterval(FX.manager.timer); FX.manager.timer = setInterval(FX.tick, 15000); setTimeout(FX.tick, 4000); }
    setInterval(() => { if (document.visibilityState === 'visible') renderFloor(); }, 4000);
    // ask for notification permission only when the user starts something that will want to alert them
    const askNotify = () => { try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {} };
    $('#fxRun')?.addEventListener('click', askNotify, { once: true }); $('#apOn')?.addEventListener('change', askNotify, { once: true });
  })();
})(window.FX);
