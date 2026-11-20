/* AutoClipper 2.0 — CONTENT DIRECTOR + 7-DAY PLAN
   Reads what the background worker researched (research.json / plan.json / status.json on the
   autoclipper-data branch), adds what this browser researched itself, compares against your own
   performance data, and keeps a 7-day content plan. In Autonomous Business mode it runs on its own:
   researches on a schedule, rebuilds the plan, feeds planned topics to the Assembly Line in priority
   order and keeps the line running. Clip slots need an authorized source (your VODs / creators you
   have permission for); the Director never fetches or downloads someone else's video. */
'use strict';
(function (FX) {
  const now = FX.now, DAY = 864e5, H = 3600e3;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const fmtT = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');

  // where the worker publishes its files: the autoclipper-data branch of this site's repo
  const guessUrl = () => {
    const h = location.hostname; if (!/\.github\.io$/.test(h)) return '';
    const owner = h.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0] || `${owner}.github.io`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/autoclipper-data/data/`;
  };
  const cfg = () => ({ dataUrl: guessUrl(), authorized: '', ...(ls.get('fx_director', {}) || {}) });
  const setCfg = (p) => ls.set('fx_director', { ...cfg(), ...p });
  const st = () => ls.get('fx_directorState', { lastWorkerPull: 0, lastResearch: 0, lastPlan: 0 });
  const setSt = (p) => ls.set('fx_directorState', { ...st(), ...p });

  /* ---------------- worker data ---------------- */
  async function pullWorker() {
    const base = cfg().dataUrl; if (!base) return { ok: false, why: 'No worker data address (only automatic on github.io sites)' };
    const get = async (f) => { const r = await fetch(base + f + '?t=' + Math.floor(now() / 6e4), { cache: 'no-store' }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); };
    try {
      const status = await get('status.json');
      const [research, plan, logj] = await Promise.all([get('research.json'), get('plan.json'), get('log.json').catch(() => [])]);
      ls.set('fx_workerStatus', { at: Date.parse(status.at), ok: status.ok, next: Date.parse(status.next), summary: status.summary, sources: status.sources, errors: status.errors });
      ls.set('fx_workerResearch', research); ls.set('fx_workerPlan', plan);
      // research runs count in the daily report
      const rl = ls.get('fx_researchLog', []);
      for (const x of logj || []) { const at = Date.parse(x.at); if (!rl.some((y) => y.at === at && y.by === 'worker')) rl.push({ at, by: 'worker', investigated: x.investigated, found: x.opportunities, ok: x.ok }); }
      ls.set('fx_researchLog', rl.sort((a, b) => b.at - a.at).slice(0, 300));
      setSt({ lastWorkerPull: now() });
      return { ok: true, status };
    } catch (e) { setSt({ lastWorkerPull: now(), workerError: e.message }); return { ok: false, why: e.message }; }
  }

  /* ---------------- research in this browser (fallback / extra) ---------------- */
  async function researchHere() {
    const c = FX.channel(), log = { at: now(), by: 'browser', investigated: 0, found: 0, ok: true };
    try {
      if (c.type === 'clips') {
        if (!FX.scout) throw new Error('Clip Scout not loaded');
        const res = await FX.scout.hunt({ quiet: true });
        log.investigated = res.length; log.found = new Set(res.map((x) => x.src + x.login)).size;
      } else {
        const g = await FX.generateIdeas(null, 8);
        log.investigated = g.signals.reduce((a, s) => a + s.items.length, 0); log.found = g.made.length;
      }
    } catch (e) { log.ok = false; log.error = e.message; }
    const rl = ls.get('fx_researchLog', []); rl.unshift(log); ls.set('fx_researchLog', rl.slice(0, 300));
    setSt({ lastResearch: now() });
    FX.feedPush?.('scout', log.ok ? `Research run: ${log.investigated} items investigated, ${log.found} opportunities` : 'Research run failed: ' + log.error, null, log.ok ? 'done' : 'bad');
    return log;
  }

  /* ---------------- the plan ---------------- */
  const learnedFormat = () => FX.learned?.()?.formatWeights || {};
  async function buildPlan() {
    const c = FX.channel(), per = Math.max(1, +c.videosPerDay || 1), wp = ls.get('fx_workerPlan', null), wr = ls.get('fx_workerResearch', null);
    const ideas = await FX.db.ideas.all(), recs = await FX.db.prod.all();
    const done = new Set(recs.map((r) => FX.norm(r.idea?.topic || '')));
    const days = Array.from({ length: 7 }, (_, k) => ({ date: dayKey(now() + k * DAY), slots: [] }));
    const fw = learnedFormat();
    const opp = new Map((wr?.opportunities || []).map((o) => [o.key, o]));
    const pool = [];
    // 1) the worker's plan and opportunities (researched in the background with cross-source evidence)
    for (const d of wp?.days || []) for (const s of d.slots || []) { const o = opp.get(s.key) || s; pool.push({ key: s.key, topic: s.topic, kind: s.kind || o.kind, format: s.format || o.format, hook: s.hook || o.hook || '', why: s.why || o.why, confidence: s.confidence ?? o.confidence, sources: o.sources || [], risks: o.risks || [], creator: o.creator, platform: o.platform, from: 'worker', want: d.date, score: (s.score ?? o.score ?? 50) * (fw[s.format || o.format] || 1) }); }
    // 2) ideas researched in this browser that are still open
    for (const i of ideas.filter((x) => x.status === 'new' && x.type !== 'moment' && !x.practice && now() - x.created < 7 * DAY)) pool.push({ key: 'idea:' + i.id, ideaId: i.id, topic: i.topic, kind: 'faceless', format: i.format, hook: i.hook, why: i.description, confidence: i.confidence ?? null, sources: i.sources || [], risks: i.concerns || [], from: 'browser', score: (i.rank || 5) * 10 * (fw[i.format] || 1) });
    // 3) clip line: moments already found in your VODs, and creators whose clips are taking off
    for (const m of ideas.filter((x) => x.type === 'moment' && x.status === 'new')) pool.push({ key: 'moment:' + m.id, ideaId: m.id, topic: m.topic, kind: 'clip', format: 'clip', hook: m.hook, why: m.description, confidence: null, sources: [{ title: m.vodName }], risks: m.concerns || [], from: 'your VOD', score: (m.rank || 5) * 10 + 20, ready: true });
    const auth = new Set(String(cfg().authorized + ',' + (c.streamer || '')).toLowerCase().split(/[,\s]+/).filter(Boolean));
    const want = c.type === 'clips' ? 'clip' : 'faceless';
    const uniq = new Map();
    for (const p of pool.filter((x) => x.kind === want)) { const k = FX.norm(p.topic); if (done.has(k)) continue; if (!uniq.has(k) || uniq.get(k).score < p.score) uniq.set(k, p); }
    const ranked = [...uniq.values()].sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || b.score - a.score);
    for (const p of ranked) {
      if (p.kind === 'clip' && !p.ready) p.needsSource = p.creator && auth.has(String(p.creator).toLowerCase()) ? 'authorized creator: drop their VOD or add them to Live Watch' : 'needs an authorized source (your VOD, or a creator you have permission to clip)';
      const di = Math.max(0, days.findIndex((d) => d.date === p.want));
      for (let k = di; k < 7; k++) {
        const near = days.slice(Math.max(0, k - 3), k + 4).flatMap((d) => d.slots);
        if (days[k].slots.length >= per || near.some((s) => FX.jaccard(FX.keywords(s.topic), FX.keywords(p.topic)) >= 0.6)) continue;
        days[k].slots.push(p); break;
      }
    }
    // feed the line: planned ideas get a priority the Assembly Line follows (earliest day first)
    let n = 0; const planned = new Set();
    for (const d of days) for (const s of d.slots) {
      n++;
      if (s.kind === 'faceless' && !s.ideaId && s.from === 'worker') {
        const id = 'res_' + s.key.slice(0, 40);
        const ex = ideas.find((x) => x.id === id);
        if (!ex) await FX.db.ideas.put({ id, created: now(), status: 'new', type: 'research', niche: c.niche, topic: s.topic, description: s.why, hook: s.hook, hookStyle: 'bold claim', format: s.format, research: (s.sources || []).map((x) => `${x.publisher || x.source}: ${x.title}`), sources: s.sources, concerns: s.risks, confidence: s.confidence, scores: { relevance: 7, interest: 7, originality: 6, difficulty: 3 }, rank: Math.round(s.score) / 10, from: 'worker research' });
        s.ideaId = id;
      }
      if (s.ideaId) { const i = ideas.find((x) => x.id === s.ideaId) || await FX.db.ideas.get(s.ideaId); if (i && i.status === 'new') { i.priority = n; i.plannedFor = d.date; await FX.db.ideas.put(i); planned.add(i.id); } }
    }
    // ideas the Director dropped from the plan lose their priority; research ideas older than 7 days expire
    for (const i of await FX.db.ideas.all()) {
      if (i.priority && !planned.has(i.id)) { delete i.priority; delete i.plannedFor; await FX.db.ideas.put(i); }
      if (i.type === 'research' && i.status === 'new' && now() - i.created > 7 * DAY) { i.status = 'expired'; i.rejectReason = 'Outdated research: replaced by newer opportunities'; await FX.db.ideas.put(i); }
    }
    const plan = { at: now(), days, source: wp ? 'worker + this browser' : 'this browser', per };
    ls.set('fx_plan', plan); setSt({ lastPlan: now() });
    FX.feedPush?.('manager', `Content Director planned ${days.reduce((a, d) => a + d.slots.length, 0)} slot(s) for the next 7 days (${plan.source})`, null, 'decision');
    FX.emit('ideas');
    return plan;
  }

  /* ---------------- autonomous loop (while this tab is open) ---------------- */
  async function loop() {
    const o = FX.ops?.() || {}, s = st();
    if (now() - s.lastWorkerPull > 30 * 60e3) await pullWorker();
    if (o.mode !== 'autonomous') return;
    const w = ls.get('fx_workerStatus', null), workerFresh = w && now() - w.at < 12 * H;
    if (!workerFresh && now() - s.lastResearch > (+o.researchEvery || 12) * H) await researchHere();
    if (now() - s.lastPlan > 6 * H || (ls.get('fx_plan', null)?.days?.[0]?.date !== dayKey(now()))) await buildPlan();
    const pause = ls.get('fx_opsPause', null);
    if (!FX.manager.running && !FX.stopped() && !(pause && now() - pause.at < 6 * H) && FX.channelReady()) { await FX.setRunning(true); FX.feedPush?.('manager', 'Autonomous mode: started the line', null, 'decision'); }
  }
  FX.director = {
    state: () => { const s = st(), o = FX.ops?.() || {}, w = ls.get('fx_workerStatus', null); return { ...s, nextResearch: o.mode === 'autonomous' ? (w && now() - w.at < 12 * H ? w.next : (s.lastResearch || now()) + (+o.researchEvery || 12) * H) : null, nextPlan: o.mode === 'autonomous' ? (s.lastPlan || now()) + 6 * H : null }; },
    kick: () => loop().catch((e) => log('Content Director: ' + e.message)),
    pullWorker, researchHere, buildPlan,
  };
  setInterval(() => FX.director.kick(), 5 * 60e3);
  setTimeout(() => FX.director.kick(), 6000);

  /* ---------------- PLAN TAB ---------------- */
  const sec = document.getElementById('plan');
  async function render() {
    if (!sec || !sec.classList.contains('active')) return;
    const p = ls.get('fx_plan', null), w = ls.get('fx_workerStatus', null), s = st(), c = cfg(), recs = await FX.db.prod.all();
    const rl = ls.get('fx_researchLog', []).slice(0, 6);
    const recByIdea = new Map(recs.filter((r) => r.idea?.id).map((r) => [r.idea.id, r]));
    const slot = (x) => {
      const r = x.ideaId && recByIdea.get(x.ideaId);
      const status = r ? `${r.status === 'live' ? 'Published' : r.status === 'scheduled' ? 'Scheduled' : 'In production'} · <button class="linkish" data-pl="open" data-id="${esc(r.id)}">${esc(r.id)}</button>` : x.needsSource ? `<span class="warn-text">${esc(x.needsSource)}</span>` : 'Planned';
      return `<div class="pl-slot"><div class="pl-top"><b>${esc(x.topic)}</b><span class="chip">${esc(x.format || x.kind)}</span>${x.confidence != null ? `<span class="chip" title="from independent sources">conf ${Math.round(x.confidence * 100)}%</span>` : ''}</div>
        <div class="small muted">${esc(x.why || '')}</div>
        ${x.sources?.length ? `<div class="pl-src">${x.sources.slice(0, 3).map((q) => q.url ? `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.publisher || q.source || 'source')}</a>` : `<span>${esc(q.title || q.publisher || '')}</span>`).join(' · ')}</div>` : ''}
        ${x.risks?.length ? `<div class="small warn-text">Risks: ${esc(x.risks.join('; '))}</div>` : ''}
        <div class="row small"><span>${status}</span>${x.ideaId && !r ? `<button data-pl="produce" data-id="${esc(x.ideaId)}">${ico('play')}Produce now</button><button data-pl="skip" data-id="${esc(x.ideaId)}">Skip</button>` : ''}</div></div>`;
    };
    sec.innerHTML = `<h2>Content plan</h2>
      <p class="muted">The Content Director's next 7 days. It uses the background worker's research (cross-checked across sources) and what this browser found, skips topics you already made, avoids near-repeats within 3 days, and drops outdated ideas. In Autonomous Business mode it refreshes on its own.</p>
      <div class="grid2"><div class="card"><h3>${ico('radio')}Research department</h3>
        <div class="op-kv"><span>Background worker</span><b>${w ? `${w.ok ? 'OK' : 'Problem'} · ran ${fmtT(w.at)} · next ${fmtT(w.next)}` : esc(s.workerError ? 'Not reachable: ' + s.workerError : 'Not set up (WORKER.md)')}</b></div>
        ${w?.summary ? `<div class="op-kv"><span>Last run</span><b>${esc(w.summary)}</b></div>` : ''}
        ${w?.sources ? `<div class="small muted">${w.sources.map((x) => `${x.ok ? '✓' : '✕'} ${esc(x.name)}${x.skipped ? ' (skipped: ' + esc(x.skipped) + ')' : x.error ? ' (' + esc(x.error) + ')' : ' ' + (x.count ?? '')}`).join(' · ')}</div>` : ''}
        <div class="op-kv"><span>Research in this browser</span><b>${s.lastResearch ? fmtT(s.lastResearch) : 'not yet'}</b></div>
        <div class="small muted">${rl.map((x) => `${fmtT(x.at)} ${x.by}: ${x.ok ? `${x.investigated} investigated, ${x.found} found` : 'failed ' + esc(x.error || '')}`).join('<br>')}</div>
        <label>Worker data address<input id="plUrl" value="${esc(c.dataUrl)}" placeholder="https://raw.githubusercontent.com/OWNER/REPO/autoclipper-data/data/"></label>
        <label>Creators you have permission to clip (comma separated)<input id="plAuth" value="${esc(c.authorized)}" placeholder="yourname, campaign-creator"></label>
        <div class="row"><button data-pl="pull">${ico('refresh')}Check worker</button><button data-pl="research">${ico('search')}Research now (this browser)</button><button class="primary" data-pl="plan">${ico('calendar')}Rebuild plan</button></div></div>
        <div class="card"><h3>${ico('bulb')}How the Director decides</h3><ul class="small muted">
          <li>Opportunities need evidence: confidence comes from how many independent sources mention the topic.</li>
          <li>Formats that did better on your channel (Stats) are weighted up; this is correlation, not proof.</li>
          <li>Topics you already produced and near-repeats within 3 days are skipped.</li>
          <li>Research older than 7 days expires and is replaced.</li>
          <li>Clip slots only become videos from an authorized source: your VODs, or creators listed here as permitted.</li></ul>
          <div class="op-kv"><span>Plan built</span><b>${p ? fmtT(p.at) + ' · ' + esc(p.source) : 'not yet'}</b></div></div></div>
      <div class="pl-days">${p ? p.days.map((d) => `<div class="pl-day card"><h4>${new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h4>${d.slots.map(slot).join('') || '<p class="muted small">Nothing planned: not enough researched opportunities yet.</p>'}</div>`).join('') : emptyBot('No plan yet. Press Rebuild plan (or switch Operations to Autonomous Business).')}</div>`;
  }
  sec?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pl]'); if (!b) return;
    const a = b.dataset.pl; b.disabled = true;
    try {
      if (a === 'pull') { const r = await pullWorker(); toast(r.ok ? 'Worker data loaded' : 'Worker: ' + r.why); }
      else if (a === 'research') { const r = await researchHere(); toast(r.ok ? `Research: ${r.found} found` : 'Research failed: ' + r.error); }
      else if (a === 'plan') { await buildPlan(); }
      else if (a === 'produce') { if (!FX.channelReady()) { toast('Save your channel config first.'); return; } const i = await FX.db.ideas.get(b.dataset.id); const r = await FX.newRecord({ idea: i }); toast(`${r.id} created; the line will produce it.`); }
      else if (a === 'skip') { const i = await FX.db.ideas.get(b.dataset.id); i.status = 'rejected'; i.rejectReason = 'Skipped by you in the plan'; delete i.priority; await FX.db.ideas.put(i); await buildPlan(); }
      else if (a === 'open') { openTab('line'); return; }
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
    render();
  });
  sec?.addEventListener('change', (e) => { if (e.target.id === 'plUrl') setCfg({ dataUrl: e.target.value.trim() }); if (e.target.id === 'plAuth') setCfg({ authorized: e.target.value.trim() }); });
  document.querySelector('nav button[data-tab="plan"]')?.addEventListener('click', () => setTimeout(render, 30));
  FX.on('ideas', () => { clearTimeout(render.t); render.t = setTimeout(render, 300); });
  FX.planRender = render;
})(window.FX);
