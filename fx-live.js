/* AutoClipper — LIVE WATCH
   Watches Twitch streams while they are live and catches moments as they happen, before
   the VOD exists or anyone else clips them.

   How it spots a moment: it reads each channel's public chat (anonymous, read-only) and keeps a
   per-second count of messages, hype words / emotes, "clip it" calls and copy-paste waves. When the
   last 10 seconds are well above that channel's normal pace (median of the last 5 minutes) and
   enough different people are reacting, that's a moment.

   What it does with a moment (each one is optional):
   1. Twitch clip: asks Twitch to make a clip right then (needs Twitch connected with clip permission).
   2. VOD timestamp: saves where it happened in the stream, so when you drop that VOD later
      the Moment Scout ranks those spots first.
   3. Record from this tab: with screen sharing of this tab, keeps a rolling recording of the
      player and turns the moment into a captioned 9:16 clip in the Review Queue.
   4. Alert: sound + desktop notification.

   Nothing is ever posted from here: clips go to the Review Queue like everything else. */
'use strict';
(function (FX) {
  const T = () => (L.clock ? L.clock() : Date.now());
  const DEF = {
    channels: '', sens: 'med', minMsgs: 8, cooldown: 90, users: 3,
    twClip: true, mark: true, grab: true, preRoll: 25, postRoll: 10, sound: true, resume: false, player: true,
  };
  const SENS = { low: 3.2, med: 2.4, high: 1.8 };
  const cfg = () => ({ ...DEF, ...(ls.get('fx_live', {}) || {}) });
  const setCfg = (p) => ls.set('fx_live', { ...cfg(), ...p });
  const L = FX.live = {
    IRC: 'wss://irc-ws.chat.twitch.tv:443', TW: 'https://api.twitch.tv/helix',
    KICK: 'https://kick.com/api/v2', KICK_WS: 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false',
    chans: new Map(), moments: ls.get('fx_liveMoments', []), watching: false, timer: null, clock: null,
  };
  const saveMoments = () => { L.moments = L.moments.slice(0, 60); ls.set('fx_liveMoments', L.moments); };
  // "xqc" or twitch.tv/xqc → Twitch; "kick:xqc" or kick.com/xqc → Kick (stored as "kick:xqc")
  const cleanLogin = (x) => {
    const t = String(x || '').trim().toLowerCase();
    const k = t.match(/^(?:kick:|(?:https?:\/\/)?(?:www\.)?kick\.com\/)([a-z0-9_-]+)/);
    if (k) return 'kick:' + k[1];
    return t.replace(/^.*twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '');
  };
  const isKick = (key) => String(key).startsWith('kick:');
  const nameOf = (key) => String(key).replace(/^kick:/, '');
  const chanUrl = (key) => isKick(key) ? 'https://kick.com/' + nameOf(key) : 'https://www.twitch.tv/' + key;
  L.cleanLogin = cleanLogin;
  const MAX_CH = 8;
  const logins = () => [...new Set(FX.lines(cfg().channels).map(cleanLogin).filter(Boolean))].slice(0, MAX_CH);
  const hhmmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m${s % 60}s`; };
  const clockTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  /* ---------------- scoring chat ---------------- */
  const HYPE = /^(kekw|lul|lulw|lmao+|lmfao|omegalul|pog+|poggers|pogu|pogchamp|w+|holy|wtf|omg|ez|gg|monkas|pepelaugh|icant|sheesh|insane|nah+|bro+|yoo+|letsgo+|hahaha+|kek|xd+|5head|clip|clipit|deadge|o7)$/i;
  function weigh(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    let w = 1;
    if (words.some((x) => HYPE.test(x.replace(/[^a-z0-9]/g, ''))) || /\?{3,}|!{3,}|(ha){3,}|😂|🤣|💀|🔥/.test(text)) w += 0.5;
    if (/\bclip (it|that|this)\b|\bclipped\b|^clip$/i.test(text)) w += 1.5;
    return { w, key: words.slice(0, 4).join(' ').slice(0, 40) };
  }
  function bucket(st, sec) {
    let b = st.buckets[st.buckets.length - 1];
    if (!b || b.s !== sec) { b = { s: sec, w: 0, n: 0, users: new Map(), keys: new Map(), clips: 0 }; st.buckets.push(b); if (st.buckets.length > 360) st.buckets.shift(); }
    return b;
  }
  // one chat message (exposed for tests and the "simulate" button)
  L.ingest = (login, user, text, t = T()) => {
    const st = L.chans.get(login); if (!st) return;
    const { w, key } = weigh(text);
    const b = bucket(st, Math.floor(t / 1000));
    b.w += w; b.n++; b.users.set(user, (b.users.get(user) || 0) + w); (b.keys.get(key) || b.keys.set(key, new Set()).get(key)).add(user);
    if (w >= 2.5) b.clips++;
    st.total++; st.lastMsg = t;
    st.recent.push({ t, user, text: text.slice(0, 140) }); if (st.recent.length > 60) st.recent.shift();
  };
  const ingestEvent = (login, kind, t = T()) => { const st = L.chans.get(login); if (!st) return; const b = bucket(st, Math.floor(t / 1000)); const x = kind === 'raid' ? 6 : 2; b.w += x; b.extra = (b.extra || 0) + x; };

  function windowStats(st, t, secs = 10) {
    const s1 = Math.floor(t / 1000), bs = st.buckets.filter((b) => b.s > s1 - secs && b.s <= s1);
    const users = new Map(); const keys = new Map(); let n = 0, clips = 0, extra = 0;
    for (const b of bs) { n += b.n; clips += b.clips; extra += b.extra || 0; b.users.forEach((v, u) => users.set(u, (users.get(u) || 0) + v)); b.keys.forEach((v, k) => { const set = keys.get(k) || keys.set(k, new Set()).get(k); v.forEach((u) => set.add(u)); }); }
    // one person spamming counts as at most 3 points, so a single spammer can't fake a moment
    let w = extra; users.forEach((v) => (w += Math.min(3, v)));
    // copy-paste waves: the same message from many people counts extra
    const wave = Math.max(0, ...[...keys.values()].map((x) => x.size)); // different people sending the same thing
    if (wave >= 4) w += wave * 0.5;
    return { w, n, users: users.size, clips, keys };
  }
  function baseline(st, t) {
    const s1 = Math.floor(t / 1000), sums = [];
    for (let k = 2; k < 32; k++) { // 10-second slots from 20 s to 5 min ago
      const hi = s1 - k * 10, lo = hi - 10;
      if (lo < st.since / 1000) break;
      const us = new Map(); let x = 0;
      for (const b of st.buckets) if (b.s > lo && b.s <= hi) { x += b.extra || 0; b.users.forEach((v, u) => us.set(u, (us.get(u) || 0) + v)); }
      us.forEach((v) => (x += Math.min(3, v)));
      sums.push(x);
    }
    if (sums.length < 4) return null; // still learning this chat's normal pace
    sums.sort((a, b) => a - b);
    return Math.max(1, sums[Math.floor(sums.length / 2)]);
  }
  function evaluate(st, t) {
    const c = cfg(), win = windowStats(st, t), base = baseline(st, t);
    st.now = win.w; st.base = base;
    st.hist.push(win.w); if (st.hist.length > 180) st.hist.shift();
    const act = st.active;
    if (act && t - act.at < 20e3 && win.w > act.peakScore) { act.peakScore = Math.round(win.w); act.peakAt = t; }
    if (base == null) { st.state = 'learning'; return; }
    const need = Math.max(+c.minMsgs || 8, base * (SENS[c.sens] || 2.4), base + 4);
    st.need = need;
    st.state = win.w >= need ? 'hype' : win.w >= need * 0.7 ? 'warm' : 'calm';
    const clipCalls = win.clips >= 3; // several people typing "clip it" is a moment on its own
    if ((win.w >= need || (clipCalls && win.w >= base * 1.5)) && win.users >= (+c.users || 3) && t - st.lastSpike > (+c.cooldown || 90) * 1000) {
      st.lastSpike = t;
      onMoment(st, t, win, base).catch((e) => log('Live Watch: ' + e.message));
    }
  }

  /* ---------------- chat connection (anonymous, read-only) ---------------- */
  function connect(st) {
    if (st.kick) return connectKick(st).catch((e) => { st.status = 'error'; st.err = e.message; paintChans(); });
    let ws;
    try { ws = new WebSocket(L.IRC); } catch (e) { st.status = 'error'; st.err = e.message; return; }
    st.ws = ws; st.status = 'connecting';
    ws.onopen = () => {
      st.retries = 0;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + (10000 + Math.floor(Math.random() * 80000)));
      ws.send('JOIN #' + st.login);
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const m = line.match(/^(?:@\S+ )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/);
        if (m) { L.ingest(st.login, m[1], m[2]); continue; }
        if (/ USERNOTICE /.test(line)) ingestEvent(st.login, /msg-id=raid/.test(line) ? 'raid' : 'sub');
        else if (/ (ROOMSTATE|JOIN) /.test(line) && st.status !== 'watching') { st.status = 'watching'; if (!st.since) st.since = T(); paintChans(); }
        else if (/ NOTICE .*(suspended|does not exist|banned)/i.test(line)) { st.status = 'error'; st.err = 'Channel not available'; paintChans(); }
      }
    };
    ws.onclose = () => {
      if (st.ws !== ws) return;
      st.ws = null;
      if (L.watching && L.chans.get(st.login) === st) { st.status = 'reconnecting'; setTimeout(() => L.chans.get(st.login) === st && L.watching && connect(st), Math.min(30e3, 2000 * ++st.retries)); }
      paintChans();
    };
  }
  /* Kick chat: public Pusher websocket, read-only, no login */
  async function kickChannel(st) {
    const r = await fetch(`${L.KICK}/channels/${encodeURIComponent(st.name)}`, { credentials: 'omit' }).catch(() => null);
    if (!r) throw new Error("Couldn't reach Kick");
    if (r.status === 404) throw new Error('Kick channel not found');
    if (!r.ok) throw new Error('Kick ' + r.status);
    const j = await r.json();
    st.chatroom = j.chatroom?.id; if (!st.chatroom) throw new Error('Kick chat not found');
    const ls2 = j.livestream;
    st.live = ls2 ? { started: Date.parse(String(ls2.start_time || ls2.created_at || '').replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(ls2.start_time || '') ? '' : 'Z')), title: ls2.session_title, game: ls2.categories?.[0]?.name, viewers: ls2.viewer_count } : false;
  }
  const kickText = (t) => String(t || '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1');
  async function connectKick(st) {
    st.status = 'connecting';
    if (!st.chatroom) await kickChannel(st);
    if (!L.watching || L.chans.get(st.login) !== st) return;
    const ws = new WebSocket(L.KICK_WS);
    st.ws = ws;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'pusher:connection_established') { st.retries = 0; ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${st.chatroom}.v2` } })); }
      else if (m.event === 'pusher_internal:subscription_succeeded') { st.status = 'watching'; if (!st.since) st.since = T(); paintChans(); }
      else if (m.event === 'pusher:ping') ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      else if (m.event === 'App\\Events\\ChatMessageEvent') { let d; try { d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch { return; } L.ingest(st.login, d.sender?.username || d.sender?.slug || '?', kickText(d.content)); }
      else if (/Subscription|GiftedSubscriptions/.test(m.event || '')) ingestEvent(st.login, 'sub');
      else if (/StreamHost|Raid/i.test(m.event || '')) ingestEvent(st.login, 'raid');
      else if (m.event === 'pusher:error') { st.status = 'error'; st.err = 'Kick chat: ' + (m.data?.message || 'error'); paintChans(); }
    };
    ws.onclose = () => {
      if (st.ws !== ws) return;
      st.ws = null;
      if (L.watching && L.chans.get(st.login) === st) { st.status = 'reconnecting'; setTimeout(() => L.chans.get(st.login) === st && L.watching && connect(st), Math.min(30e3, 2000 * ++st.retries)); }
      paintChans();
    };
  }
  const newChan = (login) => ({ login, kick: isKick(login), name: nameOf(login), chatroom: null, ws: null, status: 'connecting', buckets: [], recent: [], hist: [], total: 0, since: 0, lastSpike: 0, retries: 0, now: 0, base: null, need: null, state: 'learning', active: null, live: null, id: null });

  L.start = () => {
    const list = logins();
    if (!list.length) { toast('Type at least one Twitch channel name first.'); return false; }
    L.stop(true);
    L.watching = true; setCfg({ resume: true });
    for (const login of list) { const st = newChan(login); st.since = T(); L.chans.set(login, st); connect(st); }
    clearInterval(L.timer);
    L.timer = setInterval(L.tick, 1000);
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
    refreshLive().catch(() => {});
    FX.audit('live watch: started', list.join(', '), null, 'you').catch(() => {});
    render();
    return true;
  };
  L.stop = (quiet) => {
    L.watching = false; clearInterval(L.timer); L.timer = null;
    for (const st of L.chans.values()) { const ws = st.ws; st.ws = null; try { ws?.close(); } catch {} }
    L.chans.clear();
    stopGrab();
    if (!quiet) { setCfg({ resume: false }); render(); }
  };
  let lastLiveCheck = 0;
  L.tick = () => {
    const t = T();
    for (const st of L.chans.values()) evaluate(st, t);
    if (t - lastLiveCheck > 120e3) refreshLive().catch(() => {});
    paintMeters();
  };

  /* ---------------- Twitch API (uses the connection from the Automation tab) ---------------- */
  const twToken = () => ls.get('fx_twToken', null)?.token || null;
  const twReady = () => !!(twToken() && FX.autoCfg?.().twClient);
  async function tw(path, method = 'GET') {
    const r = await fetch(L.TW + path, { method, headers: { 'Client-Id': FX.autoCfg().twClient, Authorization: 'Bearer ' + twToken() } });
    if (r.status === 401) { const e = new Error('Twitch sign-in expired or is missing clip permission. Press "Connect Twitch" again.'); e.code = 401; throw e; }
    if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} const e = new Error(`Twitch ${r.status}${m ? ': ' + m : ''}`); e.code = r.status; throw e; }
    return r.status === 204 ? {} : r.json();
  }
  async function userId(login) {
    const ids = ls.get('fx_twIds', {});
    if (!ids[login]) { const u = await tw(`/users?login=${encodeURIComponent(login)}`); ids[login] = u.data?.[0]?.id || null; ls.set('fx_twIds', ids); }
    return ids[login];
  }
  async function refreshLive() {
    lastLiveCheck = T();
    for (const st of L.chans.values()) if (st.kick && st.chatroom) kickChannel(st).then(paintChans).catch(() => {});
    const list = [...L.chans.keys()].filter((k) => !isKick(k));
    if (!twReady() || !list.length) return;
    const j = await tw('/streams?' + list.map((l) => 'user_login=' + encodeURIComponent(l)).join('&'));
    for (const st of L.chans.values()) {
      if (st.kick) continue;
      const s = (j.data || []).find((x) => x.user_login.toLowerCase() === st.login);
      st.live = s ? { started: Date.parse(s.started_at), title: s.title, game: s.game_name, viewers: s.viewer_count } : false;
      if (s) st.id = s.user_id;
    }
    paintChans();
  }

  /* ---------------- a moment happened ---------------- */
  const topWords = (keys) => [...keys.entries()].map(([k, v]) => [k, v.size]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`);
  async function onMoment(st, t, win, base) {
    const c = cfg();
    const m = {
      id: 'lm_' + t + '_' + st.login, login: st.login, at: t, strength: Math.round((win.w / base) * 10) / 10, score: Math.round(win.w), base: Math.round(base),
      users: win.users, top: topWords(win.keys), sample: st.recent.slice(-6).map((x) => `${x.user}: ${x.text}`), status: 'new',
      clip: null, vod: null, grab: null, clipId: null, errs: [], test: !!st.testing,
    };
    st.testing = false;
    st.active = { at: t, peakScore: Math.round(win.w), peakAt: t, m };
    L.moments.unshift(m); saveMoments();
    FX.audit('live watch: moment', `${st.login} ×${m.strength} (${m.top.join(', ')})`, null, 'live watch').catch(() => {});
    alertMoment(m);
    render();
    const jobs = [];
    // a test spike never makes a real Twitch clip or timestamp
    if (c.twClip && twReady() && !m.test && !st.kick) jobs.push(makeTwitchClip(st, m));
    if (c.mark && twReady() && !m.test && !st.kick) jobs.push(markVod(st, m));
    if (c.grab && grabbing(st.login)) jobs.push(grabMoment(m));
    await Promise.allSettled(jobs);
    saveMoments(); render();
  }
  L.onMoment = onMoment;

  function alertMoment(m) {
    const c = cfg(), msg = `Hype on ${nameOf(m.login)}: chat is ${m.strength}× normal${m.top[0] ? ' (' + m.top[0] + ')' : ''}`;
    try { toast(msg); } catch {}
    log(msg);
    if (c.sound) beep();
    try { if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('AutoClipper Live Watch', { body: msg }); } catch {}
    const badge = document.querySelector('nav button[data-tab="live"] .pill'); if (badge) { badge.hidden = false; badge.textContent = L.moments.filter((x) => x.status === 'new').length; }
  }
  function beep() {
    try { const ac = getAudioCtx(); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.12, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.35); o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.36); } catch {}
  }

  async function makeTwitchClip(st, m) {
    try {
      const id = st.id || (st.id = await userId(st.login));
      if (!id) throw new Error('channel not found');
      const j = await tw(`/clips?broadcaster_id=${id}`, 'POST');
      const clipId = j.data?.[0]?.id; if (!clipId) throw new Error('Twitch did not return a clip');
      m.clipId = clipId; m.clip = { id: clipId, url: `https://clips.twitch.tv/${clipId}`, edit: j.data[0].edit_url };
      saveMoments(); render();
      // Twitch takes ~15 s to finish the clip; then read its VOD offset and thumbnail
      await new Promise((r) => setTimeout(r, L.clipWait ?? 15000));
      const g = await tw(`/clips?id=${clipId}`);
      const x = g.data?.[0];
      if (x) Object.assign(m.clip, { url: x.url, thumb: x.thumbnail_url, title: x.title, vodId: x.video_id || null, offset: x.vod_offset ?? null });
      log(`Live Watch: made Twitch clip on ${st.login}`);
    } catch (e) {
      const why = e.code === 403 ? 'Twitch refused the clip (the channel may only allow followers/subs to clip, or clips are off).' : e.message;
      m.errs.push('Twitch clip: ' + why); log('Live Watch clip: ' + why);
    }
  }
  async function markVod(st, m) {
    try {
      if (st.live == null) await refreshLive();
      if (!st.live) throw new Error(`${st.login} doesn't look live right now`);
      const id = st.id || (st.id = await userId(st.login));
      const v = await tw(`/videos?user_id=${id}&type=archive&first=1`);
      const vid = v.data?.[0];
      const offset = Math.max(0, (m.at - st.live.started) / 1000 - 8); // chat reacts ~8 s after the action
      m.vod = { id: vid && Date.parse(vid.created_at) >= st.live.started - 10 * 60e3 ? vid.id : null, offset, started: st.live.started };
      if (m.vod.id) m.vod.url = `https://www.twitch.tv/videos/${m.vod.id}?t=${hhmmss(offset - 20)}`;
    } catch (e) { m.errs.push('VOD timestamp: ' + e.message); }
  }

  // live-chat moments become hype markers when that VOD is dropped into the Assembly Line
  const prevMarkers = FX.vodMarkers;
  FX.vodMarkers = (entry, file, dur) => {
    const out = prevMarkers ? prevMarkers(entry, file, dur) : [];
    const twv = Object.values(FX.auto?.twVods?.() || {});
    const v = twv.find((x) => file.name.includes(x.id)) || twv.find((x) => x.durSec && Math.abs(x.durSec - dur) < 90);
    const vodId = v?.id || L.moments.map((x) => x.vod?.id || x.clip?.vodId).find((id) => id && file.name.includes(id));
    if (!vodId) return out;
    const mine = L.moments.filter((x) => (x.vod?.id === vodId || x.clip?.vodId === vodId));
    for (const x of mine) {
      const off = x.clip?.offset ?? x.vod?.offset; if (off == null || off > dur) continue;
      out.push({ start: Math.max(0, off - 20), views: Math.round(25 * x.strength), title: 'Live chat spike ×' + x.strength });
    }
    if (mine.length) log(`${file.name}: ${mine.length} live-chat moment(s) from Live Watch added`);
    return out;
  };

  /* ---------------- rolling recording of this tab (optional) ----------------
     One screen share of this tab; each player you record gets its own cropped copy of it, with its
     own rolling recorder, so several streams can be recorded at the same time. */
  const G = L.grabber = { share: null, by: new Map() }; // by: login -> { stream, own, recs, timer, startedAt }
  const grabMime = () => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const grabbing = (login) => G.by.has(login);
  // a new recorder starts every few seconds and only the newest two are kept per player (plus any being
  // cut into a clip), so there is always one that began before the moment's pre-roll without running
  // a pile of video encoders at once when several players are recording
  const spawnEvery = () => L.spawnEvery ?? Math.max(30e3, ((+cfg().preRoll || 25) + 10) * 1000);
  function spawnRec(g) {
    if (!g.stream) return;
    const mimeType = grabMime();
    const n = Math.max(1, G.by.size); // keep total bitrate sane when several players record at once
    const vbr = Math.max(1_500_000, Math.round(6_000_000 / n));
    let rec;
    try { rec = new MediaRecorder(g.stream, { mimeType, videoBitsPerSecond: vbr, audioBitsPerSecond: 128_000 }); } catch (e) { log('Live Watch recorder: ' + e.message); return; }
    const r = { rec, chunks: [], start: T(), hold: false, type: (mimeType || 'video/webm').split(';')[0] };
    r.rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    r.rec.onerror = (e) => { r.dead = true; log('Live Watch recorder error: ' + (e.error?.message || 'stopped')); };
    r.done = new Promise((res) => (r.rec.onstop = res));
    r.rec.start(1000);
    g.recs.push(r);
    const free = g.recs.filter((o) => !o.hold && !o.dead);
    for (const o of free.slice(0, Math.max(0, free.length - 2))) { try { o.rec.stop(); } catch {} o.dead = true; }
    g.recs = g.recs.filter((o) => !o.dead || o.hold);
  }
  // ask Chrome once to share this tab; every recorded player reuses it
  async function ensureShare() {
    const live = G.share?.getVideoTracks()[0]?.readyState === 'live';
    if (live) return G.share;
    if (!navigator.mediaDevices?.getDisplayMedia) { toast('This browser cannot record a tab. Use Chrome or Edge on a computer.'); return null; }
    let s;
    try {
      s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: { suppressLocalAudioPlayback: false }, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'include' });
    } catch { toast('Recording not started (screen sharing was cancelled).'); return null; }
    if (!s.getAudioTracks().length) toast('Recording without sound: share "This tab" and keep "Also share tab audio" on, then unmute the player.');
    s.getVideoTracks()[0]?.addEventListener('ended', () => { stopGrab(); render(); });
    G.share = s;
    return s;
  }
  L.startGrab = async (login, streamOverride) => {
    if (grabbing(login)) return true;
    let s = streamOverride, own = !!streamOverride;
    if (!s) {
      const share = await ensureShare(); if (!share) return false;
      // a copy of the tab video, cropped down to just this player (Chrome's Region Capture)
      const vt = share.getVideoTracks()[0].clone();
      try { const el = document.querySelector(`[data-player="${login}"]`); if (el && window.CropTarget && vt.cropTo) await vt.cropTo(await CropTarget.fromElement(el)); } catch {}
      s = new MediaStream([vt, ...share.getAudioTracks()]);
    }
    const g = { stream: s, own, recs: [], timer: null, startedAt: T() };
    G.by.set(login, g);
    if (own) s.getVideoTracks()[0]?.addEventListener('ended', () => { stopGrab(login); render(); });
    spawnRec(g); g.timer = setInterval(() => spawnRec(g), spawnEvery());
    FX.audit('live watch: recording', login, null, 'you').catch(() => {});
    render();
    return true;
  };
  // record every player that's showing, from one screen share
  L.startGrabAll = async () => {
    if (!cfg().player) { toast('Turn on "Show players" first.'); return false; }
    const list = [...L.chans.keys()].filter((l) => !grabbing(l));
    if (!list.length) return true;
    if (!(await ensureShare())) return false;
    for (const l of list) await L.startGrab(l);
    if (G.by.size > 1) toast(`Recording ${G.by.size} players. Keep them all on screen; sound comes from every unmuted player, so unmute only the one(s) you want in the clips.`);
    return true;
  };
  function stopGrab(login) {
    for (const [l, g] of [...G.by]) {
      if (login && l !== login) continue;
      clearInterval(g.timer);
      for (const o of g.recs) { if (!o.hold) try { o.rec.stop(); } catch {} }
      // the shared audio track belongs to the screen share, so only stop our own copies
      try { (g.own ? g.stream.getTracks() : g.stream.getVideoTracks()).forEach((t) => t.stop()); } catch {}
      G.by.delete(l);
    }
    if (!G.by.size && G.share) { try { G.share.getTracks().forEach((t) => t.stop()); } catch {} G.share = null; }
  }
  L.stopGrab = (login) => { stopGrab(login); render(); };

  async function grabMoment(m) {
    const c = cfg(), pre = +c.preRoll || 25, post = +c.postRoll || 10;
    const from = m.at - pre * 1000;
    const g = G.by.get(m.login); if (!g) { m.errs.push('Recording: this player was not being recorded'); return; }
    // the recorder that began earliest enough; else the oldest one we have
    const live = g.recs.filter((o) => !o.dead && !o.hold && o.chunks.length).sort((a, b) => a.start - b.start);
    const r = live.filter((o) => o.start <= from).pop() || live[0];
    if (!r) { m.errs.push('Recording: nothing recorded yet'); return; }
    r.hold = true; m.grab = { status: 'recording' }; render();
    await new Promise((res) => setTimeout(res, (L.postWait ?? post * 1000)));
    try { r.rec.stop(); } catch {}
    await r.done;
    g.recs = g.recs.filter((o) => o !== r);
    const raw = new Blob(r.chunks, { type: r.type });
    const start = Math.max(0, (from - r.start) / 1000), len = Math.min(90, (m.at + post * 1000 - Math.max(from, r.start)) / 1000);
    await kvSet('live_' + m.id, raw).catch(() => {});
    m.grab = { status: 'cutting', start, len, size: raw.size }; saveMoments(); render();
    try {
      const clip = await L.clipFromGrab(m, raw, start, len);
      m.grab.status = 'done'; m.grab.clipId = clip.id; m.status = 'clipped';
      log(`Live Watch: "${clip.title}" is in the Review Queue`);
    } catch (e) { m.grab.status = 'failed'; m.errs.push('Recording: ' + e.message); }
  }

  // cut a 9:16 captioned clip out of a raw live recording (same renderer as the Stream Clipper)
  L.clipFromGrab = async (m, raw, start, len) => exclusive(async () => {
    startJob('cut', `Cutting the live moment on ${m.login}…`);
    try {
      const file = new File([raw], `live_${nameOf(m.login)}_${m.at}.webm`, { type: raw.type || 'video/webm' });
      await loadVod(file);
      let chunks = null, meta = null, tr = null;
      if (val('apiKey')) {
        try {
          const buffer = await getAudioCtx().decodeAudioData(await raw.arrayBuffer());
          tr = await transcribe(await segmentWav(buffer, start, Math.min(len, buffer.duration - start)), 'clip.wav');
          if (val('burnCaptions') && tr?.words) chunks = wordsToChunks(tr.words);
          if (tr?.text) meta = await clipMeta(tr.text);
        } catch (e) { log('Live clip captions skipped: ' + e.message); }
      }
      const blob = await recordVodSegment(start, len, val('layout'), val('clipTag'), chunks);
      vod.removeAttribute('src'); vod.load();
      const clip = {
        id: Date.now() + '_live', kind: 'clip', source: 'live',
        title: meta?.title || `${nameOf(m.login)} live moment ${clockTime(m.at)}`,
        blob, caption: meta ? `${meta.caption} ${meta.hashtags}` : `Chat went crazy 😳 ${val('hashtags')}`,
        score: meta?.score ?? null, status: 'pending', created: Date.now(), transcript: tr?.text || '',
        live: { login: m.login, at: m.at, strength: m.strength, twitchClip: m.clip?.url || null },
      };
      await putClip(clip);
      await onNewVideo(clip);
      return clip;
    } finally { endJob('cut'); }
  });

  /* =====================================================================
     LIVE WATCH TAB
     ===================================================================== */
  const sec = document.getElementById('live');
  const esc2 = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const STATE_TXT = { learning: 'Learning normal pace…', calm: 'Calm', warm: 'Heating up', hype: 'HYPE' };
  // a channel card is built once and then patched in place, so the stream players never reload
  function chanHead(st) {
    const liveTxt = st.live ? `Live · ${st.live.viewers?.toLocaleString?.() ?? ''} viewers${st.live.game ? ' · ' + esc2(st.live.game) : ''}` : st.live === false ? 'Offline' : '';
    return `<h3>${ico('radio')}<a href="${chanUrl(st.login)}" target="_blank" rel="noopener">${esc2(st.name)}</a></h3>${st.kick ? '<span class="chip kick">Kick</span>' : ''}
        <span class="chip ${st.status === 'watching' ? 'on' : st.status === 'error' ? 'bad' : ''}" data-m="status">${esc2(st.status === 'error' ? st.err || 'Error' : st.status)}</span>
        ${grabbing(st.login) ? '<span class="chip rec">● REC</span>' : ''}
        <span class="muted small">${liveTxt}</span>`;
  }
  function chanActs(st) {
    const c = cfg();
    return `${grabbing(st.login)
        ? `<button data-live="stopGrab" data-login="${st.login}">${ico('stop')}Stop recording</button>`
        : `<button data-live="grab" data-login="${st.login}" ${c.player ? '' : 'disabled title="Turn on Show players"'}>${ico('film')}Record clips from this player</button>`}
        <button data-live="sim" data-login="${st.login}" title="Fake a burst of chat to see what happens">${ico('bolt')}Test a spike</button>`;
  }
  function chanCard(st) {
    const c = cfg();
    return `<div class="row live-head">${chanHead(st)}</div>
      ${c.player ? `<div class="live-player" data-player="${st.login}"><iframe title="${esc2(st.name)} stream" src="${st.kick ? `https://player.kick.com/${encodeURIComponent(st.name)}?muted=true&autoplay=true` : `https://player.twitch.tv/?channel=${st.login}&parent=${encodeURIComponent(location.hostname || 'localhost')}&muted=true&autoplay=true`}" allow="autoplay; fullscreen" allowfullscreen></iframe></div>` : ''}
      <div class="live-meter"><div class="live-bar"><i data-m="bar"></i><b data-m="need"></b></div>
        <div class="row small"><span data-m="state" class="live-state">${STATE_TXT[st.state]}</span><span class="muted" data-m="nums"></span></div>
        <canvas class="live-spark" data-m="spark" width="600" height="56" aria-label="Chat activity, last 3 minutes"></canvas></div>
      <div class="row live-acts">${chanActs(st)}</div>`;
  }
  function syncChans(host) {
    const c = cfg(), p = c.player ? '1' : '0';
    host.classList.toggle('many', L.chans.size > 2);
    for (const el of [...host.children]) if (!L.chans.has(el.dataset.chan) || el.dataset.p !== p) el.remove();
    for (const st of L.chans.values()) {
      let el = host.querySelector(`:scope > [data-chan="${st.login}"]`);
      if (!el) {
        el = document.createElement('div'); el.className = 'card live-chan'; el.dataset.chan = st.login; el.dataset.p = p;
        el.innerHTML = chanCard(st); host.appendChild(el);
      } else {
        el.querySelector('.live-head').innerHTML = chanHead(st);
        el.querySelector('.live-acts').innerHTML = chanActs(st);
      }
    }
  }
  // what the Live Watch + Assembly Line need connected, with paste boxes right here
  function connCard() {
    const ai = !!val('apiKey'), up = !!val('upKey'), soc = typeof canPost === 'function' && canPost(), tw = twReady();
    const n = [ai, up && soc, tw].filter(Boolean).length;
    const dot = (ok) => `<span class="chip ${ok ? 'on' : ''}">${ok ? 'Connected' : 'Not connected'}</span>`;
    return `<details class="card lv-conn-card" ${n === 3 ? '' : 'open'}><summary><h3>${ico('link')}Connections</h3><span class="muted small">${n} of 3 connected${n === 3 ? ' · all set' : ''}</span></summary>
      <div class="lv-conns">
        <div class="lv-conn"><div class="lv-conn-top"><b>OpenAI</b>${dot(ai)}</div>
          <p class="muted small">Captions + titles on live clips, hype scores, and the Assembly Line robots (scripts, voice, checks). Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>.</p>
          <div class="row"><input type="password" id="lvApiKey" value="${esc2(val('apiKey'))}" placeholder="Paste your OpenAI key (sk-…)" autocomplete="off" spellcheck="false"><button data-live="testAi">Save &amp; test</button></div>
          <div class="small muted" id="lvAiStatus"></div></div>
        <div class="lv-conn"><div class="lv-conn-top"><b>Upload-Post + socials</b>${dot(up && soc)}</div>
          <p class="muted small">Posts approved clips to TikTok, YouTube, Instagram and more. Free key at <a href="https://app.upload-post.com" target="_blank" rel="noopener">app.upload-post.com</a> → API Keys.</p>
          <div class="row"><input type="password" id="lvUpKey" value="${esc2(val('upKey'))}" placeholder="Paste your Upload-Post key" autocomplete="off" spellcheck="false"><button data-live="saveUp">Save &amp; check</button></div>
          <div class="row"><button data-live="socials">${ico('link')}${soc ? 'Manage socials' : 'Connect socials'}</button><span class="small muted">${up ? (soc ? 'Posting is ready.' : 'Key saved. Now connect your socials.') : ''}</span></div></div>
        <div class="lv-conn"><div class="lv-conn-top"><b>Twitch</b>${dot(tw)}</div>
          <p class="muted small">Instant Twitch clips + VOD timestamps when chat pops off. Chat reading works without it.</p>
          <div class="row"><button data-live="twOpen">${tw ? 'Twitch settings' : 'Set up Twitch'}</button></div></div>
      </div></details>`;
  }
  function momentRow(m) {
    const g = m.grab, rec = m.vod?.url;
    return `<div class="live-moment ${m.status}" data-id="${m.id}">
      <div class="lm-main"><div class="lm-top"><b>${esc2(nameOf(m.login))}</b>${isKick(m.login) ? ' <span class="chip kick">Kick</span>' : ''} <span class="chip hype">×${m.strength}</span> <span class="muted small">${clockTime(m.at)} · ${m.users} chatters</span>${m.test ? '<span class="chip">test</span>' : ''}</div>
        <div class="small muted">${m.top.map(esc2).join(' · ') || ''}</div>
        <details class="small"><summary>What chat said</summary><div class="log">${m.sample.map(esc2).join('\n')}</div></details>
        ${m.errs.length ? `<div class="small bad-text">${m.errs.map(esc2).join('<br>')}</div>` : ''}</div>
      <div class="lm-acts">
        ${m.clip ? `<a class="btnlike" href="${esc2(m.clip.url)}" target="_blank" rel="noopener">${ico('play')}Twitch clip</a>` : ''}
        ${rec ? `<a class="btnlike" href="${esc2(rec)}" target="_blank" rel="noopener">${ico('eye')}VOD at ${hhmmss(m.vod.offset)}</a>` : m.vod ? `<span class="chip">VOD ${hhmmss(m.vod.offset)} in</span>` : ''}
        ${g ? (g.status === 'done' ? `<button data-live="queue">${ico('inbox')}In Review Queue</button>` : g.status === 'failed' ? '<span class="chip bad">Recording failed</span>' : `<span class="chip">${g.status === 'recording' ? 'Recording…' : 'Cutting clip…'}</span>`) : ''}
        ${g?.size ? `<button data-live="raw" data-id="${m.id}">${ico('download')}Raw</button>` : ''}
        <button data-live="dismiss" data-id="${m.id}" title="Remove">${ico('x')}</button>
      </div></div>`;
  }
  function render() {
    if (!sec) return;
    const c = cfg(), tw = twReady(), auto = FX.autoCfg?.() || {};
    const newCount = L.moments.filter((x) => x.status === 'new').length;
    const badge = document.querySelector('nav button[data-tab="live"] .pill'); if (badge) { badge.hidden = !newCount; badge.textContent = newCount; }
    if (!sec.querySelector('#lvTop')) sec.innerHTML = '<div id="lvTop"></div><div class="live-chans" id="lvChans"></div><div id="lvMoments"></div>';
    const top = sec.querySelector('#lvTop');
    const fe = document.activeElement, focused = top.contains(fe) ? fe.id : null, sel = focused && fe.selectionStart != null ? [fe.selectionStart, fe.selectionEnd] : null, typed = focused && fe.type !== 'checkbox' ? fe.value : null;
    const openD = [...top.querySelectorAll('details[data-k]')].reduce((o, d) => ((o[d.dataset.k] = d.open), o), {});
    const recN = G.by.size, many = L.chans.size > 1;
    top.innerHTML = `
      <h2>Live Watch</h2>
      <p class="muted">Watches streams while they're live and reads chat. When chat suddenly blows up (lots of different people, hype words, "clip it"), that's a moment: it grabs it right away, before the stream ends or anyone else clips it. Nothing posts from here; clips land in your Review Queue.</p>
      ${connCard()}
      <div class="card">
        <div class="row"><h3>${ico('radio')}Channels to watch</h3><span class="chip ${L.watching ? 'on' : ''}">${L.watching ? 'Watching ' + L.chans.size : 'Off'}</span>${recN ? `<span class="chip rec">● Recording ${recN}</span>` : ''}</div>
        <div class="grid2">
          <label>Channels, comma separated (up to ${MAX_CH}). Twitch: name. Kick: kick:name or a kick.com link<input id="lvChannels" value="${esc2(c.channels)}" placeholder="e.g. kaicenat, xqc, kick:n3on" autocomplete="off"></label>
          <label>How easily it triggers
            <select id="lvSens"><option value="low" ${c.sens === 'low' ? 'selected' : ''}>Only huge moments</option><option value="med" ${c.sens === 'med' ? 'selected' : ''}>Balanced</option><option value="high" ${c.sens === 'high' ? 'selected' : ''}>Catch more moments</option></select></label>
        </div>
        <div class="row">${L.watching ? `<button class="primary" data-live="stop">${ico('stop')}Stop watching</button>` : `<button class="primary" data-live="start">${ico('play')}Start watching</button>`}
          ${L.watching && many && c.player ? (recN >= L.chans.size ? `<button data-live="stopGrab">${ico('stop')}Stop all recordings</button>` : `<button data-live="grabAll">${ico('film')}Record all ${L.chans.size} players</button>`) : ''}
          ${L.chans.size && window.ACCloud?.url() ? `<button data-live="toCloud" title="Your cloud server watches these streams 24/7 and sends hype moments to production; clips wait in Cloud studio → Review">${ico('radio')}Clip these 24/7 in the cloud</button>` : ''}
          <span class="muted small">Keep this tab open${recN > 1 ? ' and every recorded player on screen' : ''}. Chat is read anonymously; no Twitch or Kick login needed for alerts.</span></div>
        <details data-k="opts"><summary class="small">What to do when a moment hits</summary>
          <div class="grid2" style="margin-top:10px">
            <label class="check"><input type="checkbox" id="lvTwClip" ${c.twClip ? 'checked' : ''}> Make a Twitch clip instantly ${tw ? '' : '<span class="muted">(connect Twitch below)</span>'}</label>
            <label class="check"><input type="checkbox" id="lvMark" ${c.mark ? 'checked' : ''}> Save the VOD timestamp for the Moment Scout ${tw ? '' : '<span class="muted">(connect Twitch below)</span>'}</label>
            <label class="check"><input type="checkbox" id="lvGrab" ${c.grab ? 'checked' : ''}> Turn it into a 9:16 clip when recording a player</label>
            <label class="check"><input type="checkbox" id="lvSound" ${c.sound ? 'checked' : ''}> Beep + desktop notification</label>
            <label class="check"><input type="checkbox" id="lvPlayer" ${c.player ? 'checked' : ''}> Show players</label>
          </div>
          <div class="grid3" style="margin-top:10px">
            <label>Seconds before the spike<input type="number" id="lvPre" min="10" max="60" value="${c.preRoll}"></label>
            <label>Seconds after the spike<input type="number" id="lvPost" min="3" max="30" value="${c.postRoll}"></label>
            <label>Wait between moments (sec)<input type="number" id="lvCool" min="20" max="900" value="${c.cooldown}"></label>
            <label>Minimum chat score per 10 sec<input type="number" id="lvMin" min="3" max="500" value="${c.minMsgs}"></label>
            <label>Different chatters needed<input type="number" id="lvUsers" min="1" max="50" value="${c.users}"></label>
          </div></details>
        <details data-k="tw" id="lvTwBox" ${tw ? '' : 'open'}><summary class="small">Twitch connection ${tw ? '(connected)' : '(optional, for instant clips + VOD timestamps)'}</summary>
          <div class="row" style="margin-top:10px"><label style="flex:1">Twitch app Client ID<input id="lvTwClient" value="${esc2(auto.twClient || '')}" placeholder="from dev.twitch.tv/console"></label>
            <button data-live="twConnect">${tw ? 'Reconnect Twitch' : 'Connect Twitch'}</button></div>
          <p class="muted small">Make an app at <a href="https://dev.twitch.tv/console/apps/create" target="_blank" rel="noopener">dev.twitch.tv/console</a> (Category: Application Integration, Client Type: Public) with OAuth redirect URL <code>${esc2(location.origin + location.pathname)}</code>, copy its Client ID here, then press Connect. AutoClipper asks for permission to create clips. If you connected before this update, press Reconnect once so clips are allowed. Only clip channels whose clips you're allowed to post (your own, a clipping campaign, or written permission).</p>
        </details>
      </div>`;
    for (const d of top.querySelectorAll('details[data-k]')) if (d.dataset.k in openD) d.open = openD[d.dataset.k];
    if (focused) { const el = document.getElementById(focused); if (el && typed != null) el.value = typed; el?.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} }
    syncChans(sec.querySelector('#lvChans'));
    sec.querySelector('#lvMoments').innerHTML = `
      <div class="row"><h3>${ico('flag')}Moments caught</h3><span class="muted small">${L.moments.length ? L.moments.length + ' saved' : ''}</span>${L.moments.length ? '<button data-live="clearAll">Clear list</button>' : ''}</div>
      <div class="live-moments">${L.moments.map(momentRow).join('') || emptyBot('No moments yet. Start watching a channel; when chat spikes, the moment shows up here.')}</div>`;
    paintMeters();
  }
  L.render = render;
  function paintChans() { if (document.getElementById('live')?.classList.contains('active')) render(); }
  function paintMeters() {
    if (!sec || !sec.classList.contains('active')) return;
    for (const st of L.chans.values()) {
      const el = sec.querySelector(`[data-chan="${st.login}"]`); if (!el) continue;
      const q = (k) => el.querySelector(`[data-m="${k}"]`);
      const top = Math.max(st.need || 10, ...st.hist, 1) * 1.15;
      q('bar').style.width = Math.min(100, (st.now / top) * 100) + '%';
      q('bar').className = st.state;
      if (st.need) q('need').style.left = Math.min(100, (st.need / top) * 100) + '%';
      q('state').textContent = STATE_TXT[st.state] || st.state;
      q('state').className = 'live-state ' + st.state;
      q('nums').textContent = `${Math.round(st.now)} now · ${st.base == null ? 'normal: learning' : 'normal ' + Math.round(st.base)} · ${st.total} msgs`;
      q('status').textContent = st.status === 'error' ? st.err || 'Error' : st.status;
      const cv = q('spark'), x = cv.getContext('2d'), h = st.hist, W2 = cv.width, H2 = cv.height;
      x.clearRect(0, 0, W2, H2);
      if (st.need) { x.strokeStyle = 'rgba(255,138,101,.45)'; x.setLineDash([4, 4]); x.beginPath(); const y = H2 - (st.need / top) * H2; x.moveTo(0, y); x.lineTo(W2, y); x.stroke(); x.setLineDash([]); }
      x.strokeStyle = '#7cf7d4'; x.lineWidth = 2; x.beginPath();
      h.forEach((v, i) => { const px = (i / 179) * W2, py = H2 - (v / top) * H2; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.stroke();
    }
  }
  const readForm = () => setCfg({
    channels: document.getElementById('lvChannels')?.value || '', sens: document.getElementById('lvSens')?.value || 'med',
    twClip: !!document.getElementById('lvTwClip')?.checked, mark: !!document.getElementById('lvMark')?.checked, grab: !!document.getElementById('lvGrab')?.checked,
    sound: !!document.getElementById('lvSound')?.checked, player: !!document.getElementById('lvPlayer')?.checked,
    preRoll: Math.min(60, Math.max(10, +document.getElementById('lvPre')?.value || 25)), postRoll: Math.min(30, Math.max(3, +document.getElementById('lvPost')?.value || 10)),
    cooldown: Math.min(900, Math.max(20, +document.getElementById('lvCool')?.value || 90)), minMsgs: Math.min(500, Math.max(3, +document.getElementById('lvMin')?.value || 8)),
    users: Math.min(50, Math.max(1, +document.getElementById('lvUsers')?.value || 3)),
  });
  // the paste boxes here write into the real Settings / Accounts fields, which save themselves
  function setField(id, v) {
    const el = document.getElementById(id); if (!el || v == null) return;
    el.value = String(v).trim();
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  sec?.addEventListener('change', (e) => {
    if (e.target.id === 'lvApiKey') { setField('apiKey', e.target.value); render(); return; }
    if (e.target.id === 'lvUpKey') { setField('upKey', e.target.value); render(); return; }
    if (!e.target.id?.startsWith('lv')) return;
    if (e.target.id === 'lvTwClient') { const a = ls.get('fx_auto', {}) || {}; ls.set('fx_auto', { ...a, twClient: e.target.value.trim() }); return; }
    readForm();
    if (e.target.id === 'lvPlayer') render();
  });
  L.simulate = (login, t0 = T()) => { // a fake burst of chat, to try the detector without waiting for a real one
    const st = L.chans.get(login); if (!st) return;
    if (st.base == null) { st.since = Math.min(st.since, t0 - 6 * 60e3); for (let s = 300; s > 20; s -= 2) L.ingest(login, 'calm' + (s % 7), 'hello chat', t0 - s * 1000); }
    const lines = ['KEKW', 'CLIP IT', 'NO WAY', 'LMAOOO', 'clip that', 'OMEGALUL', 'W', '???', 'HOLY', 'KEKW'];
    for (let i = 0; i < 60; i++) L.ingest(login, 'viewer' + (i % 25), lines[i % lines.length], t0 - (i % 9) * 1000);
    st.lastSpike = 0; st.testing = true; evaluate(st, t0); st.testing = false;
  };
  sec?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-live]'); if (!b) return;
    const act = b.dataset.live;
    if (act === 'start') { readForm(); L.start(); }
    else if (act === 'stop') { L.stop(); FX.audit('live watch: stopped', '', null, 'you').catch(() => {}); }
    else if (act === 'grab') { await L.startGrab(b.dataset.login); }
    else if (act === 'grabAll') { await L.startGrabAll(); }
    else if (act === 'toCloud') {
      const names = [...L.chans.keys()];
      if (!confirm(`Watch ${names.join(', ')} on your cloud server 24/7?\n\nOnly do this for streamers who allow clipping (your own channel, an open clipping policy, or a deal). Every clip still waits for your approval in Cloud studio → Review.`)) return;
      try {
        const r = await window.ACCloud.api('/api/watchlist', { method: 'POST', body: { streamers: names, attest: true } });
        toast(`${r.added.length} streamer(s) now watched 24/7 in the cloud. Their hype moments go straight to production.`);
      } catch (err) { toast('Cloud: ' + err.message); }
    }
    else if (act === 'stopGrab') L.stopGrab(b.dataset.login);
    else if (act === 'testAi') {
      const st = (t) => { const el = document.getElementById('lvAiStatus'); if (el) el.textContent = t; };
      setField('apiKey', document.getElementById('lvApiKey')?.value);
      if (!val('apiKey')) return st('Paste a key first.');
      st('Testing…');
      try { await chat('Reply with just: OK'); render(); st('OpenAI key works.'); } catch (e) { st('' + e.message); }
    }
    else if (act === 'saveUp') {
      setField('upKey', document.getElementById('lvUpKey')?.value);
      if (!val('upKey')) return toast('Paste your Upload-Post key first.');
      try { await refreshAccounts(); } catch {} render();
      toast(typeof canPost === 'function' && canPost() ? 'Upload-Post connected. Posting is ready.' : 'Key saved. Next: Connect socials.');
    }
    else if (act === 'socials') openTab('accounts');
    else if (act === 'twOpen') { const d = document.getElementById('lvTwBox'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.getElementById('lvTwClient')?.focus(); } }
    else if (act === 'sim') { L.simulate(b.dataset.login); }
    else if (act === 'queue') openTab('queue');
    else if (act === 'twConnect') { const v = document.getElementById('lvTwClient')?.value.trim(); if (v) { const a = ls.get('fx_auto', {}) || {}; ls.set('fx_auto', { ...a, twClient: v }); } FX.auto?.twConnect?.(); }
    else if (act === 'dismiss') { L.moments = L.moments.filter((x) => x.id !== b.dataset.id); saveMoments(); kvSet('live_' + b.dataset.id, null).catch(() => {}); render(); }
    else if (act === 'clearAll') { if (!confirm('Clear the list of caught moments? Clips already in the Review Queue stay there.')) return; L.moments.forEach((x) => kvSet('live_' + x.id, null).catch(() => {})); L.moments = []; saveMoments(); render(); }
    else if (act === 'raw') { const blob = await kvGet('live_' + b.dataset.id); if (!blob) return toast('The raw recording is gone.'); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.dataset.id + '.webm'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60e3); }
  });
  // opening the tab marks moments as seen
  document.querySelector('nav button[data-tab="live"]')?.addEventListener('click', () => {
    let ch = false; for (const m of L.moments) if (m.status === 'new') { m.status = 'seen'; ch = true; }
    if (ch) saveMoments();
    render();
  });
  render();
  if (cfg().resume && logins().length) setTimeout(() => L.start(), 1500);
})(window.FX);
