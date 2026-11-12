/* AutoClipper — runs fully in the browser (GitHub Pages friendly). */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const W = 1080, H = 1920, FPS = 30;
const canvas = $('#renderCanvas');
const ctx = canvas.getContext('2d');
let audioCtx = null;
const getAudioCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Settings ---------------- */
const SETTINGS_KEYS = ['apiKey', 'voice', 'capColor', 'hashtags'];
function loadSettings() {
  SETTINGS_KEYS.forEach((k) => {
    try { const v = localStorage.getItem('ac_' + k); if (v !== null) $('#' + k).value = v; } catch {}
  });
}
function saveSettings() {
  SETTINGS_KEYS.forEach((k) => { try { localStorage.setItem('ac_' + k, $('#' + k).value); } catch {} });
  $('#savedMsg').textContent = 'Saved ✓';
  setTimeout(() => ($('#savedMsg').textContent = ''), 2000);
}
const S = (k) => $('#' + k).value.trim();

/* ---------------- Tabs ---------------- */
$$('nav button').forEach((b) => b.onclick = () => {
  $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
  if (b.dataset.tab === 'queue') renderQueue();
});

/* ---------------- Storage (IndexedDB) ---------------- */
let dbP = null;
function db() {
  return dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('autoclipper', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('clips', mode);
    const req = fn(tx.objectStore('clips'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const putClip = (c) => store('readwrite', (s) => s.put(c));
const allClips = () => store('readonly', (s) => s.getAll());
const delClip = (id) => store('readwrite', (s) => s.delete(id));

/* ---------------- Recording helpers ---------------- */
function pickMime() {
  const opts = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRecorder(audioStream) {
  const stream = canvas.captureStream(FPS);
  if (audioStream) audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = () => r(new Blob(chunks, { type: (mimeType || 'video/webm').split(';')[0] }))));
  rec.start(500);
  return { stop: () => { rec.stop(); return done; } };
}

function coverRect(sw, sh, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  return [(dw - sw * s) / 2, (dh - sh * s) / 2, sw * s, sh * s];
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
  ctx.fillStyle = color || S('capColor') || '#ffd400';
  const lines = wrapText(text.toUpperCase(), W - 140);
  lines.forEach((l, i) => {
    const ly = y + (i - (lines.length - 1) / 2) * size * 1.12;
    ctx.strokeText(l, W / 2, ly); ctx.fillText(l, W / 2, ly);
  });
  ctx.restore();
}

/* ================= STREAM CLIPPER ================= */
const vod = $('#vodVideo');
let vodFile = null, mediaSrc = null, mediaDest = null;

function setupDrop(dropEl, inputEl, onFiles) {
  inputEl.onchange = () => inputEl.files.length && onFiles([...inputEl.files]);
  dropEl.ondragover = (e) => { e.preventDefault(); dropEl.classList.add('over'); };
  dropEl.ondragleave = () => dropEl.classList.remove('over');
  dropEl.ondrop = (e) => { e.preventDefault(); dropEl.classList.remove('over'); onFiles([...e.dataTransfer.files]); };
}

setupDrop($('#vodDrop'), $('#vodFile'), (files) => {
  vodFile = files[0];
  vod.src = URL.createObjectURL(vodFile);
  $('#vodDrop span').textContent = '🎞️ ' + vodFile.name + ' (' + (vodFile.size / 1e6).toFixed(0) + ' MB)';
  $('#scanBtn').disabled = false;
});

const clipStatus = (t) => ($('#clipStatus').textContent = t);

async function findHighlights(buffer, count, len) {
  const sr = buffer.sampleRate, win = Math.floor(sr * 0.5);
  const data = buffer.getChannelData(0);
  const data2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = Math.floor(data.length / win);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * win; j < (i + 1) * win; j += 4) {
      const v = data2 ? (data[j] + data2[j]) / 2 : data[j];
      sum += v * v;
    }
    energy[i] = Math.sqrt(sum / (win / 4));
  }
  // Score = loudness over ~3s, compared to the surrounding 60s (so a spike stands out from its baseline)
  const score = new Float32Array(n);
  const local = 6, ctxWin = 120;
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0, ca = 0, cb = 0;
    for (let k = i - local; k <= i + local; k++) if (k >= 0 && k < n) { a += energy[k]; ca++; }
    for (let k = i - ctxWin; k <= i + ctxWin; k += 4) if (k >= 0 && k < n) { b += energy[k]; cb++; }
    score[i] = (a / ca) / ((b / cb) + 1e-4);
  }
  const order = [...score.keys()].sort((x, y) => score[y] - score[x]);
  const picks = [];
  const gap = len / 0.5;
  for (const i of order) {
    if (picks.length >= count) break;
    if (picks.every((p) => Math.abs(p - i) > gap)) picks.push(i);
  }
  drawWave(energy, picks);
  return picks.map((i) => {
    const peak = i * 0.5;
    const start = Math.max(0, Math.min(buffer.duration - len, peak - len * 0.6));
    return { start, peak, score: score[i] };
  }).sort((a, b) => a.start - b.start);
}

function drawWave(energy, picks) {
  const c = $('#waveform'); c.style.display = 'block';
  c.width = c.clientWidth * devicePixelRatio; c.height = 80 * devicePixelRatio;
  const g = c.getContext('2d'); const max = Math.max(...energy) || 1;
  g.fillStyle = '#4b5263';
  for (let x = 0; x < c.width; x++) {
    const v = energy[Math.floor((x / c.width) * energy.length)] / max;
    g.fillRect(x, c.height - v * c.height, 1, v * c.height);
  }
  g.fillStyle = '#ffd400';
  picks.forEach((i) => g.fillRect((i / energy.length) * c.width - 1, 0, 3, c.height));
}

function drawVodFrame(layout, tag) {
  const vw = vod.videoWidth, vh = vod.videoHeight;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (layout === 'crop') {
    ctx.drawImage(vod, ...coverRect(vw, vh, W, H));
  } else if (layout === 'split') {
    // top: facecam (assumed top-left third of the stream), bottom: centered gameplay
    const fw = vw * 0.33, fh = vh * 0.33;
    ctx.drawImage(vod, 0, 0, fw, fh, ...coverRect(fw, fh, W, H * 0.4).map((v, k) => v));
    ctx.save(); ctx.beginPath(); ctx.rect(0, H * 0.4, W, H * 0.6); ctx.clip();
    const [x, y, w, h] = coverRect(vw, vh, W, H * 0.6);
    ctx.drawImage(vod, x, y + H * 0.4, w, h); ctx.restore();
  } else {
    ctx.save(); ctx.filter = 'blur(28px) brightness(0.55)';
    ctx.drawImage(vod, ...coverRect(vw, vh, W, H)); ctx.restore();
    ctx.drawImage(vod, ...containRect(vw, vh, W, H));
  }
  if (tag) drawCaption(tag, 240, 70, '#fff');
}

async function recordVodSegment(start, len, layout, tag) {
  const ac = getAudioCtx(); await ac.resume();
  if (!mediaSrc) {
    mediaSrc = ac.createMediaElementSource(vod);
    mediaDest = ac.createMediaStreamDestination();
    mediaSrc.connect(mediaDest);
  }
  vod.muted = false;
  vod.currentTime = start;
  await new Promise((r) => (vod.onseeked = r));
  const rec = startRecorder(mediaDest.stream);
  await vod.play();
  await new Promise((resolve) => {
    const tick = () => {
      drawVodFrame(layout, tag);
      if (vod.currentTime >= start + len || vod.ended) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
  vod.pause();
  return rec.stop();
}

async function aiClipCaption(blob, fallback) {
  const key = S('apiKey');
  if (!key || blob.size > 24e6) return fallback;
  try {
    const fd = new FormData();
    fd.append('file', blob, 'clip.' + (blob.type.includes('mp4') ? 'mp4' : 'webm'));
    fd.append('model', 'whisper-1');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
    }).then((r) => r.json());
    if (!tr.text) return fallback;
    const out = await chat(`Here is the transcript of a short stream clip:\n"""${tr.text}"""\nWrite a punchy TikTok caption (max 120 chars, 1 emoji ok) followed by 5 relevant hashtags. Return only the caption line.`);
    return out || fallback;
  } catch { return fallback; }
}

$('#scanBtn').onclick = async () => {
  const btn = $('#scanBtn'); btn.disabled = true;
  try {
    const count = +$('#numClips').value || 5, len = +$('#clipLen').value || 30;
    const layout = $('#layout').value, tag = S('clipTag');
    clipStatus('Reading audio… (big files can take a minute)');
    let buffer;
    try {
      buffer = await getAudioCtx().decodeAudioData(await vodFile.arrayBuffer());
    } catch {
      throw new Error('Could not read this file\'s audio. Try an MP4 under ~2 GB (or trim the VOD into parts).');
    }
    if (!vod.videoWidth) await new Promise((r) => (vod.onloadedmetadata = r));
    clipStatus('Finding hype moments…');
    const hl = await findHighlights(buffer, count, len);
    for (let i = 0; i < hl.length; i++) {
      const h = hl[i];
      clipStatus(`Rendering clip ${i + 1}/${hl.length} at ${fmt(h.start)} (real-time — keep this tab open & visible)…`);
      const blob = await recordVodSegment(h.start, len, layout, tag);
      clipStatus(`Writing caption for clip ${i + 1}…`);
      const fallback = `Wait for it… 😳 ${S('hashtags')}`;
      const caption = await aiClipCaption(blob, fallback);
      await putClip({ id: Date.now() + '_' + i, kind: 'clip', title: `${vodFile.name} @ ${fmt(h.start)}`, blob, caption, status: 'pending', created: Date.now() });
      updateCount();
    }
    clipStatus(`✅ Done — ${hl.length} clips are in your Review Queue.`);
  } catch (e) {
    clipStatus('⚠️ ' + e.message);
  } finally { btn.disabled = false; }
};
const fmt = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ================= FACELESS GENERATOR ================= */
let bgFiles = [];
setupDrop($('#bgDrop'), $('#bgFile'), (files) => {
  bgFiles = files;
  $('#bgDrop span').textContent = `🎮 ${files.length} background video(s) loaded`;
});
const genStatus = (t) => ($('#genStatus').textContent = t);

async function chat(prompt, json = false) {
  const key = S('apiKey'); if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  }).then((r) => r.json());
  if (r.error) throw new Error('OpenAI: ' + r.error.message);
  return r.choices[0].message.content.trim();
}

const TEMPLATES = {
  'GTA 6 facts & secrets': ['GTA 6 is set in Leonida, a fictional take on Florida, and Vice City is back for the first time since 2006.', 'For the first time in the main series, you play as a female lead, Lucia, alongside Jason.', 'The first trailer broke YouTube records, pulling over ninety million views in its first day.'],
  'Gaming news': ['The biggest games this year are pushing budgets past three hundred million dollars.', 'Handheld PCs are now outselling some home consoles in certain months.'],
  'Crazy history facts': ['Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.', 'Oxford University is older than the Aztec Empire.'],
  Motivation: ['Nobody is coming to save you. That is the best news you will ever hear, because it means you are in control.'],
  'Scary stories': ['At 3 a.m. my phone buzzed. A text from my own number said: do not look at the window.'],
  'Sports facts': ['A golf ball has around three hundred to five hundred dimples, and they help it fly up to twice as far.'],
  'Money tips': ['If you save just ten dollars a day, that is over three thousand six hundred dollars a year.'],
};

async function writeScript(niche, topic, secs) {
  const words = Math.round(secs * 2.6);
  const ai = await chat(
    `Write a viral faceless short-form video script for the niche "${niche}"${topic ? ` about: ${topic}` : ' (pick a fresh, specific topic)'}.\n` +
    `About ${words} words. Start with a scroll-stopping hook in the first sentence. No scene directions, no emojis, just the spoken words. End with a short call to follow.\n` +
    `Return JSON: {"title": string, "script": string, "caption": string (TikTok caption, max 120 chars), "hashtags": string (5 hashtags)}`, true);
  if (ai) return JSON.parse(ai);
  const lines = TEMPLATES[niche] || TEMPLATES['Gaming news'];
  const pick = lines[Math.floor(Math.random() * lines.length)];
  return { title: topic || niche, script: `${topic ? topic + '. ' : 'You probably did not know this. '}${pick} Follow for more.`, caption: `${topic || niche} 🤯`, hashtags: S('hashtags') };
}

async function tts(text) {
  const key = S('apiKey'); if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'tts-1', voice: S('voice') || 'onyx', input: text }),
  });
  if (!r.ok) throw new Error('Voiceover failed: ' + (await r.text()).slice(0, 150));
  return getAudioCtx().decodeAudioData(await r.arrayBuffer());
}

function chunkScript(text, total) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += 3) chunks.push(words.slice(i, i + 3).join(' '));
  const lens = chunks.map((c) => c.length + 4);
  const sum = lens.reduce((a, b) => a + b, 0);
  let t = 0;
  return chunks.map((c, i) => { const s = t; t += (lens[i] / sum) * total; return { text: c, start: s, end: t }; });
}

async function loadBgVideo() {
  if (!bgFiles.length) return null;
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true;
  v.src = URL.createObjectURL(bgFiles[Math.floor(Math.random() * bgFiles.length)]);
  await new Promise((r) => (v.onloadedmetadata = r));
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
    const r = 80 + i * 18;
    ctx.beginPath();
    ctx.arc((W / 2) + Math.sin(t * 0.6 + i) * 300, (H / 2) + Math.cos(t * 0.4 + i * 2) * 600, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function renderFaceless(data) {
  const ac = getAudioCtx(); await ac.resume();
  genStatus('Voicing script…');
  const audio = await tts(data.script);
  const dur = audio ? audio.duration + 0.4 : Math.max(8, data.script.split(/\s+/).length / 2.6);
  const chunks = chunkScript(data.script, audio ? audio.duration : dur);
  const bg = await loadBgVideo();
  if (bg) await bg.play();

  let dest = null;
  if (audio) {
    dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource(); src.buffer = audio; src.connect(dest);
    src.start(ac.currentTime + 0.05);
  }
  const rec = startRecorder(dest && dest.stream);
  genStatus(`Rendering "${data.title}" (${Math.round(dur)}s, real-time — keep this tab visible)…`);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      if (bg && bg.videoWidth) {
        ctx.drawImage(bg, ...coverRect(bg.videoWidth, bg.videoHeight, W, H));
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
      } else drawAnimatedBg(t);
      const c = chunks.find((c) => t >= c.start && t < c.end);
      if (c) {
        const pop = Math.min(1, (t - c.start) / 0.12);
        drawCaption(c.text, H * 0.5, 100 + 12 * (1 - pop));
      }
      if (t >= dur) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
  if (bg) { bg.pause(); URL.revokeObjectURL(bg.src); }
  return rec.stop();
}

$('#writeBtn').onclick = async () => {
  try {
    genStatus(S('apiKey') ? 'Writing script with AI…' : 'No API key — using a built-in template…');
    const d = await writeScript($('#niche').value, S('topic'), +$('#vidLen').value);
    $('#script').value = d.script; $('#script').dataset.meta = JSON.stringify(d);
    genStatus('Script ready — edit it if you like, then hit Generate.');
  } catch (e) { genStatus('⚠️ ' + e.message); }
};

$('#genBtn').onclick = async () => {
  const btn = $('#genBtn'); btn.disabled = true;
  try {
    const n = Math.max(1, +$('#numVids').value || 1);
    for (let i = 0; i < n; i++) {
      let d;
      const edited = $('#script').value.trim();
      if (i === 0 && edited) {
        let meta = {}; try { meta = JSON.parse($('#script').dataset.meta || '{}'); } catch {}
        d = { title: meta.title || S('topic') || $('#niche').value, caption: meta.caption || S('topic') || $('#niche').value, hashtags: meta.hashtags || S('hashtags'), script: edited };
      } else {
        genStatus(`Writing script ${i + 1}/${n}…`);
        d = await writeScript($('#niche').value, n > 1 ? '' : S('topic'), +$('#vidLen').value);
      }
      const blob = await renderFaceless(d);
      await putClip({ id: Date.now() + '_f' + i, kind: 'faceless', title: d.title, blob, caption: `${d.caption} ${d.hashtags || S('hashtags')}`.trim(), status: 'pending', created: Date.now() });
      updateCount();
    }
    $('#script').value = ''; delete $('#script').dataset.meta;
    genStatus(`✅ Done — ${n} video(s) added to your Review Queue.`);
  } catch (e) { genStatus('⚠️ ' + e.message); }
  finally { btn.disabled = false; }
};

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

async function renderQueue() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const list = $('#queueList');
  const items = (await allClips()).filter((c) => c.status === filter).sort((a, b) => b.created - a.created);
  list.innerHTML = items.length ? '' : `<div class="empty">No ${filter} clips yet.</div>`;
  for (const c of items) {
    const url = URL.createObjectURL(c.blob); urls.push(url);
    const el = document.createElement('div'); el.className = 'item';
    el.innerHTML = `
      <video src="${url}" controls playsinline preload="metadata"></video>
      <div class="body">
        <strong class="small"></strong>
        <textarea rows="3"></textarea>
        <div class="row">
          ${c.status !== 'approved' ? '<button class="ok" data-a="approve">✓ Approve</button>' : '<button data-a="download">⬇ Download</button>'}
          ${c.status !== 'rejected' ? '<button class="no" data-a="reject">✕</button>' : '<button data-a="delete">🗑 Delete</button>'}
        </div>
      </div>`;
    el.querySelector('strong').textContent = (c.kind === 'clip' ? '🎮 ' : '🤖 ') + c.title;
    const ta = el.querySelector('textarea'); ta.value = c.caption || '';
    ta.onchange = () => { c.caption = ta.value; putClip(c); };
    el.querySelectorAll('button').forEach((b) => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'approve' || a === 'download') {
        download(c, url);
        try { await navigator.clipboard.writeText(ta.value); } catch {}
        if (a === 'approve') { c.status = 'approved'; await putClip(c); }
        alert('Downloaded ✓ Caption copied to clipboard — paste it when you upload to TikTok / Shorts / Reels.');
      } else if (a === 'reject') { c.status = 'rejected'; await putClip(c); }
      else if (a === 'delete') await delClip(c.id);
      await updateCount(); renderQueue();
    });
    list.appendChild(el);
  }
}

function download(c, url) {
  const ext = c.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = url; a.download = `${c.title.replace(/[^\w-]+/g, '_').slice(0, 50)}.${ext}`;
  a.click();
}

/* ---------------- Init ---------------- */
$('#saveSettings').onclick = saveSettings;
loadSettings();
updateCount();
if (!pickMime()) alert('This browser can\'t record video. Use Chrome or Edge on a computer.');
