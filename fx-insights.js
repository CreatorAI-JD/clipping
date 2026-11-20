/* AutoClipper 2.0 — PRODUCTION ANALYTICS + LEARNING
   1. Production analytics on the Stats tab: everything counted from production records (processed, clips,
      approved, rejected, published, views, likes, comments, shares, retention where YouTube provides it,
      costs, processing time, agent success rates, revision rates) with filters and a daily trend.
   2. The performance database: each published video with stats older than 24 h becomes a row of
      features (type, format/style, length, hook style, caption preset, the scout's 10 scores) and its
      performance relative to the channel's median (so a bigger or smaller audience doesn't skew it).
   3. What's working: differences between groups of your own videos, with sample sizes. Correlation only.
      These findings gently re-weight the Clip Scout's ranking and the Content Director's format choice.
      They never change your settings and never publish anything. */
'use strict';
(function (FX) {
  const now = FX.now, DAY = 864e5;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
  const last = (r) => r.metricsHistory?.[r.metricsHistory.length - 1] || null;
  const lenBucket = (s) => (s == null ? null : s < 20 ? 'under 20 s' : s < 35 ? '20–35 s' : s < 60 ? '35–60 s' : '60 s+');

  /* ---------------- performance database ---------------- */
  FX.perfRows = async () => {
    const recs = await FX.db.prod.all();
    return recs.filter((r) => r.publish && last(r)?.views != null && now() - (r.publish.scheduledFor || r.publish.at) > DAY).map((r) => {
      const m = last(r), len = r.export?.duration || r.duration || null;
      return {
        id: r.id, at: r.publish.scheduledFor || r.publish.at, views: m.views || 0, likes: m.likes || 0, comments: m.comments || 0, shares: m.shares || 0, retention: m.yt?.avgViewPct ?? null,
        type: r.type, format: r.type === 'clips' ? (r.idea?.style || 'clip') : (r.idea?.format || r.script?.format || 'unknown'), len: lenBucket(len), hookStyle: r.script?.hookStyle || r.idea?.hookStyle || null,
        caption: r.captions?.style?.preset || null, layout: r.clip?.layout || null, platforms: r.publish.platforms || [], scores: r.idea?.scores || {}, quality: r.inspection?.overall ?? null, viral: r.viral?.score ?? null,
      };
    });
  };
  FX.learn = async () => {
    const rows = await FX.perfRows();
    const out = { at: now(), n: rows.length, findings: [], dimWeights: {}, formatWeights: {}, hint: '', note: '' };
    if (rows.length < 6) { out.note = `Not enough published videos with stats yet: ${rows.length} of 6 needed. Until then nothing is re-weighted.`; ls.set('fx_learned', out); return out; }
    const med = median(rows.map((x) => x.views)) || 1;
    rows.forEach((x) => { x.rel = x.views / med; x.eng = x.views ? (x.likes + x.comments * 2 + x.shares * 3) / x.views : 0; });
    const group = (key, label) => {
      const g = new Map(); for (const x of rows) { const v = typeof key === 'function' ? key(x) : x[key]; if (v == null) continue; (g.get(v) || g.set(v, []).get(v)).push(x); }
      for (const [v, xs] of g) if (xs.length >= 3 && xs.length < rows.length) {
        const rel = median(xs.map((x) => x.rel)), others = rows.filter((x) => !xs.includes(x)), relO = median(others.map((x) => x.rel)) || 1;
        out.findings.push({ feature: label, value: String(v), n: xs.length, rel: Math.round(rel * 100) / 100, vsOthers: Math.round((rel / relO) * 100) / 100, eng: Math.round(median(xs.map((x) => x.eng)) * 1000) / 10, weak: xs.length < 5 });
      }
    };
    group('format', 'Format / style'); group('len', 'Length'); group('hookStyle', 'Hook style'); group('caption', 'Caption preset'); group('layout', 'Layout'); group('type', 'Line');
    group((x) => (x.retention == null ? null : x.retention >= 70 ? 'retention 70%+' : 'retention under 70%'), 'Retention (YouTube)');
    out.findings.sort((a, b) => Math.abs(Math.log(b.vsOthers)) - Math.abs(Math.log(a.vsOthers)));
    // which of the scout's dimensions go together with better results (rank correlation, needs 6+ videos with that score)
    for (const k of FX.CLIP_DIMS || []) {
      const xs = rows.filter((x) => x.scores[k] != null); if (xs.length < 6) continue;
      const rank = (arr) => { const s = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const rk = []; s.forEach(([, i], j) => (rk[i] = j)); return rk; };
      const a = rank(xs.map((x) => x.scores[k])), b = rank(xs.map((x) => x.rel)), n = xs.length;
      const d2 = a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0), rho = 1 - (6 * d2) / (n * (n * n - 1));
      out.dimWeights[k] = Math.round(Math.max(0.85, Math.min(1.25, 1 + rho * 0.25)) * 100) / 100;
    }
    for (const f of out.findings.filter((x) => x.feature === 'Format / style' && !x.weak)) out.formatWeights[f.value] = Math.max(0.8, Math.min(1.25, f.vsOthers));
    const strong = out.findings.filter((x) => !x.weak && Math.abs(x.vsOthers - 1) >= 0.2).slice(0, 3);
    out.hint = strong.map((f) => `${f.feature} "${f.value}" got ${f.vsOthers >= 1 ? f.vsOthers.toFixed(1) + '× ' : Math.round((1 - f.vsOthers) * 100) + '% fewer '}views than the rest (${f.n} videos)`).join('; ');
    ls.set('fx_learned', out);
    if (strong.length) FX.feedPush?.('performance', `Updated insights from ${rows.length} published videos: ${out.hint}`, null, 'done');
    return out;
  };
  FX.learned = () => ls.get('fx_learned', null);
  setTimeout(() => FX.learn().catch(() => {}), 8000);
  setInterval(() => FX.learn().catch(() => {}), 3 * 3600e3);

  /* ---------------- production analytics (Stats tab) ---------------- */
  const stats = document.querySelector('section#stats');
  const host = document.createElement('div'); host.id = 'prodStats';
  stats?.querySelector('.stats-head')?.after(host);
  const F = ls.get('fx_psFilter', { days: 30, platform: '', cat: '', src: '', status: '' });
  async function render() {
    if (!stats?.classList.contains('active')) return;
    const all = await FX.db.prod.all(), since = F.days ? now() - F.days * DAY : 0;
    const cat = (r) => (r.type === 'clips' ? 'Clip · ' + (r.idea?.style || 'any') : 'Faceless · ' + (r.idea?.format || r.script?.format || 'any'));
    const cats = [...new Set(all.map(cat))].sort(), srcs = [...new Set(all.map((r) => r.clip?.vodName || (r.type === 'clips' ? null : 'research')).filter(Boolean))].sort();
    const recs = all.filter((r) => r.created >= since && (!F.platform || (r.publish?.platforms || []).includes(F.platform)) && (!F.cat || cat(r) === F.cat) && (!F.src || (r.clip?.vodName || 'research') === F.src) && (!F.status || r.status === F.status));
    const pub = recs.filter((r) => r.publish), withM = pub.filter((r) => last(r));
    const tot = (k) => withM.reduce((a, r) => a + (last(r)[k] || 0), 0);
    const ret = withM.map((r) => last(r).yt?.avgViewPct).filter((x) => x != null);
    const cost = recs.reduce((a, r) => a + FX.recCost(r), 0);
    const ms = recs.map((r) => Object.values(r.ledger || {}).reduce((a, L) => a + (L.ms || 0), 0)).filter(Boolean);
    const revised = recs.filter((r) => (r.revisions || []).length).length;
    const vods = FX.vodInbox?.().filter((e) => e.status === 'scanned' && (e.scannedAt || 0) >= since).length || 0;
    const agentSt = FX.agentStatus ? await FX.agentStatus() : {};
    // daily trend
    const days = Math.min(F.days || 30, 60), buckets = Array.from({ length: days }, (_, i) => { const d = new Date(now() - (days - 1 - i) * DAY); d.setHours(0, 0, 0, 0); return { t: d.getTime(), made: 0, posted: 0 }; });
    for (const r of recs) { const b = buckets.find((x) => r.created >= x.t && r.created < x.t + DAY); if (b) b.made++; const p = r.publish && buckets.find((x) => r.publish.at >= x.t && r.publish.at < x.t + DAY); if (p) p.posted++; }
    const mx = Math.max(1, ...buckets.map((b) => Math.max(b.made, b.posted)));
    const chart = `<svg class="ps-chart" viewBox="0 0 ${days * 12} 80" preserveAspectRatio="none" role="img" aria-label="Videos made and published per day">${buckets.map((b, i) => `<rect x="${i * 12 + 1}" y="${78 - (b.made / mx) * 74}" width="5" height="${(b.made / mx) * 74}" fill="#9fb4ff"><title>${new Date(b.t).toLocaleDateString()}: ${b.made} made</title></rect><rect x="${i * 12 + 6}" y="${78 - (b.posted / mx) * 74}" width="5" height="${(b.posted / mx) * 74}" fill="#ff8a65"><title>${new Date(b.t).toLocaleDateString()}: ${b.posted} published</title></rect>`).join('')}</svg>`;
    const L = FX.learned();
    const byCat = new Map(); for (const r of withM) { const k = cat(r); (byCat.get(k) || byCat.set(k, []).get(k)).push(last(r).views || 0); }
    const catRows = [...byCat.entries()].map(([k, v]) => ({ k, n: v.length, med: median(v) })).sort((a, b) => b.med - a.med);
    const kpi = (l, v, tip = '') => `<div class="op-stat" title="${esc(tip)}"><b>${v}</b><span>${esc(l)}</span></div>`;
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, l]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    host.innerHTML = `<div class="card"><div class="row"><h3>${ico('chart')}Production analytics</h3><span class="muted small">From your production records. Views/likes/comments/shares only where the platforms report them.</span></div>
      <div class="row ps-filters">${sel('psDays', [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'All time']], F.days)}${sel('psPlat', [['', 'All platforms'], ...['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'threads'].map((p) => [p, p])], F.platform)}${sel('psCat', [['', 'All categories'], ...cats.map((c) => [c, c])], F.cat)}${sel('psSrc', [['', 'All sources'], ...srcs.map((s) => [s, s])], F.src)}${sel('psStatus', [['', 'Any status'], ...['live', 'scheduled', 'awaiting_approval', 'needs_human', 'rejected', 'error', 'queued'].map((s) => [s, s])], F.status)}</div>
      <div class="op-stats">${kpi('Source videos processed', vods)}${kpi('Videos produced', recs.length)}${kpi('Clips rendered', recs.filter((r) => r.export).length)}${kpi('Approved', recs.filter((r) => r.approval?.approved).length)}${kpi('Rejected', recs.filter((r) => r.status === 'rejected').length)}${kpi('Published', pub.length)}
        ${kpi('Total views', num(tot('views')))}${kpi('Average views', withM.length ? num(tot('views') / withM.length) : '–')}${kpi('Likes', num(tot('likes')))}${kpi('Comments', num(tot('comments')))}${kpi('Shares', num(tot('shares')))}${kpi('Avg retention (YouTube)', ret.length ? Math.round(ret.reduce((a, x) => a + x, 0) / ret.length) + '%' : '–', 'Average view percentage from YouTube Analytics; other platforms do not provide it')}
        ${kpi('Production cost', FX.money(cost))}${kpi('Avg processing time', ms.length ? Math.round(ms.reduce((a, x) => a + x, 0) / ms.length / 1000) + ' s' : '–')}${kpi('Revision rate', recs.length ? Math.round((revised / recs.length) * 100) + '%' : '–')}</div>
      <h4>Made <span style="color:#9fb4ff">■</span> and published <span style="color:#ff8a65">■</span> per day</h4>${chart}
      <div class="grid2"><div><h4>Agent success rates</h4><div class="ps-agents">${(FX.AGENTS || []).filter((a) => agentSt[a.key]?.runs).map((a) => { const s = agentSt[a.key]; return `<div><span>${esc(a.name)}</span><i style="width:${Math.round((s.ok / s.runs) * 100)}%"></i><b>${Math.round((s.ok / s.runs) * 100)}%</b><small>${s.runs} runs</small></div>`; }).join('') || '<p class="muted small">No agent runs yet.</p>'}</div></div>
      <div><h4>Strongest categories</h4>${catRows.length ? `<div class="ps-cats">${catRows.map((c) => `<div><span>${esc(c.k)}</span><b>${num(c.med)}</b><small>median views · ${c.n} video${c.n > 1 ? 's' : ''}</small></div>`).join('')}</div>` : '<p class="muted small">No published videos with stats in this range.</p>'}</div></div>
      <h4>What's working (learning)</h4>${L?.findings?.length ? `<div class="ps-find">${L.findings.slice(0, 8).map((f) => `<div class="${f.vsOthers >= 1 ? 'up' : 'down'}"><b>${esc(f.feature)}: ${esc(f.value)}</b> ${f.vsOthers >= 1 ? '▲' : '▼'} ${f.vsOthers.toFixed(2)}× the rest · ${f.n} videos · engagement ${f.eng}%${f.weak ? ' · <i>weak evidence</i>' : ''}</div>`).join('')}</div>
        <p class="disc">ⓘ Comparisons between your own videos, normalised to your median views. They show what went together with better results, not proof that it caused them. Used to gently re-weight the Clip Scout and Content Director; your settings are never changed automatically.${Object.keys(L.dimWeights || {}).length ? ' Scout weights: ' + Object.entries(L.dimWeights).map(([k, v]) => `${k} ×${v}`).join(', ') + '.' : ''}</p>` : `<p class="muted small">${esc(L?.note || 'Insights appear after 6 published videos have stats.')}</p>`}</div>`;
  }
  host.addEventListener('change', (e) => {
    const m = { psDays: 'days', psPlat: 'platform', psCat: 'cat', psSrc: 'src', psStatus: 'status' }[e.target.id]; if (!m) return;
    F[m] = m === 'days' ? +e.target.value : e.target.value; ls.set('fx_psFilter', F); render();
  });
  document.querySelector('nav button[data-tab="stats"]')?.addEventListener('click', () => setTimeout(render, 50));
  FX.on('analytics', render);
  FX.prodStatsRender = render;
})(window.FX);
