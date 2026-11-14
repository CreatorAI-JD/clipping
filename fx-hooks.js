/* AutoClipper — retention hooks + brand tag.
   - "Hook" layout: the clip on top, a satisfying / ASMR filler loop underneath (split screen).
   - Filler comes from two copyright-safe places only:
       1. loops generated right here in the browser (original drawings, nothing downloaded), and
       2. your Hook library: clips you recorded yourself, or free-licensed stock (Pexels / Pixabay / CC0),
          each saved with its license record. Nothing from TikTok/YouTube/other creators is accepted.
   - Brand tag: your channel name drawn in the middle of the frame (on the split line in the hook layout).
   - Copyright + Monetization robots are extended to check the filler's license and the
     reused-content risk that low-effort split-screen videos carry.
   - Niche presets so the clip line works for any game or stream niche, not just one. */
'use strict';
(function (FX) {
  const HK = (FX.hooks = {});
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const TAU = Math.PI * 2;

  /* ---------------- settings ---------------- */
  const DEF = {
    apply: 'always', // always = every clip gets the split-screen hook; layout = only when the Channel layout is "Split-screen hook"; off
    pick: 'rotate', // rotate = auto-pick a different filler each clip; fixed = always use `fixed`
    fixed: 'gen:ramp',
    off: [], // filler ids switched off
    split: 0.5, // fraction of the height the clip gets (top part)
    brandTag: 'Nuggiez Clips',
    tagPos: 'middle', // middle (on the split line / centre of frame), top, bottom, off
    tagColor: '#ffd400',
  };
  HK.cfg = () => ({ ...DEF, ...ls.get('fx_hooks', {}) });
  HK.save = (c) => ls.set('fx_hooks', c);

  // licenses a hook filler may carry: your own recording, or stock that allows commercial use with edits
  HK.LICENSES = ['Owned by me (confirmed)', 'CC0', 'Pexels License', 'Pixabay Content License'];
  HK.CATS = { satisfying: 'Satisfying', asmr: 'ASMR', driving: 'Driving / stunts', gameplay: 'My own gameplay' };

  /* ---------------- generated loops (original, made in the browser) ---------------- */
  // Each draws into the box (x, y, w, h) at time t (seconds). Designed on a 1080 x 960 board and scaled.
  const rnd = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  function board(g, x, y, w, h, fn) {
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    const s = Math.max(w / 1080, h / 960); g.translate(x + (w - 1080 * s) / 2, y + (h - 960 * s) / 2); g.scale(s, s);
    fn(); g.restore();
  }
  const rr = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };

  const GEN = {
    'gen:ramp': {
      name: 'Ramp car stunts', cat: 'driving', desc: 'A cartoon sports car flying off mega ramps over a night city.',
      draw(g, t) {
        const sky = g.createLinearGradient(0, 0, 0, 960); sky.addColorStop(0, '#1b0f3a'); sky.addColorStop(0.6, '#d9467a'); sky.addColorStop(1, '#ffb347');
        g.fillStyle = sky; g.fillRect(0, 0, 1080, 960);
        g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(820, 300, 90, 0, TAU); g.fill();
        // two parallax skylines
        for (const [sp, col, base, hmax] of [[40, '#3a1d5c', 640, 260], [110, '#22123b', 700, 200]]) {
          g.fillStyle = col; const off = (t * sp) % 120;
          for (let i = -1; i < 11; i++) { const bh = 80 + rnd(i + Math.floor((t * sp) / 120) + base) * hmax; g.fillRect(i * 120 - off, base - bh, 104, bh + 300); }
        }
        // road
        g.fillStyle = '#2b2b33'; g.fillRect(0, 760, 1080, 200);
        g.fillStyle = '#ffd400'; const dash = (t * 900) % 160; for (let i = -1; i < 9; i++) g.fillRect(i * 160 - dash, 850, 90, 12);
        // the jump: 3.2 s loop — drive up the ramp, fly, flip, land
        const P = 3.2, u = (t % P) / P, rampX = 760 - u * 2600;
        g.fillStyle = '#ff6a00'; g.beginPath(); g.moveTo(rampX, 760); g.lineTo(rampX + 300, 760); g.lineTo(rampX + 300, 600); g.closePath(); g.fill();
        g.fillStyle = '#ffd400'; for (let k = 0; k < 4; k++) g.fillRect(rampX + 60 + k * 60, 760 - (k + 1) * 32 - 8, 30, 8);
        let cy = 700, rot = 0;
        const air = clamp((u - 0.3) / 0.5, 0, 1);
        if (u > 0.22 && u <= 0.3) { const k = (u - 0.22) / 0.08; cy = 700 - k * 150; rot = -0.5 * k; }
        else if (air > 0 && air < 1) { cy = 550 - Math.sin(air * Math.PI) * 330 + air * 150; rot = -0.5 - air * (TAU - 0.5); }
        const bob = air === 0 || air === 1 ? Math.sin(t * 40) * 2 : 0;
        g.save(); g.translate(400, cy + bob); g.rotate(rot);
        g.fillStyle = '#00c2ff'; rr(g, -150, -40, 300, 70, 26); g.fill();
        g.fillStyle = '#0a84b8'; rr(g, -70, -88, 150, 60, 22); g.fill();
        g.fillStyle = '#bff3ff'; rr(g, -50, -78, 110, 40, 12); g.fill();
        g.fillStyle = '#fff36b'; g.fillRect(132, -24, 22, 16);
        for (const wx of [-90, 95]) { g.fillStyle = '#111'; g.beginPath(); g.arc(wx, 32, 34, 0, TAU); g.fill(); g.fillStyle = '#ccc'; g.beginPath(); g.arc(wx, 32, 14, 0, TAU); g.fill(); g.strokeStyle = '#555'; g.lineWidth = 5; g.beginPath(); g.moveTo(wx, 32); g.lineTo(wx + Math.cos(t * 30) * 14, 32 + Math.sin(t * 30) * 14); g.stroke(); }
        g.restore();
        // speed lines + landing sparks
        g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 6; for (let i = 0; i < 7; i++) { const ly = 200 + rnd(i) * 520, lx = 1080 - ((t * 1500 + rnd(i + 9) * 1080) % 1400); g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 140, ly); g.stroke(); }
        if (u > 0.8 && u < 0.92) { g.fillStyle = '#ffd400'; for (let i = 0; i < 14; i++) { const k = (u - 0.8) / 0.12, a = Math.PI + rnd(i) * Math.PI; g.beginPath(); g.arc(400 + Math.cos(a) * k * 220, 770 + Math.sin(a) * k * 120, 9 * (1 - k), 0, TAU); g.fill(); } }
      },
    },
    'gen:blender': {
      name: 'Smoothie blender', cat: 'asmr', desc: 'Fruit drops into a blender and swirls into a smoothie, on repeat.',
      draw(g, t) {
        g.fillStyle = '#ffe6ef'; g.fillRect(0, 0, 1080, 960);
        g.fillStyle = '#f7c6d6'; g.fillRect(0, 820, 1080, 140);
        const P = 8, u = (t % P) / P, cx = 540;
        // jar
        const top = 170, bot = 700, wt = 420, wb = 300;
        const jar = () => { g.beginPath(); g.moveTo(cx - wt / 2, top); g.lineTo(cx + wt / 2, top); g.lineTo(cx + wb / 2, bot); g.lineTo(cx - wb / 2, bot); g.closePath(); };
        const fill = clamp((u - 0.05) / 0.45, 0, 1), level = bot - fill * 380, blend = clamp((u - 0.45) / 0.3, 0, 1), empty = clamp((u - 0.88) / 0.1, 0, 1);
        g.save(); jar(); g.clip();
        g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(0, 0, 1080, 960);
        const lv = level + empty * (bot - level);
        if (fill > 0) {
          const mix = blend; const col = `rgb(${Math.round(235 - 20 * mix)},${Math.round(70 + 40 * mix)},${Math.round(110 + 20 * mix)})`;
          g.fillStyle = col; g.fillRect(0, lv, 1080, bot - lv + 10);
          // swirl while blending
          if (blend > 0 && blend < 1 || (u > 0.45 && u < 0.88)) {
            for (let k = 0; k < 18; k++) { const a = t * 9 + k * 0.7, r = 20 + (k * 9) % 140, yy = lv + 40 + ((k * 37) % Math.max(40, bot - lv - 60)); g.fillStyle = ['#ffb3c7', '#ffd36b', '#8c6bff', '#ff4d6d'][k % 4]; g.globalAlpha = 0.55 * (1 - mix * 0.6); g.beginPath(); g.ellipse(cx + Math.cos(a) * r, yy, 26, 12, a, 0, TAU); g.fill(); }
            g.globalAlpha = 1;
            g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.ellipse(cx, lv + 10, 150, 26 + Math.sin(t * 20) * 6, 0, 0, TAU); g.fill();
          }
        }
        // fruit falling in
        if (u < 0.5) for (let k = 0; k < 9; k++) {
          const d = clamp((u * P - k * 0.4) / 0.9, 0, 1); if (d <= 0) continue;
          const fy = Math.min(-60 + d * 900, lv - 30 - (k % 3) * 40), fx = cx - 110 + (k * 67) % 220, kind = k % 3;
          g.fillStyle = ['#e8233f', '#ffd84d', '#3d4bd6'][kind];
          if (kind === 1) { g.beginPath(); g.ellipse(fx, fy, 50, 22, 0.4, 0, TAU); g.fill(); } else { g.beginPath(); g.arc(fx, fy, kind === 0 ? 34 : 18, 0, TAU); g.fill(); }
          if (kind === 0) { g.fillStyle = '#3cb043'; g.fillRect(fx - 8, fy - 44, 16, 14); }
        }
        // blades
        g.fillStyle = '#9aa3ad'; g.save(); g.translate(cx, bot - 30); g.rotate(u > 0.45 && u < 0.88 ? t * 40 : 0); g.fillRect(-90, -6, 180, 12); g.restore();
        g.restore();
        g.strokeStyle = 'rgba(80,80,100,.6)'; g.lineWidth = 10; jar(); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect(cx - wt / 2 + 40, top + 30, 18, 420);
        g.fillStyle = '#333'; rr(g, cx - wt / 2 - 10, top - 50, wt + 20, 50, 16); g.fill();
        g.fillStyle = '#e94d77'; rr(g, cx - 210, bot, 420, 140, 30); g.fill();
        g.fillStyle = u > 0.45 && u < 0.88 ? '#7cf7d4' : '#fff'; g.beginPath(); g.arc(cx, bot + 70, 26, 0, TAU); g.fill();
      },
    },
    'gen:sand': {
      name: 'Kinetic sand cutting', cat: 'satisfying', desc: 'A knife slices through a rainbow block of sand, slice after slice.',
      draw(g, t) {
        g.fillStyle = '#1e1b2e'; g.fillRect(0, 0, 1080, 960);
        g.fillStyle = '#2c2842'; rr(g, 120, 700, 840, 60, 20); g.fill();
        const cols = ['#ff5d8f', '#ffb84d', '#ffe66d', '#6bf178', '#4dc3ff', '#9b6bff'];
        const P = 1.6, u = (t % P) / P, sw = 34, blockW = 480;
        const x0 = 300, cut = x0 + blockW - sw; // the block never runs out: a fresh slice every loop
        // block
        for (let i = 0; i < 6; i++) { g.fillStyle = cols[i]; g.fillRect(x0, 340 + i * 60, blockW - sw, 60); }
        // texture
        g.fillStyle = 'rgba(255,255,255,.08)'; for (let k = 0; k < 120; k++) g.fillRect(x0 + rnd(k) * (blockW - sw), 340 + rnd(k + 50) * 360, 4, 4);
        // the slice: still standing, then tips over and crumbles
        const tip = clamp((u - 0.45) / 0.3, 0, 1), crumb = clamp((u - 0.75) / 0.25, 0, 1);
        g.save(); g.translate(cut + sw, 700); g.rotate(tip * Math.PI / 2 * 0.98);
        for (let i = 0; i < 6; i++) { g.fillStyle = cols[i]; g.globalAlpha = 1 - crumb; g.fillRect(-sw, -360 + i * 60, sw, 60); }
        g.restore(); g.globalAlpha = 1;
        if (crumb > 0) for (let k = 0; k < 40; k++) { g.fillStyle = cols[k % 6]; g.beginPath(); g.arc(cut + 40 + rnd(k) * 360, 690 - rnd(k + 3) * 40 * (1 - crumb), 7, 0, TAU); g.fill(); }
        // knife
        const kd = clamp(u / 0.4, 0, 1), ky = u < 0.4 ? 180 + kd * 520 : 700 - clamp((u - 0.4) / 0.2, 0, 1) * 520;
        g.fillStyle = '#d9dde3'; g.beginPath(); g.moveTo(cut, ky - 260); g.lineTo(cut + 10, ky - 260); g.lineTo(cut + 10, ky); g.lineTo(cut - 60, ky - 40); g.lineTo(cut - 60, ky - 260); g.closePath(); g.fill();
        g.fillStyle = '#3b2f2f'; rr(g, cut - 70, ky - 420, 86, 170, 16); g.fill();
        g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(cut - 50, ky - 250, 8, 200);
      },
    },
    'gen:marble': {
      name: 'Marble run', cat: 'satisfying', desc: 'Glowing marbles rolling down zig-zag tracks into a bucket.',
      draw(g, t) {
        const bg = g.createLinearGradient(0, 0, 0, 960); bg.addColorStop(0, '#0f2027'); bg.addColorStop(1, '#203a43'); g.fillStyle = bg; g.fillRect(0, 0, 1080, 960);
        const tracks = [[140, 130, 900, 230], [940, 330, 180, 430], [140, 530, 900, 630], [940, 730, 300, 830]];
        g.lineWidth = 18; g.lineCap = 'round'; g.strokeStyle = '#ffffff33';
        for (const [a, b, c, d] of tracks) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }
        g.strokeStyle = '#7cf7d4aa'; g.lineWidth = 6; for (const [a, b, c, d] of tracks) { g.beginPath(); g.moveTo(a, b + 12); g.lineTo(c, d + 12); g.stroke(); }
        const cols = ['#ff4d6d', '#ffd400', '#4dc3ff', '#9b6bff', '#6bf178', '#ff9f1c'];
        const P = 6;
        for (let m = 0; m < 6; m++) {
          let u = ((t + m * P / 6) % P) / P * 4; const k = Math.floor(u), f = u - k; if (k > 3) continue;
          const [a, b, c, d] = tracks[k]; const x = a + (c - a) * f, y = b + (d - b) * f - 26;
          g.fillStyle = cols[m]; g.beginPath(); g.arc(x, y, 24, 0, TAU); g.fill();
          g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(x - 8, y - 8, 7, 0, TAU); g.fill();
        }
        g.fillStyle = '#ffffff22'; rr(g, 200, 840, 200, 110, 20); g.fill();
        for (let k = 0; k < 9; k++) { g.fillStyle = cols[k % 6]; g.beginPath(); g.arc(240 + (k % 5) * 30, 920 - Math.floor(k / 5) * 30, 14, 0, TAU); g.fill(); }
      },
    },
    'gen:press': {
      name: 'Hydraulic press', cat: 'satisfying', desc: 'A press slowly squishes colourful jelly blobs flat.',
      draw(g, t) {
        g.fillStyle = '#2a2d34'; g.fillRect(0, 0, 1080, 960);
        g.fillStyle = '#3d414a'; g.fillRect(200, 0, 60, 960); g.fillRect(820, 0, 60, 960);
        g.fillStyle = '#555b66'; g.fillRect(140, 800, 800, 160);
        const P = 3.4, n = Math.floor(t / P), u = (t % P) / P, cols = ['#ff4d6d', '#ffd400', '#4dc3ff', '#6bf178', '#c77dff'], col = cols[n % 5];
        const down = u < 0.55 ? clamp(u / 0.55, 0, 1) : 1 - clamp((u - 0.7) / 0.3, 0, 1);
        const blobH = 260, flat = clamp((down - 0.62) / 0.38, 0, 1), bh = blobH * (1 - flat * 0.85), bw = 280 * (1 + flat * 1.25);
        const plateY = 120 + down * (800 - blobH - 120) + flat * (blobH - bh);
        // blob
        g.fillStyle = col; g.beginPath(); g.ellipse(540, 800 - bh / 2, bw / 2, bh / 2, 0, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(540 - bw / 6, 800 - bh * 0.7, bw / 10, bh / 8, -0.4, 0, TAU); g.fill();
        if (flat > 0.6) { g.fillStyle = col; for (let k = 0; k < 10; k++) { const a = Math.PI + rnd(k + n) * Math.PI, d = (flat - 0.6) * 900; g.beginPath(); g.arc(540 + Math.cos(a) * d * (0.6 + rnd(k) * 0.6), 790 + Math.sin(a) * d * 0.18, 12, 0, TAU); g.fill(); } }
        // press
        g.fillStyle = '#9aa3ad'; g.fillRect(500, 0, 80, plateY); g.fillStyle = '#c4ccd6'; rr(g, 260, plateY - 60, 560, 70, 10); g.fill();
        g.fillStyle = '#ffd400'; for (let k = 0; k < 7; k++) g.fillRect(280 + k * 80, plateY - 20, 40, 10);
      },
    },
    'gen:paint': {
      name: 'Paint swirl', cat: 'asmr', desc: 'Thick paint ribbons swirling and mixing on a turntable.',
      draw(g, t) {
        g.fillStyle = '#f4efe6'; g.fillRect(0, 0, 1080, 960);
        const cols = ['#ff4d6d', '#ffd400', '#2ec4b6', '#5f6bff', '#ff9f1c', '#c77dff'];
        g.save(); g.translate(540, 480); g.rotate(t * 0.9);
        g.fillStyle = '#fffaf2'; g.beginPath(); g.arc(0, 0, 440, 0, TAU); g.fill();
        g.lineCap = 'round';
        for (let k = 0; k < 6; k++) {
          g.strokeStyle = cols[k]; g.lineWidth = 46;
          g.beginPath();
          for (let s = 0; s <= 60; s++) { const r = 40 + s * 6.2, a = k * TAU / 6 + s * 0.11 + Math.sin(t * 0.7 + k) * 0.25 * (s / 60); const px = Math.cos(a) * r, py = Math.sin(a) * r; s ? g.lineTo(px, py) : g.moveTo(px, py); }
          g.stroke();
        }
        g.restore();
        g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.ellipse(420, 330, 120, 40, -0.6, 0, TAU); g.fill();
      },
    },
  };
  HK.GEN = GEN;

  /* ---------------- library (your recordings + free-licensed stock) ---------------- */
  HK.library = async () => (await FX.db.library.all()).filter((a) => a.hook && a.kind === 'video');
  const usable = (a) => a && a.hook && a.status === 'verified' && HK.LICENSES.includes(a.license);
  HK.all = async () => [
    ...Object.entries(GEN).map(([id, x]) => ({ id, name: x.name, cat: x.cat, kind: 'generated', license: 'Original work (generated in AutoClipper)', source: 'Generated in AutoClipper' })),
    ...(await HK.library()).filter(usable).map((a) => ({ id: 'lib:' + a.id, name: a.name, cat: a.category || 'satisfying', kind: 'video', license: a.license, licenseUrl: a.licenseUrl || '', source: a.source, creator: a.creator || '', pageUrl: a.pageUrl || '', libId: a.id })),
  ];

  // pick the filler for one clip: fixed choice, or rotate (never the same as the last two clips)
  HK.pick = async () => {
    const c = HK.cfg(), all = (await HK.all()).filter((x) => !c.off.includes(x.id));
    if (!all.length) return null;
    if (c.pick === 'fixed') return all.find((x) => x.id === c.fixed) || all[0];
    const recent = ls.get('fx_hooks_recent', []);
    const pool = all.filter((x) => !recent.includes(x.id));
    const ch = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];
    ls.set('fx_hooks_recent', [ch.id, ...recent].slice(0, Math.min(2, all.length - 1)));
    return ch;
  };

  // turn a filler record into something we can draw every frame
  HK.prep = async (f) => {
    if (!f) return null;
    if (f.kind === 'generated' && GEN[f.id]) return { ...f, draw: (g, x, y, w, h, t) => board(g, x, y, w, h, () => GEN[f.id].draw(g, t)) };
    const a = f.libId && (await FX.db.library.get(f.libId)); if (!usable(a)) return null;
    const blob = await FX.getFile(a.fileId); if (!blob) return null;
    const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    await new Promise((res) => { v.oncanplay = res; v.onerror = res; setTimeout(res, 8000); });
    try { await v.play(); } catch {}
    return {
      ...f, video: v,
      draw(g, x, y, w, h) {
        const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return;
        const s = Math.max(w / vw, h / vh), dw = vw * s, dh = vh * s;
        g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); g.restore();
      },
      dispose() { v.pause(); URL.revokeObjectURL(v.src); },
    };
  };
  let previewFiller = null;
  const previewOne = () => (previewFiller ||= { id: 'gen:ramp', draw: (g, x, y, w, h, t) => board(g, x, y, w, h, () => GEN['gen:ramp'].draw(g, t)) });

  /* ---------------- the hook layout + brand tag ---------------- */
  const baseZones = FX.layoutZones, baseDraw = FX.drawClipFrame;
  FX.layoutZones = (layout) => {
    if (layout !== 'hook') return baseZones(layout);
    const s = HK.cfg().split; return { hook: 0.1, caption: clamp(s - 0.085, 0.3, 0.6) };
  };
  // fx: {zoom, shakeX, shakeY, filler, t}
  FX.drawClipFrame = (g, src, c, layout, fx = {}) => {
    if (layout !== 'hook') return baseDraw(g, src, c, layout, fx);
    const Wd = g.canvas.width, Hd = g.canvas.height, vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
    const top = Math.round(Hd * clamp(+HK.cfg().split || 0.5, 0.35, 0.7));
    g.fillStyle = '#000'; g.fillRect(0, 0, Wd, Hd);
    if (vw && vh) {
      const z = fx.zoom || 1, sc = Math.max(Wd / vw, top / vh) * z, w = vw * sc, h = vh * sc;
      g.save(); g.beginPath(); g.rect(0, 0, Wd, top); g.clip(); g.drawImage(src, 0, 0, vw, vh, (Wd - w) / 2 + (fx.shakeX || 0), (top - h) / 2 + (fx.shakeY || 0), w, h); g.restore();
    }
    const f = fx.filler || previewOne();
    f.draw(g, 0, top, Wd, Hd - top, fx.t ?? performance.now() / 1000);
    g.fillStyle = 'rgba(0,0,0,.9)'; g.fillRect(0, top - 4, Wd, 8);
  };

  // brand tag (pill) — in the middle: on the split line for the hook layout, centre of the frame otherwise
  HK.tagY = (layout, pos, Hd) => pos === 'top' ? Hd * 0.045 : pos === 'bottom' ? Hd * 0.955 : layout === 'hook' ? Hd * clamp(+HK.cfg().split || 0.5, 0.35, 0.7) : Hd * 0.5;
  HK.drawTag = (g, text, layout, opt = {}) => {
    const c = HK.cfg(), pos = opt.pos || c.tagPos; text = String(text ?? c.brandTag ?? '').trim();
    if (!text || pos === 'off') return;
    const Wd = g.canvas.width, Hd = g.canvas.height, y = HK.tagY(layout, pos, Hd), fs = Math.round(Wd * 0.04);
    g.save(); g.font = `800 ${fs}px "Arial Black", Impact, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width, pw = tw + fs * 2.2, ph = fs * 1.75, x = (Wd - pw) / 2;
    g.globalAlpha = layout === 'hook' || pos !== 'middle' ? 1 : 0.85;
    g.fillStyle = 'rgba(10,8,18,.88)'; rr(g, x, y - ph / 2, pw, ph, ph / 2); g.fill();
    g.lineWidth = Math.max(3, fs * 0.09); g.strokeStyle = opt.color || c.tagColor; g.stroke();
    g.fillStyle = opt.color || c.tagColor; g.beginPath(); g.arc(x + fs * 0.85, y, fs * 0.22, 0, TAU); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, Wd / 2 + fs * 0.25, y + fs * 0.04);
    g.restore();
  };

  /* ---------------- the clip line: put the hook + tag on every clip ---------------- */
  const R = FX.RUN, isClip = (r) => r?.type === 'clips';
  const baseScript = R.script;
  R.script = async (r, say, o) => {
    const rep = await baseScript(r, say, o);
    if (!isClip(r) || !r.clip) return rep;
    const c = HK.cfg(), ch = FX.channel();
    const useHook = c.apply === 'always' || (c.apply === 'layout' && ch.layout === 'hook');
    r.clip.layout = useHook ? 'hook' : (ch.layout === 'hook' ? 'blur' : r.clip.layout);
    r.clip.filler = useHook ? await HK.pick() : null;
    if (useHook && r.clip.filler) { const { draw, video, dispose, ...rec } = r.clip.filler; r.clip.filler = rec; }
    r.clip.brandTag = c.tagPos === 'off' ? '' : c.brandTag;
    r.clip.tagPos = c.tagPos;
    if (useHook && r.clip.filler) rep.summary += ` Split-screen hook: ${r.clip.filler.name} (${r.clip.filler.license}).`;
    if (useHook && !r.clip.filler) rep.summary += ' Split-screen hook is on, but every filler is switched off: rendering without one.';
    if (useHook && !r.clip.filler) r.clip.layout = ch.layout === 'hook' ? 'blur' : (ch.layout || 'blur');
    return rep;
  };

  /* ---------------- copyright: the filler must carry a license we accept ---------------- */
  const baseCopy = R.copyright;
  R.copyright = async (r, say, o) => {
    const rep = await baseCopy(r, say, o);
    const f = r.clip?.filler; if (!isClip(r) || !f) return rep;
    const it = FX.item;
    if (f.kind === 'generated') { rep.items.push(it('low', 'Hook filler', `"${f.name}" is drawn by AutoClipper itself: original, no third-party footage.`, '')); return rep; }
    const a = f.libId && (await FX.db.library.get(f.libId));
    const lic = a && FX.checkLicense ? FX.checkLicense(a) : { status: a ? 'verified' : 'rejected', reason: a ? '' : 'Filler was removed from the library' };
    if (!a || !HK.LICENSES.includes(a.license) || lic.status !== 'verified') {
      rep.items.push(it('high', 'Hook filler', `"${f.name}" has no accepted license (${a ? a.license : 'missing'}${lic.reason ? ': ' + lic.reason : ''}).`, 'Use a generated filler, your own recording, or Pexels/Pixabay/CC0 footage.'));
      rep.verdict = 'HUMAN_REVIEW'; rep.summary = 'The split-screen filler has no accepted license. A person must check it.';
      return rep;
    }
    rep.items.push(it('low', 'Hook filler', `"${f.name}": ${a.license}${a.source ? ' from ' + a.source : ''}${a.creator ? ' by ' + a.creator : ''}${a.pageUrl ? ' (' + a.pageUrl + ')' : ''}.`, ''));
    if (a.category === 'gameplay') rep.items.push(it('medium', 'Hook filler', 'Your own gameplay recording: game publishers generally allow gameplay videos, but in-game radio / licensed music can be claimed.', 'Record filler gameplay with the in-game music turned off (the filler is muted in the export anyway).'));
    return rep;
  };

  /* ---------------- monetization: split-screen filler and "reused content" ---------------- */
  const baseMon = R.monetization;
  R.monetization = async (r, say, o) => {
    const rep = await baseMon(r, say, o);
    if (!isClip(r) || !r.clip?.filler || !r.monetization) return rep;
    const it = FX.item; let score = r.monetization.score;
    rep.items.push(it('medium', 'Split-screen filler', 'Split-screen filler alone does not make a clip original. YouTube\'s reused-content rule and TikTok\'s originality rule look at what you add.', 'Keep captions and the hook line on, and turn on commentary intros (Channel tab) so each clip has your own voice and edit.'));
    if (!r.clip.intro) { score += 1; rep.items.push(it('medium', 'Split-screen filler', 'This clip has no commentary intro, so the only additions are captions, the hook line and the filler.', 'Add a short commentary intro to lower reused-content risk.')); }
    const level = score >= 6 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';
    r.monetization = { ...r.monetization, score, level };
    return { ...rep, verdict: level === 'HIGH' ? 'HUMAN_REVIEW' : level === 'MEDIUM' ? 'WARNING' : 'PASS', summary: `Monetization risk: ${level} (score ${score}, split-screen hook).`, data: { ...(rep.data || {}), level, score } };
  };

  /* ---------------- niche presets (clip any niche) ---------------- */
  HK.NICHES = {
    'GTA 6 launch': { game: 'GTA 6 (plus GTA V / GTA RP)', niche: 'GTA 6 launch clips: first reactions, glitches, chases, funny NPC moments', audience: 'GTA fans 14–30 watching GTA 6 launch streams and wanting the wildest moments', subreddits: 'GTA6, GTA, gtaonline, RPClipsGTA', cta: 'Follow for daily GTA 6 clips', allowed: 'First reactions, funny or chaotic gameplay, clutch chases, glitches, wholesome moments, map discoveries' },
    'Any game (streamer clips)': { game: 'Video games (any)', niche: 'Gaming streamer clips: funny fails, clutch plays, rage and wholesome moments', audience: 'Gamers 14–30 who watch Twitch/Kick/YouTube streams', subreddits: 'gaming, LivestreamFail, Twitch', cta: 'Follow for the best stream moments', allowed: 'Funny, clutch or chaotic gameplay moments; reactions; game news reactions from the stream' },
    'Just Chatting / IRL': { game: 'Just Chatting / IRL stream', niche: 'Streamer Just Chatting and IRL clips: hot takes, funny stories, reactions', audience: 'Stream fans 16–30 who want the funniest talk moments', subreddits: 'LivestreamFail, Twitch', cta: 'Follow for daily stream moments', allowed: 'Funny stories, reactions, hot takes (no harassment), wholesome moments' },
    'Podcast / talk show': { game: 'Podcast / talk show', niche: 'Podcast clips: strongest stories, advice and laugh-out-loud moments', audience: 'Podcast listeners 18–35', subreddits: 'podcasts', cta: 'Follow for the best podcast moments', allowed: 'Self-contained stories, advice, debates, funny moments' },
    'Sports / real-life events': { game: 'Sports and live events (own footage only)', niche: 'Sports and event reaction clips from streams', audience: 'Sports fans 16–35', subreddits: 'sports, nba, soccer', cta: 'Follow for more reactions', allowed: 'Reactions and commentary; never re-upload broadcast footage' },
  };
  HK.nicheRow = () => `<div class="row"><label>Quick niche preset<select id="fxNichePreset"><option value="">Pick a niche to fill the fields…</option>${Object.keys(HK.NICHES).map((k) => `<option>${esc(k)}</option>`).join('')}</select></label><span class="muted small">Fills game, niche, audience, subreddits, call to action and allowed content below. Review, then save.</span></div>`;
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'fxNichePreset' || !e.target.value) return;
    const p = HK.NICHES[e.target.value];
    for (const [k, v] of Object.entries(p)) { const el = document.getElementById('ch_' + k); if (el) el.value = v; }
    toast(`Loaded the "${e.target.value}" preset. Review and press Save channel config.`);
  });

  /* ---------------- the Hooks section (Satisfying / ASMR) ---------------- */
  const live = new Map(); let raf = 0;
  function animate() {
    cancelAnimationFrame(raf);
    const tick = () => {
      const cs = [...document.querySelectorAll('canvas[data-hookprev]')]; if (!cs.length) { live.forEach((f) => f.dispose?.()); live.clear(); return; }
      const t = performance.now() / 1000;
      for (const cv of cs) {
        const id = cv.dataset.hookprev, g = cv.getContext('2d');
        if (GEN[id]) board(g, 0, 0, cv.width, cv.height, () => GEN[id].draw(g, t));
        else if (live.get(id)?.draw) live.get(id).draw(g, 0, 0, cv.width, cv.height, t);
      }
      const big = document.getElementById('fxHookFrame');
      if (big) {
        const g = big.getContext('2d'), c = HK.cfg(), top = Math.round(big.height * c.split), ids = cs.map((x) => x.dataset.hookprev).filter((id) => !c.off.includes(id));
        const pid = c.pick === 'fixed' ? c.fixed : ids[Math.floor(t / 4) % Math.max(1, ids.length)];
        const st = g.createLinearGradient(0, 0, big.width, top); st.addColorStop(0, '#3a1d5c'); st.addColorStop(1, '#0f5a66'); g.fillStyle = st; g.fillRect(0, 0, big.width, top);
        g.fillStyle = 'rgba(255,255,255,.75)'; g.font = `700 ${big.width * 0.05}px system-ui, sans-serif`; g.textAlign = 'center'; g.fillText('YOUR CLIP', big.width / 2, top / 2);
        if (pid && GEN[pid]) board(g, 0, top, big.width, big.height - top, () => GEN[pid].draw(g, t)); else if (pid && live.get(pid)) live.get(pid).draw(g, 0, top, big.width, big.height - top, t);
        else { g.fillStyle = '#111'; g.fillRect(0, top, big.width, big.height - top); }
        g.fillStyle = '#000'; g.fillRect(0, top - 2, big.width, 4);
        HK.drawTag(g, c.brandTag, 'hook');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  HK.pane = async () => {
    const c = HK.cfg(), lib = await HK.library(), k = FX.keys ? FX.keys() : {};
    const card = (id, name, sub, extra = '') => `<div class="hook-card ${c.off.includes(id) ? 'off' : ''}"><canvas data-hookprev="${esc(id)}" width="216" height="192"></canvas><b>${esc(name)}</b><span class="muted small">${sub}</span>
      <div class="row"><label class="check"><input type="checkbox" data-hookon="${esc(id)}" ${c.off.includes(id) ? '' : 'checked'}> Use</label>${c.pick === 'fixed' ? `<label class="check"><input type="radio" name="hookFixed" value="${esc(id)}" ${c.fixed === id ? 'checked' : ''}> Always this</label>` : ''}${extra}</div></div>`;
    return `<p class="muted">Split-screen retention hooks: your clip on top, a satisfying or ASMR loop underneath, and your brand tag on the line in the middle. Every filler here is copyright-safe: drawn by the app, recorded by you, or free stock with a license that allows commercial use. Filler is always muted, so only the stream audio plays.</p>
      <div class="hook-top">
        <canvas id="fxHookFrame" width="270" height="480"></canvas>
        <div class="card"><h3>Settings</h3><div class="grid3">
          <label>Use the split-screen hook<select id="hk_apply"><option value="always" ${c.apply === 'always' ? 'selected' : ''}>On every clip</option><option value="layout" ${c.apply === 'layout' ? 'selected' : ''}>Only when Channel layout is "Split-screen hook"</option><option value="off" ${c.apply === 'off' ? 'selected' : ''}>Off</option></select></label>
          <label>Which filler<select id="hk_pick"><option value="rotate" ${c.pick === 'rotate' ? 'selected' : ''}>Auto-pick (rotates, never the same twice in a row)</option><option value="fixed" ${c.pick === 'fixed' ? 'selected' : ''}>Always the one I choose</option></select></label>
          <label>Clip height (% of screen)<input id="hk_split" type="number" min="35" max="70" step="1" value="${Math.round(c.split * 100)}"></label>
          <label>Brand tag text<input id="hk_brandTag" value="${esc(c.brandTag)}" placeholder="Nuggiez Clips"></label>
          <label>Tag position<select id="hk_tagPos">${[['middle', 'Middle (on the split line)'], ['top', 'Top'], ['bottom', 'Bottom'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${c.tagPos === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Tag colour<input id="hk_tagColor" type="color" value="${esc(c.tagColor)}"></label></div>
          <div class="row"><button class="primary" data-act="hkSave">Save hook settings</button><span class="muted small">Applies to clips planned from now on. The Copyright and Monetization robots check every filler.</span></div>
          <p class="small warn-t">Heads-up: split-screen filler is common in low-effort reposts. YouTube (reused content) and TikTok (originality) judge what you add, so keep captions, the hook line and commentary intros on. The Monetization robot flags clips without an intro.</p></div>
      </div>
      <h3>Made by the app (always copyright-safe)</h3>
      <div class="hook-grid">${Object.entries(GEN).map(([id, x]) => card(id, x.name, `${esc(HK.CATS[x.cat])} · ${esc(x.desc)}`)).join('')}</div>
      <h3>Your hook library</h3>
      <div class="hook-grid">${lib.length ? lib.map((a) => card('lib:' + a.id, a.name, `${esc(HK.CATS[a.category] || 'Satisfying')} · ${a.licenseUrl ? `<a href="${esc(a.licenseUrl)}" target="_blank" rel="noopener">${esc(a.license)}</a>` : esc(a.license)}${a.creator ? ' · ' + esc(a.creator) : ''}${usable(a) ? '' : ' · <b class="warn-t">not usable</b>'}`, `<button data-hookdel="${esc(a.id)}">Remove</button>`)).join('') : '<p class="muted small">No filler clips of your own yet. Add one below or search free stock.</p>'}</div>
      <div class="card"><h3>Add a clip you recorded</h3><div class="grid3"><label>Video file<input type="file" id="hkFile" accept="video/*"></label>
        <label>Category<select id="hkCat">${Object.entries(HK.CATS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>License<select id="hkLic"><option>Owned by me (confirmed)</option><option>CC0</option><option>Pexels License</option><option>Pixabay Content License</option></select></label></div>
        <label class="check"><input type="checkbox" id="hkConfirm"> I recorded this myself, or it is CC0 / Pexels / Pixabay footage. It is not downloaded from TikTok, YouTube, Instagram or another creator.</label>
        <p class="muted small">Filming your own: a blender, slime, soap cutting, sand, a car on a ramp in a game you play (music off). 10–30 seconds is plenty; it loops.</p>
        <div class="row"><button data-act="hkAdd">Add to hook library</button></div></div>
      <div class="card"><h3>Find free stock (commercial use allowed)</h3>
        <div class="row"><input id="hkQuery" placeholder="satisfying, slime, kinetic sand, soap cutting, car ramp…" value="satisfying"><select id="hkSrc"><option value="pexels">Pexels</option><option value="pixabay">Pixabay</option></select><button data-act="hkSearch">Search</button></div>
        <p class="muted small">${k.pexels || k.pixabay ? 'Uses your free Pexels / Pixabay key from the Channel tab.' : 'Add a free Pexels or Pixabay API key on the Channel tab (Research & assets) to search here.'} Each result is saved with its license, creator and source page.</p>
        <div id="hkResults" class="hook-grid"></div></div>`;
  };
  HK.wire = async () => {
    live.forEach((f) => f.dispose?.()); live.clear();
    for (const a of await HK.library()) { try { const f = await HK.prep({ id: 'lib:' + a.id, kind: 'video', libId: a.id }); if (f) live.set('lib:' + a.id, f); } catch {} }
    animate();
  };

  async function stockSearch(src, q) {
    const k = FX.keys(); const out = [];
    if (src === 'pexels') {
      if (!k.pexels) throw new Error('Add a free Pexels API key on the Channel tab first.');
      const j = await FX.fetchJSON(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=12`, { headers: { Authorization: k.pexels } }, 'Pexels');
      for (const v of j.videos || []) { const f = (v.video_files || []).filter((x) => x.width && x.width <= 1280).sort((a, b) => b.width - a.width)[0] || v.video_files?.[0]; if (f) out.push({ name: `Pexels video ${v.id}`, url: f.link, thumb: v.image, source: 'Pexels', creator: v.user?.name || '', pageUrl: v.url, license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/' }); }
    } else {
      if (!k.pixabay) throw new Error('Add a free Pixabay API key on the Channel tab first.');
      const j = await FX.fetchJSON(`https://pixabay.com/api/videos/?key=${encodeURIComponent(k.pixabay)}&q=${encodeURIComponent(q)}&per_page=12&safesearch=true`, {}, 'Pixabay');
      for (const h of j.hits || []) { const f = h.videos?.small || h.videos?.medium; if (f?.url) out.push({ name: `Pixabay video ${h.id}`, url: f.url, thumb: f.thumbnail || h.videos?.tiny?.thumbnail || '', source: 'Pixabay', creator: h.user || '', pageUrl: h.pageURL, license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/' }); }
    }
    return out;
  }
  let lastResults = [];
  async function addToLibrary(blob, meta) {
    const fileId = await FX.saveFile(blob, meta.name, { role: 'hook-filler' });
    const a = { id: 'lib_' + FX.now(), name: meta.name, kind: 'video', source: meta.source, creator: meta.creator || '', pageUrl: meta.pageUrl || '', license: meta.license, licenseUrl: meta.licenseUrl || '', commercial: true, attribution: 'not required', acquired: new Date().toISOString(), fileId, tags: ['hook-filler', meta.category || 'satisfying'], hook: true, category: meta.category || 'satisfying', addedAt: FX.now() };
    const chk = FX.checkLicense ? FX.checkLicense(a) : { status: 'verified' };
    a.status = chk.status === 'verified' && HK.LICENSES.includes(a.license) ? 'verified' : 'manual_review';
    await FX.db.library.put(a);
    await FX.audit('hook filler added', `${a.name} (${a.license}${a.source ? ', ' + a.source : ''})`, null, 'you');
    return a;
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button, input[data-hookon], input[name=hookFixed]'); if (!b) return;
    try {
      if (b.dataset.hookon) { const c = HK.cfg(); c.off = b.checked ? c.off.filter((x) => x !== b.dataset.hookon) : [...new Set([...c.off, b.dataset.hookon])]; HK.save(c); b.closest('.hook-card').classList.toggle('off', !b.checked); return; }
      if (b.name === 'hookFixed') { HK.save({ ...HK.cfg(), fixed: b.value }); return; }
      if (b.dataset.hookdel) { if (!confirm('Remove this filler from the hook library?')) return; await FX.db.library.del(b.dataset.hookdel); return FX.renderLine(); }
      if (b.dataset.hookadd != null) {
        const m = lastResults[+b.dataset.hookadd]; b.disabled = true; b.textContent = 'Saving…';
        const res = await fetch(m.url, { mode: 'cors' }); if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
        const blob = await res.blob(); if (blob.size > 60e6) throw new Error('That file is too large; pick a shorter one.');
        await addToLibrary(blob, { ...m, category: /asmr|slime|soap|blend/i.test($('#hkQuery').value) ? 'asmr' : /car|ramp|drive|stunt/i.test($('#hkQuery').value) ? 'driving' : 'satisfying' });
        toast(`Saved to the hook library with its ${m.license}.`); return FX.renderLine();
      }
      const act = b.dataset.act; if (!act || !act.startsWith('hk')) return;
      if (act === 'hkSave') {
        const c = HK.cfg();
        c.apply = $('#hk_apply').value; c.pick = $('#hk_pick').value; c.split = clamp((+$('#hk_split').value || 50) / 100, 0.35, 0.7);
        c.brandTag = $('#hk_brandTag').value.trim(); c.tagPos = $('#hk_tagPos').value; c.tagColor = $('#hk_tagColor').value;
        HK.save(c); toast('Hook settings saved.'); return FX.renderLine();
      }
      if (act === 'hkAdd') {
        const f = $('#hkFile').files[0]; if (!f) return toast('Pick a video file first.');
        if (!$('#hkConfirm').checked) return toast('Confirm where the clip comes from first.');
        if (f.size > 200e6) return toast('Keep filler clips under 200 MB (10–30 seconds is plenty).');
        const lic = $('#hkLic').value;
        await addToLibrary(f, { name: f.name, source: lic === 'Owned by me (confirmed)' ? 'Your recording' : 'Your upload', creator: lic === 'Owned by me (confirmed)' ? 'You' : '', license: lic, licenseUrl: { CC0: 'https://creativecommons.org/publicdomain/zero/1.0/', 'Pexels License': 'https://www.pexels.com/license/', 'Pixabay Content License': 'https://pixabay.com/service/license-summary/' }[lic] || '', category: $('#hkCat').value });
        toast('Added to the hook library.'); return FX.renderLine();
      }
      if (act === 'hkSearch') {
        b.disabled = true; b.textContent = 'Searching…';
        try { lastResults = await stockSearch($('#hkSrc').value, $('#hkQuery').value.trim() || 'satisfying'); } finally { b.disabled = false; b.textContent = 'Search'; }
        $('#hkResults').innerHTML = lastResults.length ? lastResults.map((m, i) => `<div class="hook-card">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : ''}<b>${esc(m.name)}</b><span class="muted small">${esc(m.creator)} · <a href="${esc(m.licenseUrl)}" target="_blank" rel="noopener">${esc(m.license)}</a> · <a href="${esc(m.pageUrl)}" target="_blank" rel="noopener">page</a></span><div class="row"><button data-hookadd="${i}">Add to hooks</button></div></div>`).join('') : '<p class="muted small">Nothing found. Try another word.</p>';
        return;
      }
    } catch (err) { toast('' + err.message); }
  });
})(window.FX);
