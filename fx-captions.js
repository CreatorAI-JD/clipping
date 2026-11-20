/* AutoClipper 2.0 — CAPTION STYLES
   Presets + full customisation (font, size, color, outline, position, highlight color and mode,
   words per caption, animation, timing offset, background box, uppercase), and optional rotation
   between presets so every video doesn't look identical. The renderer (clips and faceless) paints
   captions through FX.paintCue, which draws on any canvas context (previews never touch a render). */
'use strict';
(function (FX) {
  const FONTS = {
    impact: '900 {s}px Impact, "Arial Black", system-ui, sans-serif',
    black: '900 {s}px "Arial Black", Impact, system-ui, sans-serif',
    inter: '800 {s}px Inter, "Segoe UI", system-ui, sans-serif',
    rounded: '800 {s}px "Trebuchet MS", "Verdana", system-ui, sans-serif',
    serif: '800 {s}px Georgia, "Times New Roman", serif',
    mono: '800 {s}px "Courier New", ui-monospace, monospace',
  };
  FX.CAPTION_FONTS = { impact: 'Impact (heavy)', black: 'Arial Black', inter: 'Clean sans', rounded: 'Rounded', serif: 'Serif', mono: 'Typewriter' };
  // highlight: keywords = emphasis words (numbers, hook words, exclamations); active = the word being said (karaoke); none
  FX.CAPTION_PRESETS = {
    bold: { name: 'Bold Pop', font: 'impact', size: 86, color: '#ffffff', outline: '#000000', outlineW: 0.16, highlight: '#ffd400', hlMode: 'keywords', words: 3, anim: 'pop', upper: true, box: false },
    karaoke: { name: 'Karaoke', font: 'black', size: 80, color: '#ffffff', outline: '#000000', outlineW: 0.14, highlight: '#39ff88', hlMode: 'active', words: 3, anim: 'none', upper: true, box: false },
    clean: { name: 'Clean Box', font: 'inter', size: 66, color: '#ffffff', outline: '#000000', outlineW: 0, highlight: '#7cf7d4', hlMode: 'keywords', words: 4, anim: 'fade', upper: false, box: true },
    neon: { name: 'Neon', font: 'rounded', size: 82, color: '#ffffff', outline: '#7a2cff', outlineW: 0.2, highlight: '#00e5ff', hlMode: 'active', words: 2, anim: 'pop', upper: true, box: false },
    minimal: { name: 'Minimal', font: 'inter', size: 60, color: '#ffffff', outline: '#000000', outlineW: 0.08, highlight: '#ffffff', hlMode: 'none', words: 5, anim: 'none', upper: false, box: false },
    bounce: { name: 'One-word bounce', font: 'impact', size: 104, color: '#ffe14d', outline: '#000000', outlineW: 0.18, highlight: '#ff5c8a', hlMode: 'keywords', words: 1, anim: 'bounce', upper: true, box: false },
  };
  const P = FX.CAPTION_PRESETS;

  // the style a video uses: a preset (or "custom" = the channel's own fields), optionally rotated per video
  FX.captionStyle = (c = FX.channel(), r = null, z = null) => {
    let key = c.captionPreset || 'bold';
    const rot = String(c.captionRotate || '').split(',').map((x) => x.trim()).filter((x) => P[x]);
    if (rot.length > 1 && r?.id) { let h = 0; for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; key = rot[h % rot.length]; }
    const base = key === 'custom' ? {
      name: 'Custom', font: c.captionFont || 'impact', size: +c.captionSize || 84, color: c.captionColor || '#fff', outline: c.captionOutline || '#000', outlineW: c.captionOutlineW != null ? +c.captionOutlineW : 0.16,
      highlight: c.highlightColor || '#ffd400', hlMode: c.captionHlMode || 'keywords', words: +c.captionWords || 3, anim: c.captionAnim || 'pop', upper: c.captionUpper !== false, box: !!c.captionBox,
    } : { ...(P[key] || P.bold) };
    return { ...base, preset: key, pos: z ?? (+c.captionPos || 0.64), offset: Math.max(-1, Math.min(1, +c.captionOffset || 0)) };
  };

  // which caption is on screen at time t (timing offset applied)
  FX.cueAt = (cues, t, st) => { const tt = t - (st?.offset || 0); return (cues || []).find((q) => tt >= q.start && tt < q.end); };

  FX.paintCue = (g, cue, st, t, Wd = 1080, Hd = 1920) => {
    if (!cue) return;
    st = st || {};
    const size = st.size || 84, lt = Math.max(0, t - (st.offset || 0) - cue.start);
    let scale = 1, alpha = 1, dy = 0;
    if (st.anim === 'pop') scale = 1 + 0.1 * (1 - Math.min(1, lt / 0.12));
    else if (st.anim === 'bounce') scale = lt < 0.18 ? 0.7 + 0.45 * Math.sin((lt / 0.18) * Math.PI * 0.75) : 1;
    else if (st.anim === 'fade') alpha = Math.min(1, lt / 0.15);
    else if (st.anim === 'slide') { dy = (1 - Math.min(1, lt / 0.15)) * 40; alpha = Math.min(1, lt / 0.1); }
    const font = (FONTS[st.font] || FONTS.impact).replace('{s}', size);
    g.save(); g.globalAlpha = alpha; g.font = font; g.textBaseline = 'middle'; g.lineJoin = 'round';
    const txt = st.upper === false ? cue.text : cue.text.toUpperCase();
    const words = txt.split(' '), lines = [[]]; let lw = 0; const max = Wd * 0.84, sp = g.measureText(' ').width;
    // which word is being said (for karaoke highlight): real word timings when the cue has them
    let active = -1;
    if (st.hlMode === 'active') {
      if (cue.ts?.length) { const tt = t - (st.offset || 0); for (let i = 0; i < cue.ts.length; i++) if (tt >= cue.ts[i]) active = i; }
      else active = Math.min(words.length - 1, Math.floor((lt / Math.max(0.1, cue.end - cue.start)) * words.length));
    }
    words.forEach((w, i) => { const ww = g.measureText(w).width; if (lw + ww > max && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push({ w, ww, i }); lw += ww + sp; });
    const cy = Hd * (st.pos || 0.64) + dy, y0 = cy - (lines.length - 1) * size * 0.56;
    g.translate(Wd / 2, cy); g.scale(scale, scale); g.translate(-Wd / 2, -cy);
    if (st.box) {
      const bw = Math.max(...lines.map((ln) => ln.reduce((a, x) => a + x.ww, 0) + sp * (ln.length - 1))) + size * 0.8, bh = lines.length * size * 1.12 + size * 0.45;
      g.fillStyle = 'rgba(8,8,12,.78)'; g.beginPath(); g.roundRect ? g.roundRect((Wd - bw) / 2, cy - bh / 2, bw, bh, size * 0.3) : g.rect((Wd - bw) / 2, cy - bh / 2, bw, bh); g.fill();
    }
    g.lineWidth = size * (st.outlineW ?? 0.16); g.strokeStyle = st.outline || '#000';
    lines.forEach((ln, li) => {
      const total = ln.reduce((a, x) => a + x.ww, 0) + sp * (ln.length - 1); let x = (Wd - total) / 2; const y = y0 + li * size * 1.12;
      for (const p of ln) {
        if ((st.outlineW ?? 0.16) > 0) g.strokeText(p.w, x, y);
        const hl = st.hlMode === 'active' ? p.i === active : st.hlMode === 'keywords' ? !!cue.hl?.[p.i] : false;
        g.fillStyle = hl ? (st.highlight || '#ffd400') : (st.color || '#fff'); g.fillText(p.w, x, y); x += p.ww + sp;
      }
    });
    g.restore();
  };

  // a small live preview for the Channel tab
  FX.previewCaption = (canvas, st) => {
    const g = canvas.getContext('2d'), Wd = 1080, Hd = 1920;
    g.save(); g.setTransform(canvas.width / Wd, 0, 0, canvas.height / Hd, 0, 0);
    const grad = g.createLinearGradient(0, 0, Wd, Hd); grad.addColorStop(0, '#2b3a55'); grad.addColorStop(1, '#4a2b3a'); g.fillStyle = grad; g.fillRect(0, 0, Wd, Hd);
    g.fillStyle = 'rgba(255,255,255,.08)'; for (let i = 0; i < 12; i++) g.fillRect(0, i * 170, Wd, 70);
    const cue = { text: st.words <= 1 ? 'INSANE' : st.words === 2 ? 'NO WAY' : 'HE DID NOT SEE 3 COPS', start: 0, end: 1.2, hl: [false, false, false, false, true, true], ts: [0, 0.2, 0.4, 0.6, 0.8, 1] };
    FX.paintCue(g, cue, st, 0.65, Wd, Hd);
    g.restore();
  };
})(window.FX);
