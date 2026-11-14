/* AutoClipper — Publish Gate.
   The last checkpoint before anything leaves the app. Every upload path (the assembly line AND the older
   Stream Clipper / Faceless / Autopilot / Review Queue path) has to pass through here:
   - free OpenAI moderation scan (omni-moderation) of what is said, the on-screen text, the title/caption and sampled frames
   - the platform checklists (whole-word keyword rules)
   - rights + reused-content checks for stream clips
   - a final re-check right before upload (reports present, nothing unresolved, metadata still clean)
   Internal checks only: platforms make the final call. Nothing here is a guarantee. */
(function (FX) {
  'use strict';
  const R = FX.RUN, now = FX.now, item = FX.item;
  const ok3 = ['youtube', 'tiktok', 'instagram'];

  /* ---------------- OpenAI moderation (free endpoint) ---------------- */
  // What each moderation category means for us. GTA is a violent game: fictional gameplay violence alone is fine.
  const CAT = {
    'sexual/minors': { sev: 'block', label: 'sexual content involving minors' },
    'hate/threatening': { sev: 'high', label: 'threatening hate speech' },
    'hate': { sev: 'high', label: 'hate speech / slurs' },
    'harassment/threatening': { sev: 'high', label: 'threats against a person' },
    'self-harm/instructions': { sev: 'high', label: 'self-harm instructions' },
    'self-harm/intent': { sev: 'high', label: 'self-harm intent' },
    'self-harm': { sev: 'high', label: 'self-harm' },
    'sexual': { sev: 'high', label: 'sexual content' },
    'illicit/violent': { sev: 'high', label: 'real-world violent wrongdoing instructions' },
    'violence/graphic': { sev: 'medium', label: 'graphic violence / gore (limits ads, may be age-restricted)' },
    'harassment': { sev: 'medium', label: 'harassment / insults aimed at someone' },
    'illicit': { sev: 'low', label: 'talk about crime (normal in GTA RP; fine unless it is real-world advice)' },
    'violence': { sev: 'low', label: 'violence (normal for GTA gameplay)' },
  };
  const ORDER = Object.keys(CAT);

  async function modCall(input) {
    const key = val('apiKey'); if (!key) throw new Error('no OpenAI key');
    const j = await FX.retry(() => FX.fetchJSON('https://api.openai.com/v1/moderations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'omni-moderation-latest', input }),
    }, 'OpenAI moderation'), 'moderation');
    return j.results || [];
  }
  // texts: [{where, text}], images: [{where, url}] → { ran, flags: [{sev, where, cat, label, score}], error }
  FX.moderate = async (texts = [], images = []) => {
    const out = { ran: false, flags: [], error: null, at: now() };
    if (!val('apiKey')) { out.error = 'No OpenAI key, so the automatic safety scan could not run.'; return out; }
    const take = (res, where) => {
      for (const cat of ORDER) {
        if (!res?.categories?.[cat]) continue;
        // keep only the most specific flagged category per family (hate/threatening over hate, etc.)
        if (out.flags.some((f) => f.where === where && f.cat.startsWith(cat + '/'))) continue;
        out.flags.push({ ...CAT[cat], cat, where, score: Math.round((res.category_scores?.[cat] || 0) * 100) / 100 });
      }
    };
    try {
      const tx = texts.filter((t) => t.text && t.text.trim());
      if (tx.length) (await modCall(tx.map((t) => t.text.slice(0, 8000)))).forEach((res, i) => take(res, tx[i].where));
      for (const im of images.slice(0, 4)) { const [res] = await modCall([{ type: 'image_url', image_url: { url: im.url } }]); take(res, im.where); }
      out.ran = true;
    } catch (e) { out.error = 'Automatic safety scan failed: ' + e.message; }
    return out;
  };
  const modItems = (m) => m.flags.map((f) => item(f.sev, `Safety scan · ${f.where}`, `Flagged: ${f.label} (score ${f.score})`, f.sev === 'block' ? 'This can never be posted.' : f.sev === 'high' ? 'Watch it. Cut the moment or reject the clip if it is real.' : f.sev === 'medium' ? 'Check it; consider trimming.' : ''));

  // checklist keyword rules for the given platforms
  FX.ruleHits = (text, plats) => {
    const items = [];
    for (const p of plats) {
      const pol = FX.policy(p);
      for (const rule of pol.rules || []) for (const k of rule.keywords || []) if (FX.hasPhrase(text, k)) items.push(item(rule.severity === 'block' ? 'high' : 'medium', `${pol.name} · ${rule.id}`, `Matches "${k}": ${rule.text}`, 'Rephrase or remove.'));
    }
    return items;
  };
  const verdictOf = (items) => items.some((i) => i.sev === 'block') ? 'BLOCK' : items.some((i) => i.sev === 'high') ? 'HUMAN_REVIEW' : items.some((i) => i.sev === 'medium') ? 'WARNING' : 'PASS';

  /* ---------------- Assembly line: Guidelines QC gets the safety scan ---------------- */
  const baseGuidelines = R.guidelines;
  R.guidelines = async (r, say, o) => {
    const rep = await baseGuidelines(r, say, o);
    if (r.practice) return rep;
    say('Running the safety scan on what is said, the text and sampled frames…');
    const s = r.script || { scenes: [] };
    const texts = [
      { where: r.type === 'clips' ? 'stream audio' : 'narration', text: s.scenes.filter((x) => r.type !== 'clips' || x.streamAudio).map((x) => x.vo).join(' ') },
      { where: 'commentary intro', text: r.type === 'clips' ? s.scenes.filter((x) => !x.streamAudio).map((x) => x.vo).join(' ') : '' },
      { where: 'on-screen text & title', text: [s.title, ...s.scenes.map((x) => x.onScreen)].filter(Boolean).join(' | ') },
    ];
    const frames = r.reports.visualqc?.data?.frames || {};
    const images = Object.keys(frames).map(Number).sort((a, b) => a - b).filter((_, i, a) => a.length <= 4 || i % Math.ceil(a.length / 4) === 0).map((k) => ({ where: `frame ${k + 1}`, url: frames[k] }));
    const m = await FX.moderate(texts, images);
    r.moderation = m;
    rep.items = [...(rep.items || []), ...modItems(m)];
    if (!m.ran) rep.items.push(item('high', 'Safety scan', m.error || 'did not run', 'Watch the whole video yourself before approving.'));
    const block = m.flags.some((f) => f.sev === 'block');
    rep.items.forEach((i) => { if (i.sev === 'block') i.sev = 'high'; });
    rep.method = `${rep.method || 'keyword rules'} + OpenAI moderation (${m.ran ? `${texts.filter((t) => t.text).length} text parts, ${images.length} frames` : 'did not run'})`;
    if (block) { r.hardBlock = 'Safety scan: ' + m.flags.filter((f) => f.sev === 'block').map((f) => f.label).join(', '); return { ...rep, verdict: 'REJECTED', summary: `Rejected: ${r.hardBlock}. This video can never be published.` }; }
    if (rep.items.some((i) => i.sev === 'high') && rep.verdict !== 'HUMAN_REVIEW') { rep.verdict = 'HUMAN_REVIEW'; rep.summary = m.ran ? 'The safety scan flagged something. A person must watch it and decide.' : 'The safety scan could not run. A person must watch it and decide.'; }
    else if (rep.verdict === 'PASS' && rep.items.some((i) => i.sev === 'medium')) rep.verdict = 'WARNING';
    return rep;
  };

  /* ---------------- Assembly line: last check right before upload ---------------- */
  FX.gatePassed = new Set();
  FX.recordGate = async (r) => {
    const why = [], c = FX.channel();
    let sendBackTo = null;
    const fail = (msg, to) => { why.push(msg); if (to && !sendBackTo) sendBackTo = to; };
    if (r.hardBlock) fail(r.hardBlock);
    if (!r.approval?.approved) fail('no approval on record', 'approval');
    for (const k of ['copyright', 'guidelines', 'monetization', 'finalqc']) {
      const rep = r.reports?.[k], ov = r.overrides?.[k];
      if (!rep && !ov) fail(`${FX.dept(k).name} never ran`, k);
      else if (!ov && rep.verdict === 'FAIL') fail(`${FX.dept(k).name} failed: ${rep.summary}`, k);
      else if (!ov && rep.verdict === 'HUMAN_REVIEW') fail(`${FX.dept(k).name} is waiting for a person: ${rep.summary}`, k);
      else if (rep?.verdict === 'REJECTED') fail(`${FX.dept(k).name} rejected it`);
    }
    const d = r.final?.decision;
    if (!r.overrides?.finalqc && !['APPROVED', 'APPROVED WITH WARNING'].includes(d)) fail(`Final QC decision is ${d || 'missing'}`, 'finalqc');
    // the video must not have changed after it was inspected
    const editAt = r.reports?.edit?.at || 0;
    for (const k of ['copyright', 'guidelines', 'monetization']) if (r.reports?.[k] && r.reports[k].at < editAt) fail(`the video was re-edited after ${FX.dept(k).name} looked at it`, 'audioqc');
    if (r.approval?.by !== 'you' && (r.monetization?.level === 'HIGH' || Object.keys(r.overrides || {}).length)) fail('auto-approval is not allowed for HIGH monetization risk or hand-approved steps', 'approval');
    if (r.type === 'clips' && !c.streamerRelation && !r.overrides?.assets) fail('whose streams these are is not set (Channel → Streams & rights)', 'assets');
    // final metadata may have been edited after Guidelines QC: scan exactly what will be posted
    const plats = (c.platforms || []).filter((p) => r.publishPrep?.platforms?.[p]);
    const meta = plats.map((p) => { const m = r.publishPrep.platforms[p]; return `${m.title}\n${m.description}`; }).join('\n');
    const hits = FX.ruleHits(meta.toLowerCase(), plats.filter((p) => ok3.includes(p))).filter((i) => i.sev === 'high');
    if (hits.length) fail('the final title/description matches a blocked rule: ' + hits.map((i) => i.issue).join('; '), 'prep');
    const sig = meta;
    if (val('apiKey') && r.gateMetaSig !== sig) {
      const m = await FX.moderate([{ where: 'final title & description', text: meta }]);
      const bad = m.flags.filter((f) => ['block', 'high'].includes(f.sev));
      if (bad.length) fail('the final title/description was flagged: ' + bad.map((f) => f.label).join(', '), 'prep');
      else if (m.ran) r.gateMetaSig = sig;
    }
    r.gate = { at: now(), ok: !why.length, why };
    return { ok: !why.length, why, sendBackTo };
  };
  const basePublish = R.publish;
  R.publish = async (r, say, o) => {
    if (r.practice || FX.stopped()) return basePublish(r, say, o);
    say('Publish gate: re-checking every inspection report and the final metadata…');
    const g = await FX.recordGate(r);
    if (!g.ok) {
      await FX.audit('publish gate stopped upload', g.why.join(' | '), r.id, 'system');
      if (r.hardBlock) return { verdict: 'REJECTED', summary: 'Publish gate: ' + g.why.join('; '), items: g.why.map((w) => item('high', 'Publish gate', w, '')) };
      r.approval = null;
      return { verdict: 'FAIL', sendBackTo: g.sendBackTo || 'finalqc', summary: 'Publish gate stopped the upload: ' + g.why.join('; '), items: g.why.map((w) => item('high', 'Publish gate', w, 'Resolve it, then approve again.')) };
    }
    FX.gatePassed.add(r.id); FX.gatePassed.add('fx_' + r.id);
    try { return await basePublish(r, say, o); }
    finally { FX.gatePassed.delete(r.id); FX.gatePassed.delete('fx_' + r.id); }
  };

  /* ---------------- Older path: Stream Clipper / Faceless / Autopilot / Review Queue ---------------- */
  async function grabFrames(blob, n = 3) {
    const out = [];
    if (!(blob instanceof Blob)) return out;
    const v = document.createElement('video'), u = URL.createObjectURL(blob);
    v.muted = true; v.preload = 'auto'; v.src = u;
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; setTimeout(rej, 8000); });
      let dur = v.duration;
      if (!isFinite(dur)) { v.currentTime = 1e7; await new Promise((res) => { v.ontimeupdate = res; setTimeout(res, 3000); }); dur = v.duration; v.ontimeupdate = null; }
      if (!isFinite(dur) || dur <= 0) return out;
      const cv = document.createElement('canvas'); cv.width = 270; cv.height = 480; const g = cv.getContext('2d');
      for (let i = 0; i < n; i++) {
        v.currentTime = dur * (i + 0.5) / n;
        await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
        g.drawImage(v, 0, 0, cv.width, cv.height);
        out.push({ where: `frame at ${Math.round(v.currentTime)}s`, url: cv.toDataURL('image/jpeg', 0.6) });
      }
    } catch {} finally { URL.revokeObjectURL(u); }
    return out;
  }
  FX.gateClip = async (clip) => {
    const c = FX.channel(), items = [];
    const plats = (typeof selectedPlatforms === 'function' ? selectedPlatforms() : c.platforms || []).filter((p) => ok3.includes(p));
    const text = [clip.title, clip.caption, clip.transcript].filter(Boolean).join('\n');
    items.push(...FX.ruleHits(text.toLowerCase(), plats.length ? plats : ok3));
    if (!clip.transcript) items.push(item('high', 'What is said', 'No transcript (no OpenAI key or transcription failed), so nothing could check what is said in it.', 'Watch it with sound before approving.'));
    const m = await FX.moderate([{ where: 'what is said', text: clip.transcript || '' }, { where: 'title & caption', text: `${clip.title || ''}\n${clip.caption || ''}` }], await grabFrames(clip.blob, 3));
    items.push(...modItems(m));
    if (!m.ran) items.push(item('high', 'Safety scan', m.error || 'did not run', 'Watch the whole video yourself before approving.'));
    if (clip.kind === 'clip') {
      const rel = c.streamerRelation;
      if (!rel) items.push(item('high', 'Rights', 'Whose streams these are is not set (Assembly Line → Channel → Streams & rights).', 'Set it before posting clips.'));
      else if (rel === 'none') items.push(item('high', 'Rights', 'No permission recorded to clip this streamer: copyright strikes and no monetization.', 'Get written permission or clip your own streams.'));
      else if (rel === 'permission') items.push(item('medium', 'Reused content', 'Clips from this quick clipper have no commentary. YouTube can judge them "reused content" even with the streamer\'s permission.', 'Use the Assembly Line (commentary intros, smarter edits) for monetized channels.'));
      if (/♪|\(music\)|\[music\]/i.test(clip.transcript || '')) items.push(item('high', 'Music', 'Music is playing in this clip (GTA radio songs trigger Content ID claims).', 'Listen; reject it if a song is audible.'));
      items.push(item('low', 'Music', 'GTA radio and background music can trigger Content ID claims even when the transcript misses them.', 'Listen before approving.'));
    } else if (clip.kind === 'faceless') {
      items.push(item('medium', 'Facts', 'Quick faceless scripts are not fact-checked.', 'Use the Assembly Line (it verifies facts against sources) for anything you want monetized.'));
    }
    const verdict = verdictOf(items);
    clip.gate = { at: now(), verdict, items, moderation: m.ran, summary: verdict === 'PASS' ? 'All checks passed.' : `${items.filter((i) => i.sev !== 'low').length} thing(s) to check.` };
    if (verdict === 'BLOCK') clip.gate.summary = 'Blocked by the safety scan. This video can never be posted.';
    return clip.gate;
  };
  // throws unless the clip passed the gate, or a person looked at the gate's findings and approved anyway
  FX.assertClipPublishable = async (clip) => {
    if (FX.stopped()) throw new Error('Emergency stop is on. Release it first.');
    if (clip.prodId) { // made by the assembly line: its own inspection record decides
      const r = await FX.db.prod.get(clip.prodId);
      if (!r) throw new Error('Publish gate: production record missing');
      const g = await FX.recordGate(r); await FX.saveRecord(r);
      if (!g.ok) throw new Error('Publish gate: ' + g.why.join('; '));
      FX.gatePassed.add(clip.id); return;
    }
    if (!clip.gate) { await FX.gateClip(clip); await putClip(clip); }
    const g = clip.gate;
    if (g.verdict === 'BLOCK') throw new Error('Publish gate: ' + g.summary);
    if (g.verdict !== 'PASS' && !(clip.gateAck && clip.gateAck.gateAt === g.at)) throw new Error(`Publish gate: needs your review first (${g.summary})`);
    FX.gatePassed.add(clip.id);
  };
  FX.gateText = (g) => !g ? '' : `${{ PASS: 'Checks passed', WARNING: 'Warnings', HUMAN_REVIEW: 'Needs your review', BLOCK: 'Blocked' }[g.verdict]}${g.items?.filter((i) => i.sev !== 'low').length ? ': ' + g.items.filter((i) => i.sev !== 'low').map((i) => i.issue).join(' · ') : ''}`;
})(window.FX);
