/* AutoClipper Assembly Line — GTA streamer clip line (the main line).
   Same departments, adapted to clips: VODs go in, hype moments are found and ranked,
   each clip gets a hook, optional AI commentary intro, captions from the real stream audio,
   and rights checks for the streamer's footage, the game and in-game radio music.
   Faceless channels fall through to the base departments in fx-depts.js. */
'use strict';
(function (FX) {
  const R = FX.RUN, base = { ...R }, now = FX.now, item = FX.item, verdictFrom = FX.verdictFrom;
  const isClip = (r) => r?.type === 'clips';
  const clipVO = (r) => (r.script?.scenes || []).filter((s) => s.streamAudio).map((s) => s.vo).join(' ');

  /* ---------------- VOD inbox ---------------- */
  FX.vods = new Map(); // files dropped this session (big VODs are not copied into browser storage)
  const keyOf = (f) => `${f.name}|${f.size}`;
  FX.vodInbox = () => ls.get('fx_vodInbox', []);
  const saveInbox = (x) => { ls.set('fx_vodInbox', x.slice(-60)); FX.emit('vods'); };
  FX.addVod = (file, from = 'dropped') => {
    const key = keyOf(file); FX.vods.set(key, file);
    const inbox = FX.vodInbox();
    if (!inbox.find((e) => e.key === key)) { inbox.push({ key, name: file.name, size: file.size, added: now(), from, status: 'new' }); log(`📥 VOD added to the assembly line: ${file.name}`); }
    saveInbox(inbox);
  };
  FX.vodAvailable = async (key) => !!(await getVod(key));
  // Channel tab: show what a clip frame will look like with the current layout + facecam settings
  FX.previewLayout = async (c, out) => {
    let file = null;
    for (const e of FX.vodInbox().slice().reverse()) if ((file = await getVod(e.key))) break;
    if (!file) return 'No VOD in this session yet. Drop one on the Assembly Line first.';
    const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(file);
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('This VOD can\'t be played in the browser.')); });
      v.currentTime = Math.min(v.duration * 0.4, 600); await new Promise((res) => { v.onseeked = res; setTimeout(res, 6000); });
      const off = Object.assign(document.createElement('canvas'), { width: 1080, height: 1920 }), g = off.getContext('2d');
      FX.drawClipFrame(g, v, c, c.layout || 'blur');
      const zn = FX.layoutZones(c.layout), cy = c.layout === 'blur' || c.layout === 'split' ? zn.caption : (+c.captionPos || 0.64);
      g.setLineDash([24, 16]); g.lineWidth = 8;
      g.strokeStyle = '#ffd400'; g.strokeRect(120, 1920 * zn.hook - 90, 840, 180);
      g.strokeStyle = '#7cf7d4'; g.strokeRect(80, 1920 * cy - 70, 920, 140);
      g.setLineDash([]); g.font = '700 44px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#ffd400'; g.fillText('HOOK', 540, 1920 * zn.hook + 15); g.fillStyle = '#7cf7d4'; g.fillText('CAPTIONS', 540, 1920 * cy + 15);
      out.style.display = 'block'; out.getContext('2d').drawImage(off, 0, 0, out.width, out.height);
      return `Frame from ${file.name}. ${c.layout === 'split' ? 'The top part should show only the face. If not, change the facecam corner/size.' : 'Switch the layout to "Facecam top / gameplay bottom" if the streamer has a facecam.'}`;
    } finally { URL.revokeObjectURL(v.src); }
  };
  async function getVod(key) {
    if (FX.vods.has(key)) return FX.vods.get(key);
    if (typeof folderHandle !== 'undefined' && folderHandle && await folderReady()) {
      const [name, size] = key.split('|');
      try { const h = await folderHandle.getFileHandle(name); const f = await h.getFile(); if (String(f.size) === size) { FX.vods.set(key, f); return f; } } catch {}
    }
    return null;
  }
  FX.getVod = getVod;
  async function scanFolder() {
    if (typeof folderHandle === 'undefined' || !folderHandle || !(await folderReady())) return;
    let since = ls.get('fx_folderSince', null); if (!since) { since = now(); ls.set('fx_folderSince', since); }
    for await (const [name, h] of folderHandle.entries()) {
      if (h.kind !== 'file' || !/\.(mp4|mov|webm|m4v)$/i.test(name)) continue;
      const f = await h.getFile();
      if (f.lastModified < since || now() - f.lastModified < 90e3) continue;
      if (!FX.vodInbox().find((e) => e.key === keyOf(f))) FX.addVod(f, 'folder');
    }
  }
  FX.canStart = async () => {
    if (!FX.isClips()) return true;
    await scanFolder().catch(() => {});
    for (const i of (await FX.db.ideas.all()).filter((x) => x.type === 'moment' && x.status === 'new')) if (await getVod(i.vodKey)) return true;
    for (const e of FX.vodInbox().filter((x) => x.status === 'new')) if (await getVod(e.key)) return true;
    return false;
  };

  /* ---------------- licenses for stream footage ---------------- */
  Object.assign(FX.LICENSES, {
    'My own stream': { commercial: true, attribution: false, url: '' },
    'Streamer permission (documented)': { commercial: true, attribution: true, url: '' },
    'Game publisher video policy (reviewed)': { commercial: true, attribution: false, url: '' },
  });
  const baseCheck = FX.checkLicense;
  FX.checkLicense = (a) => {
    if (a.license === 'No permission recorded') return { status: 'manual_review', reason: 'No permission recorded to clip this streamer. Re-uploading someone else\'s stream can get copyright strikes. Record written permission in Channel, or reject.' };
    if (a.license === 'Streamer permission (undocumented)') return { status: 'manual_review', reason: 'Permission is marked but there is no proof/date saved. Add the link or screenshot reference in Channel.' };
    if (a.license === 'Game publisher video policy (not reviewed)') return { status: 'manual_review', reason: 'Confirm you have read the game publisher\'s video/monetization policy (tick it in Channel).' };
    if (a.license === 'My own stream' || a.license === 'Game publisher video policy (reviewed)') return a.name && a.source ? { status: 'verified', reason: 'Verified' } : { status: 'rejected', reason: 'Incomplete record' };
    if (a.license === 'Streamer permission (documented)') return a.attributionText ? { status: 'verified', reason: 'Verified — streamer credit added to descriptions' } : { status: 'rejected', reason: 'Credit text missing' };
    return baseCheck(a);
  };

  /* ===================================================================
     2. MOMENT SCOUT (trend research for clips)
     Finds hype moments by audio energy (no key needed), transcribes them, then the AI ranks
     them with what's trending in GTA communities right now.
     =================================================================== */
  async function gtaSignals(c) {
    const out = [];
    for (const sub of FX.lines(c.subreddits).slice(0, 3)) {
      try {
        const j = await FX.fetchJSON(`https://www.reddit.com/r/${encodeURIComponent(sub.replace(/^r\//, ''))}/hot.json?limit=12&raw_json=1`, {}, 'Reddit');
        out.push({ source: `r/${sub}`, items: (j.data?.children || []).filter((p) => !p.data.stickied && !p.data.over_18).map((p) => p.data.title.slice(0, 140)) });
      } catch (e) { out.push({ source: `r/${sub}`, error: e.message, items: [] }); }
    }
    return out;
  }
  async function scoutVod(r, entry, say) {
    const file = await getVod(entry.key); if (!file) return [];
    const c = FX.channel(), len = +c.clipLen || 35;
    say(`Reading the audio of ${file.name} (big files take a minute)…`);
    let buffer;
    try { buffer = await getAudioCtx().decodeAudioData(await file.arrayBuffer()); }
    catch { entry.status = 'unreadable'; saveInbox(FX.vodInbox().map((e) => (e.key === entry.key ? entry : e))); throw new Error(`Could not read ${file.name}'s audio. Use MP4 under ~2 GB (split long VODs).`); }
    say('Finding hype moments…');
    const hl = findHighlights(buffer, +c.momentsPerVod || 6, Math.min(len, buffer.duration));
    // moments viewers clipped on Twitch (fx-auto.js) are added and boosted
    const markers = FX.vodMarkers ? FX.vodMarkers(entry, file, buffer.duration) : [];
    for (const mk of markers) {
      const near = hl.find((h) => Math.abs(h.start - mk.start) < len * 0.6);
      if (near) near.chat = Math.max(near.chat || 0, mk.views);
      else if (mk.start < buffer.duration - 3) hl.push({ start: mk.start, peak: mk.start + 5, score: 0, chat: mk.views });
    }
    const known = (await FX.db.ideas.all()).filter((i) => i.type === 'moment' && i.vodKey === entry.key);
    const ms = [];
    for (const [i, h] of hl.entries()) {
      if (known.some((k) => Math.abs((k.peak ?? k.start) - h.peak) < len * 0.6)) continue; // never clip the same moment twice
      // transcribe a padded window around the peak so the clip plan can start on the setup and end on a finished sentence
      const s0 = Math.max(0, h.peak - len * 0.6 - 6), L = Math.min(len + 14, buffer.duration - s0);
      const wav = await segmentWav(buffer, s0, L);
      const wavFile = await FX.saveFile(wav, `${file.name}_${Math.round(s0)}.wav`, { role: 'moment-audio' });
      let tr = null;
      if (FX.hasAI()) {
        say(`Transcribing moment ${i + 1}/${hl.length}…`);
        FX.use('whisper');
        tr = await FX.retry(async () => { try { return await transcribe(wav, 'moment.wav'); } catch (e) { throw /429|5\d\d|network|fetch/i.test(e.message) ? new FX.TempError(e.message) : e; } }, 'transcription');
        FX.cost(r, 'trends', 'openai:whisper-1', Math.round(L), (L / 60) * FX.prices().whisper_per_min);
      }
      ms.push({ i, start: s0, peak: h.peak, len: L, chat: h.chat || 0, energy: Math.round(h.score * 100) / 100, transcript: tr?.text?.trim() || '', words: (tr?.words || []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })), wavFile });
    }
    const maxE = Math.max(1, ...ms.map((m) => m.energy));
    const maxChat = Math.max(1, ...ms.map((m) => m.chat));
    let ai = null, signals = [];
    if (FX.hasAI() && ms.some((m) => m.transcript)) {
      say('Ranking moments…');
      signals = await gtaSignals(c);
      ai = await FX.ai(r, 'trends', `You are the clip scout for a ${c.game} streamer clip channel. You pick moments that are funny, clutch, chaotic or wholesome AND make sense to a stranger scrolling TikTok. Channel avoids: ${c.avoid}.`,
        `Trending in GTA communities right now:\n${signals.filter((s) => s.items.length).map((s) => `${s.source}: ${s.items.slice(0, 8).join(' | ')}`).join('\n') || '(unavailable)'}\n\nCandidate moments from the VOD "${file.name}" (loudness = audio hype vs the rest of the stream):\n` +
        ms.map((m) => `#${m.i} at ${fmt(m.start)} (loudness ${m.energy}): "${m.transcript.slice(0, 700)}"`).join('\n') +
        `\n\nReturn JSON {"moments":[{"i": number, "hype": 1-10, "standalone": 1-10 (understandable without context), "trending": 1-10 (fits what GTA fans talk about now), "title": short title, "hook": on-screen hook max 8 words, "concerns": [policy/copyright concerns like slurs, real threats, personal info, radio music, other streamers' content], "skip": boolean, "why": string}]}`, { temperature: 0.4 });
    }
    const out = [];
    for (const m of ms) {
      const a = (ai?.moments || []).find((x) => +x.i === m.i) || {};
      const scores = { hype: a.hype ?? Math.round((m.energy / maxE) * 10), standalone: a.standalone ?? 5, trending: a.trending ?? 5, loudness: Math.round((m.energy / maxE) * 10), ...(m.chat ? { viewerClips: Math.max(4, Math.round((m.chat / maxChat) * 10)) } : {}) };
      const idea = {
        id: 'mom_' + now().toString(36) + m.i, type: 'moment', created: now(), status: a.skip ? 'rejected' : 'new', rejectReason: a.skip ? a.why : '',
        vodKey: entry.key, vodName: file.name, start: m.start, len: m.len, peak: m.peak, energy: m.energy, transcript: m.transcript, words: m.words, wavFile: m.wavFile,
        topic: a.title || `${file.name.replace(/\.\w+$/, '')} @ ${fmt(m.start)}`, description: a.why || (m.chat && !m.energy ? `Viewers clipped this on Twitch (${m.chat} clip views)` : `Hype moment at ${fmt(m.start)} (loudness ${m.energy}× the stream average)`),
        hook: a.hook || 'WAIT FOR IT…', hookStyle: 'moment', concerns: a.concerns || [], scores,
        rank: Math.round((scores.hype * 0.4 + scores.standalone * 0.3 + scores.trending * 0.15 + scores.loudness * 0.15 + (scores.viewerClips || 0) * 0.4) * 10) / 10,
        method: (ai ? 'audio hype + transcript + AI ranking' : 'audio hype only (no OpenAI key)') + (m.chat ? ' + Twitch viewer clips' : ''), signals: signals.map((s) => s.source).concat(m.chat ? [`Twitch: viewers clipped this (${m.chat} clip views)`] : []),
      };
      await FX.db.ideas.put(idea); out.push(idea);
    }
    saveInbox(FX.vodInbox().map((e) => (e.key === entry.key ? { ...e, status: 'scanned', moments: out.length, scannedAt: now() } : e)));
    FX.emit('ideas');
    return out;
  }
  FX.scoutVod = scoutVod;

  R.trends = async (r, say, o) => {
    if (!isClip(r)) return base.trends(r, say, o);
    await scanFolder().catch(() => {});
    let pool = [];
    for (const i of (await FX.db.ideas.all()).filter((x) => x.type === 'moment' && x.status === 'new')) if (await getVod(i.vodKey)) pool.push(i);
    let scanned = null;
    if (!pool.length) {
      let entry = null;
      for (const e of FX.vodInbox().filter((x) => x.status === 'new')) if (await getVod(e.key)) { entry = e; break; }
      if (!entry) return { verdict: 'BLOCKED', summary: 'No VODs waiting. Drop a stream VOD on the Assembly Line (or choose a VOD folder on the Autopilot tab) and this video starts automatically.', items: [] };
      scanned = await scoutVod(r, entry, say);
      pool = scanned.filter((x) => x.status === 'new');
    }
    if (!pool.length) return { verdict: 'HUMAN_REVIEW', summary: 'No usable moments found in that VOD (all skipped or duplicates). Drop another VOD or pick a moment yourself in Ideas.', items: [] };
    pool.sort((a, b) => b.rank - a.rank);
    const idea = pool[0]; idea.status = 'used'; idea.usedBy = r.id; await FX.db.ideas.put(idea);
    r.idea = idea;
    const items = (idea.concerns || []).map((x) => item('medium', 'Moment', x, 'Later departments will check this.'));
    if (!idea.transcript) items.push(item('low', 'Moment', 'No transcript (no OpenAI key): ranked by audio hype only.', 'Add a key for captions and smarter picks.'));
    return { verdict: verdictFrom(items), summary: `Picked the moment at ${fmt(idea.start)} in ${idea.vodName} (rank ${idea.rank}${scanned ? `, from ${scanned.length} new moments found` : ''}).`, items, method: idea.method, data: { ranking: pool.slice(0, 8).map((i) => ({ topic: i.topic, rank: i.rank, scores: i.scores, at: fmt(i.start) })) } };
  };

  /* ===================================================================
     3. CONTEXT CHECK (fact-check for clips): streamer statements are not facts;
        flag personal info, real threats and claims about real people
     =================================================================== */
  R.factcheck = async (r, say, o) => {
    if (!isClip(r)) return base.factcheck(r, say, o);
    const c = FX.channel(), m = r.idea, t = m.transcript || '', items = [];
    r.research = { method: 'context check (stream clip, not a factual video)', sources: [{ id: 'S1', publisher: c.streamer || 'Stream VOD', title: m.vodName, url: '', retrieved: now() }], claims: [], at: now() };
    if (/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(t)) items.push(item('high', 'Transcript', 'Looks like a phone number is said out loud', 'Do not publish personal info; pick another moment or cut it.'));
    if (/[\w.+-]+@[\w-]+\.\w+/.test(t)) items.push(item('high', 'Transcript', 'Looks like an email address is said', 'Cut it.'));
    if (!t) items.push(item('low', 'Transcript', 'No transcript (no OpenAI key), so context could not be checked.', 'Watch the clip before approving.'));
    if (t && FX.hasAI()) {
      say('Checking context and real-world claims…');
      const out = await FX.ai(r, 'factcheck', 'You review a moment from a GTA livestream before it is clipped. In-game events are fiction. You care about real-world risk: claims about real people, real threats, personal information, slurs.',
        `Transcript: "${t.slice(0, 3000)}"\nReturn JSON {"standalone": 1-10, "contextNeeded": string, "realWorldClaims": [{"claim": string, "risk": "low"|"medium"|"high"}], "personalInfo": boolean, "realThreats": boolean, "slurs": boolean, "notes": string}`, { temperature: 0.1 });
      (out?.realWorldClaims || []).forEach((x, i) => { r.research.claims.push({ id: 'C' + (i + 1), text: x.claim, kind: 'streamer statement', status: 'unverified', note: 'Said on stream; titles must not present it as fact' }); if (x.risk !== 'low') items.push(item(x.risk === 'high' ? 'high' : 'medium', 'Real-world claim', `"${x.claim}"`, 'Don\'t repeat it as fact in title/description; cut it if it could be defamatory.')); });
      if (out?.personalInfo) items.push(item('high', 'Transcript', 'Possible personal information', 'Cut it or skip this moment.'));
      if (out?.realThreats) items.push(item('high', 'Transcript', 'Possible real-world threat (not in-game)', 'Skip this moment.'));
      if (out?.slurs) items.push(item('high', 'Transcript', 'Possible slur', 'Skip this moment or mute it.'));
      if ((out?.standalone ?? 10) < 4) items.push(item('medium', 'Context', `Hard to follow without context: ${out.contextNeeded}`, 'Add a commentary intro or on-screen context.'));
      r.research.context = out?.contextNeeded || '';
    }
    const high = items.some((i) => i.sev === 'high');
    return { verdict: high ? 'HUMAN_REVIEW' : verdictFrom(items), summary: high ? 'Something in this moment needs a person to look.' : 'Context checked. In-game events are treated as fiction; streamer statements are not presented as fact.', items, method: r.research.method };
  };

  /* ===================================================================
     4. CLIP PLAN (script for clips): trim, hook overlay, title, optional AI commentary intro
     =================================================================== */
  const wordsIn = (m, a, b) => (m.words || []).filter((w) => w.start >= a - 0.05 && w.end <= b + 0.2);
  R.script = async (r, say, o) => {
    if (!isClip(r)) return base.script(r, say, o);
    const c = FX.channel(), m = r.idea;
    if (r.script) r.scriptHistory.push({ ...r.script, replacedAt: now() });
    let trimStart = 0, trimEnd = m.len, title = m.topic, hook = m.hook, intro = '';
    { // without AI: a window around the loudest point, ending a few seconds after it
      const pk = (m.peak ?? m.start + m.len / 2) - m.start, L = Math.min(+c.clipLen || 35, m.len);
      trimStart = Math.max(0, Math.min(m.len - L, pk - L * 0.65)); trimEnd = Math.min(m.len, trimStart + L);
    }
    let method = 'audio + word timings';
    if (FX.hasAI() && m.transcript) {
      say('Planning the cut, hook and title…');
      method = 'AI clip plan';
      const fix = r.revisionNote ? `\nTHIS IS A REVISION. Fix: ${(r.reports[r.revisionNote.from]?.items || []).filter((i) => i.sev !== 'low').map((i) => `${i.where}: ${i.issue} → ${i.fix}`).join(' | ')}` : '';
      const out = await FX.ai(r, 'script', `You edit GTA stream clips for TikTok/Shorts/Reels. ${c.style}. Tone: ${c.tone}. Never put words in the streamer's mouth.`,
        `Moment transcript with timestamps (seconds from clip start, clip is ${m.len.toFixed(1)}s):\n${(m.words || []).map((w) => `${w.start.toFixed(1)} ${w.word}`).join(' ').slice(0, 5000)}\n${r.research?.context ? `Context note: ${r.research.context}\n` : ''}${fix}\n` +
        `Pick the tightest window (8–${c.clipLen}s) that starts as late as possible while keeping the setup, ends right after the payoff/reaction, and does not cut mid-sentence. The first 2 seconds must already be interesting. Return JSON {"trimStart": seconds, "trimEnd": seconds, "hook": on-screen hook max 8 words (no false claims), "title": short honest title, "intro": ${c.introCommentary ? 'ONE short spoken sentence (max 14 words) that gives the context a stranger needs, in our own voice, or "" if the clip explains itself' : '""'}}`, { temperature: 0.5 });
      if (out) {
        const a = Math.max(0, Math.min(m.len - 5, +out.trimStart || 0)), b = Math.min(m.len, Math.max(a + 5, +out.trimEnd || m.len));
        trimStart = a; trimEnd = b; hook = out.hook || hook; title = out.title || title; intro = c.introCommentary ? String(out.intro || '').trim() : '';
      }
    }
    // snap the cut to word boundaries, finish the sentence, and jump-cut dead air (no AI needed)
    let env = null;
    try { if (m.wavFile) env = FX.envelope(await FX.decode(await FX.getFile(m.wavFile)), 0.05); } catch {}
    const cut = FX.planCut(m, trimStart, trimEnd, env, { maxLen: +c.clipLen || 35, jumpCuts: c.jumpCuts !== false });
    trimStart = cut.trimStart; trimEnd = cut.trimEnd;
    const len = Math.max(3, trimEnd - trimStart);
    r.clip = { vodKey: m.vodKey, vodName: m.vodName, start: m.start + trimStart, len, trimStart, keep: cut.keep.map(([a, b]) => [m.start + a, m.start + b]), outLen: cut.outLen, cuts: cut.cuts, peak: m.peak, layout: c.layout || 'blur', tag: c.clipTag || '', hook, intro, title };
    const said = wordsIn(m, trimStart, trimEnd).map((w) => w.word).join(' ');
    const scenes = [];
    if (intro) scenes.push({ n: 1, vo: intro, onScreen: hook, footage: { kind: 'stream', query: 'freeze frame + context' }, sfx: 'none', transition: 'cut', claims: [] });
    scenes.push({ n: scenes.length + 1, vo: said || '(stream audio)', onScreen: hook, footage: { kind: 'stream', query: 'stream VOD segment' }, sfx: intro ? 'whoosh' : 'none', transition: intro ? 'flash' : 'cut', claims: [], streamAudio: true });
    r.script = { title, hookStyle: intro ? 'commentary intro' : 'cold open', format: 'stream clip', scenes, cta: c.cta, version: r.scriptHistory.length + 1, at: now(), method, duration: (intro ? FX.words(intro).length / 2.6 + 0.3 : 0) + cut.outLen };
    return { verdict: 'PASS', summary: `Clip plan v${r.script.version}: ${fmt(r.clip.start)}–${fmt(r.clip.start + len)} (${cut.outLen.toFixed(1)}s${cut.cuts.length ? ` after ${cut.cuts.length} jump cut(s) removing ${(len - cut.outLen).toFixed(1)}s of dead air` : ''}), hook "${hook}"${intro ? ', with a commentary intro' : ''}.`, items: [], method };
  };

  /* 5. CLIP QC */
  const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|cunt|dick)\b/gi;
  R.scriptqc = async (r, say, o) => {
    if (!isClip(r)) return base.scriptqc(r, say, o);
    const c = FX.channel(), m = r.idea, cl = r.clip, items = [];
    if (FX.words(cl.hook).length > 8) items.push(item('medium', 'Hook', `Hook is ${FX.words(cl.hook).length} words`, 'Keep it to 8 words or less.'));
    if (cl.len < 8) items.push(item('medium', 'Length', `Clip is only ${cl.len.toFixed(1)}s`, 'Include more setup.'));
    if (cl.len > 90) items.push(item('medium', 'Length', `Clip is ${cl.len.toFixed(0)}s`, 'Shorts work best under 60s.'));
    const after = (m.words || []).find((w) => w.start > cl.trimStart + cl.len - 0.1);
    if (after && after.start - (cl.trimStart + cl.len) < 0.25) items.push(item('medium', `End @ ${fmt(cl.start + cl.len)}`, 'Clip cuts off mid-sentence', 'Extend the end to the end of the sentence.'));
    const swears = (clipVO(r).match(PROFANITY) || []).length;
    if (swears) items.push(item(swears > 3 ? 'medium' : 'low', 'Language', `${swears} strong swear word(s)`, 'Fine on TikTok mostly; heavy profanity early on limits YouTube ads. Consider muting.'));
    for (const a of FX.lines(c.avoid)) if (a.length > 3 && FX.norm(clipVO(r) + ' ' + cl.title).includes(FX.norm(a))) items.push(item('high', 'Channel rules', `Touches an avoided topic: "${a}"`, 'Pick another moment.'));
    for (const o2 of await FX.db.prod.all()) if (o2.id !== r.id && o2.clip && o2.clip.vodKey === cl.vodKey && Math.abs(o2.clip.start - cl.start) < cl.len * 0.5 && o2.status !== 'rejected') items.push(item('high', 'Duplicate', `Overlaps ${o2.id}, which clips the same moment`, 'Reject one of them.'));
    let method = 'rules';
    if (FX.hasAI() && m.transcript) {
      method = 'rules + independent AI review';
      const out = await FX.ai(r, 'scriptqc', 'You review a planned GTA stream clip before rendering. Be specific and practical. In-game violence is normal for GTA.',
        `Title: ${cl.title}\nHook overlay: ${cl.hook}\nIntro commentary: ${cl.intro || '(none)'}\nWhat the streamer says in the clip: "${clipVO(r)}"\nCheck: is the title/hook honest about what happens (no clickbait about things that don't happen), hook quality, intro grammar, slurs, harassment of real people, sexual content, anything that breaks: ${c.avoid}.\nReturn JSON {"issues":[{"severity":"high"|"medium"|"low","where":string,"issue":string,"fix":string}]}`, { temperature: 0.2 });
      (out?.issues || []).forEach((i) => items.push(item(i.severity || 'low', i.where || 'Clip', i.issue, i.fix || '')));
    } else items.push(item('low', 'Method', 'AI review skipped (no OpenAI key). Watch the clip before approving.', ''));
    const dup = items.some((i) => i.where === 'Duplicate');
    const v = verdictFrom(items);
    return { verdict: dup ? 'REJECTED' : v, sendBackTo: 'script', summary: dup ? 'Duplicate of an existing clip — rejected.' : v === 'FAIL' ? 'Returned to the clip plan with fixes.' : 'Clip plan approved.', items, method };
  };

  /* 6. INTRO VOICEOVER (stream audio is used as-is) */
  R.voice = async (r, say, o) => {
    if (!isClip(r)) return base.voice(r, say, o);
    const cl = r.clip, c = FX.channel();
    if (!cl.intro) { r.voice = { scenes: [], streamAudio: true, method: 'original stream audio, no voiceover', at: now() }; return { verdict: 'PASS', summary: 'No intro; the clip uses the original stream audio.', items: [], method: r.voice.method }; }
    if (!FX.hasAI()) { cl.intro = ''; r.script.scenes = r.script.scenes.filter((s) => s.streamAudio).map((s) => ({ ...s, n: 1, transition: 'cut' })); r.voice = { scenes: [], streamAudio: true, at: now() }; return { verdict: 'WARNING', summary: 'Intro skipped (needs an OpenAI key for the voice).', items: [item('medium', 'Intro', 'Commentary intro skipped: no OpenAI key', 'Add a key for commentary intros (they help originality).')] }; }
    say('Voicing the commentary intro…');
    const blob = await FX.tts(r, 'voice', cl.intro, { voice: c.voice, speed: +c.speed || 1 });
    const buf = await FX.decode(blob), st = FX.analyzeVoice(buf, cl.intro), items = [];
    const tr = await FX.whisper(r, 'voice', buf), al = FX.align(cl.intro.split(/\s+/), (tr?.text || '').split(/\s+/));
    if (al.accuracy < 0.85) items.push(item('high', 'Intro', `Intro doesn't match the text (${Math.round(al.accuracy * 100)}% heard)`, 'Regenerating.'));
    if (st.clip > 20) items.push(item('high', 'Intro', 'Clipping in the intro voice', 'Regenerating.'));
    st.gaps.forEach((g) => items.push(item('medium', `Intro @ ${FX.ts(g.at)}`, `Pause of ${g.len.toFixed(1)}s`, '')));
    const fileId = await FX.saveFile(blob, `${r.id}_intro.mp3`, { recId: r.id, role: 'voice' });
    r.voice = { scenes: [{ n: 1, text: cl.intro, fileId, ...st, accuracy: al.accuracy, transcript: tr?.text || '', gainDb: Math.max(-6, Math.min(9, -18 - st.rmsDb)), issues: [] }], streamAudio: true, voiceName: c.voice, method: 'OpenAI tts-1 intro + original stream audio', at: now() };
    const v = verdictFrom(items);
    return { verdict: v, sendBackTo: 'voice', summary: v === 'FAIL' ? 'Intro voice failed its check; regenerating.' : `Intro voiced (${st.dur.toFixed(1)}s).`, items, method: r.voice.method };
  };

  /* 7. ASSETS & RIGHTS RECORDS for the clip */
  R.assets = async (r, say, o) => {
    if (!isClip(r)) return base.assets(r, say, o);
    const c = FX.channel(), cl = r.clip, n = r.script.scenes.find((s) => s.streamAudio).n;
    const rel = c.streamerRelation, proof = !!(c.permissionProof && c.permissionDate);
    const lic = rel === 'me' ? 'My own stream' : rel === 'permission' ? (proof ? 'Streamer permission (documented)' : 'Streamer permission (undocumented)') : 'No permission recorded';
    const mk = (o2) => ({ id: 'a_' + now().toString(36) + Math.random().toString(36).slice(2, 6), acquired: new Date().toISOString(), ...o2 });
    const assets = [
      mk({ scene: n, name: `${cl.vodName} ${fmt(cl.start)}–${fmt(cl.start + cl.len)}`, kind: 'stream', source: `${c.streamer || 'Streamer'} stream VOD`, creator: c.streamer || 'You', license: lic, licenseUrl: c.permissionProof || '', commercial: rel === 'me' || (rel === 'permission' && proof) ? true : 'unknown', attribution: rel === 'permission' ? 'required' : 'not required', attributionText: rel === 'permission' && c.streamer ? `Clip from ${c.streamer}'s stream, used with permission (${c.permissionDate})` : '', note: `Permission: ${rel === 'me' ? 'your own stream' : rel === 'permission' ? `granted ${c.permissionDate || '(no date)'} — ${c.permissionProof || 'no proof saved'}` : 'none recorded'}` }),
      mk({ scene: n, name: `${c.game} gameplay shown in the stream`, kind: 'game', source: 'Game publisher', creator: 'Game publisher', license: c.gamePolicyAck ? 'Game publisher video policy (reviewed)' : 'Game publisher video policy (not reviewed)', licenseUrl: '', commercial: c.gamePolicyAck ? true : 'unknown', attribution: 'not required' }),
    ];
    if (cl.intro) assets.push(mk({ scene: 1, name: 'Commentary intro voice', kind: 'audio', source: 'OpenAI tts-1', creator: 'Generated for this video', license: 'AI voice (OpenAI TTS output)', licenseUrl: 'https://openai.com/policies/terms-of-use/', commercial: true, attribution: 'not required', aiGenerated: true }));
    if (cl.intro) assets.push(mk({ scene: 0, name: 'Transition whoosh', kind: 'audio', source: 'AutoClipper WebAudio synth', creator: 'AutoClipper', license: 'Original work (generated in AutoClipper)', licenseUrl: '', commercial: true, attribution: 'not required' }));
    const items = [];
    for (const a of assets) { const chk = FX.checkLicense(a); a.status = chk.status; a.check = chk.reason; if (chk.status !== 'verified') items.push(item('high', a.name, chk.reason, chk.status === 'manual_review' ? 'Fix it in Channel, or approve it yourself if you\'re sure.' : 'Replace it.')); }
    r.assets = assets; r.assetRejects = [];
    r.attributions = assets.filter((a) => a.attributionText).map((a) => a.attributionText);
    const manual = assets.some((a) => a.status === 'manual_review');
    return { verdict: manual ? 'HUMAN_REVIEW' : verdictFrom(items), summary: manual ? 'Rights for the stream footage or the game are not documented yet.' : `${assets.length} asset record(s) documented (stream: ${lic}).`, items };
  };

  /* 8. CAPTIONS from the stream's own audio (word timings from the moment transcription) */
  R.captions = async (r, say, o) => {
    if (!isClip(r)) return base.captions(r, say, o);
    const c = FX.channel(), cl = r.clip, m = r.idea, items = [];
    const iv = r.voice.scenes[0]; const introEnd = iv ? iv.dur + 0.25 : 0;
    const map = FX.clipMap(cl);
    let words = [];
    if (iv) { // spread the intro text over the voice length, weighted by word length
      const w = cl.intro.split(/\s+/).filter(Boolean), tot = w.reduce((t, x) => t + x.length + 2, 0); let t = 0.1;
      w.forEach((x) => { const d = (iv.dur - 0.1) * (x.length + 2) / tot; words.push({ word: x, start: t, end: t + d }); t += d; });
    }
    // stream words, moved onto the output timeline (words inside a jump cut are dropped)
    for (const w of wordsIn(m, cl.trimStart, cl.trimStart + cl.len)) {
      const s0 = map.toOut(m.start + w.start); if (s0 == null) continue;
      const e0 = map.toOut(m.start + w.end); words.push({ word: w.word, start: introEnd + s0, end: introEnd + (e0 ?? s0 + (w.end - w.start)) });
    }
    let cues = [];
    if (words.length) {
      cues = FX.captionChunks(words);
      const emph = new Set(FX.keywords(cl.hook + ' ' + cl.title));
      cues.forEach((q) => { q.hl = q.text.split(' ').map((w) => /\d/.test(w) || emph.has(FX.norm(w)) || PROFANITY.test(w) || /^(no|yo|bro|what|wait|oh|omg|bruh)\W*$/i.test(w)); PROFANITY.lastIndex = 0; const cps = q.text.length / Math.max(0.05, q.end - q.start); if (cps > 26) items.push(item('low', FX.ts(q.start), `"${q.text}" is on screen ${(q.end - q.start).toFixed(2)}s`, 'Fast speech; readable but quick.')); });
    } else items.push(item('medium', 'Captions', 'No captions: the stream audio was not transcribed (needs an OpenAI key).', 'Captions roughly double watch time on shorts; add a key.'));
    const z = FX.layoutZones(cl.layout);
    const style = { color: c.captionColor, highlight: c.highlightColor, pos: cl.layout === 'blur' ? z.caption : (cl.layout === 'split' ? z.caption : c.captionPos), size: c.captionSize };
    if (style.pos < 0.3 || style.pos > 0.78) items.push(item('medium', 'Style', 'Caption position outside the platform-safe zone', 'Change it in Channel.'));
    const srt = cues.map((q, i) => `${i + 1}\n${FX.srtT(q.start)} --> ${FX.srtT(q.end)}\n${q.text}\n`).join('\n');
    r.captions = { cues, style, method: words.length ? 'stream transcription (Whisper word timings), mapped through jump cuts' : 'none', srtFile: await FX.saveFile(new Blob([srt], { type: 'text/plain' }), r.id + '.srt', { recId: r.id, role: 'captions' }), at: now() };
    r.timeline = iv ? [{ n: 1, start: 0, end: introEnd, voiceStart: 0.1, voiceEnd: 0.1 + iv.dur }, { n: 2, start: introEnd, end: introEnd + map.len, voiceStart: introEnd, voiceEnd: introEnd + map.len }] : [{ n: 1, start: 0, end: map.len, voiceStart: 0, voiceEnd: map.len }];
    r.duration = introEnd + map.len;
    return { verdict: verdictFrom(items), summary: cues.length ? `${cues.length} captions synced to the stream audio.` : 'No captions (no transcription).', items, method: r.captions.method };
  };

  /* 9. EDIT & EXPORT: intro card (optional) + the clip in your layout, captions burned in */
  // hook card: white box, black heavy type, pops in
  function banner(text, a = 1, y = H * 0.15, pop = 1) {
    if (!text) return;
    ctx.save(); ctx.globalAlpha = a; ctx.font = '900 70px Impact, "Arial Black", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapText(text.toUpperCase(), W - 200).slice(0, 2), bh = lines.length * 80 + 40, bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 80;
    ctx.translate(W / 2, y); ctx.scale(pop, pop); ctx.rotate(-0.02); ctx.translate(-W / 2, -y);
    const box = (dy) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect((W - bw) / 2, y - bh / 2 + dy, bw, bh, 24) : ctx.rect((W - bw) / 2, y - bh / 2 + dy, bw, bh); ctx.fill(); };
    ctx.fillStyle = 'rgba(0,0,0,.35)'; box(10); // cheap drop shadow (shadowBlur is too slow at 30 fps)
    ctx.fillStyle = '#fff'; box(0);
    ctx.fillStyle = '#111'; lines.forEach((l, i) => ctx.fillText(l, W / 2, y + (i - (lines.length - 1) / 2) * 80));
    ctx.restore();
  }
  const waitEv = (el, ev, ms = 8000) => new Promise((res) => { const f = () => { el.removeEventListener(ev, f); res(); }; el.addEventListener(ev, f); setTimeout(f, ms); });
  async function renderClip(r, p, file, say) {
    const ac = getAudioCtx(); await ac.resume();
    if (ac.state !== 'running') throw new FX.TempError('The browser paused audio. Click anywhere on the page so the line can render.');
    await loadVod(file);
    if (!mediaSrc) { mediaSrc = ac.createMediaElementSource(vod); mediaDest = ac.createMediaStreamDestination(); mediaSrc.connect(mediaDest); const mute = ac.createGain(); mute.gain.value = 0; mediaSrc.connect(mute).connect(ac.destination); }
    const c = FX.channel(), cl = r.clip, introEnd = p.introEnd, map = FX.clipMap(cl), keep = map.keep, z = FX.layoutZones(cl.layout);
    // audio: stream -> level/duck -> compressor -> make-up gain -> limiter -> recorder
    const dest = ac.createMediaStreamDestination();
    const sg = ac.createGain(), comp = ac.createDynamicsCompressor(), mk = ac.createGain(), lim = ac.createDynamicsCompressor(), out = ac.createGain();
    comp.threshold.value = -22; comp.knee.value = 8; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.2;
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const lvl = 10 ** ((p.audio.streamGainDb || 0) / 20); sg.gain.value = introEnd ? lvl * 0.16 : lvl; mk.gain.value = 1;
    const clip = ac.createWaveShaper(), cv = new Float32Array(2049); for (let i = 0; i < cv.length; i++) { const x = i / 1024 - 1, ax = Math.abs(x); cv[i] = ax < 0.85 ? x : Math.sign(x) * (0.85 + 0.12 * Math.tanh((ax - 0.85) / 0.12)); } clip.curve = cv; // safety soft-clip, never above -0.3 dBFS
    mediaSrc.connect(sg); sg.connect(comp).connect(mk).connect(lim).connect(clip).connect(out).connect(dest);
    let introSrc = null;
    if (p.audio.introFile) { const b = await FX.decode(await FX.getFile(p.audio.introFile)); introSrc = ac.createBufferSource(); introSrc.buffer = b; const g = ac.createGain(); g.gain.value = 10 ** ((p.audio.introGainDb || 0) / 20); introSrc.connect(g).connect(lim); }
    let whoosh = null;
    if (introEnd) { const n = ac.createBuffer(1, ac.sampleRate * 0.45, ac.sampleRate), d = n.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((i / d.length) * Math.PI) * 0.12; whoosh = ac.createBufferSource(); whoosh.buffer = n; const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; whoosh.connect(bp).connect(dest); }
    // during the intro the footage leading into the clip plays underneath (ducked), so nothing is ever frozen
    const pre = introEnd ? Math.max(0, keep[0][0] - introEnd) : keep[0][0];
    const playAt = introEnd ? introEnd - (keep[0][0] - pre) : 0; // wall-clock second when the VOD starts moving
    vod.muted = false; vod.currentTime = pre; await waitEv(vod, 'seeked');
    let t = 0, vt = pre;
    const draw = () => {
      FX.drawClipFrame(ctx, vod, c, cl.layout, FX.clipFx(vt, cl.peak, t, introEnd, c.punchZoom !== false));
      if (t < introEnd) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(8,6,14,.35)'); g.addColorStop(1, 'rgba(8,6,14,.15)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
      const hookUntil = Math.max(introEnd, 0) + 2.8;
      if (t < hookUntil) banner(cl.hook, Math.min(1, (hookUntil - t) / 0.3), H * z.hook, t < 0.18 ? 0.85 + 0.15 * (t / 0.18) + 0.06 * Math.sin((t / 0.18) * Math.PI) : 1);
      if (cl.tag) drawCaption(cl.tag, cl.layout === 'split' ? H * 0.06 : H * 0.95, 48, '#fff');
      const cue = p.captions.find((q) => t >= q.start && t < q.end); if (cue) FX.drawCue(cue, p.captionStyle, t);
    };
    draw();
    const rec = startRecorder(dest.stream);
    const t0 = performance.now(); if (introSrc) introSrc.start(ac.currentTime + 0.1);
    if (whoosh) whoosh.start(ac.currentTime + Math.max(0, introEnd - 0.3));
    let frames = 0, drawMs = 0;
    let playing = false, ducked = !!introEnd, seg = 0, seeking = false, lastT = -1, stuck = 0, lastPct = -1, fading = false;
    if (playAt <= 0) { await vod.play(); playing = true; }
    await renderLoop(() => {
      if (seeking) return false;
      if (!playing) { t = (performance.now() - t0) / 1000; if (t >= playAt) { vod.play(); playing = true; } }
      else {
        vt = vod.currentTime;
        if (vt < keep[0][0]) t = introEnd - (keep[0][0] - vt);
        else {
          // jump cut: pause the recorder, seek past the dead air, resume (the cut is seamless in the file)
          if (seg < keep.length - 1 && vt >= keep[seg][1]) {
            seeking = true; seg++; rec.pause(); vod.pause();
            vod.currentTime = keep[seg][0];
            waitEv(vod, 'seeked').then(async () => { vt = vod.currentTime; t = introEnd + map.toOut(vt, true); draw(); await vod.play().catch(() => {}); rec.resume(); seeking = false; });
            return false;
          }
          t = introEnd + map.toOut(vt, true);
        }
      }
      if (ducked && t >= introEnd - 0.05) { ducked = false; sg.gain.setTargetAtTime(lvl, ac.currentTime, 0.03); }
      if (!fading && t > p.duration - 0.2) { fading = true; out.gain.setTargetAtTime(0, ac.currentTime, 0.05); }
      const d0 = performance.now(); draw(); frames++; drawMs += performance.now() - d0;
      const pct = Math.floor((t / p.duration) * 20); if (pct !== lastPct) { lastPct = pct; say(`Rendering ${Math.min(100, Math.max(0, pct) * 5)}% (real-time, ${Math.round(p.duration)}s)…`); }
      stuck = playing && vod.currentTime === lastT ? stuck + 1 : 0; lastT = vod.currentTime;
      if (stuck > FPS * 15) throw new FX.TempError('VOD playback stalled while rendering');
      return t >= p.duration || vod.ended;
    });
    vod.pause(); try { mediaSrc.disconnect(sg); } catch {}
    const blob = await rec.stop();
    vod.removeAttribute('src'); vod.load();
    blob.stats = { frames, fps: frames / Math.max(1, p.duration), drawMs: drawMs / Math.max(1, frames) };
    return blob;
  }
  async function streamGain(r) {
    try { const m = r.idea, env = FX.envelope(await FX.decode(await FX.getFile(m.wavFile)), 0.05); return FX.streamGainDb(env, FX.clipMap(r.clip).keep.map(([a, b]) => [a - m.start, b - m.start])); } catch { return 0; }
  }
  R.edit = async (r, say, o) => {
    if (!isClip(r)) return base.edit(r, say, o);
    const file = await getVod(r.clip.vodKey);
    if (!file) return { verdict: 'BLOCKED', summary: `The VOD "${r.clip.vodName}" isn't available in this session. Drop it on the Assembly Line again (or re-grant the folder) and the line continues.`, items: [] };
    const iv = r.voice.scenes[0];
    if (r.edit) r.editHistory.push({ version: r.edit.version, at: r.edit.at });
    const p = {
      version: (r.editHistory?.length || 0) + 1, at: now(), width: W, height: H, fps: FPS, duration: r.duration, introEnd: iv ? r.timeline[0].end : 0,
      scenes: r.timeline.map((t, i) => ({ ...t, onScreen: r.clip.hook, transition: i ? 'zoom' : 'cut', asset: { kind: i === r.timeline.length - 1 ? 'stream' : 'lead-in footage (ducked)' } })),
      clip: { ...r.clip }, captions: r.captions.cues, captionStyle: r.captions.style,
      audio: { stream: 'original VOD audio, levelled + compressed + limited', streamGainDb: await streamGain(r), introFile: iv?.fileId || null, introGainDb: iv?.gainDb || 0, music: null, sfx: iv ? [{ t: r.timeline[0].end, kind: 'whoosh' }] : [] },
      cuts: r.clip.cuts || [],
      export: { container: (pickMime() || 'video/webm').split(';')[0], ratio: '9:16', resolution: `${W}x${H}`, fps: FPS, audio: pickMime().includes('mp4a') ? 'AAC' : 'Opus', captions: 'burned in', layout: r.clip.layout },
    };
    const blob = await exclusive(() => renderClip(r, p, file, say));
    if (!blob || blob.size < 10000) return { verdict: 'FAIL', sendBackTo: 'edit', summary: 'Export produced an empty file.', items: [item('high', 'Export', 'Empty file')] };
    const container = blob.type.includes('mp4') ? 'MP4' : 'WebM', items = [];
    if (container !== 'MP4') items.push(item('medium', 'Export', 'This browser exported WebM, not MP4.', 'Use a recent Chrome or Edge for MP4/AAC.'));
    const st = blob.stats || {};
    if (st.fps && st.fps < 24) items.push(item(st.fps < 15 ? 'high' : 'medium', 'Export', `Only ${st.fps.toFixed(0)} frames per second were drawn (${(st.drawMs || 0).toFixed(0)} ms per frame), so motion will look choppy`, 'Keep this tab visible, close other heavy tabs/games, and re-export.'));
    const fileId = await FX.saveFile(blob, `${r.id}.${container.toLowerCase()}`, { recId: r.id, role: 'export' });
    const projFile = await FX.saveFile(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${r.id}_edit_v${p.version}.json`, { recId: r.id, role: 'edit-project' });
    r.edit = { ...p, projectFile: projFile };
    r.export = { fileId, size: blob.size, mime: blob.type, container, width: W, height: H, fps: FPS, duration: p.duration, audio: p.export.audio, captions: 'embedded', at: now(), editVersion: p.version };
    return { verdict: verdictFrom(items), summary: `Exported ${container} 1080×1920 @ ${FPS}fps, ${p.duration.toFixed(1)}s (${r.clip.layout} layout${p.cuts.length ? `, ${p.cuts.length} jump cut(s)` : ''}, stream audio ${p.audio.streamGainDb >= 0 ? '+' : ''}${p.audio.streamGainDb.toFixed(1)} dB), edit project v${p.version} saved.`, items };
  };

  /* 10. AUDIO QC for clips (stream audio is raw, so the thresholds are looser) */
  R.audioqc = async (r, say, o) => {
    if (!isClip(r)) return base.audioqc(r, say, o);
    say('Decoding the exported audio…');
    const items = []; let buf;
    try { buf = await FX.decode(await FX.getFile(r.export.fileId)); } catch { return { verdict: 'WARNING', summary: 'This browser could not decode the exported audio; checked nothing. Listen before approving.', items: [item('medium', 'Method', 'Exported audio not decodable here', 'Listen to it in the approval dashboard.')] }; }
    const d = buf.getChannelData(0), sr = buf.sampleRate; let clips = 0, first = null;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.995) { clips++; if (first == null) first = i / sr; }
    if (clips > 200) items.push(item('medium', FX.ts(first), `Distortion: ${clips} clipped samples (streams are often loud)`, 'Lower the stream\'s mic/game volume next time; consider another moment.'));
    const env = FX.envelope(buf, 0.1); let run = 0;
    env.forEach((db, i) => { if (db < -50) run++; else { if (run >= 30 && (i - run) * 0.1 > 1) items.push(item('medium', FX.ts((i - run) * 0.1), `Silence for ${(run * 0.1).toFixed(1)}s`, 'Trim dead air.')); run = 0; } });
    const loud = env.filter((x) => x > -50), avg = loud.length ? loud.reduce((a, x) => a + x, 0) / loud.length : -120;
    if (avg < -38) items.push(item('medium', 'Whole clip', `Very quiet (${avg.toFixed(0)} dBFS average)`, 'Raise the stream volume.'));
    if (r.edit.introEnd) { const a = FX.db20(FX.rms(d, 0, Math.round(r.edit.introEnd * sr))), b = FX.db20(FX.rms(d, Math.round(r.edit.introEnd * sr))); if (Math.abs(a - b) > 9) items.push(item('medium', FX.ts(r.edit.introEnd), `Intro voice and stream differ by ${Math.abs(a - b).toFixed(0)} dB`, 'Balance the intro gain.')); }
    if (Math.abs(buf.duration - r.edit.duration) > 1.5) items.push(item('high', 'Sync', `Audio ${buf.duration.toFixed(1)}s vs timeline ${r.edit.duration.toFixed(1)}s`, 'Re-export.'));
    const v = verdictFrom(items);
    return { verdict: v, sendBackTo: 'edit', summary: v === 'FAIL' ? 'Sent back to Editing.' : 'Audio checked on the exported file.', items, method: 'decoded the exported file' };
  };

  /* 12. RIGHTS: stream footage, game, and GTA's licensed radio music */
  R.copyright = async (r, say, o) => {
    const rep = await base.copyright(r, say, o);
    if (!isClip(r)) return rep;
    const t = r.idea?.transcript || '';
    if (rep.verdict === 'PASS') rep.verdict = 'WARNING';
    rep.items.push(item('medium', 'Music', 'GTA\'s in-game radio and streamers\' background music are licensed songs and commonly trigger Content ID claims.', 'Listen to the clip; if a song is audible, mute it or pick another moment.'));
    if (/♪|\(music\)|\[music\]/i.test(t)) { rep.items.push(item('high', 'Music', 'The transcript shows music playing in this moment', 'A person must check it; music claims can block monetization.')); rep.verdict = 'HUMAN_REVIEW'; rep.summary = 'Music detected in the clip. A person must check it before publishing.'; }
    return rep;
  };

  /* 14. MONETIZATION for clips: reused-content risk depends on who owns the stream */
  R.monetization = async (r, say, o) => {
    const rep = await base.monetization(r, say, o);
    if (!isClip(r)) return rep;
    const c = FX.channel();
    rep.items = rep.items.filter((i) => i.where !== 'Automation');
    let score = r.monetization.score - 1;
    if (c.streamerRelation === 'none') { score += 5; rep.items.push(item('high', 'Reused content', 'Clips of someone else\'s stream without documented permission are not eligible for YouTube monetization and risk strikes.', 'Clip your own streams or get written permission.')); }
    else if (c.streamerRelation === 'permission' && !r.clip?.intro) { score += 2; rep.items.push(item('medium', 'Reused content', 'Permitted clips with no added commentary can still be judged "reused content" by YouTube.', 'Turn on commentary intros or add your own edits.')); }
    else if (c.streamerRelation === 'me') rep.items.push(item('low', 'Reused content', 'Your own stream: low reused-content risk. Keep uploads varied.', ''));
    const level = score >= 6 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';
    r.monetization = { ...r.monetization, score, level };
    return { ...rep, verdict: level === 'HIGH' ? 'HUMAN_REVIEW' : level === 'MEDIUM' ? 'WARNING' : 'PASS', summary: `Monetization risk: ${level} (score ${score}).`, data: { ...rep.data, level, score } };
  };
})(window.FX);
