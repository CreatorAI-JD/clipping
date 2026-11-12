/* AutoClipper — clip quality helpers used by the GTA clip line (fx-clips.js).
   - planCut: snaps the AI's cut to word boundaries, finishes the last sentence, and plans
     jump cuts that remove dead air (but never loud game action or the hype peak).
   - clipMap: maps VOD time <-> output time once jump cuts are applied.
   - captionChunks: short, readable caption groups (whisper word timings have no punctuation,
     so pauses decide where a caption ends).
   - drawClipFrame: the 9:16 layouts (bigger gameplay, configurable facecam, punch-in zoom).
   - streamGainDb: how much to raise/lower raw stream audio so every clip lands at a similar loudness. */
'use strict';
(function (FX) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /* ---------------- cut planning ---------------- */
  // m: moment (words relative to m.start, m.len, m.peak absolute). a/b: proposed trim (relative).
  // env: dB envelope of the moment audio at 50 ms steps (or null).
  FX.planCut = (m, a, b, env, { maxLen = 35, jumpCuts = true } = {}) => {
    const words = (m.words || []).filter((w) => w.word && w.end > w.start).sort((x, y) => x.start - y.start);
    a = clamp(+a || 0, 0, m.len); b = clamp(+b || m.len, a + 3, m.len);
    if (words.length) {
      // never start in the middle of a word
      const sw = words.find((w) => w.end > a);
      if (sw && sw.start < a) a = Math.max(0, sw.start - 0.12);
      // finish the sentence: include the word under the cut, then keep going while the next word follows within a breath
      let i = words.findIndex((w) => w.start >= b - 0.05) - 1; if (i < -1) i = words.length - 1;
      if (i >= 0) {
        while (i + 1 < words.length && words[i + 1].start - words[i].end < 0.45 && words[i + 1].end - a <= maxLen + 4) i++;
        const next = words[i + 1];
        b = Math.min(m.len, words[i].end + 0.45, next ? next.start - 0.05 : Infinity);
        if (b < words[i].end) b = words[i].end;
      }
    }
    if (b - a > maxLen + 4) b = a + maxLen + 4;
    // jump cuts: silences between words that are also quiet in the audio (no engine/explosion/gunfire)
    const cuts = [];
    if (jumpCuts && words.length > 1) {
      const peak = (m.peak ?? -1e9) - m.start;
      const dbAt = (x, y) => { if (!env) return -120; const i0 = Math.floor(x / 0.05), i1 = Math.max(i0 + 1, Math.ceil(y / 0.05)); let s = 0, n = 0; for (let i = i0; i < i1 && i < env.length; i++) { s += 10 ** (env[i] / 10); n++; } return n ? 10 * Math.log10(s / n + 1e-12) : -120; };
      const inside = words.filter((w) => w.start >= a && w.end <= b + 0.05);
      const speechDb = inside.length ? inside.reduce((t, w) => t + dbAt(w.start, w.end), 0) / inside.length : -20;
      const gaps = [];
      if (inside.length && inside[0].start - a > 1.4) gaps.push([a + 0.35, inside[0].start - 0.3]);
      for (let k = 1; k < inside.length; k++) if (inside[k].start - inside[k - 1].end > 0.9) gaps.push([inside[k - 1].end + 0.25, inside[k].start - 0.2]);
      for (const [x, y] of gaps) {
        if (y - x < 0.45) continue;
        if (peak > x - 1.5 && peak < y + 1.5) continue; // keep everything around the hype peak
        if (env && dbAt(x, y) > speechDb - 10) continue; // game action is happening, keep it
        cuts.push([x, y]);
      }
    }
    const keep = [], applied = []; let s = a;
    for (const [x, y] of cuts) { if (x - s >= 0.5 && b - y >= 0.5) { keep.push([s, x]); applied.push([x, y]); s = y; } }
    keep.push([s, b]);
    const outLen = keep.reduce((t, [x, y]) => t + (y - x), 0);
    return { trimStart: a, trimEnd: b, keep, outLen, cuts: applied };
  };

  // VOD time (absolute) -> seconds into the clip after jump cuts, or null if that moment was cut
  FX.clipMap = (cl) => {
    const keep = cl.keep?.length ? cl.keep : [[cl.start, cl.start + cl.len]];
    const offs = []; let o = 0; for (const [a, b] of keep) { offs.push(o); o += b - a; }
    return {
      keep, len: o,
      toOut(v, snap = false) {
        for (let k = 0; k < keep.length; k++) {
          if (v >= keep[k][0] - 1e-3 && v <= keep[k][1] + 1e-3) return offs[k] + (v - keep[k][0]);
          if (snap && v < keep[k][0]) return offs[k];
        }
        return snap ? o : null;
      },
      segAt(v) { return keep.findIndex(([a, b]) => v >= a - 1e-3 && v < b - 1e-3); },
    };
  };

  /* ---------------- captions ---------------- */
  // words: [{word,start,end}] in output time. Short groups, break on pauses/punctuation, min on-screen time.
  FX.captionChunks = (words, { maxWords = 3, maxChars = 16, minDur = 0.32 } = {}) => {
    const out = []; let cur = null;
    for (const w of words) {
      const text = String(w.word || '').trim(); if (!text) continue;
      const brk = !cur || cur.n >= maxWords || (cur.text + ' ' + text).length > maxChars || w.start - cur.end > 0.3 || /[.!?,;:]$/.test(cur.text);
      if (brk) { cur = { text, start: w.start, end: w.end, n: 1 }; out.push(cur); } else { cur.text += ' ' + text; cur.end = w.end; cur.n++; }
    }
    out.forEach((c, i) => { const nx = out[i + 1]; c.until = nx ? Math.min(nx.start, c.end + 0.35) : c.end + 0.5; });
    // merge flashes that would be on screen too briefly to read
    for (let i = 0; i < out.length - 1; i++) {
      const c = out[i], nx = out[i + 1];
      if (c.until - c.start < minDur && nx.start - c.end < 0.3 && (c.text + ' ' + nx.text).length <= maxChars + 8) { nx.text = c.text + ' ' + nx.text; nx.start = c.start; nx.n += c.n; out.splice(i, 1); i--; }
    }
    out.forEach((c, i) => { const nx = out[i + 1]; c.until = Math.max(c.until, Math.min(c.start + minDur, nx ? nx.start : Infinity)); });
    return out.map((c) => ({ start: Math.round(c.start * 100) / 100, end: Math.round(c.until * 100) / 100, text: c.text.replace(/[,;:]$/, '') }));
  };

  /* ---------------- audio ---------------- */
  // gain that brings the speech/action of the kept part to about -20 dBFS RMS; after the compressor the
  // export lands near -14 LUFS, which is what TikTok/Shorts/Reels normalise to anyway
  FX.streamGainDb = (env, keepRel) => {
    if (!env?.length) return 0;
    const vals = [];
    for (const [a, b] of keepRel) for (let i = Math.floor(a / 0.05); i < Math.min(env.length, Math.ceil(b / 0.05)); i++) if (env[i] > -50) vals.push(env[i]);
    if (vals.length < 10) return 0;
    vals.sort((x, y) => x - y);
    const loud = vals[Math.floor(vals.length * 0.7)]; // 70th percentile = typical talking/action level
    return clamp(-20.5 - loud, -12, 12);
  };

  /* ---------------- layouts ---------------- */
  FX.camRect = (c, vw, vh) => {
    const s = clamp((+c.camSize || 25) / 100, 0.1, 0.6), ins = clamp((+c.camInset || 0) / 100, 0, 0.2) * vw;
    const fw = vw * s, fh = Math.min(vh, fw * 9 / 16), cn = c.camCorner || 'bl';
    return [cn.includes('r') ? vw - fw - ins : ins, cn.includes('b') ? vh - fh - ins : ins, fw, fh];
  };
  // where text goes in each layout (fractions of the 1920 height)
  FX.layoutZones = (layout) => layout === 'split' ? { hook: 0.375, caption: 0.7 } : layout === 'crop' ? { hook: 0.15, caption: 0.66 } : { hook: 0.17, caption: 0.69 };

  // draw source rect (sx,sy,sw,sh) to cover the box (dx,dy,dw,dh), zoomed around the box centre
  function coverInto(g, src, sx, sy, sw, sh, dx, dy, dw, dh, zoom = 1, ox = 0, oy = 0) {
    const sc = Math.max(dw / sw, dh / sh) * zoom, w = sw * sc, h = sh * sc;
    g.save(); g.beginPath(); g.rect(dx, dy, dw, dh); g.clip();
    g.drawImage(src, sx, sy, sw, sh, dx + (dw - w) / 2 + ox, dy + (dh - h) / 2 + oy, w, h);
    g.restore();
  }
  // fx: {zoom, shakeX, shakeY}
  FX.drawClipFrame = (g, src, c, layout, fx = {}) => {
    const Wd = g.canvas.width, Hd = g.canvas.height, vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
    const z = fx.zoom || 1, ox = fx.shakeX || 0, oy = fx.shakeY || 0;
    g.fillStyle = '#000'; g.fillRect(0, 0, Wd, Hd);
    if (!vw || !vh) return;
    if (layout === 'crop') { coverInto(g, src, 0, 0, vw, vh, 0, 0, Wd, Hd, z, ox, oy); return; }
    if (layout === 'split') {
      const [cx, cy, cw, ch] = FX.camRect(c, vw, vh), top = Math.round(Hd * 0.375);
      coverInto(g, src, cx, cy, cw, ch, 0, 0, Wd, top, 1);
      coverInto(g, src, 0, 0, vw, vh, 0, top, Wd, Hd - top, z, ox, oy);
      g.fillStyle = 'rgba(0,0,0,.85)'; g.fillRect(0, top - 3, Wd, 6);
      return;
    }
    // blur: background from a tiny copy, the full stream frame (facecam included) in the upper-middle,
    // leaving clean space above for the hook and below for captions
    blurCtx.drawImage(src, ...coverRect(vw, vh, 0, 0, blurCanvas.width, blurCanvas.height));
    g.save(); g.imageSmoothingQuality = 'low'; g.drawImage(blurCanvas, 0, 0, Wd, Hd); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, Wd, Hd); g.restore();
    const gh = Math.round(Wd * vh / vw), gy = Math.round(Hd * 0.45 - gh / 2);
    coverInto(g, src, 0, 0, vw, vh, 0, gy, Wd, gh, z, ox, oy);
  };

  // punch-in zoom + a little shake on the hype peak, and a quick zoom on the cut out of the intro
  FX.clipFx = (vodT, peak, t, introEnd, on = true) => {
    let zoom = 1, shakeX = 0, shakeY = 0;
    if (on && peak != null) {
      const d = vodT - peak + 0.15;
      if (d > 0 && d < 1.8) { const e = d < 0.12 ? d / 0.12 : d > 1.3 ? 1 - (d - 1.3) / 0.5 : 1; zoom += 0.14 * clamp(e, 0, 1); if (d < 0.5) { shakeX = Math.sin(d * 90) * 10 * (1 - d / 0.5); shakeY = Math.cos(d * 73) * 7 * (1 - d / 0.5); } }
    }
    if (introEnd && t >= introEnd && t < introEnd + 0.3) zoom += 0.08 * (1 - (t - introEnd) / 0.3);
    return { zoom, shakeX, shakeY };
  };
})(window.FX);
