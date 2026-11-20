"""Caption Specialist: word-level captions -> editable cues -> styled ASS subtitles burned in by ffmpeg (libass).
Presets live in the database (caption_presets setting) so research can add new ones; every cue can override
text, timing, position, color, font and animation from the Review Queue."""
import re

from . import db

W, H = 1080, 1920

PRESETS = {
    "bold": {"name": "Bold Pop", "font": "Anton", "size": 124, "color": "#FFFFFF", "outline": "#000000", "outline_w": 9, "highlight": "#FFD400", "hl_mode": "keywords", "words": 3, "anim": "pop", "upper": True, "box": False, "shadow": 2},
    "karaoke": {"name": "Karaoke", "font": "Montserrat", "size": 104, "color": "#FFFFFF", "outline": "#000000", "outline_w": 6, "highlight": "#39FF88", "hl_mode": "active", "words": 3, "anim": "none", "upper": True, "box": False, "shadow": 2, "bold": True},
    "clean": {"name": "Clean Box", "font": "Inter", "size": 80, "color": "#FFFFFF", "outline": "#000000", "outline_w": 0, "highlight": "#7CF7D4", "hl_mode": "keywords", "words": 4, "anim": "fade", "upper": False, "box": True, "shadow": 0, "bold": True},
    "neon": {"name": "Neon", "font": "Poppins", "size": 106, "color": "#FFFFFF", "outline": "#7A2CFF", "outline_w": 8, "highlight": "#00E5FF", "hl_mode": "active", "words": 2, "anim": "pop", "upper": True, "box": False, "shadow": 0, "bold": True},
    "minimal": {"name": "Minimal", "font": "Inter", "size": 74, "color": "#FFFFFF", "outline": "#000000", "outline_w": 3, "highlight": "#FFFFFF", "hl_mode": "none", "words": 5, "anim": "none", "upper": False, "box": False, "shadow": 1},
    "bounce": {"name": "One-word bounce", "font": "Archivo Black", "size": 148, "color": "#FFE14D", "outline": "#000000", "outline_w": 10, "highlight": "#FF5C8A", "hl_mode": "keywords", "words": 1, "anim": "bounce", "upper": True, "box": False, "shadow": 3},
}
# which preset fits which kind of stream (research and performance learning can change this table)
CATEGORY_PRESET = {"gaming": "bold", "irl": "karaoke", "podcast": "clean", "interview": "clean", "comedy": "bounce", "educational": "minimal", "sports": "neon", "just chatting": "karaoke"}
EMPH = re.compile(r"^(no+|yo+|bro+|what+|wait|oh+|omg|bruh|insane|crazy|never|why|how|wow|lets?|go+)\W*$", re.I)


def presets():
    return {**PRESETS, **(db.setting("caption_presets", {}) or {})}


def preset_for(category):
    table = {**CATEGORY_PRESET, **(db.setting("category_presets", {}) or {})}
    key = table.get((category or "").lower(), "bold")
    return key if key in presets() else "bold"


def style(key="bold", overrides=None):
    st = dict(presets().get(key) or PRESETS["bold"])
    st.update({k: v for k, v in (overrides or {}).items() if v is not None})
    st["preset"] = key
    return st


def cues_from_words(words, st, hook_words=()):
    """Group word timings into readable captions: max N words, break on pauses and sentence ends."""
    maxw = max(1, int(st.get("words", 3)))
    maxc = 14 if maxw == 1 else 16 + max(0, maxw - 3) * 7
    emph = {w.lower().strip(".,!?") for w in hook_words}
    cues, cur = [], None
    for w in words:
        t = str(w["word"]).strip()
        if not t:
            continue
        brk = (cur is None or len(cur["words"]) >= maxw or len(cur["text"] + " " + t) > maxc or w["start"] - cur["end"] > 0.35
               or re.search(r"[.!?,;:]$", cur["text"]))
        if brk:
            cur = {"start": w["start"], "end": w["end"], "text": t, "words": []}
            cues.append(cur)
        else:
            cur["text"] += " " + t
            cur["end"] = w["end"]
        cur["words"].append({"w": t, "s": round(w["start"], 3), "e": round(w["end"], 3), "hl": bool(re.search(r"\d", t) or EMPH.match(t) or t.lower().strip(".,!?") in emph)})
    for i, c in enumerate(cues):
        nx = cues[i + 1]["start"] if i + 1 < len(cues) else c["end"] + 0.5
        c["end"] = round(min(nx, max(c["end"] + 0.15, c["start"] + 0.35)), 3)
        c["start"] = round(c["start"], 3)
    return cues


def _ass_color(hex_, alpha=0):
    h = hex_.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _esc(t):
    return t.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def _lines(words, maxc):
    lines, cur = [[]], 0
    for w in words:
        if cur + len(w) > maxc and lines[-1]:
            lines.append([])
            cur = 0
        lines[-1].append(w)
        cur += len(w) + 1
    return lines[:3]


def ass(cues, st, y_frac=0.66, offset=0.0):
    """Build the .ass subtitle file. Each cue may carry its own style overrides and position."""
    def style_line(name, s):
        border = 3 if s.get("box") else 1
        return (f"Style: {name},{s['font']},{int(s['size'])},{_ass_color(s['color'])},{_ass_color(s['highlight'])},{_ass_color(s['outline'])},"
                f"{_ass_color('#0A0A10', 0x40) if s.get('box') else _ass_color('#000000', 0x80)},{-1 if s.get('bold', True) else 0},0,0,0,100,100,0,0,{border},"
                f"{s.get('outline_w', 6) if not s.get('box') else 14},{s.get('shadow', 0)},5,60,60,60,1")
    out = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
           "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
           style_line("Base", st)]
    custom = {}
    for i, c in enumerate(cues):
        if c.get("style"):
            custom[i] = {**st, **c["style"]}
            out.append(style_line(f"C{i}", custom[i]))
    out += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    tc = lambda t: f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"
    for i, c in enumerate(cues):
        s = custom.get(i, st)
        x = int((c.get("pos") or {}).get("x", 0.5) * W)
        y = int((c.get("pos") or {}).get("y", y_frac) * H)
        words = c.get("words") or [{"w": w, "s": c["start"], "e": c["end"], "hl": False} for w in c["text"].split()]
        # edited text: keep timings for words that survived, spread new ones over the cue
        toks = c["text"].split()
        if [w["w"] for w in words] != toks:
            n = max(1, len(toks))
            words = [{"w": t, "s": c["start"] + (c["end"] - c["start"]) * k / n, "e": c["start"] + (c["end"] - c["start"]) * (k + 1) / n, "hl": bool(re.search(r"\d", t) or EMPH.match(t))} for k, t in enumerate(toks)]
        up = (lambda t: t.upper()) if s.get("upper", True) else (lambda t: t)
        maxc = 14 if len(words) == 1 else 18
        lines = _lines([up(w["w"]) for w in words], maxc)
        anim = {"pop": r"\fscx82\fscy82\t(0,110,\fscx100\fscy100)", "bounce": r"\fscx60\fscy60\t(0,90,\fscx112\fscy112)\t(90,170,\fscx100\fscy100)",
                "fade": r"\fad(120,60)", "slide": r"\move(%d,%d,%d,%d,0,140)" % (x, y + 50, x, y), "none": ""}.get(s.get("anim", "none"), "")
        pos = "" if s.get("anim") == "slide" else rf"\pos({x},{y})"
        hl_col, base_col = _ass_color(s["highlight"]), _ass_color(s["color"])

        def render(active=None):
            parts, k = [], 0
            for ln in lines:
                seg = []
                for t in ln:
                    w = words[k]
                    on = (s.get("hl_mode") == "active" and k == active) or (s.get("hl_mode") == "keywords" and w.get("hl"))
                    seg.append((rf"{{\c{hl_col}}}" if on else "") + _esc(t) + (rf"{{\c{base_col}}}" if on else ""))
                    k += 1
                parts.append(" ".join(seg))
            return r"\N".join(parts)
        a, b = c["start"] + offset, c["end"] + offset
        if s.get("hl_mode") == "active" and len(words) > 1:
            for k, w in enumerate(words):
                ws = max(a, w["s"] + offset) if k else a
                we = b if k == len(words) - 1 else max(ws + 0.04, words[k + 1]["s"] + offset)
                out.append(f"Dialogue: 0,{tc(ws)},{tc(we)},{'C%d' % i if i in custom else 'Base'},,0,0,0,,{{{pos}{anim if k == 0 else ''}}}{render(k)}")
        else:
            out.append(f"Dialogue: 0,{tc(a)},{tc(b)},{'C%d' % i if i in custom else 'Base'},,0,0,0,,{{{pos}{anim}}}{render()}")
    return "\n".join(out) + "\n"
