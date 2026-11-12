/* AutoClipper v2 — runs fully in the browser (GitHub Pages friendly). */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const W = 1080, H = 1920, FPS = 30;
const canvas = $('#renderCanvas');
const ctx = canvas.getContext('2d');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let audioCtx = null;
const getAudioCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

const PLATFORMS = [
  ['tiktok', 'TikTok'], ['instagram', 'Instagram'], ['youtube', 'YouTube'],
  ['facebook', 'Facebook'], ['x', 'X / Twitter'], ['threads', 'Threads'],
];
const UP_API = 'https://api.upload-post.com/api';

/* ---------------- Local storage helpers ---------------- */
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('ac_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ac_' + k, JSON.stringify(v)); } catch {} },
};
const val = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };

/* ---------------- Activity log ---------------- */
let logLines = ls.get('log', []);
function log(msg) {
  const t = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  logLines.unshift(`[${t}] ${msg}`);
  logLines = logLines.slice(0, 200);
  ls.set('log', logLines);
  renderLog();
}
function renderLog() { $('#log').textContent = logLines.join('\n') || 'Nothing yet.'; }

/* ---------------- IndexedDB ---------------- */
let dbP = null;
function db() {
  return dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('autoclipper', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('clips')) d.createObjectStore('clips', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('bg')) d.createObjectStore('bg', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(storeName, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const putClip = (c) => idb('clips', 'readwrite', (s) => s.put(c));
const getClip = (id) => idb('clips', 'readonly', (s) => s.get(id));
const allClips = () => idb('clips', 'readonly', (s) => s.getAll());
const delClip = (id) => idb('clips', 'readwrite', (s) => s.delete(id));
const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k));

/* ---------------- One job at a time ---------------- */
let chain = Promise.resolve();
let busy = 0;
function exclusive(fn) {
  busy++;
  const p = chain.then(() => fn()).finally(() => busy--);
  chain = p.catch(() => {});
  return p;
}

/* ---------------- Frame ticker (keeps rendering in background tabs) ---------------- */
const ticker = new Worker(URL.createObjectURL(new Blob(
  [`let t;onmessage=e=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),${Math.round(1000 / FPS)})}`],
  { type: 'text/javascript' })));
function renderLoop(step) {
  return new Promise((resolve, reject) => {
    ticker.onmessage = () => {
      try { if (step() === true) { ticker.postMessage(0); resolve(); } }
      catch (e) { ticker.postMessage(0); reject(e); }
    };
    ticker.postMessage(1);
  });
}

/* ---------------- Recording ---------------- */
function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRecorder(audioStream) {
  const stream = canvas.captureStream(FPS);
  if (audioStream) audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = () => {
    stream.getVideoTracks().forEach((t) => t.stop());
    r(new Blob(chunks, { type: (mimeType || 'video/webm').split(';')[0] }));
  }));
  rec.start(1000);
  return { stop: () => { rec.stop(); return done; } };
}

/* ---------------- Drawing ---------------- */
function coverRect(sw, sh, dx, dy, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  return [dx + (dw - sw * s) / 2, dy + (dh - sh * s) / 2, sw * s, sh * s];
}
function containRect(sw, sh, dw, dh) {
  const s = Math.min(dw / sw, dh / sh);
  return [(dw - sw * s) / 2, (dh - sh * s) / 2, sw * s, sh * s];
}
function wrapText(text, maxW) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
function drawCaption(text, y, size = 92, color) {
  if (!text) return;
  ctx.save();
  ctx.font = `900 ${size}px Impact, "Arial Black", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#000';
  ctx.fillStyle = color || val('capColor') || '#ffd400';
  const lines = wrapText(text.toUpperCase(), W - 140);
  lines.forEach((l, i) => {
    const ly = y + (i - (lines.length - 1) / 2) * size * 1.12;
    ctx.strokeText(l, W / 2, ly); ctx.fillText(l, W / 2, ly);
  });
  ctx.restore();
}
// Group timed words into 1–3 word caption chunks
function wordsToChunks(words) {
  const chunks = []; let cur = null;
  for (const w of words) {
    const text = w.word.trim(); if (!text) continue;
    if (!cur || cur.n >= 3 || w.start - cur.end > 0.6 || /[.!?]$/.test(cur.text)) {
      cur = { text, start: w.start, end: w.end, n: 1 }; chunks.push(cur);
    } else { cur.text += ' ' + text; cur.end = w.end; cur.n++; }
  }
  chunks.forEach((c, i) => { c.until = chunks[i + 1] ? Math.min(chunks[i + 1].start, c.end + 0.5) : c.end + 0.5; });
  return chunks;
}
const chunkAt = (chunks, t) => chunks.find((c) => t >= c.start && t < c.until);

/* ================= OPENAI ================= */
async function chat(prompt, json = false) {
  const key = val('apiKey'); if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: val('model') || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  }).then((r) => r.json());
  if (r.error) throw new Error('OpenAI: ' + r.error.message);
  return r.choices[0].message.content.trim();
}
async function transcribe(blob, filename) {
  const key = val('apiKey'); if (!key) return null;
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
  }).then((r) => r.json());
  if (r.error) throw new Error('Whisper: ' + r.error.message);
  return r;
}
async function tts(text) {
  const key = val('apiKey'); if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'tts-1', voice: val('voice') || 'onyx', input: text.slice(0, 4000) }),
  });
  if (!r.ok) throw new Error('Voiceover failed: ' + (await r.text()).slice(0, 150));
  return getAudioCtx().decodeAudioData(await r.arrayBuffer());
}

// Slice an AudioBuffer segment to a small 16 kHz mono WAV (for Whisper)
async function segmentWav(buffer, start, len) {
  const sr = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination);
  src.start(0, start, len);
  const out = (await off.startRendering()).getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + out.length * 2));
  const wr = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  wr(0, 'RIFF'); view.setUint32(4, 36 + out.length * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i])) * 0x7fff, true);
  return new Blob([view], { type: 'audio/wav' });
}

/* ================= STREAM CLIPPER ================= */
const vod = $('#vodVideo');
let vodFile = null, mediaSrc = null, mediaDest = null;
const fmt = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setupDrop(dropEl, inputEl, onFiles) {
  inputEl.onchange = () => inputEl.files.length && onFiles([...inputEl.files]);
  dropEl.ondragover = (e) => { e.preventDefault(); dropEl.classList.add('over'); };
  dropEl.ondragleave = () => dropEl.classList.remove('over');
  dropEl.ondrop = (e) => { e.preventDefault(); dropEl.classList.remove('over'); onFiles([...e.dataTransfer.files]); };
}
setupDrop($('#vodDrop'), $('#vodFile'), (files) => {
  vodFile = files[0];
  $('#vodDrop span').textContent = '🎞️ ' + vodFile.name + ' (' + (vodFile.size / 1e6).toFixed(0) + ' MB)';
  $('#scanBtn').disabled = false;
});

function findHighlights(buffer, count, len) {
  const sr = buffer.sampleRate, win = Math.floor(sr * 0.5);
  const a = buffer.getChannelData(0);
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = Math.floor(a.length / win);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = i * win; j < (i + 1) * win; j += 8) { const v = b ? (a[j] + b[j]) / 2 : a[j]; sum += v * v; cnt++; }
    energy[i] = Math.sqrt(sum / cnt);
  }
  // prefix sums so scoring is fast even for 10-hour VODs
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + energy[i];
  const avg = (lo, hi) => { lo = Math.max(0, lo); hi = Math.min(n, hi); return hi > lo ? (pre[hi] - pre[lo]) / (hi - lo) : 0; };
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) score[i] = avg(i - 6, i + 7) / (avg(i - 120, i + 121) + 1e-4); // ~6s burst vs ~2min baseline
  const order = [...score.keys()].sort((x, y) => score[y] - score[x]);
  const picks = [], gap = len / 0.5;
  for (const i of order) {
    if (picks.length >= count) break;
    if (energy[i] < 0.005) continue; // ignore silence
    if (picks.every((p) => Math.abs(p - i) > gap)) picks.push(i);
  }
  drawWave(energy, picks);
  return picks.map((i) => {
    const peak = i * 0.5;
    const start = Math.max(0, Math.min(buffer.duration - len, peak - len * 0.6));
    return { start, peak, score: score[i] };
  }).sort((x, y) => x.start - y.start);
}

function drawWave(energy, picks) {
  const c = $('#waveform'); c.style.display = 'block';
  c.width = (c.clientWidth || 900) * devicePixelRatio; c.height = 80 * devicePixelRatio;
  const g = c.getContext('2d');
  let max = 0; for (const e of energy) if (e > max) max = e;
  max ||= 1;
  g.fillStyle = '#4b5263';
  for (let x = 0; x < c.width; x++) {
    const v = energy[Math.floor((x / c.width) * energy.length)] / max;
    g.fillRect(x, c.height - v * c.height, 1, v * c.height);
  }
  g.fillStyle = '#ffd400';
  picks.forEach((i) => g.fillRect((i / energy.length) * c.width - 1, 0, 3, c.height));
}

const blurCanvas = Object.assign(document.createElement('canvas'), { width: 27, height: 48 });
const blurCtx = blurCanvas.getContext('2d');
function drawVodFrame(layout, tag, cap) {
  const vw = vod.videoWidth, vh = vod.videoHeight;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  let capY = H * 0.72;
  if (layout === 'crop') {
    ctx.drawImage(vod, ...coverRect(vw, vh, 0, 0, W, H));
  } else if (layout === 'split') {
    const fw = vw * 0.3, fh = vh * 0.3, corner = val('camCorner') || 'tl';
    const sx = corner.includes('r') ? vw - fw : 0, sy = corner.includes('b') ? vh - fh : 0;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H * 0.4); ctx.clip();
    ctx.drawImage(vod, sx, sy, fw, fh, ...coverRect(fw, fh, 0, 0, W, H * 0.4)); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(0, H * 0.4, W, H * 0.6); ctx.clip();
    ctx.drawImage(vod, ...coverRect(vw, vh, 0, H * 0.4, W, H * 0.6)); ctx.restore();
    capY = H * 0.4;
  } else {
    // cheap blur: draw tiny, then scale up smoothly (ctx.filter blur is too slow at 30fps)
    blurCtx.drawImage(vod, ...coverRect(vw, vh, 0, 0, blurCanvas.width, blurCanvas.height));
    ctx.save(); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, H); ctx.restore();
    const r = containRect(vw, vh, W, H);
    ctx.drawImage(vod, ...r);
    capY = Math.min(H - 260, r[1] + r[3] + 170);
  }
  if (tag) drawCaption(tag, layout === 'blur' ? 330 : 200, 64, '#fff');
  if (cap) drawCaption(cap, capY, 96);
}

async function loadVod(file) {
  if (vod.src) URL.revokeObjectURL(vod.src);
  vod.src = URL.createObjectURL(file);
  await new Promise((res, rej) => { vod.onloadedmetadata = res; vod.onerror = () => rej(new Error('This video format can\'t be played in the browser. Use MP4 or WebM.')); });
}

async function recordVodSegment(start, len, layout, tag, chunks) {
  const ac = getAudioCtx(); await ac.resume();
  if (!mediaSrc) {
    mediaSrc = ac.createMediaElementSource(vod);
    mediaDest = ac.createMediaStreamDestination();
    mediaSrc.connect(mediaDest);
    // silent path to the speakers keeps the audio clock (and playback speed) in real time
    const mute = ac.createGain(); mute.gain.value = 0;
    mediaSrc.connect(mute).connect(ac.destination);
  }
  vod.muted = false;
  vod.currentTime = start;
  await new Promise((r) => (vod.onseeked = r));
  drawVodFrame(layout, tag, null);
  const rec = startRecorder(mediaDest.stream);
  await vod.play();
  let stalled = 0, lastT = -1;
  await renderLoop(() => {
    const t = vod.currentTime - start;
    const c = chunks && chunkAt(chunks, t);
    drawVodFrame(layout, tag, c && c.text);
    if (vod.currentTime === lastT) stalled++; else stalled = 0;
    lastT = vod.currentTime;
    return t >= len || vod.ended || stalled > FPS * 15;
  });
  vod.pause();
  return rec.stop();
}

async function clipVideoFile(file, status = () => {}) {
  const count = +val('numClips') || 5, len = +val('clipLen') || 30;
  const layout = val('layout'), tag = val('clipTag');
  status('Loading video…');
  await loadVod(file);
  status('Reading audio… (big files can take a minute)');
  let buffer;
  try { buffer = await getAudioCtx().decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('Could not read this file\'s audio. Use an MP4 under ~2 GB (trim long VODs into parts).'); }
  status('Finding hype moments…');
  const hl = findHighlights(buffer, count, Math.min(len, buffer.duration));
  const made = [];
  for (let i = 0; i < hl.length; i++) {
    const h = hl[i];
    let chunks = null, meta = null;
    if (val('apiKey')) {
      try {
        status(`Clip ${i + 1}/${hl.length}: transcribing…`);
        const tr = await transcribe(await segmentWav(buffer, h.start, len), 'clip.wav');
        if (val('burnCaptions') && tr && tr.words) chunks = wordsToChunks(tr.words);
        if (tr && tr.text) meta = await clipMeta(tr.text);
      } catch (e) { log('⚠️ AI captions skipped: ' + e.message); }
    }
    status(`Clip ${i + 1}/${hl.length}: rendering at ${fmt(h.start)} (real-time)…`);
    const blob = await recordVodSegment(h.start, len, layout, tag, chunks);
    const clip = {
      id: Date.now() + '_' + i, kind: 'clip',
      title: meta?.title || `${file.name.replace(/\.\w+$/, '')} @ ${fmt(h.start)}`,
      blob, caption: meta ? `${meta.caption} ${meta.hashtags}` : `Wait for it… 😳 ${val('hashtags')}`,
      score: meta?.score ?? null, status: 'pending', created: Date.now(),
    };
    await putClip(clip);
    made.push(clip);
    await onNewVideo(clip);
  }
  vod.removeAttribute('src'); vod.load();
  return made;
}

async function clipMeta(transcript) {
  const out = await chat(
    `Transcript of a short gaming/stream clip:\n"""${transcript.slice(0, 3000)}"""\n` +
    `Return JSON {"title": short title (max 60 chars), "caption": punchy TikTok caption (max 110 chars, 1 emoji ok), ` +
    `"hashtags": 5 relevant hashtags in one string, "score": integer 1-10 for how likely this clip is to go viral (be strict)}`, true);
  const m = JSON.parse(out);
  m.score = Number(m.score) || null;
  return m;
}

$('#scanBtn').onclick = async () => {
  const btn = $('#scanBtn'); btn.disabled = true;
  const st = (t) => ($('#clipStatus').textContent = t);
  try {
    const made = await exclusive(() => clipVideoFile(vodFile, st));
    st(`✅ Done — ${made.length} clips made. Check the Review Queue.`);
    log(`✂️ Made ${made.length} clips from ${vodFile.name}`);
  } catch (e) { st('⚠️ ' + e.message); log('⚠️ Clipper: ' + e.message); }
  finally { btn.disabled = false; }
};

/* ================= FACELESS GENERATOR ================= */
const TEMPLATES = {
  'GTA 6 facts & secrets': ['GTA 6 is set in Leonida, a fictional take on Florida, and Vice City is back for the first time since 2006.', 'For the first time in the main series, you play as a female lead, Lucia, alongside Jason.', 'The first GTA 6 trailer broke YouTube records, pulling over ninety million views in its first day.'],
  'Gaming news': ['The biggest games now cost over three hundred million dollars to make.', 'Handheld gaming PCs are outselling some home consoles in certain months.'],
  'Crazy history facts': ['Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.', 'Oxford University is older than the Aztec Empire.'],
  Motivation: ['Nobody is coming to save you. That is the best news you will ever hear, because it means you are in control.'],
  'Scary stories': ['At 3 a.m. my phone buzzed. A text from my own number said: do not look at the window.'],
  'Sports facts': ['A golf ball has around three hundred to five hundred dimples, and they help it fly up to twice as far.'],
  'Money tips': ['If you save just ten dollars a day, that is over three thousand six hundred dollars a year.'],
};
for (const sel of ['#niche', '#apNiche']) $(sel).innerHTML = Object.keys(TEMPLATES).map((k) => `<option>${k}</option>`).join('');

let bgFiles = [];
setupDrop($('#bgDrop'), $('#bgFile'), async (files) => {
  bgFiles = files.slice(0, 5);
  await idb('bg', 'readwrite', (s) => s.clear());
  for (let i = 0; i < bgFiles.length; i++) await idb('bg', 'readwrite', (s) => s.put({ id: i, file: bgFiles[i] }));
  $('#bgDrop span').textContent = `🎮 ${bgFiles.length} background video(s) saved`;
});
const genStatus = (t) => ($('#genStatus').textContent = t);

async function writeScript(niche, topic, secs) {
  const words = Math.round(secs * 2.6);
  const recent = ls.get('recentTopics', []).slice(0, 15).join('; ');
  const ai = await chat(
    `Write a viral faceless short-form video script for the niche "${niche}"${topic ? ` about: ${topic}` : ' (pick a fresh, specific topic)'}.\n` +
    (recent && !topic ? `Do NOT repeat these recent topics: ${recent}\n` : '') +
    `About ${words} words. First sentence must be a scroll-stopping hook. Only state facts you are confident are true. No scene directions, no emojis, just the spoken words. End with a short call to follow.\n` +
    `Return JSON: {"title": string, "script": string, "caption": string (TikTok caption, max 110 chars), "hashtags": string (5 hashtags)}`, true);
  if (ai) {
    const d = JSON.parse(ai);
    ls.set('recentTopics', [d.title, ...ls.get('recentTopics', [])].slice(0, 30));
    return d;
  }
  const lines = TEMPLATES[niche] || TEMPLATES['Gaming news'];
  const pick = lines[Math.floor(Math.random() * lines.length)];
  return { title: topic || niche, script: `${topic ? topic + '. ' : 'You probably did not know this. '}${pick} Follow for more.`, caption: `${topic || niche} 🤯`, hashtags: val('hashtags') };
}

function evenChunks(text, total) {
  const words = text.split(/\s+/).filter(Boolean);
  const per = total / Math.max(1, words.reduce((a, w) => a + w.length + 2, 0));
  let t = 0;
  return wordsToChunks(words.map((w) => { const s = t; t += (w.length + 2) * per; return { word: w, start: s, end: t }; }));
}

async function loadBgVideo() {
  if (!bgFiles.length) return null;
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true;
  v.src = URL.createObjectURL(bgFiles[Math.floor(Math.random() * bgFiles.length)]);
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = j; });
  v.currentTime = Math.random() * Math.max(0, v.duration - 90);
  await new Promise((r) => (v.onseeked = r));
  return v;
}
function drawAnimatedBg(t) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  const h = (t * 20) % 360;
  g.addColorStop(0, `hsl(${h},70%,18%)`); g.addColorStop(1, `hsl(${(h + 80) % 360},70%,8%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.arc(W / 2 + Math.sin(t * 0.6 + i) * 300, H / 2 + Math.cos(t * 0.4 + i * 2) * 600, 80 + i * 18, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function renderFaceless(data, status = genStatus) {
  const ac = getAudioCtx(); await ac.resume();
  status('Voicing script…');
  const audio = await tts(data.script);
  let chunks;
  const total = audio ? audio.duration : Math.max(8, data.script.split(/\s+/).length / 2.6);
  if (audio) {
    try {
      // exact word timing from the voiceover
      const wav = await segmentWav(audio, 0, audio.duration);
      const tr = await transcribe(wav, 'vo.wav');
      if (tr && tr.words && tr.words.length) chunks = wordsToChunks(tr.words);
    } catch {}
  }
  chunks ||= evenChunks(data.script, total);
  const dur = total + 0.5;
  const bg = await loadBgVideo().catch(() => null);
  if (bg) await bg.play();
  let dest = null;
  if (audio) {
    dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource(); src.buffer = audio; src.connect(dest);
    src.start(ac.currentTime + 0.05);
  }
  const rec = startRecorder(dest && dest.stream);
  status(`Rendering "${data.title}" (${Math.round(dur)}s, real-time)…`);
  const t0 = performance.now();
  await renderLoop(() => {
    const t = (performance.now() - t0) / 1000;
    if (bg && bg.videoWidth) {
      ctx.drawImage(bg, ...coverRect(bg.videoWidth, bg.videoHeight, 0, 0, W, H));
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
    } else drawAnimatedBg(t);
    const c = chunkAt(chunks, t);
    if (c) drawCaption(c.text, H * 0.5, 100 + 14 * (1 - Math.min(1, (t - c.start) / 0.12)));
    return t >= dur;
  });
  if (bg) { bg.pause(); URL.revokeObjectURL(bg.src); }
  return rec.stop();
}

async function makeFacelessVideo(d, status) {
  const blob = await renderFaceless(d, status);
  const clip = {
    id: Date.now() + '_f', kind: 'faceless', title: d.title, blob,
    caption: `${d.caption} ${d.hashtags || val('hashtags')}`.trim(), score: null, status: 'pending', created: Date.now(),
  };
  await putClip(clip);
  await onNewVideo(clip);
  return clip;
}

$('#writeBtn').onclick = async () => {
  try {
    genStatus(val('apiKey') ? 'Writing script with AI…' : 'No OpenAI key — using a built-in template…');
    const d = await writeScript(val('niche'), val('topic'), +val('vidLen'));
    $('#script').value = d.script; $('#script').dataset.meta = JSON.stringify(d);
    genStatus('Script ready — edit it if you like, then hit Generate.');
  } catch (e) { genStatus('⚠️ ' + e.message); }
};

$('#genBtn').onclick = async () => {
  const btn = $('#genBtn'); btn.disabled = true;
  try {
    const n = Math.max(1, +val('numVids') || 1);
    for (let i = 0; i < n; i++) {
      let d;
      const edited = $('#script').value.trim();
      if (i === 0 && edited) {
        let meta = {}; try { meta = JSON.parse($('#script').dataset.meta || '{}'); } catch {}
        d = { title: meta.title || val('topic') || val('niche'), caption: meta.caption || val('topic') || val('niche'), hashtags: meta.hashtags || val('hashtags'), script: edited };
      } else {
        genStatus(`Writing script ${i + 1}/${n}…`);
        d = await writeScript(val('niche'), n > 1 ? '' : val('topic'), +val('vidLen'));
      }
      await exclusive(() => makeFacelessVideo(d, genStatus));
      log(`🤖 Made faceless video: ${d.title}`);
    }
    $('#script').value = ''; delete $('#script').dataset.meta;
    genStatus(`✅ Done — ${n} video(s) added to your Review Queue.`);
  } catch (e) { genStatus('⚠️ ' + e.message); log('⚠️ Faceless: ' + e.message); }
  finally { btn.disabled = false; }
};

/* ================= ACCOUNTS / POSTING ================= */
let upProfiles = [];
const upHeaders = () => ({ Authorization: 'Apikey ' + val('upKey') });
const selectedPlatforms = () => PLATFORMS.map(([k]) => k).filter((k) => ls.get('pt_' + k, k === 'tiktok' || k === 'youtube' || k === 'instagram'));
const upProfile = () => ls.get('upProfile', 'autoclipper');

async function upFetch(path, opts = {}) {
  const r = await fetch(UP_API + path, { ...opts, headers: { ...upHeaders(), ...(opts.headers || {}) } });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { message: text }; }
  if (!r.ok || j.success === false) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  return j;
}

async function refreshAccounts(quiet) {
  const st = (t) => ($('#upStatus').textContent = t);
  if (!val('upKey')) { renderPlatforms(null); if (!quiet) st('Add your Upload-Post API key first.'); return; }
  try {
    if (!quiet) st('Checking…');
    let j = await upFetch('/uploadposts/users');
    upProfiles = j.profiles || [];
    if (!upProfiles.length) {
      await upFetch('/uploadposts/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'autoclipper', display_name: 'AutoClipper' }) });
      j = await upFetch('/uploadposts/users'); upProfiles = j.profiles || [];
    }
    if (!upProfiles.find((p) => p.username === upProfile())) ls.set('upProfile', upProfiles[0]?.username || 'autoclipper');
    st(`✅ Key works (${j.plan || 'plan'} plan). Profile: ${upProfile()}`);
    renderPlatforms(upProfiles.find((p) => p.username === upProfile()));
  } catch (e) { st('⚠️ ' + e.message); renderPlatforms(null); }
}

function connectedMap(profile) {
  const m = {};
  const sa = (profile && profile.social_accounts) || {};
  for (const [k] of PLATFORMS) { const a = sa[k]; if (a && typeof a === 'object') m[k] = a; }
  if (ytToken()) m.youtube = { display_name: 'YouTube (direct)', direct: true };
  return m;
}
let connected = {};
function renderPlatforms(profile) {
  connected = connectedMap(profile);
  $('#platformGrid').innerHTML = PLATFORMS.map(([k, name]) => {
    const a = connected[k];
    const who = a ? (a.handle || a.display_name || a.username || 'connected') : 'not connected';
    return `<div class="plat ${a ? 'on' : ''}"><b>${a ? '✅' : '⚪'} ${name}</b><span class="tagline">${escapeHtml(String(who))}${a && a.reauth_required ? ' — ⚠️ reconnect' : ''}</span></div>`;
  }).join('');
  $('#postTo').innerHTML = PLATFORMS.map(([k, name]) =>
    `<label class="check"><input type="checkbox" data-pt="${k}" ${selectedPlatforms().includes(k) ? 'checked' : ''}> ${name}${connected[k] ? '' : ' <span class="muted small">(not connected)</span>'}</label>`).join('');
  $$('#postTo input').forEach((cb) => cb.onchange = () => { ls.set('pt_' + cb.dataset.pt, cb.checked); updatePlatformSummary(); });
  updatePlatformSummary();
}
function updatePlatformSummary() {
  const ready = selectedPlatforms().filter((k) => connected[k]);
  $('#platformSummary').innerHTML = ready.length
    ? `Posting to: <b>${ready.map((k) => PLATFORMS.find((p) => p[0] === k)[1]).join(', ')}</b>`
    : '⚠️ No accounts connected yet — set them up in the <b>Accounts</b> tab.';
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const canPost = () => selectedPlatforms().some((k) => connected[k]);

$('#upSave').onclick = () => { saveAll(); refreshAccounts(); };
$('#refreshAccts').onclick = () => refreshAccounts();
$('#connectBtn').onclick = async () => {
  if (!val('upKey')) { $('#upStatus').textContent = 'Add your Upload-Post API key first (Step 1).'; return; }
  const win = window.open('about:blank', '_blank');
  try {
    if (!upProfiles.length) await refreshAccounts(true);
    const j = await upFetch('/uploadposts/users/generate-jwt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: upProfile(), redirect_url: location.origin + location.pathname + '?connected=1',
        platforms: PLATFORMS.map(([k]) => k), connect_title: 'Connect your accounts to AutoClipper',
      }),
    });
    if (win) win.location = j.access_url; else location.href = j.access_url;
    $('#upStatus').textContent = 'Finish connecting in the new tab, then hit ↻ Refresh here.';
  } catch (e) { if (win) win.close(); $('#upStatus').textContent = '⚠️ ' + e.message; }
};

/* ---- YouTube direct (Google OAuth, token lasts ~1 hour) ---- */
let tokenClient = null;
const ytToken = () => { const t = ls.get('ytTok'); return t && t.exp > Date.now() + 60000 ? t.token : null; };
function loadGis() {
  return window.google?.accounts ? Promise.resolve() : new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in')); document.head.appendChild(s);
  });
}
$('#ytConnect').onclick = async () => {
  saveAll();
  const st = (t) => ($('#ytStatus').textContent = t);
  if (!val('gClientId')) return st('Paste your Google OAuth Client ID first.');
  try {
    await loadGis();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: val('gClientId'),
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      callback: (resp) => {
        if (resp.error) return st('⚠️ ' + resp.error);
        ls.set('ytTok', { token: resp.access_token, exp: Date.now() + resp.expires_in * 1000 });
        st('✅ YouTube connected (Google makes you re-click this about once an hour while posting directly).');
        refreshAccounts(true);
      },
    });
    tokenClient.requestAccessToken();
  } catch (e) { st('⚠️ ' + e.message); }
};
async function ytUpload(clip, when) {
  const token = ytToken(); if (!token) throw new Error('YouTube login expired — click Connect YouTube again');
  const title = (clip.title || clip.caption).replace(/#\S+/g, '').trim().slice(0, 90) + ' #Shorts';
  const status = { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: clip.kind === 'faceless' };
  if (when) { status.privacyStatus = 'private'; status.publishAt = new Date(when).toISOString(); }
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': clip.blob.type, 'X-Upload-Content-Length': clip.blob.size },
    body: JSON.stringify({ snippet: { title, description: clip.caption, categoryId: '20' }, status }),
  });
  if (!init.ok) throw new Error('YouTube: ' + (await init.text()).slice(0, 200));
  const loc = init.headers.get('Location');
  const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': clip.blob.type }, body: clip.blob });
  const j = await up.json();
  if (!up.ok) throw new Error('YouTube: ' + (j.error?.message || up.status));
  return 'https://youtube.com/shorts/' + j.id;
}

async function upUpload(clip, platforms, when) {
  const fd = new FormData();
  const ext = clip.blob.type.includes('mp4') ? 'mp4' : 'webm';
  fd.append('user', upProfile());
  platforms.forEach((p) => fd.append('platform[]', p));
  fd.append('title', clip.caption.slice(0, 2000));
  fd.append('video', new File([clip.blob], `autoclipper_${clip.id}.${ext}`, { type: clip.blob.type }));
  fd.append('youtube_title', ((clip.title || clip.caption).replace(/#\S+/g, '').trim().slice(0, 90) + ' #Shorts'));
  fd.append('youtube_description', clip.caption);
  fd.append('privacyStatus', 'public');
  fd.append('privacy_level', val('tiktokPrivacy') || 'PUBLIC_TO_EVERYONE');
  fd.append('async_upload', 'true');
  fd.append('external_id', clip.id);
  if (clip.kind === 'faceless') { fd.append('tiktok_is_ai_generated', 'true'); fd.append('is_ai_generated', 'true'); fd.append('containsSyntheticMedia', 'true'); }
  if (when) { fd.append('scheduled_date', new Date(when).toISOString()); fd.append('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone); }
  return upFetch('/upload', { method: 'POST', body: fd });
}

// Next free posting slot inside the posting window, N per day
function nextSlot() {
  const per = Math.max(1, +val('apPostsPerDay') || 3);
  const [sh, sm] = (val('apStart') || '11:00').split(':').map(Number);
  const [eh, em] = (val('apEnd') || '21:00').split(':').map(Number);
  const winMin = Math.max(30, (eh * 60 + em) - (sh * 60 + sm));
  const step = winMin / per;
  const after = Math.max(Date.now() + 10 * 60000, ls.get('lastSlot', 0) + 60000);
  for (let day = 0; day < 400; day++) {
    for (let i = 0; i < per; i++) {
      const d = new Date(); d.setDate(d.getDate() + day);
      d.setHours(sh, sm + Math.round(step * i + step * 0.15), 0, 0);
      if (d.getTime() >= after) { ls.set('lastSlot', d.getTime()); return d.getTime(); }
    }
  }
  return Date.now() + 15 * 60000;
}

async function postClip(clip, { schedule } = {}) {
  const platforms = selectedPlatforms().filter((k) => connected[k]);
  if (!platforms.length) throw new Error('No connected accounts selected (Accounts tab)');
  const when = schedule ? nextSlot() : null;
  const ytDirect = platforms.includes('youtube') && connected.youtube?.direct && ytToken();
  const viaUp = platforms.filter((p) => !(p === 'youtube' && ytDirect));
  const results = [];
  if (viaUp.length) {
    const j = await upUpload(clip, viaUp, when);
    results.push(`Upload-Post (${viaUp.join(', ')}): ${j.request_id || j.job_id || 'sent'}`);
    clip.requestId = j.request_id || null; clip.jobId = j.job_id || null;
  }
  if (ytDirect) results.push('YouTube: ' + await ytUpload(clip, when));
  clip.status = 'scheduled';
  clip.scheduledFor = when || Date.now();
  clip.postResult = results.join('\n');
  clip.error = null;
  await putClip(clip);
  log(`📤 ${when ? 'Scheduled' : 'Posted'} "${clip.title}" → ${platforms.join(', ')}${when ? ' for ' + new Date(when).toLocaleString() : ''}`);
}

async function approveClip(clip, { auto = false } = {}) {
  clip.status = 'approved'; await putClip(clip);
  if (canPost() && (!auto || val('apAutoPost'))) {
    try { await postClip(clip, { schedule: val('apAutoPost') }); }
    catch (e) { clip.status = 'failed'; clip.error = e.message; await putClip(clip); log('⚠️ Post failed: ' + e.message); }
    return true;
  }
  return false;
}

// Called whenever a new video is created
async function onNewVideo(clip) {
  await updateCount();
  if (!(apOn() && val('apAutoApprove'))) return;
  const min = +val('apMinScore') || 0;
  if (clip.score != null && clip.score < min) { log(`🟡 Left "${clip.title}" for review (hype score ${clip.score})`); return; }
  await approveClip(clip, { auto: true });
  log(`✅ Auto-approved "${clip.title}"${clip.score != null ? ` (score ${clip.score})` : ''}`);
  await updateCount();
}

// Check on Upload-Post jobs
async function pollStatuses() {
  if (!val('upKey')) return;
  const items = (await allClips()).filter((c) => c.status === 'scheduled' && (c.requestId || c.jobId) && !c.final);
  for (const c of items) {
    if (c.scheduledFor > Date.now()) continue; // not due yet
    try {
      const q = c.requestId ? 'request_id=' + encodeURIComponent(c.requestId) : 'job_id=' + encodeURIComponent(c.jobId);
      const r = await fetch(`${UP_API}/uploadposts/status?${q}`, { headers: upHeaders() });
      const j = await r.json();
      const s = JSON.stringify(j).toLowerCase();
      if (/"status":"(completed|success|published|done)"/.test(s)) { c.status = 'posted'; c.final = true; log(`🎉 Live: "${c.title}"`); }
      else if (/"status":"(failed|error)"/.test(s)) { c.status = 'failed'; c.error = (j.message || j.error || 'Upload-Post reported a failure').toString().slice(0, 200); c.final = true; log(`⚠️ Upload failed: "${c.title}" — ${c.error}`); }
      await putClip(c);
    } catch {}
  }
}

/* ================= REVIEW QUEUE ================= */
let filter = 'pending', urls = [];
$$('.filter').forEach((b) => b.onclick = () => {
  filter = b.dataset.filter;
  $$('.filter').forEach((x) => x.classList.toggle('active', x === b));
  renderQueue();
});
async function updateCount() {
  const all = await allClips();
  $('#qcount').textContent = all.filter((c) => c.status === 'pending').length;
}
function statusText(c) {
  if (c.status === 'scheduled') return c.scheduledFor > Date.now() ? `⏰ Scheduled ${new Date(c.scheduledFor).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '📤 Sent';
  if (c.status === 'posted') return '🎉 Posted';
  if (c.status === 'failed') return '⚠️ ' + (c.error || 'Failed');
  if (c.score != null) return `🔥 Hype ${c.score}/10`;
  return '';
}
async function renderQueue() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const list = $('#queueList');
  const match = (c) => filter === 'scheduled' ? ['scheduled', 'posted'].includes(c.status) : c.status === filter;
  const items = (await allClips()).filter(match).sort((a, b) => b.created - a.created);
  list.innerHTML = items.length ? '' : `<div class="empty">No ${filter} videos.</div>`;
  for (const c of items) {
    const url = URL.createObjectURL(c.blob); urls.push(url);
    const el = document.createElement('div'); el.className = 'item';
    const btns = {
      pending: `<button class="ok" data-a="approve">✓ ${canPost() ? (val('apAutoPost') ? 'Approve & schedule' : 'Approve & post') : 'Approve'}</button><button class="no" data-a="reject">✕</button>`,
      approved: `${canPost() ? '<button class="ok" data-a="post">📤 Post</button>' : ''}<button data-a="download">⬇</button><button class="no" data-a="reject">✕</button>`,
      failed: `<button class="ok" data-a="post">↻ Retry</button><button data-a="download">⬇</button><button class="no" data-a="reject">✕</button>`,
      scheduled: `<button data-a="download">⬇ Download</button>`,
      posted: `<button data-a="download">⬇ Download</button><button data-a="delete">🗑</button>`,
      rejected: `<button data-a="restore">↩ Restore</button><button data-a="delete">🗑 Delete</button>`,
    }[c.status] || '';
    el.innerHTML = `
      <video src="${url}" controls playsinline preload="metadata"></video>
      <div class="body">
        <strong class="small"></strong>
        <span class="st"></span>
        <textarea rows="3"></textarea>
        <div class="row">${btns}</div>
      </div>`;
    el.querySelector('strong').textContent = (c.kind === 'clip' ? '🎮 ' : '🤖 ') + c.title;
    const st = el.querySelector('.st'); st.textContent = statusText(c); if (!st.textContent) st.remove();
    const ta = el.querySelector('textarea'); ta.value = c.caption || '';
    ta.onchange = async () => { const fresh = await getClip(c.id); fresh.caption = ta.value; await putClip(fresh); };
    el.querySelectorAll('button').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      const fresh = await getClip(c.id); fresh.caption = ta.value;
      const a = b.dataset.a;
      try {
        if (a === 'approve') {
          const posted = await approveClip(fresh);
          if (!posted) { download(fresh, url); copy(ta.value); toast('Approved ✓ Downloaded & caption copied. Connect accounts to auto-post.'); }
        } else if (a === 'post') {
          try { await postClip(fresh, { schedule: val('apAutoPost') }); }
          catch (e) { fresh.status = 'failed'; fresh.error = e.message; await putClip(fresh); }
        } else if (a === 'download') { download(fresh, url); copy(ta.value); toast('Downloaded ✓ Caption copied.'); }
        else if (a === 'reject') { fresh.status = 'rejected'; await putClip(fresh); }
        else if (a === 'restore') { fresh.status = 'pending'; await putClip(fresh); }
        else if (a === 'delete') await delClip(fresh.id);
      } finally { await updateCount(); renderQueue(); }
    });
    list.appendChild(el);
  }
}
$('#approveAll').onclick = async () => {
  const pend = (await allClips()).filter((c) => c.status === 'pending');
  for (const c of pend) await approveClip(c);
  if (!canPost() && pend.length) toast('Approved. Connect accounts in the Accounts tab to post them automatically.');
  await updateCount(); renderQueue();
};
function download(c, url) {
  const ext = c.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = url; a.download = `${(c.title || 'clip').replace(/[^\w-]+/g, '_').slice(0, 50)}.${ext}`;
  a.click();
}
function copy(t) { try { navigator.clipboard.writeText(t); } catch {} }
function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  Object.assign(d.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: '#30a46c', color: '#fff', padding: '10px 16px', borderRadius: '10px', zIndex: 99, maxWidth: '90vw' });
  document.body.appendChild(d); setTimeout(() => d.remove(), 3500);
}

/* ================= AUTOPILOT ================= */
const apOn = () => val('apOn');
let folderHandle = null, apTimer = null, wakeLock = null, apTickRunning = false;

async function pickFolder() {
  if (!window.showDirectoryPicker) { alert('Folder watching needs Chrome or Edge on a computer.'); return; }
  try {
    folderHandle = await window.showDirectoryPicker({ mode: 'read' });
    await kvSet('folder', folderHandle);
    $('#folderName').textContent = '📂 Watching: ' + folderHandle.name;
    // mark existing files as already done so only NEW videos get clipped
    const seen = ls.get('seenFiles', {});
    for await (const [name, h] of folderHandle.entries()) if (h.kind === 'file') { const f = await h.getFile(); seen[`${name}|${f.size}|${f.lastModified}`] = 1; }
    ls.set('seenFiles', seen);
    log(`📂 Watching folder "${folderHandle.name}" — new videos will be clipped automatically`);
  } catch {}
}
$('#pickFolder').onclick = pickFolder;

async function folderReady() {
  if (!folderHandle) return false;
  try { return (await folderHandle.queryPermission({ mode: 'read' })) === 'granted'; } catch { return false; }
}

async function apTick() {
  if (!apOn() || apTickRunning) return;
  apTickRunning = true;
  try {
    await pollStatuses();
    if (busy) return;
    // 1) new VODs in the watched folder
    if (await folderReady()) {
      const seen = ls.get('seenFiles', {});
      for await (const [name, h] of folderHandle.entries()) {
        if (h.kind !== 'file' || !/\.(mp4|mov|webm|m4v)$/i.test(name)) continue;
        const f = await h.getFile();
        const key = `${name}|${f.size}|${f.lastModified}`;
        if (seen[key] || Date.now() - f.lastModified < 90000) continue; // skip done / still being written
        seen[key] = 1; ls.set('seenFiles', seen);
        log(`🎞️ New VOD found: ${name} — clipping…`);
        try {
          const made = await exclusive(() => clipVideoFile(f, (t) => ($('#apSummary').textContent = 'Working: ' + t)));
          log(`✂️ Made ${made.length} clips from ${name}`);
        } catch (e) { log(`⚠️ ${name}: ${e.message}`); }
        return; // one job per tick
      }
    }
    // 2) daily faceless videos
    const per = +val('apFacelessPerDay') || 0;
    const today = new Date().toDateString();
    const done = ls.get('facelessDay', {});
    const count = done.date === today ? done.n : 0;
    if (count < per) {
      const st = (t) => ($('#apSummary').textContent = 'Working: ' + t);
      try {
        st('writing a faceless script…');
        const d = await writeScript(val('apNiche'), '', +val('vidLen') || 45);
        await exclusive(() => makeFacelessVideo(d, st));
        ls.set('facelessDay', { date: today, n: count + 1 });
        log(`🤖 Autopilot made faceless video ${count + 1}/${per}: ${d.title}`);
      } catch (e) { log('⚠️ Faceless: ' + e.message); ls.set('facelessDay', { date: today, n: count + 1 }); }
    }
  } finally {
    apTickRunning = false;
    updateApSummary();
  }
}

function updateApSummary() {
  const on = apOn();
  $('#apBadge').textContent = on ? 'Autopilot ON' : 'Autopilot OFF';
  $('#apBadge').className = 'badge ' + (on ? 'on' : 'off');
  document.body.classList.toggle('ap-on', on); // wakes up the robot workshop
  if (busy && on) return;
  $('#apSummary').textContent = on
    ? `On — checking every minute. Keep this tab open (it's fine in the background).${folderHandle ? '' : ' Tip: choose a folder to auto-clip VODs.'}`
    : 'Off';
}

async function startAutopilot() {
  try { await getAudioCtx().resume(); } catch {}
  if (folderHandle) { try { await folderHandle.requestPermission({ mode: 'read' }); } catch {} }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  clearInterval(apTimer);
  apTimer = setInterval(apTick, 60000);
  setTimeout(apTick, 1500);
  updateApSummary();
}
function stopAutopilot() { clearInterval(apTimer); try { wakeLock?.release(); } catch {} updateApSummary(); }
$('#apOn').onchange = () => {
  saveAll();
  if (apOn()) { log('🚀 Autopilot turned ON'); startAutopilot(); } else { log('⏸ Autopilot turned OFF'); stopAutopilot(); }
};
document.addEventListener('visibilitychange', async () => {
  if (apOn() && document.visibilityState === 'visible') { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
});

/* ================= SETTINGS / INIT ================= */
const AP_IDS = ['apOn', 'apFacelessPerDay', 'apNiche', 'apAutoApprove', 'apMinScore', 'apAutoPost', 'apPostsPerDay', 'apStart', 'apEnd'];
const saveIds = () => [...$$('[data-save]').map((e) => e.id), ...AP_IDS];
function loadAll() {
  for (const id of saveIds()) {
    const v = ls.get('f_' + id); const el = document.getElementById(id);
    if (v === null || !el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
}
function saveAll() {
  for (const id of saveIds()) { const el = document.getElementById(id); ls.set('f_' + id, el.type === 'checkbox' ? el.checked : el.value); }
}
document.addEventListener('change', (e) => { if (e.target.id && saveIds().includes(e.target.id)) { saveAll(); if (e.target.id.startsWith('ap')) updateApSummary(); } });

$$('nav button').forEach((b) => b.onclick = () => {
  $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
  if (b.dataset.tab === 'queue') renderQueue();
});
const openTab = (id) => $(`nav button[data-tab="${id}"]`).click();

$('#testKey').onclick = async () => {
  saveAll();
  const st = (t) => ($('#setStatus').textContent = t);
  if (!val('apiKey')) return st('Paste a key first.');
  st('Testing…');
  try { await chat('Reply with just: OK'); st('✅ OpenAI key works.'); } catch (e) { st('⚠️ ' + e.message); }
};
$('#clearDone').onclick = async () => {
  const old = (await allClips()).filter((c) => ['posted', 'rejected'].includes(c.status) || (c.status === 'scheduled' && c.scheduledFor < Date.now() - 86400000));
  if (!confirm(`Delete ${old.length} posted/rejected videos from this browser? (Already-posted videos stay on your socials.)`)) return;
  for (const c of old) await delClip(c.id);
  $('#setStatus').textContent = `🧹 Deleted ${old.length} videos.`;
  updateCount();
};

(async function init() {
  loadAll();
  renderLog();
  $('#originHint').textContent = location.origin;
  try { bgFiles = ((await idb('bg', 'readonly', (s) => s.getAll())) || []).map((r) => r.file); } catch {}
  if (bgFiles.length) $('#bgDrop span').textContent = `🎮 ${bgFiles.length} background video(s) saved`;
  try { folderHandle = (await kvGet('folder')) || null; } catch {}
  if (folderHandle) $('#folderName').textContent = '📂 Watching: ' + folderHandle.name;
  renderPlatforms(null);
  await refreshAccounts(true);
  await updateCount();
  updateApSummary();
  if (new URLSearchParams(location.search).has('connected')) {
    history.replaceState(null, '', location.pathname);
    openTab('accounts');
    toast('Accounts updated ✓');
  }
  if (!pickMime()) alert('This browser can\'t record video. Use Chrome or Edge on a computer.');
  if (apOn()) {
    // browsers need one click before audio/folder access can resume
    $('#apSummary').textContent = '⏯ Click anywhere on the page to resume Autopilot';
    document.addEventListener('pointerdown', () => startAutopilot(), { once: true });
  }
})();
