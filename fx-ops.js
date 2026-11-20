/* AutoClipper 2.0 — AUTONOMOUS OPERATIONS
   - Operating modes: Assisted (you approve every video), Autopilot (videos that pass every required check
     are approved and scheduled automatically, only after you switch auto-publishing on), Autonomous
     Business (Autopilot + the Content Director plans research and production by itself).
     All modes keep the same publish gate, rights, policy, budget and platform rules.
   - Daily budget: estimated spend is tracked as it happens; paid API calls stop at the cap.
   - Health monitor: pauses the line when the API key stops working, spending hits the cap, or jobs keep failing.
   - Notification center: only things that need you (critical / action); routine events go to the daily report.
   - Daily report: built from production records, ledgers, ideas and the feed. No number is typed in by hand.
   Honest about where the engine runs: in this browser tab. The background worker (worker/) runs research
   and planning on a schedule without the browser; see WORKER.md. */
'use strict';
(function (FX) {
  const now = FX.now, R = FX.RUN, DAY = 864e5;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayStart = (t = now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayKey = (t = now()) => new Date(dayStart(t)).toISOString().slice(0, 10);
  const fmtT = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
  const ago = (t) => { if (!t) return 'never'; const s = (now() - t) / 1000; return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };

  const DEF = { mode: 'assisted', autoPublish: false, maxPostsPerDay: 3, minOverall: 70, minViral: 0, budget: 3, warnAt: 0.8, pauseOnFails: 3, directorHour: 7, researchEvery: 12 };
  FX.ops = () => ({ ...DEF, ...(ls.get('fx_ops', {}) || {}) });
  const setOps = (p) => { ls.set('fx_ops', { ...FX.ops(), ...p }); FX.emit('ops'); };
  FX.setOps = setOps;
  FX.MODES = {
    assisted: { name: 'Assisted', text: 'AI researches and makes videos; you approve every video before it posts.' },
    autopilot: { name: 'Autopilot', text: 'AI makes, checks and schedules videos; ones that pass every required check post automatically (after you switch auto-publishing on).' },
    autonomous: { name: 'Autonomous Business', text: 'Autopilot + the Content Director researches, plans the next 7 days and starts production by itself, using your performance data.' },
  };

  /* ---------------- spend + budget ---------------- */
  const spend = () => { const s = ls.get('fx_spend', {}); return s.day === dayKey() ? s : { day: dayKey(), usd: 0, n: 0 }; };
  FX.spentToday = () => spend().usd;
  const baseCost = FX.cost;
  FX.cost = (rec, dept, service, units, usd) => {
    baseCost(rec, dept, service, units, usd);
    const s = spend(); s.usd = Math.round((s.usd + (usd || 0)) * 1e5) / 1e5; s.n++; ls.set('fx_spend', s);
    const hist = ls.get('fx_spendHist', {}); hist[s.day] = s.usd; ls.set('fx_spendHist', hist);
  };
  // costs that don't belong to one video (research runs, planning)
  FX.costExtra = (dept, service, units, usd) => FX.cost(null, dept, service, units, usd);
  const PAID = new Set(['openai', 'tts', 'whisper', 'images']);
  const baseUse = FX.use;
  FX.use = (kind, n = 1) => {
    const o = FX.ops();
    if (PAID.has(kind) && o.budget > 0 && spend().usd >= o.budget) {
      const e = new FX.LimitError(`Daily budget reached ($${spend().usd.toFixed(2)} of $${(+o.budget).toFixed(2)}). Paid AI calls stop until tomorrow or until you raise the budget on Operations.`);
      throw e;
    }
    return baseUse(kind, n);
  };

  /* ---------------- notifications ---------------- */
  let notes = ls.get('fx_notes', []);
  const saveNotes = () => { ls.set('fx_notes', notes.slice(0, 200)); FX.emit('notes'); paintPill(); };
  FX.notify = (level, text, recId = null, key = null) => {
    if (key && notes.some((n) => n.key === key && now() - n.at < DAY)) return; // one per condition per day
    notes.unshift({ id: now() + Math.random().toString(36).slice(2, 5), at: now(), level, text: String(text).slice(0, 400), recId, read: false, key });
    saveNotes();
  };
  FX.notes = () => notes;
  const classify = (m) => /budget|key|stopped|failed|error|reconnect|limit reached|paused/i.test(m) ? 'critical' : /needs you|needs a human|needs a person|decision|rights|policy|approval/i.test(m) ? 'action' : 'info';
  const baseAlert = FX.alert;
  FX.alert = async (msg, recId) => { const lv = classify(String(msg)); if (lv !== 'info') FX.notify(lv, msg, recId); return baseAlert(msg, recId); };

  /* ---------------- health monitor: pause instead of burning money or failing silently ---------------- */
  FX.opsPause = async (reason, key) => {
    ls.set('fx_opsPause', { at: now(), reason });
    if (FX.manager.running) await FX.setRunning(false);
    FX.notify('critical', 'Production paused: ' + reason, null, key);
    FX.feedPush?.('manager', 'Paused the line: ' + reason, null, 'bad');
    log('Operations: line paused: ' + reason);
  };
  FX.health = async () => {
    const o = FX.ops(), recs = await FX.db.prod.all(), out = { checks: [], at: now() };
    const add = (name, ok, detail) => out.checks.push({ name, ok, detail });
    const s = spend().usd;
    add('Budget', !(o.budget > 0 && s >= o.budget), o.budget > 0 ? `$${s.toFixed(2)} of $${(+o.budget).toFixed(2)} today` : 'No daily cap set');
    const recentErr = recs.flatMap((r) => (r.errors || []).map((e) => ({ ...e, id: r.id }))).filter((e) => now() - e.at < 3600e3);
    const keyErr = recs.flatMap((r) => (r.errors || []).map((e) => ({ ...e, id: r.id }))).find((e) => now() - e.at < 6 * 3600e3 && /\b401\b|incorrect api key|invalid_api_key|insufficient_quota|billing|exceeded your current quota/i.test(e.message));
    add('OpenAI key', !keyErr && (!!val('apiKey') || o.mode === 'assisted'), keyErr ? `Failed on ${keyErr.id}: ${keyErr.message.slice(0, 120)}` : val('apiKey') ? 'Working (no auth errors in the last 6 h)' : 'Not set: AI agents run in limited mode');
    add('Failure rate', recentErr.length < o.pauseOnFails, `${recentErr.length} stage error(s) in the last hour`);
    const posting = typeof canPost === 'function' ? canPost() : false;
    add('Publishing accounts', posting || !o.autoPublish, posting ? 'Connected' : val('upKey') ? 'No connected account selected; reconnect on Accounts' : 'Upload-Post key not set');
    add('Emergency stop', !FX.stopped(), FX.stopped() ? 'STOP is on' : 'Off');
    // act on it
    const run = FX.manager.running;
    if (run && o.budget > 0 && s >= o.budget) await FX.opsPause(`daily budget of $${(+o.budget).toFixed(2)} reached`, 'budget-' + dayKey());
    else if (o.budget > 0 && s >= o.budget * o.warnAt) FX.notify('action', `Spending is at $${s.toFixed(2)}, ${Math.round((s / o.budget) * 100)}% of today's $${(+o.budget).toFixed(2)} budget.`, null, 'budgetwarn-' + dayKey());
    if (run && keyErr) await FX.opsPause('the OpenAI key stopped working (' + keyErr.message.slice(0, 80) + '). Fix it in Settings, then start the line again.', 'key-' + dayKey());
    if (recentErr.length >= o.pauseOnFails && FX.manager.running) await FX.opsPause(`${recentErr.length} production stages failed in the last hour`, 'fails-' + Math.floor(now() / 3600e3));
    if (o.autoPublish && o.mode !== 'assisted' && !posting) FX.notify('critical', 'Auto-publishing is on but no publishing account is connected. Reconnect on Accounts.', null, 'acct-' + dayKey());
    ls.set('fx_health', out);
    return out;
  };

  /* ---------------- Autopilot approval: only videos that passed every required check ---------------- */
  FX.autopilotCheck = async (r) => {
    const o = FX.ops(), why = [];
    if (o.mode === 'assisted') why.push('mode is Assisted');
    if (!o.autoPublish) why.push('auto-publishing is off');
    if (r.practice) why.push('practice record');
    const fin = r.reports?.finalqc;
    if (!fin || !['PASS', 'WARNING'].includes(fin.verdict)) why.push('Final QC did not pass');
    const ins = r.inspection;
    if (!ins) why.push('no inspection');
    else {
      if (ins.tickets.some((t) => t.severity === 'high' && t.status !== 'Resolved')) why.push('open must-fix tickets');
      const unver = ins.board.filter((b) => b.status === 'unverified' && b.n !== 10).map((b) => b.name);
      if (unver.length) why.push('not verified: ' + unver.join(', '));
      if ((ins.overall ?? 0) < o.minOverall) why.push(`quality ${ins.overall} < ${o.minOverall}`);
      if ((ins.viral ?? 0) < (+o.minViral || 0)) why.push(`viral estimate ${ins.viral} < ${o.minViral}`);
    }
    for (const k of ['copyright', 'guidelines']) if (r.reports?.[k]?.verdict === 'HUMAN_REVIEW' && !r.overrides?.[k]) why.push(`${FX.dept(k).name} needs a person`);
    if (r.monetization?.level === 'HIGH') why.push('monetization risk HIGH');
    const recs = await FX.db.prod.all(), today = dayStart();
    const autoToday = recs.filter((x) => x.approval?.by === 'autopilot' && x.approval.at >= today).length;
    if (autoToday >= +o.maxPostsPerDay) why.push(`daily auto-publish cap (${o.maxPostsPerDay}) reached`);
    if (typeof canPost === 'function' && !canPost()) why.push('no connected publishing account');
    return { ok: !why.length, why };
  };
  const baseApproval = R.approval;
  R.approval = async (r, say, o) => {
    if (r.approval?.approved) return baseApproval(r, say, o);
    const chk = await FX.autopilotCheck(r);
    if (chk.ok) {
      r.approval = { approved: true, by: 'autopilot', at: now(), note: `Passed every required check (quality ${r.inspection.overall}, viral estimate ${r.inspection.viral})` };
      FX.hist(r, 'approval', 'auto-approved', r.approval.note);
      await FX.audit('autopilot approved for publishing', r.approval.note, r.id, 'autopilot');
      FX.feedPush?.('publishing', `Autopilot approved ${r.id}: ${r.approval.note}`, r.id, 'done');
      return { verdict: 'PASS', summary: 'Approved by Autopilot: ' + r.approval.note + '.', items: [] };
    }
    const rep = await baseApproval(r, say, o);
    if (rep.verdict === 'WAIT' && FX.ops().mode !== 'assisted') rep.summary += ` (Autopilot did not approve: ${chk.why.join('; ')}.)`;
    r.autopilot = { at: now(), ok: false, why: chk.why };
    return rep;
  };

  /* ---------------- daily report (real records only) ---------------- */
  FX.dailyReport = async (t = now()) => {
    const a = dayStart(t), b = a + DAY, inDay = (x) => x >= a && x < b;
    const recs = await FX.db.prod.all(), ideas = await FX.db.ideas.all();
    const runs = recs.flatMap((r) => Object.entries(r.ledger || {}).flatMap(([k, L]) => (L.runs || []).map((x) => ({ ...x, key: k, id: r.id })))).filter((x) => inDay(x.end || x.start));
    const res = ls.get('fx_researchLog', []).filter((x) => inDay(x.at));
    const tomorrow = [b, b + DAY];
    const rep = {
      day: dayKey(t), generated: now(),
      research: {
        runs: res.length, topicsInvestigated: res.reduce((s, x) => s + (x.investigated || 0), 0),
        ideasFound: ideas.filter((i) => inDay(i.created) && i.type !== 'moment').length, momentsFound: ideas.filter((i) => inDay(i.created) && i.type === 'moment').length,
        promising: ideas.filter((i) => inDay(i.created) && i.status !== 'rejected' && (i.rank || 0) >= 7).length,
        selected: recs.filter((r) => inDay(r.created) && r.idea).length,
      },
      production: {
        started: recs.filter((r) => inDay(r.created)).length,
        rendered: runs.filter((x) => x.key === 'edit' && /completed/.test(x.status)).length,
        passedQC: runs.filter((x) => x.key === 'finalqc' && /completed/.test(x.status)).length,
        sentForRevision: runs.filter((x) => x.status === 'sent_back').length,
        rejected: recs.filter((r) => r.status === 'rejected' && inDay(r.updated)).length,
      },
      publishing: {
        published: recs.filter((r) => r.publish && inDay(r.publish.at) && !(r.publish.results || []).every((x) => x.error)).length,
        scheduledTomorrow: recs.filter((r) => r.publish && r.publish.scheduledFor >= tomorrow[0] && r.publish.scheduledFor < tomorrow[1]).length,
        autoApproved: recs.filter((r) => r.approval?.by === 'autopilot' && inDay(r.approval.at)).length,
        awaitingApproval: recs.filter((r) => r.status === 'awaiting_approval').length,
      },
      problems: {
        failedRuns: runs.filter((x) => x.status === 'failed').length,
        retries: runs.filter((x) => x.status === 'retry').length,
        needsHuman: recs.filter((r) => r.status === 'needs_human').length,
        sourceUnavailable: recs.filter((r) => r.status === 'blocked' && /isn't available|No VODs/.test(r.blocked || '')).length,
        errors: recs.filter((r) => r.status === 'error').map((r) => `${r.id}: ${r.error || 'error'}`).slice(0, 5),
      },
      system: {
        spend: (ls.get('fx_spendHist', {})[dayKey(t)] || 0), budget: +FX.ops().budget || 0,
        usage: (ls.get('fx_usageHist', {})[new Date(a).toDateString()] || {}),
        engine: 'browser tab', lastBeat: ls.get('fx_heartbeat', 0), worker: ls.get('fx_workerStatus', null),
      },
    };
    return rep;
  };
  // keep yesterday's report when the day rolls over (the engine runs in this tab, so this happens when it is open)
  async function rollReports() {
    const saved = ls.get('fx_dailyReports', []), y = now() - DAY;
    if (!saved.some((x) => x.day === dayKey(y))) { const r = await FX.dailyReport(y); if (r.production.started || r.publishing.published || r.research.ideasFound || r.research.momentsFound) { saved.unshift(r); ls.set('fx_dailyReports', saved.slice(0, 30)); FX.notify('info', `Daily report for ${r.day} is ready on Operations.`, null, 'report-' + r.day); } }
  }

  /* ---------------- heartbeat (so the dashboard can tell if the engine is actually running) ---------------- */
  FX.on('tick', () => ls.set('fx_heartbeat', now()));

  /* =====================================================================
     OPERATIONS TAB
     ===================================================================== */
  const sec = document.getElementById('ops');
  const kv = (label, value, cls = '') => `<div class="op-kv ${cls}"><span>${esc(label)}</span><b>${value}</b></div>`;
  const LEVEL = { critical: 'Critical', action: 'Needs you', info: 'Info' };
  function paintPill() { const b = document.querySelector('nav button[data-tab="ops"] .pill'); if (!b) return; const n = notes.filter((x) => !x.read && x.level !== 'info').length; b.hidden = !n; b.textContent = n; }
  async function render() {
    if (!sec || !sec.classList.contains('active')) { paintPill(); return; }
    const o = FX.ops(), recs = await FX.db.prod.all(), rep = await FX.dailyReport(), h = ls.get('fx_health', null), M = FX.manager;
    const beat = ls.get('fx_heartbeat', 0), engineLive = M.running && now() - beat < 60e3;
    const pause = ls.get('fx_opsPause', null);
    const nextPub = recs.filter((r) => r.publish && r.publish.scheduledFor > now()).sort((a, b) => a.publish.scheduledFor - b.publish.scheduledFor)[0];
    const dir = FX.director?.state?.() || null, worker = ls.get('fx_workerStatus', null);
    const lim = FX.limits(), use = FX.usage().n, s = spend().usd;
    const inProd = recs.filter((r) => !['live', 'rejected', 'scheduled', 'awaiting_approval', 'needs_human', 'error'].includes(r.status) && r.stage !== 'monitor').length;
    const revising = recs.filter((r) => r.revisionNote && ['queued', 'working'].includes(r.status)).length;
    const approved = recs.filter((r) => r.approval?.approved && !r.publish).length;
    const scheduled = recs.filter((r) => r.status === 'scheduled').length, published = recs.filter((r) => r.status === 'live').length;
    const failed = recs.filter((r) => r.status === 'error').length;
    const fresh = notes.filter((x) => x.level !== 'info' && !x.read);
    const reports = ls.get('fx_dailyReports', []);
    sec.innerHTML = `
      <h2>Autonomous Operations</h2>
      <p class="muted">The control center for running AutoClipper with as little supervision as possible. Every number here is counted from your production records.</p>
      <div class="op-modes">${Object.entries(FX.MODES).map(([k, m]) => `<button class="op-mode ${o.mode === k ? 'on' : ''}" data-op="mode" data-v="${k}"><b>${m.name}</b><span>${esc(m.text)}</span></button>`).join('')}</div>
      <div class="grid2 op-top">
        <div class="card"><h3>${ico('bolt')}Operating status</h3>
          ${kv('Line', FX.stopped() ? '<span class="bad-text">EMERGENCY STOP</span>' : M.running ? (engineLive ? '<span class="ok-text">Running</span>' : 'Running (no heartbeat)') : 'Paused')}
          ${kv('Engine', engineLive ? `This browser tab · last active ${ago(beat)}` : `This browser tab · last active ${ago(beat)}`)}
          ${kv('Background worker', worker ? `${esc(worker.ok ? 'OK' : 'Problem')} · last run ${ago(worker.at)}${worker.next ? ' · next ' + fmtT(worker.next) : ''}` : '<span class="muted">Not connected (see WORKER.md)</span>')}
          ${pause ? kv('Last auto-pause', `${esc(pause.reason)} · ${ago(pause.at)}`, 'warn') : ''}
          <p class="muted small">Production, rendering and the quality checks run in this tab: they stop when it is closed and pick up again when it reopens. ${worker ? 'Research and planning also run in the background worker.' : 'Set up the background worker so research and planning keep running when the browser is closed.'}</p>
          <div class="row"><button class="primary" data-op="run">${M.running ? ico('pause') + 'Pause line' : ico('play') + 'Start line'}</button><button data-op="health">${ico('shield')}Run health check</button></div>
          ${h ? `<div class="op-health">${h.checks.map((c) => `<div class="${c.ok ? 'h-ok' : 'h-bad'}">${c.ok ? '✓' : '✕'} <b>${esc(c.name)}</b> <span>${esc(c.detail)}</span></div>`).join('')}<div class="muted small">Checked ${ago(h.at)} (every minute while this tab is open)</div></div>` : ''}
        </div>
        <div class="card"><h3>${ico('calendar')}Schedule</h3>
          ${kv('Next research run', dir?.nextResearch ? fmtT(dir.nextResearch) : worker?.next ? fmtT(worker.next) + ' (worker)' : o.mode === 'autonomous' ? 'When this tab is open' : 'Only in Autonomous mode')}
          ${kv('Next content plan', dir?.nextPlan ? fmtT(dir.nextPlan) : o.mode === 'autonomous' ? 'When this tab is open' : 'Only in Autonomous mode')}
          ${kv('Next production check', M.running ? 'within 15 seconds' : 'line paused')}
          ${kv('Next scheduled post', nextPub ? `${fmtT(nextPub.publish.scheduledFor)} · ${esc(nextPub.id)}` : 'none')}
          ${kv('Videos per day target', esc(FX.channel().videosPerDay))}
          <div class="row"><button data-op="goPlan">${ico('calendar')}Open the 7-day plan</button></div></div>
      </div>
      <div class="op-stats">
        ${[['Research runs today', rep.research.runs], ['Topics / moments found today', rep.research.ideasFound + rep.research.momentsFound], ['In production', inProd], ['Awaiting revision', revising], ['Approved, not yet posted', approved], ['Scheduled', scheduled], ['Published', published], ['Failed jobs', failed]].map(([l, v]) => `<div class="op-stat ${l === 'Failed jobs' && v ? 'bad' : ''}"><b>${v}</b><span>${l}</span></div>`).join('')}
      </div>
      <div class="grid2">
        <div class="card"><h3>${ico('coins')}Budget & API usage today</h3>
          ${kv('Estimated spend', `$${s.toFixed(2)}${o.budget > 0 ? ` of $${(+o.budget).toFixed(2)} (${Math.round((s / o.budget) * 100)}%)` : ' (no cap)'}`, o.budget > 0 && s >= o.budget * o.warnAt ? 'warn' : '')}
          <div class="bar"><i style="width:${o.budget > 0 ? Math.min(100, (s / o.budget) * 100) : 0}%"></i></div>
          ${['openai', 'whisper', 'tts', 'images', 'uploads'].map((k) => kv(k === 'openai' ? 'AI text calls' : k === 'whisper' ? 'Transcriptions' : k === 'tts' ? 'Voiceovers' : k === 'images' ? 'AI images' : 'Uploads', `${use[k] || 0} / ${lim[k] ?? '∞'}`)).join('')}
          <p class="muted small">Estimates from your prices on Assembly Line → Costs & limits. Your provider's billing page is the source of truth.</p></div>
        <div class="card"><h3>${ico('sliders')}Rules</h3><div class="grid2">
          <label>Daily budget (USD, 0 = no cap)<input type="number" id="opBudget" min="0" step="0.5" value="${o.budget}"></label>
          <label>Warn me at (% of budget)<input type="number" id="opWarn" min="10" max="100" value="${Math.round(o.warnAt * 100)}"></label>
          <label>Max auto-published videos per day<input type="number" id="opMaxPosts" min="0" max="50" value="${o.maxPostsPerDay}"></label>
          <label>Min overall quality to auto-publish (0–100)<input type="number" id="opMinQ" min="0" max="100" value="${o.minOverall}"></label>
          <label>Min viral-potential estimate (0–100)<input type="number" id="opMinV" min="0" max="100" value="${o.minViral}"></label>
          <label>Pause after this many failed stages in an hour<input type="number" id="opFails" min="1" max="50" value="${o.pauseOnFails}"></label></div>
          <label class="check"><input type="checkbox" id="opAutoPub" ${o.autoPublish ? 'checked' : ''}> <b>Allow auto-publishing</b> (Autopilot and Autonomous only). Until this is on, every video waits in the Review Queue.</label>
          <p class="muted small">Auto-published videos still pass the publish gate (rights, guidelines, safety scan) and need zero open must-fix tickets and zero "not verified" checkers.</p></div>
      </div>
      <div class="card"><div class="row"><h3>${ico('alert')}Notifications</h3><span class="muted small">${fresh.length} need attention · routine events go to the daily report</span>${notes.length ? '<button data-op="readAll" class="small-btn">Mark all read</button>' : ''}</div>
        <div class="op-notes">${notes.slice(0, 30).map((n) => `<div class="op-note ${n.level} ${n.read ? 'read' : ''}"><span class="chip ${n.level === 'critical' ? 'bad' : n.level === 'action' ? 'hype' : ''}">${LEVEL[n.level]}</span><span>${esc(n.text)}</span><time>${ago(n.at)}</time>${n.recId ? `<button class="linkish" data-op="open" data-id="${esc(n.recId)}">${esc(n.recId)}</button>` : ''}</div>`).join('') || '<p class="muted small">Nothing needs you.</p>'}</div>
        <p class="muted small">Email alerts need the background worker (it can email from GitHub). In the browser you get these plus desktop notifications.</p></div>
      <div class="card"><div class="row"><h3>${ico('file')}Daily report</h3><select id="opDay">${[{ day: rep.day, live: true }, ...reports].map((x) => `<option value="${x.day}">${x.day}${x.live ? ' (today, live)' : ''}</option>`).join('')}</select></div>
        <div id="opReport">${reportHtml(rep)}</div></div>`;
    paintPill();
  }
  function reportHtml(r) {
    const L = (t, rows) => `<div class="op-rep-sec"><h4>${t}</h4><ul>${rows.filter(Boolean).map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
    const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
    return `<div class="op-report">
      ${L('Research', [r.research.runs ? n(r.research.runs, 'research run', 'research runs') + (r.research.topicsInvestigated ? `, ${r.research.topicsInvestigated} topics investigated` : '') : 'No research runs', `${n(r.research.ideasFound, 'idea', 'ideas')} and ${n(r.research.momentsFound, 'clip moment', 'clip moments')} found`, `${r.research.promising} promising (rank 7+)`, `${r.research.selected} selected for production`])}
      ${L('Production', [`${n(r.production.started, 'video', 'videos')} started`, `${n(r.production.rendered, 'render', 'renders')} completed`, `${r.production.passedQC} passed Final QC`, `${r.production.sentForRevision} sent for revision`, r.production.rejected ? `${r.production.rejected} rejected` : ''])}
      ${L('Publishing', [`${n(r.publishing.published, 'video', 'videos')} published`, `${r.publishing.scheduledTomorrow} scheduled for tomorrow`, r.publishing.autoApproved ? `${r.publishing.autoApproved} approved by Autopilot` : '', `${r.publishing.awaitingApproval} waiting for your approval`])}
      ${L('Problems', [`${n(r.problems.failedRuns, 'failed stage', 'failed stages')}${r.problems.retries ? `, ${r.problems.retries} retried` : ''}`, `${r.problems.needsHuman} need a human decision`, r.problems.sourceUnavailable ? `${r.problems.sourceUnavailable} waiting for a source video` : '', ...r.problems.errors.map(esc)])}
      ${L('System', [`Spend $${(+r.system.spend).toFixed(2)}${r.system.budget ? ` of $${r.system.budget.toFixed(2)} budget` : ''}`, `Engine: ${r.system.engine}${r.system.lastBeat ? `, last active ${fmtT(r.system.lastBeat)}` : ''}`, r.system.worker ? `Background worker last ran ${fmtT(r.system.worker.at)} (${r.system.worker.ok ? 'OK' : 'problem'})` : 'Background worker not connected'])}
    </div>`;
  }
  FX.reportHtml = reportHtml;
  sec?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-op]'); if (!b) return;
    const a = b.dataset.op;
    if (a === 'mode') {
      const v = b.dataset.v;
      if (v !== 'assisted' && !FX.ops().autoPublish) toast(`${FX.MODES[v].name} on. Videos still wait for you until you tick "Allow auto-publishing".`);
      setOps({ mode: v }); await FX.audit('operating mode', FX.MODES[v].name, null, 'you'); FX.feedPush?.('manager', `Operating mode set to ${FX.MODES[v].name}`, null, 'decision');
      if (v === 'autonomous') FX.director?.kick?.();
    }
    else if (a === 'run') { if (!FX.manager.running) ls.set('fx_opsPause', null); await FX.setRunning(!FX.manager.running); }
    else if (a === 'health') { await FX.health(); }
    else if (a === 'readAll') { notes.forEach((n) => (n.read = true)); saveNotes(); }
    else if (a === 'open') { const n = notes.find((x) => x.recId === b.dataset.id); if (n) { n.read = true; saveNotes(); } openTab('line'); setTimeout(() => document.querySelector(`[data-open="${b.dataset.id}"]`)?.click() || FX.openRecordById?.(b.dataset.id), 300); return; }
    else if (a === 'goPlan') { openTab('plan'); return; }
    render();
  });
  sec?.addEventListener('change', async (e) => {
    const id = e.target.id;
    if (id === 'opDay') { const d = e.target.value, r = d === dayKey() ? await FX.dailyReport() : ls.get('fx_dailyReports', []).find((x) => x.day === d); if (r) $('#opReport').innerHTML = reportHtml(r); return; }
    if (id === 'opAutoPub' && e.target.checked && !confirm('Allow AutoClipper to publish videos without asking you, when they pass every required check and your rules here? You can turn this off any time; the emergency STOP also stops it.')) { e.target.checked = false; return; }
    const g = (x) => $('#' + x);
    setOps({ budget: Math.max(0, +g('opBudget').value || 0), warnAt: Math.min(1, Math.max(0.1, (+g('opWarn').value || 80) / 100)), maxPostsPerDay: Math.max(0, +g('opMaxPosts').value || 0), minOverall: Math.min(100, Math.max(0, +g('opMinQ').value || 0)), minViral: Math.min(100, Math.max(0, +g('opMinV').value || 0)), pauseOnFails: Math.max(1, +g('opFails').value || 3), autoPublish: g('opAutoPub').checked });
    if (id === 'opAutoPub') await FX.audit(e.target.checked ? 'auto-publishing enabled' : 'auto-publishing disabled', '', null, 'you');
  });
  FX.opsRender = render;
  ['records', 'notes', 'ops', 'tick'].forEach((k) => FX.on(k, () => { clearTimeout(render.t); render.t = setTimeout(render, 300); }));
  document.querySelector('nav button[data-tab="ops"]')?.addEventListener('click', () => setTimeout(render, 30));
  setInterval(() => FX.health().catch((e) => log('Health check: ' + e.message)), 60e3);
  setTimeout(() => { FX.health().catch(() => {}); rollReports().catch(() => {}); }, 5000);
  setInterval(() => rollReports().catch(() => {}), 3600e3);
  paintPill();
})(window.FX);
