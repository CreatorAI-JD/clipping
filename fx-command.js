/* AutoClipper 2.0 — Workshop command center: the 20 agents and the live activity feed.
   Every value shown comes from FX.agentStatus() (engine state + stage ledgers) and FX.feed() (logged events). */
'use strict';
(function (FX) {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ws = $('#workshop'); if (!ws) return;
  const SCLS = { Idle: 'idle', Analyzing: 'busy', Working: 'busy', Reviewing: 'busy', 'Waiting for another agent': 'wait', 'Fixing an issue': 'fix', Completed: 'done', Failed: 'bad' };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = (ms) => (!ms ? '–' : ms < 1000 ? ms + ' ms' : ms < 60e3 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 60e3) + ' min');
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? Math.round(s) + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };

  const box = document.createElement('div'); box.id = 'acCommand';
  box.innerHTML = `<div class="card ac-team"><div class="row"><h3>${ico('bot')}AI production team</h3><span class="muted small" id="acTeamSum"></span>
      <select id="acFilter" aria-label="Show agents"><option value="all">All 20 agents</option><option value="active">Only busy / waiting / failed</option></select></div>
      <div class="ac-grid" id="acGrid"></div></div>
    <div class="card ac-feed"><div class="row"><h3>${ico('message')}Live production activity</h3><span class="muted small">Real events from the line, newest first</span><button id="acFeedClear" class="small-btn">Clear</button></div>
      <div class="ac-log" id="acLog" role="log" aria-live="polite"></div></div>`;
  const now0 = $('#fxNow'); now0 ? now0.after(box) : ws.prepend(box);
  // the 20 pipeline stations are now "Pipeline stages" under the team
  const floorTitle = document.createElement('h3'); floorTitle.className = 'ws-title'; floorTitle.innerHTML = `Pipeline stages <span class="muted small">where each video is; tap a stage for its reports</span>`;
  $('#fxFloor')?.before(floorTitle);

  let filter = ls.get('fx_acFilter', 'all');
  $('#acFilter').value = filter;
  $('#acFilter').onchange = (e) => { filter = e.target.value; ls.set('fx_acFilter', filter); paintTeam(); };
  $('#acFeedClear').onclick = () => { if (!confirm('Clear the activity feed? Production records keep their full history.')) return; ls.set('fx_feed', []); location.reload(); };

  async function paintTeam() {
    if (!ws.classList.contains('active')) return;
    const st = await FX.agentStatus();
    const busy = Object.values(st).filter((s) => !['Idle', 'Completed'].includes(s.status)).length;
    $('#acTeamSum').textContent = `${busy} of 20 active`;
    const list = FX.AGENTS.filter((a) => filter === 'all' || !['Idle', 'Completed'].includes(st[a.key].status));
    $('#acGrid').innerHTML = list.map((a) => {
      const s = st[a.key], cls = SCLS[s.status] || 'idle';
      return `<div class="ac-card ${cls}" title="${esc(a.role)}">
        <div class="ac-top"><span class="ac-ico" style="color:${a.color}">${ico(a.icon)}</span><b>${esc(a.name)}</b><span class="ac-st ${cls}">${esc(s.status)}</span></div>
        <div class="ac-task">${esc(s.task || (s.status === 'Idle' ? 'Nothing assigned' : ''))}</div>
        ${s.progress != null ? `<div class="bar"><i style="width:${s.progress}%"></i></div>` : ['busy', 'fix'].includes(cls) ? '<div class="bar indet"><i></i></div>' : ''}
        <div class="ac-meta">${s.recId ? `<button class="linkish" data-open="${esc(s.recId)}">${esc(s.recId)}</button>` : ''}
          <span title="runs that finished ok / runs">${s.runs ? `${s.ok}/${s.runs} ok` : 'no runs yet'}</span><span title="average processing time">${dur(s.avgMs)}</span></div>
        ${s.last ? `<div class="ac-last" title="Last completed task">${s.last.ok ? '✓' : '✕'} ${esc(s.last.text).slice(0, 120)} · ${ago(s.last.at)}</div>` : ''}
        ${s.errors.length ? `<div class="ac-err">${esc(s.errors[0].message).slice(0, 120)} (${esc(s.errors[0].recId)})</div>` : ''}
      </div>`;
    }).join('') || '<p class="muted small">No agents are busy right now.</p>';
  }
  function paintFeed() {
    if (!ws.classList.contains('active')) return;
    const f = FX.feed().slice(0, 80);
    $('#acLog').innerHTML = f.length ? f.map((e) => `<div class="ac-ev ${esc(e.kind)}"><time>${clock(e.at)}</time><b>${esc(FX.agent(e.agent)?.name || e.agent)}</b><span>${esc(e.text)}</span>${e.recId ? `<button class="linkish" data-open="${esc(e.recId)}">${esc(e.recId)}</button>` : ''}</div>`).join('')
      : '<p class="muted small">No activity yet. Start the line (or drop a VOD on the Assembly Line) and every assignment, result, revision and decision shows up here.</p>';
  }
  let t1 = null;
  const soon = () => { clearTimeout(t1); t1 = setTimeout(() => { paintTeam(); paintFeed(); }, 150); };
  ['feed', 'records', 'tick', 'working', 'stage:start', 'stage:end'].forEach((k) => FX.on(k, soon));
  document.querySelector('nav button[data-tab="workshop"]')?.addEventListener('click', soon);
  setInterval(() => { if (document.visibilityState === 'visible') paintTeam(); }, 5000);
  soon();
  FX.command = { paintTeam, paintFeed };
})(window.FX);
