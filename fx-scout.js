/* AutoClipper: Moment Scout upgrades
   - Look at the footage (video understanding): grabs a few small frames around each moment so the
     AI ranking sees what happens on screen, not only what is said.
   - Retention scorecard: hook (first 3 s), pacing (from word timings), story and payoff, with tips.
   - Search moments: find scanned moments by words, titles or what's on screen, or ask the AI in plain English.
   Loaded after fx-core.js and before fx-clips.js. */
(function (FX) {
  'use strict';
  const S = (FX.scout = { q: '' });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ---------- video understanding: frames ---------- */
  // Returns small JPEG data URLs at the given times (seconds). Unplayable files return [].
  S.frames = async (file, times, width = 384) => {
    if (!file || !times.length || typeof document === 'undefined') return [];
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
    const out = [];
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('unplayable')); setTimeout(() => rej(new Error('timeout')), 15000); });
      const w = width, h = Math.round(width * ((v.videoHeight || 9) / (v.videoWidth || 16)));
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d');
      for (const t of times) {
        v.currentTime = clamp(t, 0, Math.max(0, (v.duration || t) - 0.1));
        await new Promise((res) => { v.onseeked = res; setTimeout(res, 5000); });
        if (!v.videoWidth) continue;
        g.drawImage(v, 0, 0, w, h);
        out.push(c.toDataURL('image/jpeg', 0.6));
      }
    } catch { /* audio-only or unsupported codec: ranking falls back to the transcript */ }
    finally { URL.revokeObjectURL(v.src); v.removeAttribute('src'); }
    return out;
  };
  // Where to look for a moment: just before, on, and just after the hype peak.
  S.frameTimes = (m) => [m.peak - 4, m.peak, m.peak + 3].map((t) => clamp(t, m.start, m.start + m.len));

  /* ---------- retention: pacing from word timings ---------- */
  // words: [{word,start,end}] relative to the moment window. Measured only on the part that will be the clip.
  S.pacing = (words, from, to) => {
    const ws = (words || []).filter((w) => w.end > from && w.start < to);
    const dur = Math.max(1, to - from);
    if (!ws.length) return { wps: 0, firstWord: null, longestGap: dur, deadAir: 1, score: null };
    let gap = ws[0].start - from, dead = Math.max(0, gap - 0.7), longest = Math.max(0, gap);
    for (let i = 1; i < ws.length; i++) {
      const g = ws[i].start - ws[i - 1].end;
      longest = Math.max(longest, g); if (g > 0.7) dead += g - 0.7;
    }
    const tail = to - ws[ws.length - 1].end; if (tail > 0.7) dead += tail - 0.7;
    const wps = ws.length / dur, firstWord = Math.max(0, ws[0].start - from), deadAir = clamp(dead / dur, 0, 1);
    // 2-3.5 words/s is a lively stream; long silences are where viewers swipe (game audio can still carry it)
    let score = 10;
    if (wps < 1.2) score -= 3; else if (wps < 2) score -= 1.5;
    if (firstWord > 2.5) score -= 2; else if (firstWord > 1.2) score -= 1;
    score -= clamp(deadAir * 10, 0, 4);
    if (longest > 4) score -= 1;
    return { wps: Math.round(wps * 10) / 10, firstWord: Math.round(firstWord * 10) / 10, longestGap: Math.round(longest * 10) / 10, deadAir: Math.round(deadAir * 100) / 100, score: Math.round(clamp(score, 1, 10)) };
  };

  // Combines the AI's hook/story/payoff with measured pacing into a 0-100 retention estimate and tips.
  S.retention = (a, pace, energy) => {
    const hook = clamp(+a.hookScore || 0, 0, 10) || null, story = clamp(+a.story || 0, 0, 10) || null, payoff = clamp(+a.payoff || 0, 0, 10) || null;
    const pacing = pace?.score ?? (energy ? clamp(Math.round(energy * 4), 3, 8) : null);
    const parts = [[hook, 0.4], [pacing, 0.2], [story, 0.2], [payoff, 0.2]].filter(([v]) => v != null);
    if (!parts.length) return null;
    const wsum = parts.reduce((s, [, w]) => s + w, 0);
    const score = Math.round((parts.reduce((s, [v, w]) => s + v * w, 0) / wsum) * 10);
    const tips = [];
    if (hook != null && hook < 6) tips.push('Weak first 3 seconds: start closer to the action or lean on the on-screen hook.');
    if (pace?.firstWord > 1.5) tips.push(`First words come ${pace.firstWord}s in: trim the start.`);
    if (pace?.deadAir > 0.25) tips.push(`About ${Math.round(pace.deadAir * 100)}% quiet time: jump cuts will tighten it.`);
    if (story != null && story < 5) tips.push('Little setup: a short commentary intro would give strangers context.');
    if (payoff != null && payoff < 5) tips.push('Ending is flat: end right on the reaction.');
    for (const t of (a.retentionTips || []).slice(0, 2)) if (typeof t === 'string' && t.trim()) tips.push(t.trim().slice(0, 160));
    return { score, hook, pacing, story, payoff, pace: pace || null, tips: [...new Set(tips)].slice(0, 4) };
  };

  /* ---------- search moments ---------- */
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  S.haystack = (i) => [i.topic, i.hook, i.description, i.see, i.transcript, i.vodName, (i.concerns || []).join(' ')].join(' ');
  // keyword search: every word must appear (prefix match); titles and on-screen descriptions weigh more
  S.match = (i, q) => {
    const terms = norm(q).split(/\s+/).filter(Boolean); if (!terms.length) return 1;
    const fields = [[norm(i.topic) + ' ' + norm(i.hook), 3], [norm(i.see), 2], [norm(i.description), 1.5], [norm(i.transcript) + ' ' + norm(i.vodName), 1]];
    let total = 0;
    for (const t of terms) {
      const re = new RegExp('(^|\\s)' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      let best = 0; for (const [f, w] of fields) if (re.test(f)) best = Math.max(best, w);
      if (!best) return 0; total += best;
    }
    return total;
  };
  S.filter = (ideas, q) => {
    if (!q || !q.trim()) return ideas;
    if (S.aiHits && S.aiHits.q === q) return S.aiHits.ids.map((id) => ideas.find((i) => i.id === id)).filter(Boolean);
    return ideas.map((i) => [i, S.match(i, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  };
  // plain-English search ("when he gets arrested", "funny NPC") over scanned moments
  S.askAI = async (q) => {
    const ms = (await FX.db.ideas.all()).filter((i) => i.type === 'moment').slice(-120);
    if (!ms.length) return [];
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const j = await FX.ai(null, 'trends', 'You search a library of stream clip moments. Return only moments that really match the request.',
      `Request: "${q}"\n\nMoments:\n${ms.map((m) => `${m.id} | ${m.vodName} @ ${fmt(m.start)} | ${m.topic} | seen: ${m.see || '-'} | said: "${(m.transcript || '').slice(0, 260)}"`).join('\n')}\n\nReturn JSON {"matches":[{"id": string, "why": short reason}]} best first, at most 12.`, { temperature: 0.1 });
    const ids = (j?.matches || []).map((x) => x.id).filter((id) => ms.some((m) => m.id === id));
    S.aiHits = { q, ids, why: Object.fromEntries((j?.matches || []).map((x) => [x.id, x.why])) };
    return ids;
  };

  /* ---------- UI pieces used by the Ideas & VODs pane ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  S.searchBar = (shown, total) => `<div class="card scout-search"><label for="fxScoutQ"><b>Search moments</b> <span class="muted small">words said, titles, or what's on screen</span></label>
      <div class="row"><input id="fxScoutQ" type="search" placeholder="e.g. crash, police chase, he laughs" value="${esc(S.q)}" autocomplete="off">
      <button data-act="scoutAsk" ${FX.hasAI() ? '' : 'disabled title="Needs an OpenAI key"'}>Ask AI</button><button data-act="scoutClear">Clear</button></div>
      <p class="muted small" id="fxScoutCount" aria-live="polite" ${S.q ? '' : 'hidden'}>${shown} of ${total} match${S.aiHits?.q === S.q ? ' (AI search)' : ''}.</p></div>`;
  S.hayAttr = (i) => esc(JSON.stringify({ topic: i.topic, hook: i.hook, see: i.see, description: i.description, transcript: (i.transcript || '').slice(0, 1500), vodName: i.vodName, concerns: i.concerns }));
  S.card = (i) => {
    const rt = i.retention; let h = '';
    if (i.see) h += `<div class="small">${'<span class="muted">On screen:</span> ' + esc(i.see)}</div>`;
    if (S.aiHits?.q === S.q && S.aiHits.why?.[i.id]) h += `<div class="small"><span class="muted">Match:</span> ${esc(S.aiHits.why[i.id])}</div>`;
    if (rt) {
      const bar = (l, v) => v == null ? '' : `<span class="rt-p"><span>${l}</span><b>${v}</b></span>`;
      h += `<details class="rt"><summary><span class="rt-s">Retention ${rt.score}/100</span>${bar('Hook', rt.hook)}${bar('Pacing', rt.pacing)}${bar('Story', rt.story)}${bar('Payoff', rt.payoff)}</summary>
        ${rt.pace ? `<p class="muted small">${rt.pace.wps} words/s · first words at ${rt.pace.firstWord ?? '-'}s · longest pause ${rt.pace.longestGap}s · ${Math.round(rt.pace.deadAir * 100)}% quiet</p>` : ''}
        ${rt.tips?.length ? `<ul class="small">${rt.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="small ok-line">No retention problems spotted.</p>'}</details>`;
    }
    return h;
  };
  S.applyDom = () => {
    const box = document.querySelector('#fxPane .ideas'); if (!box) return;
    // live keyword filtering without re-rendering (keeps typing smooth); AI results re-render the pane
    const q = S.q.trim(); let n = 0, total = 0;
    box.querySelectorAll('.idea[data-hay]').forEach((el) => { total++; let ok = true; try { ok = !q || S.match(JSON.parse(el.dataset.hay), q) > 0; } catch {} el.hidden = !ok; if (ok) n++; });
    const c = document.getElementById('fxScoutCount'); if (c) { c.hidden = !q; c.textContent = `${n} of ${total} match.`; }
  };
  if (typeof document !== 'undefined') {
    let t = null;
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'fxScoutQ') return;
      S.q = e.target.value; S.aiHits = null; clearTimeout(t);
      t = setTimeout(S.applyDom, 120);
    });
    document.addEventListener('keydown', (e) => { if (e.target.id === 'fxScoutQ' && e.key === 'Enter' && FX.hasAI() && S.q.trim()) { e.preventDefault(); document.querySelector('[data-act="scoutAsk"]')?.click(); } });
    document.addEventListener('click', async (e) => {
      const b = e.target.closest?.('[data-act="scoutAsk"],[data-act="scoutClear"]'); if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === 'scoutClear') { S.q = ''; S.aiHits = null; return FX.renderLine?.(); }
      const q = (document.getElementById('fxScoutQ')?.value || '').trim(); if (!q) return;
      S.q = q; b.disabled = true; b.textContent = 'Searching…';
      try { await S.askAI(q); } catch (err) { (window.toast || console.warn)('AI search failed: ' + err.message); }
      b.blur(); FX.renderLine?.();
    }, true);
  }
})(window.FX);
