/* AutoClipper 2.0 — INSPECTION BOARD: 10 independent checkers on the finished video.
   Runs inside Final QC, after every department has reported, on the actual rendered file:
     1 Caption accuracy      the export's own audio is transcribed again and compared with the burned-in captions
     2 Caption sync          every caption is compared with when its words are really heard (and with voiced audio)
     3 Audio quality         peak/clipping and loudness measured on the export + the Audio QC report
     4 Visual quality        the Visual QC report (frame sampling of the export)
     5 Hook quality          speech/energy in the first seconds, hook text, the scout's opening score
     6 Context accuracy      the context/fact check and clip-plan honesty findings
     7 Copyright & rights    the rights report (unclear rights always go to a person)
     8 Platform guidelines   the guidelines + safety scan report
     9 Rendering integrity   the file itself: plays, right size, right length, has sound
    10 Overall quality       combines the nine above + the Viral Potential estimate
   Each problem becomes a ticket: problem, severity, timestamp, required action, assigned agent, status.
   Fixable high-severity tickets send the video back to the right agent (max 3 rounds, then a person).
   A checker that could not run says "Not verified"; it never turns into a pass. */
'use strict';
(function (FX) {
  const R = FX.RUN, now = FX.now, item = FX.item;
  const isClip = (r) => r?.type === 'clips';
  const ts = (s) => (s == null ? '' : FX.ts(Math.max(0, s)));
  const span = (a, b) => (a == null ? '' : b == null || Math.abs(b - a) < 0.05 ? ts(a) : `${ts(a)}–${ts(b)}`);
  const CHECKERS = [
    [1, 'Caption accuracy', 'captions'], [2, 'Caption synchronization', 'captions'], [3, 'Audio quality', 'audio'], [4, 'Visual quality', 'qa'], [5, 'Hook quality', 'hook'],
    [6, 'Context accuracy', 'context'], [7, 'Copyright & usage rights', 'rights'], [8, 'Platform guidelines', 'guidelines'], [9, 'Rendering integrity', 'visual'], [10, 'Overall content quality', 'qa'],
  ];
  FX.CHECKERS = CHECKERS;
  // where a fixable ticket goes: agent -> stage
  const FIX_STAGE = { captions: 'captions', audio: 'edit', visual: 'edit', hook: 'script', qa: 'edit' };

  async function loadMeta(blob) {
    const v = document.createElement('video'); v.muted = true; v.preload = 'metadata';
    const u = URL.createObjectURL(blob); v.src = u;
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('cannot be played')); setTimeout(() => rej(new Error('metadata timeout')), 15000); });
      let d = v.duration;
      if (!isFinite(d)) { v.currentTime = 1e7; await new Promise((res) => { v.ondurationchange = res; v.onseeked = res; setTimeout(res, 4000); }); d = v.duration; } // MediaRecorder webm has no duration until seeked
      return { ok: true, width: v.videoWidth, height: v.videoHeight, duration: isFinite(d) ? d : null };
    } catch (e) { return { ok: false, error: e.message }; } finally { URL.revokeObjectURL(u); }
  }

  FX.inspect = async (r, say = () => {}) => {
    const T = (n, problem, severity, at, action, opts = {}) => {
      const [, name, agent] = CHECKERS[n - 1];
      const a = opts.agent || agent;
      return { id: `${r.id}-C${n}-${Math.random().toString(36).slice(2, 6)}`, n, checker: name, problem, severity, at: at || '', action, agent: a, stage: opts.stage !== undefined ? opts.stage : FIX_STAGE[a] || null, status: severity === 'high' ? (opts.human ? 'Needs human review' : 'Needs revision') : 'Noted' };
    };
    const board = CHECKERS.map(([n, name, agent]) => ({ n, name, agent, status: 'pass', score: 100, method: '', tickets: [], notes: '' }));
    const B = (n) => board[n - 1];
    const add = (n, t) => { B(n).tickets.push(t); };
    const blob = r.export?.fileId ? await FX.getFile(r.export.fileId) : null;
    const planned = r.edit?.duration || r.duration || r.export?.duration || null;
    const cues = (r.edit?.captions || r.captions?.cues || []).filter((q) => q && q.text);

    /* 9 — rendering integrity (first: everything else needs a readable file) */
    say('Inspection 9/10: checking the rendered file…');
    let buf = null, meta = null;
    B(9).method = 'file playback metadata + audio decode';
    if (!blob) add(9, T(9, 'No rendered video file', 'high', '', 'Render the video again.', { stage: 'edit' }));
    else {
      if (blob.size < 10_000) add(9, T(9, `Rendered file is only ${blob.size} bytes`, 'high', '', 'Re-render; the export is empty or broken.'));
      meta = await loadMeta(blob);
      if (!meta.ok) add(9, T(9, `The rendered file cannot be played (${meta.error})`, 'high', '', 'Re-render the video.'));
      else {
        if (meta.width !== 1080 || meta.height !== 1920) add(9, T(9, `Video is ${meta.width}×${meta.height}, not 1080×1920 (9:16)`, 'high', '', 'Re-render at 1080×1920.'));
        if (meta.duration != null && planned && Math.abs(meta.duration - planned) > 1.5) add(9, T(9, `File is ${meta.duration.toFixed(1)}s but the edit is ${planned.toFixed(1)}s`, meta.duration < planned - 3 ? 'high' : 'medium', span(Math.min(meta.duration, planned), Math.max(meta.duration, planned)), 'Re-render; part of the video is missing or extra.'));
      }
      try { buf = await FX.decode(blob); } catch { add(9, T(9, 'The audio track of the rendered file cannot be decoded', 'high', '', 'Re-render with sound.')); }
      if (buf) {
        const d = buf.getChannelData(0); let peak = 0; for (let i = 0; i < d.length; i += 2) { const x = Math.abs(d[i]); if (x > peak) peak = x; }
        if (peak < 0.003) add(9, T(9, 'The rendered file is silent', 'high', '', 'Re-render; the audio was lost.'));
      }
      if (r.reports.visualqc?.data?.samples === 0) add(9, T(9, 'No video frames could be sampled from the file', 'high', '', 'Re-render.'));
    }

    /* 3 — audio quality, measured on the export */
    say('Inspection 3/10: measuring the audio…');
    B(3).method = 'peak + loudness measured on the export, plus the Audio QC report';
    if (buf) {
      const d = buf.getChannelData(0), sr = buf.sampleRate; let clipN = 0, first = null;
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.999) { clipN++; if (first == null) first = i / sr; }
      const env = FX.envelope(buf, 0.4).filter((x) => x > -70), sorted = [...env].sort((a, b) => a - b), loud = sorted[Math.floor(sorted.length * 0.7)] ?? -120;
      B(3).notes = `typical loudness ≈ ${loud.toFixed(1)} dBFS RMS`;
      if (clipN > 50) add(3, T(3, `Audio clips/distorts (${clipN} samples at full scale)`, 'high', ts(first), 'Lower the stream gain and re-render.'));
      if (loud < -32) add(3, T(3, `Audio is very quiet (≈${loud.toFixed(0)} dBFS)`, 'medium', '', 'Raise the level; aim for about −14 LUFS.'));
    } else B(3).status = 'unverified';
    for (const i of r.reports.audioqc?.items || []) if (i.sev !== 'low') add(3, T(3, i.issue, i.sev === 'high' ? 'high' : 'medium', i.where, i.fix || 'Fix the audio.'));

    /* 1 + 2 — captions against what is actually heard in the export */
    say('Inspection 1–2/10: listening to the final video and checking every caption…');
    let heard = null;
    if (!cues.length) {
      B(1).status = B(2).status = 'unverified'; B(1).notes = B(2).notes = 'This video has no captions.';
      if (r.reports.captions?.items?.some((i) => /No captions/.test(i.issue))) add(1, T(1, 'No captions (the audio was not transcribed)', 'medium', '', 'Add an OpenAI key so captions can be made.', { stage: null }));
    } else {
      if (buf && FX.hasAI() && !r.practice) {
        B(1).method = 'export audio re-transcribed (Whisper) and aligned word by word with the captions';
        try {
          FX.use('whisper');
          const wav = await segmentWav(buf, 0, buf.duration);
          const tr = await FX.retry(async () => { try { return await transcribe(wav, 'export-check.wav'); } catch (e) { throw /429|5\d\d|network|fetch/i.test(e.message) ? new FX.TempError(e.message) : e; } }, 'inspection transcription');
          FX.cost(r, 'finalqc', 'openai:whisper-1', Math.round(buf.duration), (buf.duration / 60) * FX.prices().whisper_per_min);
          heard = { text: tr?.text || '', words: (tr?.words || []).map((w) => ({ word: String(w.word).trim(), start: +w.start, end: +w.end })) };
        } catch (e) { B(1).status = 'unverified'; B(1).notes = 'Re-transcription failed: ' + e.message; }
      } else { B(1).status = 'unverified'; B(1).notes = r.practice ? 'Practice record' : 'Needs an OpenAI key to listen to the export.'; }
      const capWords = []; cues.forEach((q, qi) => q.text.split(/\s+/).filter(Boolean).forEach((w) => capWords.push({ w, qi })));
      if (heard?.words?.length) {
        const al = FX.align(capWords.map((x) => x.w), heard.words.map((x) => x.word));
        const acc = al.accuracy; B(1).score = Math.round(acc * 100); B(1).notes = `${Math.round(acc * 100)}% of caption words are heard in the final audio`;
        // group missing words into caption ranges
        const bad = new Map(); for (const k of al.missing) { const qi = capWords[k].qi; bad.set(qi, (bad.get(qi) || 0) + 1); }
        const badCues = [...bad.entries()].filter(([qi, n]) => n / cues[qi].text.split(/\s+/).length >= 0.5).map(([qi]) => qi).sort((a, b) => a - b);
        if (acc < 0.8) add(1, T(1, `Captions don't match the audio: only ${Math.round(acc * 100)}% of caption words are heard`, 'high', badCues.length ? span(cues[badCues[0]].start, cues[badCues.at(-1)].end) : '', 'Re-transcribe the final audio and rebuild the affected captions.'));
        else if (badCues.length) add(1, T(1, `${badCues.length} caption(s) show words that are not heard: ${badCues.slice(0, 3).map((qi) => `"${cues[qi].text}"`).join(', ')}`, badCues.length > 3 ? 'medium' : 'low', span(cues[badCues[0]].start, cues[badCues.at(-1)].end), 'Correct those captions from the final audio.'));
        // sync: compare each caption's start with when its first matched word is heard
        B(2).method = 'caption start vs word timing in the final audio + voiced-audio overlap';
        const offs = [];
        for (const [ci, hi] of al.pairs) {
          const qi = capWords[ci].qi; if (capWords.findIndex((x) => x.qi === qi) !== ci) continue; // first word of the cue only
          offs.push({ qi, d: cues[qi].start - heard.words[hi].start });
        }
        if (offs.length) {
          const abs = offs.map((o) => Math.abs(o.d)).sort((a, b) => a - b), med = abs[Math.floor(abs.length / 2)];
          B(2).notes = `median caption offset ${(med * 1000).toFixed(0)} ms over ${offs.length} captions`;
          const late = offs.filter((o) => Math.abs(o.d) > 0.45);
          if (med > 0.35) add(2, T(2, `Captions are out of sync by about ${med.toFixed(2)}s`, 'high', span(cues[late[0]?.qi ?? 0].start, cues[late.at(-1)?.qi ?? cues.length - 1].end), 'Re-time the captions to the final audio.'));
          else if (late.length) add(2, T(2, `${late.length} caption(s) appear more than 0.45s ${late[0].d > 0 ? 'late' : 'early'}`, late.length > 2 ? 'medium' : 'low', span(cues[late[0].qi].start, cues[late.at(-1).qi].end), 'Re-time the affected captions.'));
          B(2).score = Math.max(0, Math.round(100 - med * 200));
        }
      }
      if (buf) { // signal check that needs no AI: captions shown while nobody is speaking
        if (!B(2).method) B(2).method = 'voiced-audio overlap per caption (no transcription available)';
        // only true silence counts (stream audio usually has game sound under the speech, so "quiet" is not "silent")
        const env = FX.envelope(buf, 0.05), thr = -48;
        const silentCues = cues.filter((q) => { const a = Math.floor(q.start / 0.05), b = Math.max(a + 1, Math.ceil((q.end ?? q.start + 0.4) / 0.05)); const seg = env.slice(a, b); return seg.length && seg.filter((x) => x > thr).length / seg.length < 0.2; });
        if (silentCues.length > Math.max(1, cues.length * 0.25)) add(2, T(2, `${silentCues.length} of ${cues.length} captions are on screen while the audio is silent`, 'high', span(silentCues[0].start, silentCues.at(-1).end), 'Re-time the captions to the speech.'));
        else if (silentCues.length) add(2, T(2, `${silentCues.length} caption(s) over silence`, 'low', span(silentCues[0].start, silentCues.at(-1).end), 'Check timing.'));
      } else if (!heard) B(2).status = 'unverified';
    }

    /* 4 — visual quality (Visual QC watched the export frame by frame) */
    B(4).method = r.reports.visualqc?.method || 'Visual QC report';
    if (!r.reports.visualqc) B(4).status = 'unverified';
    for (const i of r.reports.visualqc?.items || []) if (i.sev !== 'low') add(4, T(4, i.issue, i.sev === 'high' ? 'high' : 'medium', i.where, i.fix || 'Fix the visual problem.', { human: /inappropriate/i.test(i.issue), stage: /asset|inappropriate/i.test(i.issue + i.fix) ? 'assets' : 'edit', agent: /asset|inappropriate/i.test(i.issue + i.fix) ? 'background' : 'visual' }));

    /* 5 — hook: the first seconds of the export */
    say('Inspection 5/10: checking the opening seconds…');
    B(5).method = 'speech + energy in the first 2.5 s of the export, hook text, scout opening score';
    let hookScore = 100;
    const hookText = isClip(r) ? r.clip?.hook : r.script?.scenes?.[0]?.onScreen;
    if (!hookText) { hookScore -= 15; add(5, T(5, 'No on-screen hook in the first seconds', 'low', '00:00', 'Add a short hook line.')); }
    else if (FX.words(hookText).length > 9) { hookScore -= 10; add(5, T(5, `Hook text is ${FX.words(hookText).length} words (hard to read in 2 s)`, 'medium', '00:00', 'Cut the hook to 8 words or less.')); }
    if (buf) {
      const env = FX.envelope(buf, 0.1), all = env.filter((x) => x > -70), avg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : -60;
      const first = env.slice(0, 25), voiced = first.filter((x) => x > avg - 8).length / Math.max(1, first.length);
      if (voiced < 0.25) { hookScore -= 35; add(5, T(5, 'The first 2.5 seconds are mostly quiet: viewers swipe before anything happens', 'high', '00:00–00:02.5', 'Start the clip later, on the first line of the setup.')); }
    }
    const firstWord = heard?.words?.[0]?.start;
    if (firstWord != null && firstWord > 2) { hookScore -= 15; add(5, T(5, `First word is heard at ${firstWord.toFixed(1)}s`, 'medium', span(0, firstWord), 'Trim the opening.')); }
    const op = r.idea?.scores?.opening; if (op != null && op < 5) { hookScore -= 10; add(5, T(5, `Clip Scout rated the opening ${op}/10`, 'low', '00:00', 'Consider a different starting point.')); }
    B(5).score = Math.max(0, hookScore);

    /* 6 — context accuracy */
    B(6).method = 'context/fact check + clip plan honesty review';
    for (const k of ['factcheck', 'scriptqc']) for (const i of r.reports[k]?.items || []) if (i.sev !== 'low' && /context|mislead|claim|honest|clickbait|title|personal|threat|fact/i.test(i.where + ' ' + i.issue)) add(6, T(6, i.issue, i.sev === 'high' ? 'high' : 'medium', i.where, i.fix || 'Fix the context.', { human: true }));
    const sa = r.idea?.scores?.standalone ?? r.idea?.scores?.context; if (sa != null && sa < 5) add(6, T(6, `Clip may not make sense on its own (standalone ${sa}/10)`, 'medium', '', 'Add context (intro or on-screen line) or pick a fuller window.', { stage: 'script', agent: 'hook' }));
    if (!r.reports.factcheck) B(6).status = 'unverified';

    /* 7 + 8 — rights and guidelines: those departments decide; serious items always go to a person */
    B(7).method = 'Copyright & Rights report'; B(8).method = 'Guidelines + safety scan report';
    for (const [n, k] of [[7, 'copyright'], [8, 'guidelines']]) {
      const rep = r.reports[k], ov = r.overrides?.[k];
      if (!rep && !ov) { B(n).status = 'unverified'; add(n, T(n, `${FX.dept(k).name} never ran`, 'high', '', 'Run it before publishing.', { human: true, stage: k })); continue; }
      if (ov) { B(n).notes = 'Approved by you: ' + (ov.note || ''); continue; }
      if (rep.verdict === 'HUMAN_REVIEW') add(n, T(n, rep.summary, 'high', '', 'A person must decide.', { human: true, stage: null }));
      for (const i of rep.items || []) if (i.sev === 'medium') add(n, T(n, i.issue, 'medium', i.where, i.fix || '', { stage: null }));
    }

    /* scores per checker */
    for (const b of board) {
      if (b.n === 10) continue;
      const hi = b.tickets.filter((t) => t.severity === 'high').length, me = b.tickets.filter((t) => t.severity === 'medium').length, lo = b.tickets.filter((t) => t.severity === 'low').length;
      if (b.status !== 'unverified') b.status = hi ? 'fail' : me ? 'warn' : 'pass';
      if (![1, 2, 5].includes(b.n) || b.score === 100) b.score = Math.max(0, 100 - hi * 40 - me * 12 - lo * 4);
      else b.score = Math.max(0, Math.min(b.score, 100 - hi * 40 - me * 12 - lo * 4));
      if (b.status === 'unverified') b.score = null;
    }

    /* 17 — Viral Potential (an estimate from measured signals; never a promise) */
    const sc = r.idea?.scores || {}, v10 = (k, d = 5) => (sc[k] != null ? +sc[k] : d) * 10;
    const clarity = [B(1).score, B(2).score, B(3).score].filter((x) => x != null);
    const parts = {
      hook: B(5).score,
      clarity: clarity.length ? Math.round(clarity.reduce((a, b) => a + b, 0) / clarity.length) : 50,
      pacing: Math.round(sc.pacing != null ? v10('pacing') : r.clip?.cuts?.length ? 75 : 60),
      story: Math.round(sc.story != null ? v10('story') : r.reports.scriptqc?.verdict === 'PASS' ? 70 : 55),
      audience: Math.round(sc.interest != null ? v10('interest') : sc.trending != null ? v10('trending') : 50),
    };
    const learned = FX.learned?.() || null;
    const viral = Math.round(parts.hook * 0.25 + parts.clarity * 0.2 + parts.pacing * 0.15 + parts.story * 0.2 + parts.audience * 0.2);
    r.viral = { score: viral, parts, at: now(), note: 'Estimate from hook, clarity, pacing, story and audience-fit signals. Not a prediction of views.' + (learned?.n ? ` Weighted with ${learned.n} of your published videos.` : '') };

    /* 10 — overall */
    const unver = board.filter((b) => b.status === 'unverified' && b.n !== 10).map((b) => b.name);
    const hiAll = board.flatMap((b) => b.tickets).filter((t) => t.severity === 'high');
    B(10).method = 'all checkers + Viral Potential estimate';
    if (hiAll.length) add(10, T(10, `${hiAll.length} must-fix problem(s) from other checkers`, 'high', '', 'Resolve the tickets above.', { stage: null }));
    if (unver.length) add(10, T(10, `Not verified: ${unver.join(', ')}`, 'medium', '', 'Those checks could not run; a person should watch this video before it posts.', { stage: null }));
    const scored = board.filter((b) => b.n !== 10 && b.score != null);
    B(10).score = Math.round((scored.reduce((a, b) => a + b.score, 0) / Math.max(1, scored.length)) * 0.8 + viral * 0.2);
    B(10).status = hiAll.length ? 'fail' : unver.length || board.some((b) => b.status === 'warn') ? 'warn' : 'pass';

    // ticket history: what the last inspection found that is gone now is resolved
    const prev = r.inspection?.tickets || [];
    const tickets = board.flatMap((b) => b.tickets);
    const resolved = prev.filter((p) => p.status !== 'Resolved' && !tickets.some((t) => t.n === p.n && t.problem === p.problem)).map((p) => ({ ...p, status: 'Resolved', resolvedAt: now() }));
    r.inspectionHistory = [...(r.inspectionHistory || []), ...(r.inspection ? [{ at: r.inspection.at, round: r.inspection.round, summary: r.inspection.summary }] : [])].slice(-10);
    r.inspection = {
      at: now(), round: (r.inspection?.round || 0) + 1, board, tickets, resolved: [...(r.inspection?.resolved || []), ...resolved].slice(-40),
      heard: heard ? { text: heard.text.slice(0, 4000), words: heard.words } : null, meta, overall: B(10).score, viral,
      summary: `${board.filter((b) => b.status === 'pass').length} passed · ${board.filter((b) => b.status === 'warn').length} warnings · ${board.filter((b) => b.status === 'fail').length} failed · ${unver.length} not verified`,
    };
    return r.inspection;
  };

  /* Final QC: inspection first; fixable must-fix tickets go back to the responsible agent */
  const baseFinal = R.finalqc;
  R.finalqc = async (r, say = () => {}, o) => {
    const ins = await FX.inspect(r, say);
    const fixable = ins.tickets.filter((t) => t.severity === 'high' && t.status === 'Needs revision' && t.stage);
    const items = ins.tickets.filter((t) => t.n !== 10).map((t) => item(t.severity, `Checker ${t.n} · ${t.checker}${t.at ? ' @ ' + t.at : ''}`, t.problem, `${t.action} (${FX.agent?.(t.agent)?.name || t.agent})`));
    if (fixable.length) {
      const order = FX.STAGES; const to = fixable.map((t) => t.stage).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]; // earliest stage first: later stages re-run anyway
      fixable.forEach((t) => (t.status = t.stage === to ? 'Sent to ' + (FX.agent?.(t.agent)?.name || t.agent) : 'Waiting for re-render'));
      return { verdict: 'FAIL', sendBackTo: to, summary: `Inspection round ${ins.round}: ${fixable.length} fixable problem(s); sent to ${FX.dept(to).name}. ${ins.summary}.`, items, data: { inspection: ins.summary, viral: ins.viral } };
    }
    const rep = await baseFinal(r, say, o);
    rep.items = [...items, ...(rep.items || [])];
    const humanTickets = ins.tickets.filter((t) => t.severity === 'high' && t.status === 'Needs human review');
    if (humanTickets.length && rep.verdict !== 'FAIL') { rep.verdict = 'HUMAN_REVIEW'; rep.summary = `HUMAN REVIEW: ${humanTickets[0].problem}. ` + rep.summary; }
    else if (ins.tickets.some((t) => t.n === 10 && /Not verified/.test(t.problem)) && rep.verdict === 'PASS') rep.verdict = 'WARNING';
    rep.summary = `${rep.summary} Inspection: ${ins.summary}. Overall ${ins.overall}/100 · Viral potential ${ins.viral}/100 (estimate).`;
    rep.score = ins.overall;
    rep.data = { ...(rep.data || {}), inspection: ins.summary, viral: ins.viral };
    return rep;
  };

  /* Caption Specialist fix: when the inspection sent captions back, rebuild them from what is heard in the final audio */
  const baseCaptions = R.captions;
  R.captions = async (r, say, o) => {
    const rep = await baseCaptions(r, say, o);
    const h = r.inspection?.heard, why = r.revisionNote;
    if (why?.from === 'finalqc' && h?.words?.length && r.captions?.cues?.length) {
      say('Re-timing captions to the final audio…');
      const cues = r.captions.cues, capWords = []; cues.forEach((q, qi) => q.text.split(/\s+/).filter(Boolean).forEach((w) => capWords.push({ w, qi })));
      const al = FX.align(capWords.map((x) => x.w), h.words.map((x) => x.word));
      let how;
      if (al.accuracy < 0.8) { // text is wrong: rebuild captions from the words actually heard
        const intro = isClip(r) && r.voice?.scenes?.[0] ? r.voice.scenes[0].dur + 0.25 : 0;
        r.captions.cues = FX.captionChunks(h.words.filter((w) => w.start >= intro - 0.05)).map((k) => ({ start: Math.round(k.start * 100) / 100, end: Math.round(k.until * 100) / 100, text: k.text.replace(/[,;:]$/, ''), ts: k.ts, hl: cues[0]?.hl ? k.text.split(' ').map((w) => /\d/.test(w)) : undefined }));
        how = `rebuilt ${r.captions.cues.length} captions from the final audio (old captions matched ${Math.round(al.accuracy * 100)}%)`;
      } else { // text is right, timing is off: move each caption to when its words are heard
        let moved = 0;
        cues.forEach((q, qi) => {
          const idx = al.pairs.filter(([ci]) => capWords[ci].qi === qi).map(([, hi]) => hi); if (!idx.length) return;
          const s = h.words[idx[0]].start, e = h.words[idx.at(-1)].end;
          if (Math.abs(s - q.start) > 0.08) moved++;
          const len = Math.max(0.35, e - s + 0.12), shift = s - q.start; q.start = Math.round(s * 100) / 100; q.end = Math.round((s + len) * 100) / 100;
          if (q.ts) q.ts = idx.length === q.ts.length ? idx.map((hi) => h.words[hi].start) : q.ts.map((x) => x + shift);
        });
        for (let i = 0; i < cues.length - 1; i++) if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
        how = `re-timed ${moved} caption(s) to the final audio`;
      }
      r.captions.method += ' · fixed after inspection: ' + how;
      rep.summary = `${rep.summary} Revision: ${how}.`;
      FX.hist(r, 'captions', 'revision', how);
    }
    return rep;
  };
})(window.FX);
