/* AutoClipper Assembly Line — the automation crew.
   Makes the line need less babysitting, without removing the safeguards:
   1. Mechanic (self-repair): retries failed steps, swaps a clip that keeps failing quality checks
      for the next-best moment, and re-queues VOD slots that found nothing.
   2. Smart scheduler: picks posting times from a GTA-audience prior blended with your own results.
   3. Earned auto-approve: the line may approve a video only when every warning on it is one you
      have approved yourself several times, rights are fully documented, and recent auto posts are
      performing. Never the first publish, never with a rights/policy question, never during STOP.
   4. Twitch watcher: spots new VODs on your Twitch channel(s) and uses the clips viewers made
      as hype markers for the Moment Scout.
   5. Stay awake + catch-up: keeps the screen awake while the line runs and tells you what
      happened while you were away.
   Loaded last; hooks in through FX.beforeTick, FX.vodMarkers and wrappers around a few departments. */
'use strict';
(function (FX) {
  const now = FX.now, R = FX.RUN;
  const DEF = {
    repair: true, replace: true, // Mechanic
    smart: true, gapMin: 120, explore: 0.2, // Smart scheduler
    minHuman: 3, kindMin: 3, autoCap: 4, guard: true, // Earned auto-approve
    twitch: false, twClient: '', twLogins: '', // Twitch watcher
    awake: true,
  };
  FX.autoCfg = () => ({ ...DEF, ...(ls.get('fx_auto', {}) || {}) });
  const setCfg = (patch) => ls.set('fx_auto', { ...FX.autoCfg(), ...patch });
  const A = FX.auto = { log: ls.get('fx_autoLog', []) };
  const H = 3600e3, DAY = 864e5;

  // every automatic action is written to the automation log, the record history and the audit log
  const note = async (kind, msg, r = null) => {
    A.log.unshift({ at: now(), kind, msg, recId: r?.id || null }); A.log = A.log.slice(0, 80); ls.set('fx_autoLog', A.log);
    log('🤖 ' + msg);
    await FX.audit('automation: ' + kind, msg, r?.id || null, 'automation');
  };

  /* =====================================================================
     1. MECHANIC — self-repair loop
     ===================================================================== */
  const QUALITY = ['scriptqc', 'voice', 'captions', 'edit', 'audioqc', 'visualqc'];
  const NEEDS_PERSON = /\b40[13]\b|api key|unauthori[sz]ed|insufficient_quota|billing|permission/i;
  async function replaceClip(r, why) {
    r.status = 'rejected'; r.replaced = true; r.humanReason = null;
    FX.hist(r, 'manager', 'auto-replaced', why);
    if (r.idea?.id) { const i = await FX.db.ideas.get(r.idea.id); if (i) { i.status = 'rejected'; i.rejectReason = 'Auto-replaced: ' + why; await FX.db.ideas.put(i); } }
    await FX.saveRecord(r);
    await note('replaced', `${r.id}: ${why} — dropped it; the line moves on to the next-best moment.`, r);
  }
  A.repair = async () => {
    const c = FX.autoCfg(); if (!c.repair || FX.stopped()) return;
    let fixed = 0;
    for (const r of await FX.db.prod.all()) {
      if (fixed >= 3) break;
      const reps = (r.repairs ||= []);
      // a) a department errored out: retry twice with growing gaps, then swap the clip
      if (r.status === 'error' && !['approval', 'publish', 'monitor'].includes(r.stage)) {
        const msg = r.error || '';
        if (NEEDS_PERSON.test(msg)) continue; // keys, billing and permissions need a person
        const tries = reps.filter((x) => x.kind === 'retry').length;
        if (tries < 2) {
          if (now() - r.updated < 10 * 60e3 * (tries + 1)) continue;
          reps.push({ at: now(), kind: 'retry', stage: r.stage, error: msg });
          r.status = 'queued'; r.error = null; r.retryAt = now();
          FX.hist(r, 'manager', 'auto-retry', `Retry ${tries + 1}/2 after: ${msg}`);
          await FX.saveRecord(r); fixed++;
          await note('retry', `${r.id}: retrying ${FX.dept(r.stage).name} (attempt ${tries + 1}/2) after "${msg.slice(0, 120)}"`, r);
        } else if (c.replace && FX.isClips(r) && r.stage !== 'trends') { await replaceClip(r, `${FX.dept(r.stage).name} kept failing (${msg.slice(0, 100)})`); fixed++; }
        continue;
      }
      // b) a quality department failed more times than the revision limit: swap the moment instead of waiting for you
      if (r.status === 'needs_human' && c.replace && FX.isClips(r) && QUALITY.includes(r.stage) && r.reports?.[r.stage]?.verdict === 'FAIL') {
        await replaceClip(r, `${FX.dept(r.stage).name} still failed after ${FX.MAX_REVISIONS} revisions`); fixed++; continue;
      }
      // c) the VOD had no usable moments: free the slot so the next VOD gets scanned
      if (r.status === 'needs_human' && r.stage === 'trends' && /No usable moments/.test(r.humanReason || '')) {
        r.status = 'queued'; r.humanReason = null; r.retryAt = now() + 10 * 60e3;
        reps.push({ at: now(), kind: 'requeue', stage: 'trends' });
        FX.hist(r, 'manager', 'auto-requeue', 'No usable moments in that VOD; waiting for the next one');
        await FX.saveRecord(r); fixed++;
        await note('requeue', `${r.id}: that VOD had no usable moments, so this slot waits for the next VOD instead of for you.`, r);
      }
    }
  };

  /* =====================================================================
     2. SMART SCHEDULER — best posting times
     ===================================================================== */
  // Starting guess for a GTA / Twitch-clip audience in your local time: after school/work evenings,
  // longer afternoons on weekends. Your own results take over as they come in.
  const PRIOR = [0.2, 0.12, 0.08, 0.05, 0.04, 0.05, 0.1, 0.18, 0.26, 0.34, 0.42, 0.52, 0.62, 0.66, 0.7, 0.78, 0.86, 0.94, 1, 1, 0.96, 0.86, 0.62, 0.36];
  const prior = (d) => { const h = d.getHours(), we = d.getDay() === 0 || d.getDay() === 6; return Math.min(1, PRIOR[h] + (we && h >= 11 && h <= 17 ? 0.18 : 0)); };
  const lastViews = (r) => r.metricsHistory?.[r.metricsHistory.length - 1]?.views ?? null;
  A.hourFactors = async () => {
    const recs = (await FX.db.prod.all()).filter((r) => r.publish && lastViews(r) != null && now() - r.publish.scheduledFor > 24 * H);
    const f = Array.from({ length: 24 }, () => ({ n: 0, factor: 1 }));
    if (recs.length < 3) return { f, n: recs.length };
    const avg = recs.reduce((a, r) => a + lastViews(r), 0) / recs.length || 1;
    const g = Array.from({ length: 24 }, () => []);
    for (const r of recs) g[new Date(r.publish.scheduledFor).getHours()].push(lastViews(r) / avg);
    // shrink toward 1 so two lucky posts don't move the schedule much
    g.forEach((v, h) => { const k = 4; f[h] = { n: v.length, factor: (v.reduce((a, x) => a + x, 0) + k) / (v.length + k) }; });
    return { f, n: recs.length };
  };
  async function takenSlots() {
    const t = [];
    for (const r of await FX.db.prod.all()) if (r.publish?.scheduledFor) t.push(r.publish.scheduledFor);
    try { for (const c of await allClips()) if (c.scheduledFor && ['scheduled', 'posted'].includes(c.status)) t.push(c.scheduledFor); } catch {}
    return [...new Set(t)];
  }
  A.bestSlots = async (k = 5) => {
    const c = FX.autoCfg(), ch = FX.channel(), cap = Math.max(1, Math.min(+ch.videosPerDay || 3, +ch.maxPerDay || 99));
    const taken = await takenSlots(), { f } = await A.hourFactors();
    const perDay = {}; for (const t of taken) { const d = new Date(t).toDateString(); perDay[d] = (perDay[d] || 0) + 1; }
    const gap = (+c.gapMin || 0) * 60e3, out = [];
    const start = new Date(now() + 20 * 60e3); start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
    for (let t = start.getTime(); t < now() + 3 * DAY; t += 30 * 60e3) {
      const d = new Date(t);
      if ((perDay[d.toDateString()] || 0) >= cap) continue;
      if (taken.some((x) => Math.abs(x - t) < gap)) continue;
      const p = prior(d), lf = f[d.getHours()], ahead = (t - now()) / H;
      const score = p * lf.factor * Math.exp(-ahead / 36);
      out.push({ t, score, why: `${d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: audience estimate ${Math.round(p * 100)}%${lf.n ? `, your posts at ${d.getHours()}:00 do ${lf.factor.toFixed(2)}× average (n=${lf.n})` : ''}` });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  };
  A.pickSlot = async () => {
    const s = await A.bestSlots(6); if (!s.length) return null;
    // now and then try a different good slot so the scheduler keeps learning
    if (s.length > 1 && Math.random() < (+FX.autoCfg().explore || 0)) { const x = s[1 + Math.floor(Math.random() * (s.length - 1))]; return { ...x, why: 'Exploring a different good time — ' + x.why }; }
    return { ...s[0], why: 'Best open slot — ' + s[0].why };
  };
  const basePublish = R.publish;
  R.publish = async (r, say, o) => {
    const ap = r.approval;
    if (FX.autoCfg().smart && ap?.approved && !r.practice && !FX.stopped() && (!ap.when || (ap.smart && Date.parse(ap.when) < now()))) {
      const s = await A.pickSlot();
      if (s) { ap.when = new Date(s.t).toISOString(); ap.smart = s.why; FX.hist(r, 'publish', 'smart schedule', s.why); }
    }
    return basePublish(r, say, o);
  };

  /* =====================================================================
     3. EARNED AUTO-APPROVE — trust learned from your own decisions and results
     ===================================================================== */
  const ledger = () => ls.get('fx_trust', []);
  const pushLedger = (e) => { const l = ledger(); l.unshift({ at: now(), ...e }); ls.set('fx_trust', l.slice(0, 400)); };
  // the medium warnings on a video, as stable "kinds" (department + where, without timestamps)
  A.kindsOf = (r) => {
    const ks = new Set();
    for (const k of Object.keys(FX.REQUIRED || {})) {
      const rep = r.reports?.[k]; if (!rep || rep.verdict !== 'WARNING') continue;
      for (const i of rep.items || []) if (i.sev === 'medium') ks.add(`${k}:${String(i.where || 'item').replace(/@.*$/, '').replace(/[\d:.]+/g, '').trim() || 'item'}`);
    }
    return [...ks];
  };
  A.kindLabel = (k) => { const [d, w] = k.split(':'); return `${FX.dept(d)?.name || d} → ${w}`; };
  A.kindStats = () => {
    const st = {};
    for (const e of ledger()) for (const k of e.kinds || []) {
      const s = (st[k] ||= { approved: 0, auto: 0, bad: 0, lastBad: 0 });
      if (e.act === 'approved' && e.by === 'you') s.approved++;
      else if (e.act === 'approved') s.auto++;
      else if (now() - e.at < 30 * DAY) { s.bad++; s.lastBad = Math.max(s.lastBad, e.at); }
    }
    return st;
  };
  const humanApprovals = () => Math.max(ls.get('fx_humanApprovals', 0), ledger().filter((e) => e.act === 'approved' && e.by === 'you').length);
  A.paused = () => ls.get('fx_trustPause', null);

  A.trustCheck = async (r) => {
    const a = FX.autoCfg(), ch = FX.channel();
    const no = (reason) => ({ ok: false, reason });
    if (!ch.autoPublish) return no('earned auto-approve is off');
    if (r.practice) return no('practice record');
    if (FX.stopped()) return no('emergency stop is on');
    const hum = humanApprovals();
    if (hum < Math.max(1, +a.minHuman || 1)) return no(`you have approved ${hum} of the first ${a.minHuman} videos yourself`);
    const p = A.paused(); if (p) return no('paused by the safety guard: ' + p.reason);
    const d = r.final?.decision;
    if (!['APPROVED', 'APPROVED WITH WARNING'].includes(d)) return no(`Final QC decision is ${d || 'missing'}`);
    if (Object.keys(r.overrides || {}).length) return no('a step on this video was approved by hand, so you decide this one');
    if ((r.assets || []).some((x) => x.status !== 'verified')) return no('not every rights record is verified');
    if (r.type === 'clips' && !['me', 'permission'].includes(ch.streamerRelation)) return no('no permission recorded to clip this streamer');
    if (!r.moderation?.ran) return no('the safety scan did not run on this video');
    for (const k of ['factcheck', 'assets', 'copyright', 'guidelines']) if (['HUMAN_REVIEW', 'FAIL'].includes(r.reports?.[k]?.verdict)) return no(`${FX.dept(k).name} wants a person`);
    if (r.monetization?.level === 'HIGH') return no('monetization risk is HIGH');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const autoToday = ledger().filter((e) => e.act === 'approved' && e.by === 'trust' && e.at >= today.getTime()).length;
    if (autoToday >= (+a.autoCap || 0)) return no(`daily auto-approve cap reached (${a.autoCap})`);
    const st = A.kindStats(), kinds = A.kindsOf(r);
    for (const k of kinds) {
      const s = st[k] || { approved: 0, bad: 0 };
      if (s.bad) return no(`you rejected or sent back a video with "${A.kindLabel(k)}" in the last 30 days`);
      if (s.approved < (+a.kindMin || 1)) return no(`"${A.kindLabel(k)}" approved by you ${s.approved}/${a.kindMin} times so far`);
    }
    return { ok: true, kinds, why: kinds.length ? `only warnings you have approved before (${kinds.map(A.kindLabel).join(', ')})` : 'clean Final QC' };
  };

  // Human Approval: replaces the old one-switch rule with earned trust (the person still approves the first videos)
  const baseApproval = R.approval;
  R.approval = async (r, say, o) => {
    if (r.approval?.approved) return baseApproval(r, say, o);
    const t = await A.trustCheck(r);
    r.autoApprove = { at: now(), ok: t.ok, reason: t.ok ? t.why : t.reason };
    if (t.ok) {
      r.approval = { approved: true, by: 'trust rule', at: now(), note: t.why };
      pushLedger({ id: r.id, act: 'approved', by: 'trust', kinds: t.kinds });
      await note('auto-approved', `${r.id} auto-approved: ${t.why}.`, r);
      return { verdict: 'PASS', summary: `Auto-approved by your earned-trust rule: ${t.why}.`, items: [] };
    }
    return { verdict: 'WAIT', status: 'awaiting_approval', summary: `Waiting for your approval in the publishing dashboard. (Auto-approve: ${t.reason}.)` };
  };
  // learn from every human decision
  const baseApprove = FX.approve;
  FX.approve = async (id, opts) => {
    const r = await FX.db.prod.get(id);
    const out = await baseApprove(id, opts);
    if (r) pushLedger({ id, act: 'approved', by: 'you', kinds: A.kindsOf(r), edited: (r.history || []).some((h) => h.event === 'metadata edited') });
    return out;
  };
  const decided = async (id, act) => { const r = await FX.db.prod.get(id); if (r && ['finalqc', 'prep', 'approval', 'publish'].includes(r.stage)) pushLedger({ id, act, by: 'you', kinds: A.kindsOf(r) }); };
  const baseReject = FX.reject, baseBack = FX.humanSendBack;
  if (baseReject) FX.reject = async (id, n) => { await decided(id, 'rejected'); return baseReject(id, n); };
  if (baseBack) FX.humanSendBack = async (id, to, n) => { await decided(id, 'sentback'); return baseBack(id, to, n); };

  // safety guard: auto-approval pauses itself if auto posts fail or underperform
  A.guard = async () => {
    if (!FX.autoCfg().guard || A.paused()) return;
    const recs = await FX.db.prod.all();
    const autoRecs = recs.filter((r) => r.approval?.by === 'trust rule');
    const failed = autoRecs.find((r) => r.status === 'error' && ['publish', 'monitor'].includes(r.stage));
    let reason = failed ? `${failed.id}'s upload failed (${(failed.error || '').slice(0, 80)})` : null;
    if (!reason) {
      const ripe = (list) => list.filter((r) => r.publish && now() - r.publish.scheduledFor > 24 * H && lastViews(r) != null).slice(-8).map(lastViews).sort((a, b) => a - b);
      const med = (v) => v[Math.floor(v.length / 2)];
      const au = ripe(autoRecs), hu = ripe(recs.filter((r) => r.approval?.by === 'you'));
      if (au.length >= 4 && hu.length >= 4 && med(hu) > 0 && med(au) < med(hu) * 0.35) reason = `auto-approved videos get ${fmtNum(med(au))} median views vs ${fmtNum(med(hu))} for ones you approved`;
    }
    if (reason) { ls.set('fx_trustPause', { at: now(), reason }); await FX.alert('Earned auto-approve paused: ' + reason + '. You approve every video again until you resume it on the Automation tab.'); await note('trust paused', reason); }
  };

  /* =====================================================================
     4. TWITCH WATCHER — new VODs + the clips viewers made (official Helix API)
     ===================================================================== */
  const TW = 'https://api.twitch.tv/helix';
  const redirectUri = () => location.origin + location.pathname;
  const twToken = () => ls.get('fx_twToken', null)?.token || null;
  (function catchToken() { // implicit-grant redirect lands back here with #access_token=…
    try {
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.get('access_token') && h.get('state') === ls.get('fx_twState', '')) {
        ls.set('fx_twToken', { token: h.get('access_token'), at: now() }); ls.set('fx_twState', '');
        history.replaceState(null, '', location.pathname + location.search);
        setTimeout(() => { toast('Twitch connected. The watcher checks for new VODs every 30 minutes.'); note('twitch', 'Twitch connected'); }, 800);
      }
    } catch {}
  })();
  A.twConnect = () => {
    const c = FX.autoCfg(); if (!c.twClient) return toast('Paste your Twitch app Client ID first.');
    const st = Math.random().toString(36).slice(2); ls.set('fx_twState', st);
    location.href = `https://id.twitch.tv/oauth2/authorize?response_type=token&client_id=${encodeURIComponent(c.twClient)}&redirect_uri=${encodeURIComponent(redirectUri())}&scope=&state=${st}`;
  };
  const twGet = async (path) => {
    try { return await FX.fetchJSON(TW + path, { headers: { 'Client-Id': FX.autoCfg().twClient, Authorization: 'Bearer ' + twToken() } }, 'Twitch'); }
    catch (e) { if (/Twitch 401/.test(e.message)) { ls.set('fx_twToken', null); await FX.alert('Twitch sign-in expired. Reconnect it on the Automation tab.'); } throw e; }
  };
  const durSec = (s) => { const m = String(s || '').match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/) || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
  A.twVods = () => ls.get('fx_twVods', {});
  A.twPoll = async ({ force = false } = {}) => {
    const c = FX.autoCfg(); if (!c.twitch || !c.twClient || !twToken()) return;
    if (!force && now() - ls.get('fx_twAt', 0) < 30 * 60e3) return;
    ls.set('fx_twAt', now());
    let since = ls.get('fx_twSince', 0); if (!since) { since = now(); ls.set('fx_twSince', since); }
    const vods = A.twVods(), ids = ls.get('fx_twIds', {});
    for (const login of FX.lines(c.twLogins).slice(0, 5).map((x) => x.toLowerCase().replace(/^.*twitch\.tv\//, '').replace(/[^a-z0-9_]/g, ''))) {
      if (!login) continue;
      if (!ids[login]) { const u = await twGet(`/users?login=${encodeURIComponent(login)}`); ids[login] = u.data?.[0]?.id || null; ls.set('fx_twIds', ids); }
      if (!ids[login]) { await note('twitch', `Twitch channel "${login}" not found`); continue; }
      const list = await twGet(`/videos?user_id=${ids[login]}&type=archive&first=5`);
      for (const v of list.data || []) {
        const created = Date.parse(v.created_at), dur = durSec(v.duration);
        let e = vods[v.id];
        if (!e) {
          e = vods[v.id] = { id: v.id, login, title: v.title, created, durSec: dur, url: v.url, clips: [], clipsAt: 0, seen: now() };
          if (created + dur * 1000 > since) await FX.alert(`New Twitch VOD from ${login}: "${v.title}" (${v.duration}). Save it into your VOD folder and the line clips it automatically${' — viewer clips will guide the Moment Scout'}.`);
        }
        e.durSec = dur; e.title = v.title;
        // viewer clips keep coming in for a day or two after the stream
        if (now() - (created + dur * 1000) < 3 * DAY || !e.clipsAt) {
          const end = new Date(Math.min(now(), created + dur * 1000 + 2 * DAY)).toISOString();
          const cl = await twGet(`/clips?broadcaster_id=${ids[login]}&started_at=${encodeURIComponent(new Date(created).toISOString())}&ended_at=${encodeURIComponent(end)}&first=100`);
          e.clips = (cl.data || []).filter((x) => x.video_id === v.id && x.vod_offset != null).map((x) => ({ offset: x.vod_offset, views: x.view_count, title: x.title, dur: x.duration }));
          e.clipsAt = now();
        }
      }
    }
    const keep = Object.values(vods).sort((a, b) => b.created - a.created).slice(0, 30);
    ls.set('fx_twVods', Object.fromEntries(keep.map((v) => [v.id, v])));
    FX.emit('vods');
  };
  // match a local VOD file to a Twitch VOD (id in the file name, else same length) and return hype markers
  FX.vodMarkers = (entry, file, dur) => {
    const vods = Object.values(A.twVods());
    const v = vods.find((x) => file.name.includes(x.id)) || vods.find((x) => x.durSec && Math.abs(x.durSec - dur) < 90);
    if (!v || !v.clips.length) return [];
    const m = ls.get('fx_twMatch', {}); m[entry.key] = v.id; ls.set('fx_twMatch', m);
    const groups = [];
    for (const c of [...v.clips].sort((a, b) => a.offset - b.offset)) {
      const g = groups[groups.length - 1];
      if (g && c.offset - g.offset < 20) g.views += c.views; else groups.push({ offset: c.offset, views: c.views, title: c.title });
    }
    log(`🎯 ${file.name} matched Twitch VOD ${v.id}: ${groups.length} viewer-clipped moment(s)`);
    return groups.sort((a, b) => b.views - a.views).slice(0, 10).map((g) => ({ start: Math.max(0, g.offset - 3), views: Math.max(1, g.views), title: g.title }));
  };

  /* =====================================================================
     5. STAY AWAKE + CATCH-UP
     ===================================================================== */
  let wl = null;
  const wantAwake = () => FX.autoCfg().awake && FX.manager.running && !FX.stopped();
  A.awake = async () => {
    try {
      if (wantAwake() && !wl && document.visibilityState === 'visible' && navigator.wakeLock) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => (wl = null)); }
      else if (!wantAwake() && wl) { await wl.release(); wl = null; }
    } catch {}
  };
  FX.on('tick', A.awake);
  A.catchUp = async (since) => {
    const ev = (await FX.db.audit.all()).filter((e) => e.at > since);
    if (!ev.length) return null;
    const count = (rx) => ev.filter((e) => rx.test(e.action)).length;
    const lines = [
      [count(/^video created$/), 'video(s) started'], [count(/^automation: auto-approved$/), 'auto-approved'], [count(/^(scheduled|published)$/), 'scheduled or sent'],
      [count(/^automation: (retry|replaced|requeue)$/), 'self-repair(s)'], [count(/^alert$/), 'alert(s)'],
    ].filter(([n]) => n).map(([n, t]) => `${n} ${t}`);
    const need = (await FX.db.prod.all()).filter((r) => ['needs_human', 'awaiting_approval'].includes(r.status)).length;
    if (need) lines.push(`${need} waiting for you`);
    if (!lines.length) return null;
    A.away = { since, at: now(), lines };
    return A.away;
  };
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { ls.set('fx_hiddenAt', now()); return; }
    A.awake();
    const since = ls.get('fx_hiddenAt', 0);
    if (since && now() - since > 10 * 60e3) { const a = await A.catchUp(since); if (a) toast('While you were away: ' + a.lines.join(' · ')); }
  });
  window.addEventListener('beforeunload', (e) => { if (FX.manager.running && FX.manager.working) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- hook into the production manager's tick ---------------- */
  FX.beforeTick = async () => {
    await A.twPoll().catch((e) => log('⚠️ Twitch watcher: ' + e.message));
    if (FX.manager.running) await A.repair();
    await A.guard();
  };

  /* =====================================================================
     AUTOMATION TAB
     ===================================================================== */
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tog = (k, label, v) => `<label class="check"><input type="checkbox" data-acfg="${k}" ${v ? 'checked' : ''}> ${label}</label>`;
  const num = (k, label, v, extra = '') => `<label>${label}<input type="number" data-acfg="${k}" value="${esc(v)}" ${extra}></label>`;
  const txt = (k, label, v, ph = '') => `<label>${label}<input data-acfg="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></label>`;
  const chip = (on, t) => `<span class="sb ${on ? 's-live' : 's-queued'}">${t}</span>`;

  FX.autoPane = async () => {
    const a = FX.autoCfg(), ch = FX.channel(), st = A.kindStats(), hum = humanApprovals(), pause = A.paused();
    const slots = a.smart ? await A.bestSlots(5) : [];
    const { f, n: learnedN } = await A.hourFactors();
    const bars = PRIOR.map((p, h) => { const d = new Date(); d.setHours(h, 0, 0, 0); const v = Math.min(1, p * f[h].factor); return `<i title="${h}:00 — ${Math.round(v * 100)}%${f[h].n ? ` (your data: ${f[h].factor.toFixed(2)}×, n=${f[h].n})` : ''}" style="height:${Math.max(4, v * 100)}%"></i>`; }).join('');
    const kinds = Object.entries(st).sort((x, y) => y[1].approved - x[1].approved);
    const vods = Object.values(A.twVods()).sort((x, y) => y.created - x.created), match = ls.get('fx_twMatch', {});
    const matched = new Set(Object.values(match));
    const autoToday = ledger().filter((e) => e.act === 'approved' && e.by === 'trust' && e.at >= new Date().setHours(0, 0, 0, 0)).length;
    return `<p class="muted">The automation crew keeps the line moving while you're away. Every automatic action is logged here, in the video's history and in the audit log. The safeguards stay: you approve the first videos yourself, anything with a rights or policy question waits for you, and 🛑 STOP halts all of it.</p>
      ${A.away ? `<div class="hint-card">👋 <b>While you were away</b> (since ${when(A.away.since)}): ${esc(A.away.lines.join(' · '))} <button data-sub="needs">Open Needs you</button></div>` : ''}
      <div class="auto-grid">
        <div class="card"><div class="row"><h3>🛠️ Mechanic — self-repair</h3>${chip(a.repair, a.repair ? 'On' : 'Off')}</div>
          <p class="muted small">Retries a failed step twice (10 and 20 minutes later). If a clip keeps failing a quality check after ${FX.MAX_REVISIONS} revisions, or keeps erroring, it's dropped and the next-best moment takes its slot. A VOD with no usable moments frees its slot for the next VOD. Key, billing and permission errors still come to you.</p>
          ${tog('repair', 'Retry failed steps automatically', a.repair)}${tog('replace', 'Swap clips that keep failing for the next-best moment', a.replace)}
          <h4>Recent automatic actions</h4>
          ${A.log.length ? `<div class="auto-log">${A.log.slice(0, 12).map((x) => `<div><small class="muted">${when(x.at)}</small> ${esc(x.msg)}</div>`).join('')}</div>` : '<p class="muted small">Nothing yet.</p>'}</div>

        <div class="card"><div class="row"><h3>🗓️ Smart scheduler</h3>${chip(a.smart, a.smart ? 'On' : 'Off')}</div>
          <p class="muted small">When you approve without picking a time, the post goes to the best open slot in the next 3 days: a starting guess for GTA viewers (evenings, weekend afternoons) blended with how your own posts did by hour (${learnedN >= 3 ? `learning from ${learnedN} posts` : 'starts learning after 3 posts with 24h of stats'}). At most ${Math.min(+ch.videosPerDay || 3, +ch.maxPerDay || 99)} per day (Channel), spaced ${a.gapMin} min apart.</p>
          <div class="hour-bars" aria-label="Expected audience by hour">${bars}</div><div class="hour-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
          ${tog('smart', 'Pick posting times automatically', a.smart)}
          <div class="grid3">${num('gapMin', 'Minutes between posts', a.gapMin, 'min="0" max="720"')}${num('explore', 'Try other good times (0–0.5)', a.explore, 'min="0" max="0.5" step="0.05"')}</div>
          ${slots.length ? `<h4>Next best open slots</h4><ol class="small">${slots.map((s) => `<li>${esc(s.why)}</li>`).join('')}</ol>` : ''}</div>

        <div class="card"><div class="row"><h3>🤝 Earned auto-approve</h3>${chip(ch.autoPublish && !pause, pause ? 'Paused' : ch.autoPublish ? 'On' : 'Off')}</div>
          <p class="muted small">The line approves a video only when: you've approved at least ${a.minHuman} yourself (${hum} so far); Final QC is APPROVED or APPROVED WITH WARNING; every warning on it is a kind you've approved ${a.kindMin}+ times and not rejected in 30 days; all rights records are verified with no hand overrides; no rights/policy check wants a person; monetization risk isn't HIGH; and today's cap (${a.autoCap}) isn't used up (${autoToday} today). If auto posts fail or get under 35% of your approved posts' median views, it pauses itself.</p>
          ${pause ? `<div class="hint-card">⏸ Paused ${when(pause.at)}: ${esc(pause.reason)} <button data-auto="resumeTrust">Resume</button></div>` : ''}
          <label class="check"><input type="checkbox" data-achan="autoPublish" ${ch.autoPublish ? 'checked' : ''}> Let the line approve videos that match what I approve</label>
          ${tog('guard', 'Pause automatically if auto posts fail or underperform', a.guard)}
          <div class="grid3">${num('minHuman', 'Videos you approve first', a.minHuman, 'min="1" max="50"')}${num('kindMin', 'Approvals needed per warning kind', a.kindMin, 'min="1" max="20"')}${num('autoCap', 'Max auto-approvals per day', a.autoCap, 'min="0" max="20"')}</div>
          <h4>What it has learned from you</h4>
          ${kinds.length ? `<div class="vlist">${kinds.map(([k, s]) => `<div class="vrow"><span>${esc(A.kindLabel(k))}</span><span>${s.approved} approved by you${s.auto ? ` · ${s.auto} auto` : ''}${s.bad ? ` · <b class="warn-t">${s.bad} rejected/sent back</b>` : ''}</span><span>${s.bad ? '<span class="sev sev-high">Needs you</span>' : s.approved >= a.kindMin ? '<span class="sev sev-ok">Trusted</span>' : `<span class="sev sev-medium">Learning ${s.approved}/${a.kindMin}</span>`}</span></div>`).join('')}</div>` : '<p class="muted small">Nothing yet — every approve, reject or send-back you make teaches it which warnings you accept.</p>'}</div>

        <div class="card"><div class="row"><h3>📡 Twitch watcher</h3>${chip(a.twitch && twToken(), a.twitch ? (twToken() ? 'Connected' : 'Not connected') : 'Off')}</div>
          <p class="muted small">Every 30 minutes it checks your Twitch channel(s) for new VODs and alerts you, and pulls the clips viewers made during the stream. When you drop or save that VOD (with the VOD id in the file name, or the full-length file), the Moment Scout adds the viewer-clipped moments and ranks them higher. Twitch doesn't offer VOD downloads in its API, so saving the file is still your step (TwitchDownloader names files with the id).</p>
          ${tog('twitch', 'Watch Twitch channels', a.twitch)}
          <div class="grid3">${txt('twLogins', 'Twitch channel(s), comma separated', a.twLogins, 'yourchannel')}${txt('twClient', 'Twitch app Client ID', a.twClient, 'from dev.twitch.tv/console')}</div>
          <p class="muted small">Create an app at dev.twitch.tv/console with this OAuth redirect URL: <code>${esc(redirectUri())}</code></p>
          <div class="row"><button data-auto="twConnect">${twToken() ? 'Reconnect Twitch' : 'Connect Twitch'}</button><button data-auto="twPoll" ${twToken() ? '' : 'disabled'}>Check now</button><span class="muted small">${ls.get('fx_twAt', 0) ? 'Last check ' + when(ls.get('fx_twAt', 0)) : 'Not checked yet'}</span></div>
          ${vods.length ? `<div class="vlist">${vods.slice(0, 8).map((v) => `<div class="vrow"><span>🎞️ <b>${esc(v.title)}</b> <small class="muted">${esc(v.login)} · ${when(v.created)} · ${fmt(v.durSec)}</small></span><span>${v.clips.length} viewer clip(s)</span><span>${matched.has(v.id) ? '<span class="ok-line">matched a local file</span>' : '<span class="muted">waiting for the file</span>'}</span></div>`).join('')}</div>` : ''}</div>

        <div class="card"><div class="row"><h3>☕ Stay awake</h3>${chip(a.awake, a.awake ? 'On' : 'Off')}</div>
          <p class="muted small">While the line runs, the screen stays awake so the browser doesn't freeze the tab mid-render, and you get a summary when you come back. Posts already scheduled go out from Upload-Post/YouTube even if this tab is closed; producing new clips needs the tab open.</p>
          ${tog('awake', 'Keep the screen awake while the line runs', a.awake)}</div>
      </div>`;
  };

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset?.acfg) {
      const k = t.dataset.acfg, v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value.trim();
      setCfg({ [k]: v }); await FX.audit('automation setting changed', `${k} = ${v}`, null, 'you');
      if (k === 'twitch' && v && !ls.get('fx_twSince', 0)) ls.set('fx_twSince', now());
      A.awake(); FX.renderLine?.();
    }
    if (t.dataset?.achan) { await FX.saveChannel({ ...FX.channel(), [t.dataset.achan]: t.checked }); FX.renderLine?.(); }
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-auto]'); if (!b) return;
    const act = b.dataset.auto;
    try {
      if (act === 'twConnect') return A.twConnect();
      if (act === 'twPoll') { b.disabled = true; b.textContent = 'Checking…'; await A.twPoll({ force: true }); toast('Twitch checked.'); }
      if (act === 'resumeTrust') { ls.set('fx_trustPause', null); await FX.audit('earned auto-approve resumed', '', null, 'you'); }
    } catch (err) { toast('⚠️ ' + err.message); }
    FX.renderLine?.();
  });
})(window.FX);
