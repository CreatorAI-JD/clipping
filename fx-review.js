/* AutoClipper 2.0 — PROFESSIONAL REVIEW
   Adds to every video's record and to the Review Queue:
   - the 10-checker inspection board with its tickets, and the scores (overall, hook, captions, context, viral estimate)
   - "Why the AI chose this clip": the Clip Scout's 10 dimension scores, rank among candidates, method and transcript
   - the stage ledger: every stage's agent, start, finish, duration, score, decision and attempts
   - actions: edit captions, change the title, re-render, request a revision, compare clips side by side */
'use strict';
(function (FX) {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
  const dur = (ms) => (!ms ? '–' : ms < 1000 ? ms + ' ms' : ms < 60e3 ? (ms / 1000).toFixed(1) + ' s' : (ms / 60e3).toFixed(1) + ' min');
  const fmtS = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
  const STAT = { pass: ['Pass', 'c-ok'], warn: ['Warning', 'c-warn'], fail: ['Fail', 'c-bad'], unverified: ['Not verified', 'c-unv'] };
  const scoreChip = (label, v, tip = '') => `<span class="rv-score ${v == null ? 'c-unv' : v >= 80 ? 'c-ok' : v >= 60 ? 'c-warn' : 'c-bad'}" title="${esc(tip)}"><b>${v == null ? '–' : v}</b>${esc(label)}</span>`;

  FX.reviewScores = (r) => {
    const b = r.inspection?.board || [], g = (n) => b.find((x) => x.n === n);
    const cap = [g(1)?.score, g(2)?.score].filter((x) => x != null);
    return { overall: r.inspection?.overall ?? null, hook: g(5)?.score ?? null, captions: cap.length ? Math.round(cap.reduce((a, x) => a + x, 0) / cap.length) : null, context: g(6)?.score ?? null, viral: r.viral?.score ?? null };
  };
  const scoresRow = (r) => { const s = FX.reviewScores(r); return `<div class="rv-scores">${scoreChip('Quality', s.overall, 'overall from the 10 checkers')}${scoreChip('Hook', s.hook)}${scoreChip('Captions', s.captions)}${scoreChip('Context', s.context)}${scoreChip('Viral est.', s.viral, 'an estimate from measured signals, not a promise of views')}</div>`; };

  function inspectionHtml(r) {
    const ins = r.inspection; if (!ins) return '';
    return `<details class="rep" open><summary>${ico('check')} <b>Quality inspection</b> <span class="muted small">round ${ins.round} · ${esc(ins.summary)}</span></summary>
      ${scoresRow(r)}
      <div class="rv-board">${ins.board.map((b) => { const [lbl, cls] = STAT[b.status] || [b.status, '']; return `<div class="rv-chk ${cls}"><span class="rv-n">${b.n}</span><b>${esc(b.name)}</b><span class="rv-st">${lbl}${b.score != null ? ' · ' + b.score : ''}</span><small>${esc(b.method || '')}${b.notes ? ' · ' + esc(b.notes) : ''}</small></div>`; }).join('')}</div>
      ${ins.tickets.length ? `<h4>Tickets</h4><div class="rv-tickets">${ins.tickets.map((t) => `<div class="rv-t sev-${t.severity}"><div><b>Problem:</b> ${esc(t.problem)}</div><div class="small"><b>Severity:</b> ${esc(t.severity)} · <b>Timestamp:</b> ${esc(t.at || '–')} · <b>Checker:</b> ${t.n} ${esc(t.checker)}</div><div class="small"><b>Required action:</b> ${esc(t.action)} · <b>Assigned agent:</b> ${esc(FX.agent?.(t.agent)?.name || t.agent)} · <b>Status:</b> ${esc(t.status)}</div></div>`).join('')}</div>` : '<p class="ok-line">✓ No open tickets</p>'}
      ${ins.resolved?.length ? `<details><summary class="small">${ins.resolved.length} resolved ticket(s) from earlier rounds</summary>${ins.resolved.map((t) => `<div class="small muted">✓ ${esc(t.checker)}: ${esc(t.problem)} (${esc(t.at || '')})</div>`).join('')}</details>` : ''}
      ${r.viral ? `<p class="disc">ⓘ Viral potential ${r.viral.score}/100: hook ${r.viral.parts.hook}, clarity ${r.viral.parts.clarity}, pacing ${r.viral.parts.pacing}, story ${r.viral.parts.story}, audience fit ${r.viral.parts.audience}. ${esc(r.viral.note)}</p>` : ''}</details>`;
  }
  function whyHtml(r) {
    const i = r.idea; if (!i) return '';
    const dims = (FX.CLIP_DIMS || []).filter((k) => i.scores?.[k] != null);
    const cl = r.clip;
    return `<details class="rep" ${r.status === 'awaiting_approval' ? 'open' : ''}><summary>${ico('search')} <b>Why the AI chose this ${r.type === 'clips' ? 'clip' : 'topic'}</b> <span class="muted small">rank ${i.rank ?? '–'}${i.rankPos ? ` · #${i.rankPos} of ${i.of} candidates` : ''}${i.priority ? ` · Content plan slot #${i.priority}` : ''}</span></summary>
      <p class="small">${esc(i.description || '')}</p>
      ${dims.length ? `<div class="rv-dims">${dims.map((k) => `<div><span>${esc(k)}</span><i style="width:${i.scores[k] * 10}%"></i><b>${i.scores[k]}</b></div>`).join('')}</div>` : ''}
      <p class="muted small">Method: ${esc(i.method || (r.type === 'clips' ? '' : 'AI + trend signals'))}${i.found ? ` · found by ${esc(i.found)}` : ''}${i.style ? ` · style: ${esc(i.style)}` : ''}</p>
      ${cl ? `<p class="small"><b>Source:</b> ${esc(cl.vodName)} · ${fmtS(cl.start)}–${fmtS(cl.start + cl.len)} in the VOD · ${cl.outLen ? cl.outLen.toFixed(1) : cl.len.toFixed(1)}s after edits${cl.cuts?.length ? ` (${cl.cuts.length} jump cut(s))` : ''}</p>` : ''}
      ${i.transcript ? `<div class="quote">"${esc(i.transcript.slice(0, 500))}"</div>` : ''}
      ${(i.sources || []).length ? `<p class="small">Sources: ${i.sources.slice(0, 4).map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title || 'source')}</a>` : esc(s.title || '')).join(' · ')}</p>` : ''}</details>`;
  }
  function ledgerHtml(r) {
    const L = r.ledger || {}; const keys = FX.STAGES.filter((k) => L[k]);
    if (!keys.length) return '';
    return `<details class="rep"><summary>${ico('flag')} <b>Production ledger</b> <span class="muted small">${keys.length} stage(s) · ${dur(keys.reduce((a, k) => a + (L[k].ms || 0), 0))} total</span></summary>
      <div class="rv-ledger"><div class="lg h"><span>Stage</span><span>Agent</span><span>Status</span><span>Start</span><span>Done</span><span>Time</span><span>Score</span><span>Runs</span></div>
      ${keys.map((k) => { const x = L[k]; const last = x.runs?.at(-1) || {}; return `<details class="lg-row"><summary class="lg"><span>${esc(FX.dept(k).name)}</span><span>${esc(FX.agent?.(x.agent)?.name || x.agent || '')}</span><span class="st-${esc(x.status)}">${esc(x.status)}</span><span>${tm(x.firstStart)}</span><span>${tm(x.lastEnd)}</span><span>${dur(x.ms)}</span><span>${x.score ?? '–'}</span><span>${x.runs?.length || 0}</span></summary>
        <div class="small lg-detail">${esc(x.output || '')}${last.decision ? `<br><b>Manager:</b> ${esc(last.decision)}` : ''}${x.errors?.length ? `<br><b>Errors:</b> ${x.errors.map((e) => esc(e.message)).join(' | ')}` : ''}${x.runs?.length > 1 ? `<br><b>Revision history:</b> ${x.runs.map((rn, i) => `#${i + 1} ${esc(rn.status)}${rn.score != null ? ' (' + rn.score + ')' : ''}${rn.revision ? ' after: ' + esc(rn.reason.slice(0, 80)) : ''}`).join(' → ')}` : ''}</div></details>`; }).join('')}</div></details>`;
  }
  function actionsHtml(r) {
    if (!r.export && !r.captions) return '';
    const cues = r.captions?.cues || [];
    const pp = r.publishPrep?.platforms || {};
    return `<details class="rep" id="rvEdit"><summary>${ico('edit')} <b>Edit this video</b> <span class="muted small">captions, title, re-render, revision request</span></summary>
      ${cues.length ? `<label>Captions (one per line: start-end text). Saving re-renders the video and re-runs every check.<textarea id="rvCaps" rows="8">${esc(cues.map((q) => `${q.start.toFixed(2)}-${q.end.toFixed(2)} ${q.text}`).join('\n'))}</textarea></label><div class="row"><button data-rv="saveCaps">${ico('check')}Save captions & re-render</button></div>` : ''}
      ${Object.keys(pp).length ? `<label>Custom title (all platforms)<input id="rvTitle" value="${esc(Object.values(pp)[0]?.title || '')}"></label><div class="row"><button data-rv="title">${ico('pen')}Change title</button></div>` : ''}
      <label>Revision request for the agents (what should change)<input id="rvReq" placeholder="e.g. start 2 seconds later, the hook oversells it"></label>
      <div class="row"><select id="rvTo">${['script', 'captions', 'edit'].map((k) => `<option value="${k}">${esc(FX.dept(k).name)} (${esc(FX.agent?.(FX.agentFor?.(k, r))?.name || '')})</option>`).join('')}</select><button data-rv="request">${ico('repeat')}Request revision</button><button data-rv="rerender">${ico('film')}Re-render</button></div></details>`;
  }
  // a reviewer's revision request is closed once the agent it went to has finished its stage again
  FX.on('stage:end', ({ r, run }) => { if (run.revision && r.reports?.you && /completed/.test(run.status)) { (r.yourRequests ||= []).push({ ...r.reports.you, doneAt: Date.now(), by: run.agent }); delete r.reports.you; } });
  FX.recordExtras = (r) => `${inspectionHtml(r)}${whyHtml(r)}${actionsHtml(r)}${ledgerHtml(r)}`;

  /* Review Queue cards with scores, source, timestamps; select several to compare */
  const CMP = new Set();
  document.addEventListener('change', (e) => { const id = e.target.dataset?.cmp; if (id) e.target.checked ? CMP.add(id) : CMP.delete(id); });
  FX.needCard = (r, ctx) => {
    const s = FX.reviewScores(r), cl = r.clip, len = r.export?.duration || r.duration;
    return `<div class="need-wrap"><label class="cmp" title="Compare"><input type="checkbox" data-cmp="${esc(r.id)}" ${CMP.has(r.id) ? 'checked' : ''}></label><button class="need-card" data-open="${r.id}"><span class="nc-top"><b>${esc(r.id)}</b>${ctx.stBadge(r.status)}</span><span class="nc-t">${esc(ctx.title(r))}</span>
      ${r.inspection ? scoresRow(r) : ''}
      <span class="muted small">${cl ? `${esc(cl.vodName)} · ${fmtS(cl.start)}–${fmtS(cl.start + cl.len)} · ` : ''}${len ? len.toFixed(0) + 's · ' : ''}${esc(r.status === 'awaiting_approval' ? `Final QC: ${r.final?.decision || '–'} · monetization risk ${r.monetization?.level || '–'}${r.autopilot && !r.autopilot.ok ? ' · Autopilot held it: ' + r.autopilot.why.join('; ') : ''}` : r.humanReason || r.blocked || r.error || '')}</span>
      <span class="nc-go">${r.status === 'awaiting_approval' ? 'Review & approve →' : 'Decide →'}</span></button></div>`;
  };
  async function compare(ids) {
    const recs = (await Promise.all(ids.map((id) => FX.db.prod.get(id)))).filter(Boolean);
    const box = $('#rvCompare') || Object.assign(document.createElement('div'), { id: 'rvCompare', className: 'card' });
    $('#fxNeeds')?.before(box);
    const urls = [];
    const cols = await Promise.all(recs.map(async (r) => { const v = r.export?.fileId ? await FX.getFile(r.export.fileId) : null; const u = v ? URL.createObjectURL(v) : null; if (u) urls.push(u); const s = FX.reviewScores(r);
      return `<div class="rv-col">${u ? `<video src="${u}" controls playsinline preload="metadata"></video>` : '<div class="novid">No video yet</div>'}<b>${esc(r.id)}</b><span class="small">${esc(r.script?.title || r.idea?.topic || '')}</span>${scoresRow(r)}
        <div class="small muted">${esc(r.idea?.description || '')}</div><div class="small">Open tickets: ${(r.inspection?.tickets || []).filter((t) => t.severity !== 'low').length} · rank ${r.idea?.rank ?? '–'} · ${(r.export?.duration || 0).toFixed(0)}s</div>
        <button data-open="${esc(r.id)}">Open</button></div>`; }));
    box.innerHTML = `<div class="row"><h3>${ico('eye')}Side by side</h3><button data-rv="closeCmp" class="small-btn">Close</button></div><div class="rv-cmp">${cols.join('')}</div>`;
    box._urls?.forEach(URL.revokeObjectURL); box._urls = urls;
  }

  /* actions */
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rv]'); if (!b) return;
    const a = b.dataset.rv;
    if (a === 'closeCmp') { $('#rvCompare')?._urls?.forEach(URL.revokeObjectURL); $('#rvCompare')?.remove(); return; }
    if (a === 'compare') { const ids = [...CMP]; if (ids.length < 2) return toast('Tick two or more videos to compare.'); return compare(ids); }
    const id = FX.currentRecordId?.(); if (!id) return;
    const r = await FX.db.prod.get(id); if (!r) return;
    b.disabled = true;
    try {
      if (a === 'saveCaps') {
        const cues = [];
        for (const line of $('#rvCaps').value.split('\n')) { const m = line.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s+(.+)$/); if (m && +m[2] > +m[1]) cues.push({ start: +m[1], end: +m[2], text: m[3].trim(), hl: m[3].trim().split(/\s+/).map((w) => /\d/.test(w)) }); }
        if (!cues.length) return toast('No valid caption lines (format: 1.20-2.40 text).');
        r.captions.cues = cues.sort((x, y) => x.start - y.start); r.captions.method += ' · edited by you';
        FX.sendBack(r, 'edit', 'you', 'Captions edited by you: re-render and re-check'); r.approval = null; r.humanReason = null;
        await FX.saveRecord(r); await FX.audit('captions edited', `${cues.length} captions`, id, 'you'); toast('Captions saved. The video will be re-rendered and every check runs again.');
      } else if (a === 'title') {
        const t = $('#rvTitle').value.trim(); if (!t) return;
        for (const p of Object.values(r.publishPrep?.platforms || {})) { p.titles = [...new Set([t, ...(p.titles || [])])]; p.title = t; }
        if (r.script) r.script.title = t;
        FX.hist(r, 'approval', 'title changed', t); await FX.saveRecord(r); await FX.audit('title changed', t, id, 'you'); toast('Title changed.');
      } else if (a === 'request' || a === 'rerender') {
        const to = a === 'rerender' ? 'edit' : $('#rvTo').value, why = a === 'rerender' ? 'Re-render requested by you' : ($('#rvReq').value.trim() || 'Revision requested by you');
        if (FX.humanSendBack) await FX.humanSendBack(id, to, why); else { FX.sendBack(r, to, 'you', why); await FX.saveRecord(r); }
        const x = await FX.db.prod.get(id);
        // the agents read the request like any checker report
        x.reports.you = { verdict: 'FAIL', summary: why, items: [FX.item('high', 'Your request', why, 'Do what the reviewer asked.')], at: Date.now() };
        x.revisionNote = { from: 'you', reason: why, at: Date.now() };
        await FX.saveRecord(x);
        FX.feedPush?.('revision', `Received ${id} from you: "${why}" → ${FX.dept(to).name}`, id, 'warn');
        toast(`Sent to ${FX.dept(to).name}. The line picks it up next.`);
      }
      FX.openRecordById?.(id);
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  });
})(window.FX);
