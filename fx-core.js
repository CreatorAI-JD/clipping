/* AutoClipper Assembly Line — core: production records, channel config, policies,
   costs/usage, AI wrappers and the central production manager.
   Loaded after app.js and reuses its helpers (idb, ls, val, log, tts, canvas, …).
   Departments live in fx-depts.js, the screens in fx-ui.js. */
'use strict';
window.FX = (function () {
  const FX = {};
  const now = () => Date.now();
  const clone = (o) => JSON.parse(JSON.stringify(o));
  FX.now = now; FX.clone = clone;

  /* ---------------- storage ---------------- */
  const store = (name) => ({
    put: (o) => idb(name, 'readwrite', (s) => s.put(o)),
    get: (id) => idb(name, 'readonly', (s) => s.get(id)),
    all: () => idb(name, 'readonly', (s) => s.getAll()),
    del: (id) => idb(name, 'readwrite', (s) => s.delete(id)),
  });
  FX.db = { prod: store('prod'), files: store('files'), ideas: store('ideas'), library: store('library'), audit: store('audit'), backups: store('backups') };

  FX.saveFile = async (blob, name, meta = {}) => {
    const id = 'f_' + now().toString(36) + Math.random().toString(36).slice(2, 7);
    await FX.db.files.put({ id, blob, name, type: blob.type, size: blob.size, at: now(), ...meta });
    return id;
  };
  FX.getFile = async (id) => (id ? (await FX.db.files.get(id))?.blob || null : null);

  FX.saveRecord = async (r) => { r.updated = now(); await FX.db.prod.put(r); FX.emit('records'); return r; };

  // VID-YYYYMMDD-NNN — unique, human readable
  FX.newVideoId = () => {
    const d = new Date(), day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const c = ls.get('fx_idc', {}); const n = (c.day === day ? c.n : 0) + 1;
    ls.set('fx_idc', { day, n });
    return `VID-${day}-${String(n).padStart(3, '0')}`;
  };

  /* ---------------- tiny event bus ---------------- */
  const subs = {};
  FX.on = (k, fn) => ((subs[k] ||= []).push(fn));
  FX.emit = (k, d) => (subs[k] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });

  /* ---------------- audit log (approvals, overrides, config changes) ---------------- */
  FX.audit = async (action, detail = '', recId = null, who = 'system') => {
    await FX.db.audit.put({ id: now() + '_' + Math.random().toString(36).slice(2, 6), at: now(), who, action, detail: String(detail).slice(0, 600), recId });
    FX.emit('audit');
  };

  /* ---------------- alerts (things a person must look at) ---------------- */
  FX.alert = async (msg, recId) => {
    log('🚨 ' + msg);
    await FX.audit('alert', msg, recId);
    try { toast(msg); } catch {}
    try { if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('AutoClipper assembly line', { body: msg }); } catch {}
  };

  /* ================= CHANNEL CONFIGURATION (shared by every department) ================= */
  // type "clips" = GTA streamer clips cut from VODs (the main line); type "faceless" = researched faceless videos
  FX.DEFAULT_CHANNEL = {
    type: 'clips', name: 'GTA stream clips', niche: 'GTA streamer clips (GTA RP / GTA Online / GTA 6 hype)', audience: 'GTA and GTA RP fans, 14–30, who watch Twitch/Kick streamers and want the funniest and wildest moments',
    platforms: ['youtube', 'tiktok', 'instagram'], tone: 'Hyped, funny, never mean to the streamer or chat', personality: 'A fan clipping the best moments, adding context so anyone gets the joke',
    style: 'Start right before the moment, cut dead air, big readable captions, one punchy hook line on screen', lengthSec: 35,
    streamer: '', streamerRelation: 'me', permissionProof: '', permissionDate: '', gamePolicyAck: false, game: 'Grand Theft Auto V / GTA RP',
    clipLen: 35, momentsPerVod: 6, layout: 'blur', clipTag: '', introCommentary: true, camCorner: 'bl', camSize: 25, camInset: 1, punchZoom: true, jumpCuts: true,
    voice: 'onyx', speed: 1.05, pronunciations: '', captionColor: '#ffffff', highlightColor: '#ffd400', captionPos: 0.64, captionSize: 84,
    music: true, musicVolume: 0.18, transitions: 'mixed',
    allowed: 'Funny, clutch, chaotic or wholesome gameplay and RP moments; reactions; GTA news reactions from the stream',
    avoid: 'Slurs or hate speech, real-life threats, doxxing or personal info, sexual content, harassment of other streamers or chat, real-world tragedies, gambling promos, moments with copyrighted music playing',
    originality: 'Only clip streams we own or have written permission to clip. Every clip gets our own hook, captions and edit; add a short commentary intro where it helps. Never re-upload another channel\'s clip or compilation.',
    monetizationGoal: 'YouTube Partner Program + TikTok Creator Rewards', cta: 'Follow for more GTA clips',
    subreddits: 'GTA, gtaonline, GTA6, RPClipsGTA', useStock: true, useOpenverse: true, useAiImages: true, useMyBackgrounds: false,
    videosPerDay: 3, maxPerDay: 6, autoPublish: false,
  };
  FX.FACELESS_PRESET = {
    type: 'faceless', name: 'Fact shorts', niche: 'Crazy history facts', audience: 'Curious 16–35 year olds who like quick, surprising facts', tone: 'Curious, upbeat, never mean', personality: 'A friendly know-it-all who loves a good twist', style: 'Fast hook, one clear story, surprising payoff, short sentences', lengthSec: 45,
    allowed: 'Educational facts, history, science, surprising true stories, explainers', avoid: 'Medical or financial advice, politics and elections, tragedies involving real victims, minors, graphic violence, celebrity gossip, conspiracy theories',
    originality: 'Every script is written from scratch from verified sources. Never rewrite, translate or paraphrase another creator\'s video. Add our own angle to every topic. Do not reuse the same footage in back-to-back videos.', cta: 'Follow for one surprising fact a day', subreddits: 'todayilearned, history, AskHistorians',
  };
  FX.isClips = (r) => (r ? r.type === 'clips' : FX.channel().type === 'clips');
  FX.channel = () => ({ ...FX.DEFAULT_CHANNEL, ...(ls.get('fx_channel', {}) || {}) });
  FX.channelVersion = () => ls.get('fx_channelv', 0);
  FX.saveChannel = async (c, who = 'you') => {
    const v = FX.channelVersion() + 1;
    ls.set('fx_channel', c); ls.set('fx_channelv', v);
    const hist = ls.get('fx_channelHist', []); hist.unshift({ v, at: now(), c }); ls.set('fx_channelHist', hist.slice(0, 20));
    await FX.audit('channel config saved', `version ${v}`, null, who);
  };
  FX.channelReady = () => ls.get('fx_channelv', 0) > 0;
  FX.lines = (s) => String(s || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

  /* ================= PLATFORM POLICY CHECKLISTS (stored separately per platform) =================
     These are our own plain-English summaries of each platform's public rules, used as a checklist.
     They are NOT the official policies and they go stale. The reviewer has to re-read the official pages
     and mark each checklist reviewed; anything older than 30 days is flagged. */
  const RULE = (id, text, severity, keywords = []) => ({ id, text, severity, keywords });
  FX.DEFAULT_POLICIES = {
    youtube: {
      platform: 'youtube', name: 'YouTube Shorts',
      links: ['https://support.google.com/youtube/answer/9288567', 'https://support.google.com/youtube/answer/6162278', 'https://support.google.com/youtube/answer/1311392', 'https://support.google.com/youtube/answer/14328491'],
      rules: [
        RULE('yt-harm', 'No dangerous or harmful acts, challenges or instructions that could cause serious injury', 'block', ['how to make a bomb', 'challenge gone wrong', 'try this at home']),
        RULE('yt-hate', 'No hate speech or harassment targeting people or protected groups', 'block', []),
        RULE('yt-misinfo', 'No medical, election or harmful misinformation that contradicts health authorities or election officials', 'block', ['cure for cancer', 'vaccines cause', 'election was stolen']),
        RULE('yt-mislead', 'Title, description and thumbnail must not mislead viewers about the content', 'review', ['you won\'t believe', 'banned video', 'guaranteed']),
        RULE('yt-ai', 'Disclose realistic altered or synthetic content (AI voice or realistic AI imagery) using the altered-content setting', 'review', []),
        RULE('yt-violence', 'No graphic violence or gore; educational context still needs care', 'review', ['gore', 'beheaded', 'blood everywhere']),
        RULE('yt-kids', 'Correctly set made-for-kids; no content that endangers minors', 'block', []),
        RULE('yt-reused', 'Monetization: avoid reused, repetitive or mass-produced content without meaningful original commentary', 'review', []),
        RULE('yt-gaming', 'Gaming violence is allowed, but graphic or realistic violence and gore in the first seconds limits ads', 'warn', []),
        RULE('yt-reupload', 'Copyright: only upload stream footage you own or have permission to use; re-uploading another creator\'s content can get strikes', 'review', []),
        RULE('yt-ads', 'Advertiser-friendly: avoid strong profanity, adult themes, shocking content and controversial issues in the first seconds', 'warn', ['fuck', 'shit', 'sex']),
      ],
    },
    tiktok: {
      platform: 'tiktok', name: 'TikTok',
      links: ['https://www.tiktok.com/community-guidelines/en', 'https://support.tiktok.com/en/using-tiktok/creating-videos/ai-generated-content', 'https://www.tiktok.com/creator-academy/en/article/creator-rewards-program'],
      rules: [
        RULE('tt-safety', 'No dangerous activities or challenges', 'block', ['challenge', 'try this at home']),
        RULE('tt-hate', 'No hateful behavior, harassment or bullying', 'block', []),
        RULE('tt-misinfo', 'No harmful misinformation (health, civic, crisis events)', 'block', ['cure for', 'election was stolen']),
        RULE('tt-aigc', 'Label AI-generated content that shows realistic scenes or people (AIGC label)', 'review', []),
        RULE('tt-original', 'Creator Rewards: content must be original and over one minute to be eligible; unoriginal or reposted content is ineligible', 'warn', []),
        RULE('tt-graphic', 'No shocking or graphic content', 'review', ['gore', 'graphic']),
        RULE('tt-commercial', 'Disclose paid partnerships / branded content', 'review', ['sponsored', 'ad', 'promo code']),
      ],
    },
    instagram: {
      platform: 'instagram', name: 'Instagram Reels',
      links: ['https://help.instagram.com/477434105621119', 'https://help.instagram.com/2422045651390764', 'https://www.facebook.com/business/help/1185437158530442'],
      rules: [
        RULE('ig-safety', 'No content that promotes self-harm, violence or dangerous organizations', 'block', []),
        RULE('ig-hate', 'No hate speech, bullying or harassment', 'block', []),
        RULE('ig-misinfo', 'False information may be labeled or reduced; avoid unverified claims', 'review', []),
        RULE('ig-ai', 'Use the "AI info" label for photorealistic AI-generated video or audio', 'review', []),
        RULE('ig-recommend', 'Recommendation guidelines: low-quality, watermarked or reposted content is not recommended', 'warn', ['tiktok watermark']),
        RULE('ig-branded', 'Disclose branded content', 'review', ['sponsored', 'promo code']),
      ],
    },
  };
  FX.policy = (p) => ls.get('fx_policy_' + p, null) || { ...clone(FX.DEFAULT_POLICIES[p] || { platform: p, name: platName(p), links: [], rules: [] }), version: 1, reviewedAt: null, seeded: true };
  FX.savePolicy = async (pol, who = 'you') => { // one key per platform so one never overwrites another
    pol.version = (pol.version || 1) + 1; pol.seeded = false;
    ls.set('fx_policy_' + pol.platform, pol);
    await FX.audit('policy checklist updated', `${pol.name} v${pol.version}`, null, who);
  };
  FX.policyStale = (pol) => !pol.reviewedAt || now() - pol.reviewedAt > 30 * 864e5;

  /* ================= KEYS, USAGE LIMITS & COSTS ================= */
  FX.keys = () => ls.get('fx_keys', { pexels: '', pixabay: '' });
  FX.hasAI = () => !!val('apiKey');
  FX.model = () => val('model') || 'gpt-4o-mini';

  FX.DEFAULT_PRICES = { // USD estimates — edit in the Costs tab
    'gpt-4o-mini': { in: 0.15, out: 0.6 }, 'gpt-4o': { in: 2.5, out: 10 }, 'gpt-4.1-mini': { in: 0.4, out: 1.6 }, 'gpt-4.1': { in: 2, out: 8 },
    tts_per_1m_chars: 15, whisper_per_min: 0.006, image_each: 0.063, upload_post_each: 0, pexels: 0, pixabay: 0, openverse: 0, wikipedia: 0,
  };
  FX.prices = () => ({ ...FX.DEFAULT_PRICES, ...ls.get('fx_prices', {}) });
  FX.DEFAULT_LIMITS = { openai: 400, tts: 120, whisper: 120, images: 30, uploads: 20, stock: 200 };
  FX.limits = () => ({ ...FX.DEFAULT_LIMITS, ...ls.get('fx_limits', {}) });
  FX.usage = () => { const u = ls.get('fx_usage', {}); const day = new Date().toDateString(); return u.day === day ? u : { day, n: {} }; };
  class LimitError extends Error { constructor(m) { super(m); this.limit = true; } }
  FX.LimitError = LimitError;
  FX.use = (kind, n = 1) => {
    const u = FX.usage(), lim = FX.limits()[kind];
    if (lim != null && (u.n[kind] || 0) + n > lim) throw new LimitError(`Daily ${kind} limit reached (${lim}). Raise it in Costs & limits, or wait until tomorrow.`);
    u.n[kind] = (u.n[kind] || 0) + n; ls.set('fx_usage', u);
    const hist = ls.get('fx_usageHist', {}); (hist[u.day] ||= {})[kind] = u.n[kind]; ls.set('fx_usageHist', hist);
  };
  FX.cost = (rec, dept, service, units, usd) => {
    if (!rec) return;
    (rec.costs ||= []).push({ at: now(), dept, service, units, usd: Math.round(usd * 1e5) / 1e5 });
  };
  FX.recCost = (rec) => (rec.costs || []).reduce((a, c) => a + (c.usd || 0), 0);
  FX.money = (n) => '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));

  /* ---------------- retry temporary failures ---------------- */
  class TempError extends Error { constructor(m) { super(m); this.temporary = true; } }
  FX.TempError = TempError;
  FX.retry = async (fn, label, tries = 3) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (!e.temporary || i === tries - 1) throw e;
        log(`↻ ${label}: ${e.message} — retrying in ${2 ** i * 2}s`);
        await sleep(2 ** i * 2000);
      }
    }
    throw last;
  };
  const httpErr = async (r, who) => {
    const t = (await r.text()).slice(0, 240);
    const E = (r.status === 429 || r.status >= 500) ? TempError : Error;
    return new E(`${who} ${r.status}: ${t}`);
  };
  FX.httpErr = httpErr;
  FX.fetchJSON = async (url, opts = {}, who = 'HTTP') => {
    let r;
    try { r = await fetch(url, opts); } catch (e) { throw new TempError(`${who}: network error (${e.message})`); }
    if (!r.ok) throw await httpErr(r, who);
    return r.json();
  };

  /* ---------------- OpenAI wrappers with cost + usage tracking ---------------- */
  FX.ai = async (rec, dept, system, user, { json = true, images = [], temperature = 0.7, maxTokens } = {}) => {
    const key = val('apiKey'); if (!key) return null;
    FX.use('openai');
    const content = images.length ? [{ type: 'text', text: user }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u, detail: 'low' } }))] : user;
    const model = FX.model();
    const j = await FX.retry(() => FX.fetchJSON('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content }], ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    }, 'OpenAI'), `${dept} AI call`);
    const u = j.usage || {}, p = FX.prices()[model] || FX.prices()['gpt-4o-mini'];
    FX.cost(rec, dept, 'openai:' + model, (u.prompt_tokens || 0) + (u.completion_tokens || 0), ((u.prompt_tokens || 0) * p.in + (u.completion_tokens || 0) * p.out) / 1e6);
    const txt = j.choices?.[0]?.message?.content || '';
    if (!json) return txt;
    try { return JSON.parse(txt); } catch { throw new TempError('OpenAI returned malformed JSON'); }
  };
  FX.tts = async (rec, dept, text, { voice, speed } = {}) => {
    const key = val('apiKey'); if (!key) return null;
    FX.use('tts');
    const r = await FX.retry(async () => {
      let res;
      try {
        res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({ model: 'tts-1', voice: voice || 'onyx', speed: Math.max(0.5, Math.min(2, speed || 1)), input: text.slice(0, 4000), response_format: 'mp3' }),
        });
      } catch (e) { throw new TempError('TTS network error: ' + e.message); }
      if (!res.ok) throw await httpErr(res, 'TTS');
      return res.blob();
    }, 'voiceover');
    FX.cost(rec, dept, 'openai:tts-1', text.length, text.length * FX.prices().tts_per_1m_chars / 1e6);
    return r;
  };
  FX.whisper = async (rec, dept, audioBuffer) => {
    if (!val('apiKey')) return null;
    FX.use('whisper');
    const wav = await segmentWav(audioBuffer, 0, audioBuffer.duration);
    const tr = await FX.retry(async () => { try { return await transcribe(wav, 'audio.wav'); } catch (e) { throw /429|5\d\d|network|fetch/i.test(e.message) ? new TempError(e.message) : e; } }, 'transcription');
    FX.cost(rec, dept, 'openai:whisper-1', Math.round(audioBuffer.duration), audioBuffer.duration / 60 * FX.prices().whisper_per_min);
    return tr;
  };
  FX.image = async (rec, dept, prompt) => {
    const key = val('apiKey'); if (!key) return null;
    FX.use('images');
    const j = await FX.retry(() => FX.fetchJSON('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: prompt.slice(0, 1500), size: '1024x1536', quality: 'medium', n: 1 }),
    }, 'OpenAI images'), 'image generation');
    FX.cost(rec, dept, 'openai:gpt-image-1', 1, FX.prices().image_each);
    const b64 = j.data?.[0]?.b64_json; if (!b64) throw new Error('Image generation returned nothing');
    const bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/png' });
  };

  /* ---------------- text helpers ---------------- */
  FX.words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
  const STOP = new Set('the a an and or of to in on at is was are were it this that for with as by be you your i we they he she his her its from but not have has had do did so if about into than then there their what when who how why which'.split(' '));
  FX.keywords = (s) => FX.words(s).filter((w) => w.length > 2 && !STOP.has(w));
  FX.jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
  FX.ngrams = (s, n = 3) => { const w = FX.words(s); const out = []; for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' ')); return out; };
  FX.numbers = (s) => (String(s || '').replace(/(\d),(\d)/g, '$1$2').match(/\d+(\.\d+)?/g) || []);
  FX.sentences = (s) => String(s || '').match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) || [];
  FX.ts = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
  FX.norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /* ---------------- audio helpers ---------------- */
  FX.toWav = (chans, sr) => {
    const n = chans[0].length, nc = chans.length, view = new DataView(new ArrayBuffer(44 + n * nc * 2));
    const wr = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    wr(0, 'RIFF'); view.setUint32(4, 36 + n * nc * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nc, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * nc * 2, true); view.setUint16(32, nc * 2, true); view.setUint16(34, 16, true); wr(36, 'data'); view.setUint32(40, n * nc * 2, true);
    let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { view.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true); o += 2; }
    return new Blob([view], { type: 'audio/wav' });
  };
  FX.decode = async (blob) => getAudioCtx().decodeAudioData(await blob.arrayBuffer());
  FX.rms = (data, from = 0, to = data.length) => { let s = 0, c = 0; for (let i = Math.max(0, from); i < Math.min(data.length, to); i += 4) { s += data[i] * data[i]; c++; } return c ? Math.sqrt(s / c) : 0; };
  FX.db20 = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
  // windows of RMS (in dBFS) every `win` seconds
  FX.envelope = (buf, win = 0.1) => {
    const d = buf.getChannelData(0), step = Math.floor(buf.sampleRate * win), out = [];
    for (let i = 0; i < d.length; i += step) out.push(FX.db20(FX.rms(d, i, i + step)));
    return out;
  };

  /* ================= DEPARTMENTS REGISTRY =================
     key, number, name, robot, required result. Order is the build order the owner chose,
     with one swap: captions (8) run before editing/export (9) so captions made from the
     approved voiceover can be burned into a single export instead of rendering twice. */
  FX.DEPTS = [
    { key: 'channel', n: 1, name: 'Channel Setup', bot: 'Config-o', icon: '🧭', result: 'Channel configuration', phase: 'Plan', color: '#b69cff' },
    { key: 'trends', n: 2, name: 'Trend Research', bot: 'Scout', icon: '📡', result: 'Approved idea', phase: 'Plan', color: '#b69cff' },
    { key: 'factcheck', n: 3, name: 'Research & Fact-Check', bot: 'Sherlock', icon: '🔎', result: 'Verified information', phase: 'Plan', color: '#b69cff' },
    { key: 'script', n: 4, name: 'Script Writing', bot: 'Quill', icon: '✍️', result: 'Completed script', phase: 'Create', color: '#e48ad0' },
    { key: 'scriptqc', n: 5, name: 'Script QC', bot: 'Red Pen', icon: '🖍️', result: 'Approved script', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'voice', n: 6, name: 'Voiceover', bot: 'Echo', icon: '🎙️', result: 'Approved narration', phase: 'Create', color: '#e48ad0' },
    { key: 'assets', n: 7, name: 'Asset Production', bot: 'Magpie', icon: '🖼️', result: 'Licensed assets', phase: 'Create', color: '#e48ad0' },
    { key: 'captions', n: 8, name: 'Caption Generation', bot: 'Subtitle Sam', icon: '💬', result: 'Synchronized captions', phase: 'Create', color: '#e48ad0' },
    { key: 'edit', n: 9, name: 'Video Editing & Export', bot: 'Splice', icon: '🎬', result: 'Completed video', phase: 'Create', color: '#ff7a6b' },
    { key: 'audioqc', n: 10, name: 'Audio QC', bot: 'Big Ears', icon: '🎧', result: 'Audio approval', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'visualqc', n: 11, name: 'Visual QC', bot: 'Hawkeye', icon: '👁️', result: 'Visual approval', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'copyright', n: 12, name: 'Copyright QC', bot: 'Rights Bot', icon: '©️', result: 'Rights review', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'guidelines', n: 13, name: 'Guidelines QC', bot: 'Rulebook', icon: '📜', result: 'Policy review', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'monetization', n: 14, name: 'Monetization QC', bot: 'Penny', icon: '💰', result: 'Risk assessment', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'finalqc', n: 15, name: 'Final QC', bot: 'The Foreman', icon: '🏁', result: 'Production approval', phase: 'Inspect', color: '#ffe08a', qc: true },
    { key: 'prep', n: 16, name: 'Publishing Prep', bot: 'Tagline', icon: '🏷️', result: 'Metadata completed', phase: 'Ship', color: '#7cf7d4' },
    { key: 'approval', n: 17, name: 'Human Approval', bot: 'You', icon: '🙋', result: 'Publishing authorization', phase: 'Ship', color: '#7cf7d4', human: true },
    { key: 'publish', n: 18, name: 'Publishing', bot: 'Courier', icon: '📤', result: 'Video posted', phase: 'Ship', color: '#7cf7d4' },
    { key: 'monitor', n: 19, name: 'Monitoring', bot: 'Watchtower', icon: '📈', result: 'Performance data', phase: 'Learn', color: '#3fcf9f' },
    { key: 'analytics', n: 20, name: 'Analytics', bot: 'Professor', icon: '🧠', result: 'Improvement recommendations', phase: 'Learn', color: '#3fcf9f' },
  ];
  FX.dept = (k) => FX.DEPTS.find((d) => d.key === k);
  // stages a single video moves through (channel + analytics are line-wide departments)
  FX.STAGES = ['trends', 'factcheck', 'script', 'scriptqc', 'voice', 'assets', 'captions', 'edit', 'audioqc', 'visualqc', 'copyright', 'guidelines', 'monetization', 'finalqc', 'prep', 'approval', 'publish', 'monitor'];
  FX.nextStage = (k) => FX.STAGES[FX.STAGES.indexOf(k) + 1] || null;
  FX.RUN = {}; // department implementations, filled by fx-depts.js
  FX.MAX_REVISIONS = 2;

  /* ================= PRODUCTION RECORDS ================= */
  // status: queued (ready for its stage) · working · needs_human · awaiting_approval · blocked · error · scheduled · live · rejected · stopped
  FX.newRecord = async ({ idea = null, practice = false, who = 'you' } = {}) => {
    const r = {
      id: FX.newVideoId(), created: now(), updated: now(), channel: FX.channel().name, channelVersion: FX.channelVersion(), channelSnapshot: FX.channel(),
      stage: idea ? 'factcheck' : 'trends', status: 'queued', type: FX.channel().type || 'clips', practice: FX.channel().type === 'clips' ? false : (practice || !FX.hasAI()),
      idea, research: null, script: null, scriptHistory: [], voice: null, assets: [], captions: null, edit: null, editHistory: [], export: null,
      reports: {}, reportHistory: [], approvals: {}, final: null, publish: null, metricsHistory: [],
      revisions: [], history: [], costs: [], attempts: {}, tempFails: 0, notes: '',
    };
    if (idea) { idea.status = 'used'; idea.usedBy = r.id; await FX.db.ideas.put(idea); }
    if (idea?.type === 'moment') r.stage = 'factcheck';
    FX.hist(r, 'manager', 'created', `${r.practice ? 'Practice record (no OpenAI key) — ' : ''}starts at ${FX.dept(r.stage).name}`);
    await FX.saveRecord(r);
    await FX.audit('video created', r.id, r.id, who);
    return r;
  };
  FX.hist = (r, dept, event, detail = '') => { (r.history ||= []).push({ at: now(), dept, event, detail: String(detail).slice(0, 400) }); };

  FX.setReport = (r, key, rep) => {
    rep.at = now(); rep.dept = key; rep.attempt = (r.attempts[key] || 0);
    r.reports[key] = rep;
    r.reportHistory.push({ key, at: rep.at, verdict: rep.verdict, summary: rep.summary, items: (rep.items || []).slice(0, 20) });
  };

  FX.sendBack = (r, to, from, reason) => {
    r.revisions.push({ at: now(), from, to, reason: String(reason).slice(0, 500) });
    FX.hist(r, from, 'sent back', `→ ${FX.dept(to).name}: ${reason}`);
    r.stage = to; r.status = 'queued'; r.revisionNote = { from, reason, at: now() };
  };

  /* ================= CENTRAL PRODUCTION MANAGER ================= */
  const M = FX.manager = { running: ls.get('fx_running', false), working: null, timer: null, lastMonitor: 0 };
  FX.stopped = () => !!ls.get('fx_stop', false);

  // run one department on one record; saves after every department
  FX.runStage = async (r, { manual = false } = {}) => {
    const key = r.stage, d = FX.dept(key), impl = FX.RUN[key];
    if (!impl) throw new Error('No department for stage ' + key);
    if (FX.stopped() && ['publish', 'approval'].includes(key)) { r.status = 'stopped'; await FX.saveRecord(r); return r; }
    r.status = 'working'; M.working = { id: r.id, key, text: 'Starting…', at: now() };
    FX.emit('working', M.working); await FX.saveRecord(r);
    const say = (t) => { M.working = { id: r.id, key, text: t, at: now() }; FX.emit('working', M.working); };
    r.attempts[key] = (r.attempts[key] || 0) + 1;
    const t0 = now();
    let rep;
    try {
      rep = await impl(r, say, { manual });
      r.tempFails = 0;
    } catch (e) {
      M.working = null; FX.emit('working', null);
      r.attempts[key]--;
      if (e.limit) { r.status = 'blocked'; r.blocked = e.message; FX.hist(r, key, 'paused', e.message); await FX.saveRecord(r); await FX.alert(`${r.id}: ${e.message}`, r.id); return r; }
      r.tempFails = (r.tempFails || 0) + 1;
      FX.hist(r, key, 'error', e.message);
      (r.errors ||= []).push({ at: now(), dept: key, message: e.message });
      if (e.temporary && r.tempFails < 4) { r.status = 'queued'; r.retryAt = now() + 60e3 * r.tempFails; log(`↻ ${r.id} ${d.name}: ${e.message} (will retry)`); }
      else { r.status = 'error'; r.error = e.message; await FX.alert(`${r.id} stopped at ${d.name}: ${e.message}`, r.id); }
      await FX.saveRecord(r);
      return r;
    }
    M.working = null; FX.emit('working', null);
    rep.ms = now() - t0;
    if (rep.verdict === 'WAIT') { // department is waiting on something outside the line (human approval, schedule)
      r.status = rep.status || 'needs_human'; FX.hist(r, key, 'waiting', rep.summary); await FX.saveRecord(r); return r;
    }
    if (rep.verdict === 'BLOCKED') {
      r.attempts[key]--; r.status = 'blocked'; r.blocked = rep.summary; FX.setReport(r, key, rep);
      FX.hist(r, key, 'blocked', rep.summary); await FX.saveRecord(r); return r;
    }
    FX.setReport(r, key, rep); r.blocked = null; r.error = null;
    FX.hist(r, key, rep.verdict, rep.summary);
    if (rep.verdict === 'PASS' || rep.verdict === 'WARNING') {
      r.revisionNote = null;
      const nx = rep.next !== undefined ? rep.next : FX.nextStage(key);
      if (nx) { r.stage = nx; r.status = rep.status || 'queued'; } else r.status = rep.status || 'live';
    } else if (rep.verdict === 'FAIL') {
      const to = rep.sendBackTo || key;
      const tries = r.attempts[to] || 0;
      if (tries > FX.MAX_REVISIONS) {
        r.status = 'needs_human'; r.humanReason = `${FX.dept(to).name} failed ${tries} times. ${rep.summary}`;
        await FX.alert(`${r.id} needs you: ${r.humanReason}`, r.id);
      } else FX.sendBack(r, to, key, rep.summary);
    } else if (rep.verdict === 'HUMAN_REVIEW') {
      r.status = 'needs_human'; r.humanReason = rep.summary;
      await FX.alert(`${r.id} needs a human decision at ${d.name}: ${rep.summary}`, r.id);
    } else if (rep.verdict === 'REJECTED') {
      r.status = 'rejected'; await FX.audit('video rejected by ' + d.name, rep.summary, r.id);
    }
    await FX.saveRecord(r);
    return r;
  };

  // a single-tab lock so two open tabs never run the same job twice
  const TAB = Math.random().toString(36).slice(2);
  const haveLock = () => { const l = ls.get('fx_lock', null); if (l && l.tab !== TAB && now() - l.at < 45e3) return false; ls.set('fx_lock', { tab: TAB, at: now() }); return true; };

  FX.tick = async () => {
    if (M.working || M.ticking) return;
    if (!haveLock()) return;
    M.ticking = true;
    try {
      if (now() - M.lastMonitor > 3600e3 && FX.RUN.monitorSweep) { M.lastMonitor = now(); await FX.RUN.monitorSweep().catch((e) => log('⚠️ Monitoring: ' + e.message)); }
      if (FX.RUN.analyticsWeekly) await FX.RUN.analyticsWeekly().catch(() => {});
      // automation crew (fx-auto.js): Twitch watcher, self-repair, keep-awake. Never publishes by itself.
      if (FX.beforeTick) await FX.beforeTick().catch((e) => log('⚠️ Automation: ' + e.message));
      if (!M.running || FX.stopped() || busy) return;
      const all = await FX.db.prod.all();
      // reset jobs that were mid-run when the tab closed
      for (const r of all) if (r.status === 'working' && (!M.working || M.working.id !== r.id)) { r.status = 'queued'; await FX.saveRecord(r); }
      // blocked records retry when the missing key/limit might be fixed
      for (const r of all) if (r.status === 'blocked' && now() - r.updated > 5 * 60e3) { r.status = 'queued'; await FX.saveRecord(r); }
      const ready = all.filter((r) => r.status === 'queued' && !(r.retryAt > now()) && r.stage !== 'monitor')
        .sort((a, b) => FX.STAGES.indexOf(b.stage) - FX.STAGES.indexOf(a.stage) || a.created - b.created);
      if (ready.length) { await FX.runStage(ready[0]); return; }
      // start a new video when today's quota isn't done and nothing is in the pipe
      const c = FX.channel(), today = new Date(); today.setHours(0, 0, 0, 0);
      const madeToday = all.filter((r) => r.created >= today.getTime() && !r.replaced).length; // auto-replaced videos don't use up the quota
      const active = all.filter((r) => !['live', 'rejected', 'scheduled', 'error'].includes(r.status) && r.stage !== 'monitor').length;
      if (FX.channelReady() && (!FX.canStart || await FX.canStart()) && madeToday < Math.min(+c.videosPerDay || 0, +c.maxPerDay || 99) && active < 2) {
        const r = await FX.newRecord({ who: 'manager' });
        log(`🏭 Assembly line started ${r.id}${r.practice ? ' (practice run — no OpenAI key)' : ''}`);
      }
    } catch (e) { log('⚠️ Assembly line: ' + e.message); }
    finally { M.ticking = false; FX.emit('tick'); }
  };
  FX.setRunning = async (on) => {
    M.running = on; ls.set('fx_running', on);
    clearInterval(M.timer);
    if (on) { M.timer = setInterval(FX.tick, 15000); setTimeout(FX.tick, 500); }
    await FX.audit(on ? 'line started' : 'line paused', '', null, 'you');
    FX.emit('tick');
  };
  // monitoring keeps running even when the line is paused
  setInterval(() => { if (!M.running) FX.tick(); }, 10 * 60e3);

  // Run the next stage of one record right now (button in the UI)
  FX.step = async (id) => {
    if (M.working) { toast('Another department is working right now.'); return; }
    const r = await FX.db.prod.get(id); if (!r) return;
    if (!['queued', 'blocked', 'error'].includes(r.status)) { toast('This video is not waiting on a department.'); return; }
    r.status = 'queued';
    return FX.runStage(r, { manual: true });
  };

  /* ================= EMERGENCY STOP ================= */
  FX.emergencyStop = async (reason) => {
    ls.set('fx_stop', true);
    await FX.setRunning(false);
    await FX.audit('EMERGENCY STOP', reason || 'pressed', null, 'you');
    log('🛑 EMERGENCY STOP: ' + (reason || 'pressed') + ' — all publishing paused');
    const results = [];
    // pause everything that was waiting to publish
    for (const r of await FX.db.prod.all()) {
      if (['approval', 'publish'].includes(r.stage) && !['rejected'].includes(r.status)) { r.status = 'stopped'; FX.hist(r, 'manager', 'stopped', 'Emergency stop'); await FX.saveRecord(r); }
    }
    // try to pull back posts that are scheduled in the future
    const future = (await allClips()).filter((c) => c.status === 'scheduled' && c.scheduledFor > now());
    for (const c of future) {
      const out = [];
      if (c.jobId && val('upKey')) {
        try { const r = await fetch(`${UP_API}/uploadposts/schedule/${encodeURIComponent(c.jobId)}`, { method: 'DELETE', headers: upHeaders() }); out.push(r.ok ? 'Upload-Post: cancelled' : `Upload-Post: could not cancel (HTTP ${r.status}) — cancel it in the Upload-Post dashboard`); }
        catch (e) { out.push('Upload-Post: could not cancel (' + e.message + ')'); }
      } else if (c.requestId) out.push('Upload-Post: no schedule id saved — cancel it in the Upload-Post dashboard');
      if (c.ytId && ytToken()) {
        try {
          const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: { Authorization: 'Bearer ' + ytToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.ytId, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } }) });
          out.push(r.ok ? 'YouTube: kept private, schedule removed' : `YouTube: could not change (HTTP ${r.status})`);
        } catch (e) { out.push('YouTube: ' + e.message); }
      }
      c.status = 'approved'; c.error = 'Paused by emergency stop'; c.stoppedAt = now(); await putClip(c);
      results.push({ title: c.title, out });
      log(`🛑 ${c.title}: ${out.join('; ') || 'removed from local schedule'}`);
    }
    FX.emit('records'); FX.emit('tick');
    return results;
  };
  FX.releaseStop = async () => { ls.set('fx_stop', false); await FX.audit('emergency stop released', '', null, 'you'); log('▶️ Emergency stop released'); FX.emit('tick'); };

  /* ================= BACKUPS ================= */
  FX.exportJSON = async () => {
    const strip = (r) => r; // records hold file ids, not blobs
    return {
      app: 'AutoClipper assembly line', exportedAt: new Date().toISOString(), channel: FX.channel(), channelVersion: FX.channelVersion(),
      policies: Object.fromEntries(['youtube', 'tiktok', 'instagram'].map((p) => [p, FX.policy(p)])),
      records: (await FX.db.prod.all()).map(strip), ideas: await FX.db.ideas.all(),
      library: (await FX.db.library.all()).map(({ blob, ...m }) => m), audit: await FX.db.audit.all(), learnings: ls.get('fx_learnings', null), reports: ls.get('fx_weekly', []),
    };
  };
  FX.autoBackup = async () => {
    const last = ls.get('fx_lastBackup', 0); if (now() - last < 864e5) return;
    const data = await FX.exportJSON();
    await FX.db.backups.put({ id: 'b_' + now(), at: now(), data });
    const all = (await FX.db.backups.all()).sort((a, b) => b.at - a.at);
    for (const b of all.slice(7)) await FX.db.backups.del(b.id);
    ls.set('fx_lastBackup', now());
  };
  FX.importJSON = async (data) => {
    if (!data || !Array.isArray(data.records)) throw new Error('Not an AutoClipper backup file');
    for (const r of data.records) await FX.db.prod.put(r);
    for (const i of data.ideas || []) await FX.db.ideas.put(i);
    for (const a of data.audit || []) await FX.db.audit.put(a);
    if (data.channel) ls.set('fx_channel', data.channel);
    await FX.audit('backup imported', `${data.records.length} records`, null, 'you');
    FX.emit('records');
  };

  return FX;
})();
