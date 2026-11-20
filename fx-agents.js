/* AutoClipper 2.0 — THE AI PRODUCTION TEAM
   Twenty specialised agents on top of the production line in fx-core.js. Each agent owns real code paths
   (stages and checks); its status is computed from what the engine is actually doing:
   - the stage the Production Manager is running right now and the progress text that stage reports,
   - each video's stage ledger (fx-core.js: every run's start, end, outcome, score, errors),
   - revision hand-offs and manager decisions.
   Nothing here animates on a timer or invents progress. The activity feed is a log of real events.

   All agents share one production record per video (r): every agent reads what earlier agents wrote
   (moment scores, transcript, clip plan, captions, reports, inspection tickets) and writes its own part. */
'use strict';
(function (FX) {
  const now = FX.now;
  const isClip = (r) => r?.type === 'clips';

  /* ---------------- the roster ----------------
     stages: which production stages this agent works on (per line); match: progress text that means this
     agent (rather than a teammate on the same stage) is the one working; kind decides the busy status word. */
  const A = (key, n, name, icon, color, kind, role, stages, match) => ({ key, n, name, icon, color, kind, role, stages, match });
  FX.AGENTS = [
    A('manager', 1, 'Production Manager', 'compass', '#b69cff', 'lead', 'Runs the line: assigns each video to the next agent, tracks progress and errors, decides whether a failure is retried, revised or escalated, and whether a video is ready for the next stage.', { clips: [], faceless: [] }),
    A('intel', 2, 'Video Intelligence', 'eye', '#9fb4ff', 'analysis', 'Reads the whole source video: audio energy over the full VOD, transcription of candidate windows (or the entire VOD in Deep analysis), speech, laughter and reaction patterns, chat/clip markers.', { clips: ['trends'], faceless: [] }, /reading the audio|transcrib|deep analysis|listening|decod/i),
    A('scout', 3, 'Clip Scout', 'search', '#9fb4ff', 'analysis', 'Scores every candidate on 10 dimensions (opening, interest, story, context, entertainment, conversation, emotion, pacing, ending, clarity), removes near-duplicates and ranks them. Faceless: picks the topic from research.', { clips: ['trends'], faceless: ['trends'] }, /rank|finding|moment|scor|candidate|idea|trend|signal|pick/i),
    A('hook', 4, 'Hook Specialist', 'bolt', '#ff9ec7', 'work', 'Finds the strongest natural first 1–3 seconds and the on-screen hook without misrepresenting the speaker; runs the hook checker on the render.', { clips: ['script'], faceless: ['script'] }, /hook|cut, hook|opening/i),
    A('context', 5, 'Context Checker', 'shield', '#ffe08a', 'review', 'Makes sure a clip makes sense on its own, nothing important is missing and the edit is not misleading. Faceless: verifies every claim against sources.', { clips: ['factcheck'], faceless: ['factcheck'] }),
    A('retention', 6, 'Retention Editor', 'scissors', '#ff9ec7', 'work', 'Snaps cuts to word boundaries, finishes sentences and jump-cuts dead air (never the hype peak).', { clips: ['script', 'edit'], faceless: [] }, /dead air|jump|planning the cut|trim/i),
    A('captions', 7, 'Caption Specialist', 'message', '#ff9ec7', 'work', 'Word-level captions from the real audio, synced through jump cuts, styled with the caption preset; fixes caption tickets.', { clips: ['captions'], faceless: ['captions'] }),
    A('visual', 8, 'Visual Editor', 'film', '#ff7a6b', 'work', 'Chooses the vertical layout (blur, facecam, split-screen hook), keeps the action framed, renders 1080×1920.', { clips: ['edit'], faceless: ['edit'] }, /render|layout|frame|export|timeline/i),
    A('audio', 9, 'Audio Specialist', 'headphones', '#ffe08a', 'review', 'Levels speech to about −14 LUFS, compresses and limits; inspects the export for clipping, silence and noise.', { clips: ['voice', 'audioqc'], faceless: ['voice', 'audioqc'] }),
    A('sfx', 10, 'Sound Design', 'bolt', '#ff7a6b', 'work', 'Adds a sound effect only where it helps (intro whoosh, transitions); music stays under speech.', { clips: ['edit'], faceless: ['edit'] }, /mix|music|sfx|sound/i),
    A('background', 11, 'Background Specialist', 'image', '#ff7a6b', 'work', 'Faceless: finds licensed footage per script section and records its license. Clips: picks licensed split-screen fillers.', { clips: ['assets'], faceless: ['assets'] }),
    A('story', 12, 'Storytelling', 'pen', '#e48ad0', 'work', 'Beginning, middle, payoff: writes faceless scripts from verified facts and reviews clip plans for a clear arc.', { clips: ['scriptqc'], faceless: ['script', 'scriptqc'] }),
    A('platform', 13, 'Platform Optimization', 'tag', '#7cf7d4', 'work', 'Per-platform titles, descriptions, hashtags and format rules (TikTok, Shorts, Reels); repetition and monetization risk.', { clips: ['monetization', 'prep'], faceless: ['monetization', 'prep'] }),
    A('rights', 14, 'Copyright & Rights', 'copyright', '#ffe08a', 'review', 'Checks the origin and license of every asset and the streamer permission record; unclear rights stop publishing.', { clips: ['copyright'], faceless: ['copyright'] }),
    A('guidelines', 15, 'Content Guidelines', 'file', '#ffe08a', 'review', 'Safety scan of what is said, shown and written against each platform checklist; serious issues go to a person.', { clips: ['guidelines'], faceless: ['guidelines'] }),
    A('qa', 16, 'Quality Assurance', 'check', '#ffe08a', 'review', 'Watches the actual rendered file and runs the 10 independent checkers; files a ticket for every problem.', { clips: ['visualqc', 'finalqc'], faceless: ['visualqc', 'finalqc'] }, /watch|frame|checker|inspect|sampl/i),
    A('viral', 17, 'Viral Potential', 'trending', '#7cf7d4', 'analysis', 'Scores hook, clarity, pacing, story and audience fit from the checkers and the scout scores. An estimate, never a promise of views.', { clips: ['finalqc'], faceless: ['finalqc'] }, /viral|potential|scor/i),
    A('revision', 18, 'Revision Agent', 'repeat', '#ff9ec7', 'work', 'Takes failed checks, turns them into targeted fix instructions for the right agent and sends the video back for another review (max 3 rounds).', { clips: [], faceless: [] }),
    A('publishing', 19, 'Publishing Manager', 'send', '#7cf7d4', 'work', 'Waits for approval (or your auto-publish rule), schedules into posting windows, uploads once, records results and errors.', { clips: ['approval', 'publish'], faceless: ['approval', 'publish'] }),
    A('performance', 20, 'Performance Analyst', 'chart', '#3fcf9f', 'analysis', 'Collects real platform stats, compares videos against your account baseline and feeds what works back to the Clip Scout, Hook Specialist and editors.', { clips: ['monitor'], faceless: ['monitor'] }),
  ];
  FX.agent = (k) => FX.AGENTS.find((a) => a.key === k);
  const lineOf = (r) => (isClip(r) ? 'clips' : 'faceless');
  FX.agentsFor = (stage, r) => FX.AGENTS.filter((a) => (a.stages[lineOf(r)] || []).includes(stage)).map((a) => a.key);
  // the agent that leads a stage (the ledger records it)
  const LEAD = { trends: { clips: 'intel', faceless: 'scout' }, script: { clips: 'hook', faceless: 'story' }, edit: { clips: 'visual', faceless: 'visual' }, finalqc: { clips: 'qa', faceless: 'qa' }, voice: { clips: 'audio', faceless: 'audio' }, monetization: { clips: 'platform', faceless: 'platform' }, approval: { clips: 'publishing', faceless: 'publishing' } };
  FX.agentFor = (stage, r) => LEAD[stage]?.[lineOf(r)] || FX.agentsFor(stage, r)[0] || 'manager';

  /* ---------------- live state (in memory) + persisted summary ---------------- */
  const live = { stage: null, recId: null, line: null, text: '', at: 0, active: null, sub: {} };
  const recent = ls.get('fx_agentRecent', {}); // agent -> { at, text, recId, ok }
  const saveRecent = () => ls.set('fx_agentRecent', recent);
  const FEED_MAX = 400;
  let feed = ls.get('fx_feed', []);
  const push = (agent, text, recId = null, kind = 'info') => {
    feed.unshift({ at: now(), agent, text: String(text).slice(0, 300), recId, kind });
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    ls.set('fx_feed', feed);
    FX.emit('feed');
  };
  FX.feed = () => feed;
  FX.feedPush = push;

  // which agent on the current stage is doing the work, from the stage's own progress text
  function activeAgent(stage, r, text) {
    const team = FX.agentsFor(stage, r);
    const hit = team.map(FX.agent).find((a) => a.match && a.match.test(text || ''));
    return hit?.key || FX.agentFor(stage, r);
  }

  FX.on('stage:start', ({ r, key, run }) => {
    Object.assign(live, { stage: key, recId: r.id, line: lineOf(r), text: 'Starting…', at: now(), active: FX.agentFor(key, r), revision: !!run.revision });
    const d = FX.dept(key), lead = FX.agent(FX.agentFor(key, r));
    push('manager', `Assigned ${r.id} to ${lead.name} (${d.name}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}${run.revision ? ', revision' : ''}).`, r.id, 'assign');
  });
  FX.on('working', (w) => {
    if (!w) return;
    const r = { type: live.line === 'clips' ? 'clips' : 'faceless' };
    const a = activeAgent(w.key, r, w.text);
    live.text = w.text; live.at = now();
    if (a !== live.active) { live.active = a; push(a, w.text, w.id, 'work'); }
  });
  FX.on('stage:end', ({ r, key, run }) => {
    const a = run.agent || FX.agentFor(key, r), d = FX.dept(key);
    const ok = ['completed', 'completed_warn', 'waiting'].includes(run.status);
    recent[a] = { at: now(), text: `${d.name}: ${run.summary || run.error || run.status}`, recId: r.id, ok, status: run.status };
    saveRecent();
    const what = run.status === 'completed' ? 'finished' : run.status === 'completed_warn' ? 'finished with warnings' : run.status === 'sent_back' ? 'found problems' : run.status === 'retry' ? 'hit a temporary error' : run.status === 'failed' ? 'failed' : run.status === 'needs_human' ? 'needs a person' : run.status;
    push(a, `${what} on ${r.id} (${d.name}${run.score != null ? `, score ${run.score}` : ''}): ${run.summary || run.error || ''}`, r.id, ok ? 'done' : run.status === 'retry' || run.status === 'sent_back' ? 'warn' : 'bad');
    if (run.decision && !ok) push('manager', `${r.id}: ${run.decision}`, r.id, 'decision');
    Object.assign(live, { stage: null, recId: null, text: '', active: null });
  });
  FX.on('manager', ({ r, text, kind }) => { if (kind !== 'decision') return; push('manager', `${r.id}: ${text}`, r.id, 'decision'); });
  FX.on('revision', ({ r, from, to, n, items }) => {
    const target = FX.agentFor(to, r);
    push('revision', `Received ${r.id} from ${FX.dept(from).name}. Round ${n}/${FX.MAX_REVISIONS}: ${items.length ? items.slice(0, 2).map((i) => i.issue).join('; ') : 'see report'} → ${FX.agent(target).name}`, r.id, 'warn');
    recent.revision = { at: now(), text: `Routed ${r.id} back to ${FX.dept(to).name}`, recId: r.id, ok: true, status: 'completed' };
    saveRecent();
  });

  /* ---------------- status of every agent, from real data ---------------- */
  const BUSY = { analysis: 'Analyzing', review: 'Reviewing', work: 'Working', lead: 'Working' };
  FX.agentStatus = async () => {
    const recs = await FX.db.prod.all(), M = FX.manager, w = M.working, wr = w ? recs.find((x) => x.id === w.id) : null;
    const out = {};
    // per-agent totals from every video's ledger
    const tot = {};
    for (const r of recs) for (const [key, L] of Object.entries(r.ledger || {})) {
      for (const run of L.runs || []) {
        for (const a of new Set([run.agent, ...FX.agentsFor(key, r)].filter(Boolean))) {
          const t = (tot[a] ||= { runs: 0, ok: 0, fail: 0, ms: 0, errors: [] });
          t.runs++; t.ms += run.ms || 0;
          if (['completed', 'completed_warn', 'waiting'].includes(run.status)) t.ok++;
          if (['failed', 'sent_back', 'retry', 'needs_human', 'rejected'].includes(run.status)) t.fail++;
          if (run.error && a === run.agent) t.errors.push({ at: run.end, recId: r.id, message: run.error });
        }
      }
    }
    for (const ag of FX.AGENTS) {
      const t = tot[ag.key] || { runs: 0, ok: 0, fail: 0, ms: 0, errors: [] };
      const s = { status: 'Idle', task: '', recId: null, progress: null, last: recent[ag.key] || null, runs: t.runs, ok: t.ok, fail: t.fail, avgMs: t.runs ? Math.round(t.ms / t.runs) : 0, errors: t.errors.sort((a, b) => b.at - a.at).slice(0, 3), since: null };
      const team = w && wr ? FX.agentsFor(w.key, wr) : [];
      if (w && wr && team.includes(ag.key)) {
        const active = activeAgent(w.key, wr, w.text) === ag.key;
        s.recId = wr.id; s.since = live.at && live.recId === wr.id ? (FX.ledgerOf(wr, w.key).lastStart || w.at) : w.at;
        if (active) {
          s.status = wr.revisionNote ? 'Fixing an issue' : BUSY[ag.kind];
          s.task = w.text; const pct = +(String(w.text).match(/(\d+)%/) || [])[1]; s.progress = isNaN(pct) ? null : pct;
        } else { s.status = 'Waiting for another agent'; s.task = `${FX.agent(activeAgent(w.key, wr, w.text)).name} is on ${FX.dept(w.key).name}`; }
      } else if (ag.key === 'manager') {
        if (w && wr) { s.status = 'Working'; s.recId = wr.id; s.task = `Supervising ${wr.id} at ${FX.dept(w.key).name}`; }
        else if (FX.stopped()) { s.status = 'Failed'; s.task = 'Emergency stop is on'; }
        else if (M.running) { s.status = 'Waiting for another agent'; const q = recs.filter((r) => r.status === 'queued').length; s.task = q ? `${q} video(s) queued; next check within 15 s` : 'Line running; waiting for new source videos or the next daily slot'; }
        else s.task = 'Line paused';
      } else if (ag.key === 'revision') {
        const fixing = recs.filter((r) => r.revisionNote && ['queued', 'working'].includes(r.status));
        if (fixing.length) { s.status = 'Fixing an issue'; s.recId = fixing[0].id; s.task = `${fixing.length} video(s) in revision: ${fixing[0].revisionNote.reason}`.slice(0, 160); }
      } else {
        const mine = recs.filter((r) => (ag.stages[lineOf(r)] || []).includes(r.stage) && !['rejected', 'live'].includes(r.status));
        const err = mine.find((r) => r.status === 'error'), hum = mine.find((r) => ['needs_human', 'awaiting_approval'].includes(r.status)), q = mine.find((r) => r.status === 'queued'), blk = mine.find((r) => r.status === 'blocked');
        if (err) { s.status = 'Failed'; s.recId = err.id; s.task = err.error || 'Error'; }
        else if (hum) { s.status = 'Waiting for another agent'; s.recId = hum.id; s.task = hum.status === 'awaiting_approval' ? 'Waiting for your approval' : 'Waiting for your decision: ' + (hum.humanReason || ''); }
        else if (q) { s.status = 'Waiting for another agent'; s.recId = q.id; s.task = `${q.id} queued for ${FX.dept(q.stage).name}${q.retryAt > now() ? ' (retry scheduled)' : ''}`; }
        else if (blk) { s.status = 'Waiting for another agent'; s.recId = blk.id; s.task = blk.blocked || 'Blocked'; }
        else if (ag.key === 'performance') { const live2 = recs.filter((r) => r.status === 'live' || r.status === 'scheduled').length; if (live2) s.task = `Tracking ${live2} published video(s)`; }
        if (s.status === 'Idle' && s.last && now() - s.last.at < 120e3) { s.status = s.last.ok ? 'Completed' : 'Failed'; s.task = s.last.text; s.recId = s.last.recId; }
      }
      out[ag.key] = s;
    }
    return out;
  };
})(window.FX);
