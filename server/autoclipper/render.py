"""Renderer: 1080x1920 H.264/AAC vertical clips with ffmpeg.
Two outputs per render: 'clean' (layout + audio, no captions; the Review Queue overlays editable captions on it
for instant preview) and 'final' (clean + burned-in captions and hook)."""
import json
import os
import re

from . import captions, media

W, H = 1080, 1920
FONTS_DIR = os.environ.get("AC_FONTS_DIR", "")


def _even(x):
    return int(round(x / 2) * 2)


def geometry(layout, src_w, src_h):
    """Panels for a layout, in source pixels and output pixels. Also where captions may go."""
    kind = layout.get("layout", "blur")
    g = {"kind": kind, "panels": [], "caption_y": 0.66, "hook_y": 0.12}
    if kind in ("facecam_top", "facecam_bottom") and layout.get("facecam"):
        fc = layout["facecam"]
        cx, cy, cw, ch = fc["x"] * src_w, fc["y"] * src_h, max(16, fc["w"] * src_w), max(16, fc["h"] * src_h)
        th = _even(min(860, max(560, W * ch / cw)))
        bh = H - th
        # facecam crop: cover the panel aspect, centred on the window, inside the frame
        aspect = W / th
        if cw / ch < aspect:
            nh = cw / aspect; cy += (ch - nh) / 2; ch = nh
        else:
            nw = ch * aspect; cx += (cw - nw) / 2; cw = nw
        cam = [_even(cw), _even(ch), _even(max(0, min(src_w - cw, cx))), _even(max(0, min(src_h - ch, cy)))]
        # gameplay crop: panel aspect, full height when possible, slid away from the webcam
        gh = src_h; gw = gh * W / bh
        if gw > src_w:
            gw = src_w; gh = gw * bh / W
        gx = (src_w - gw) / 2
        fx0, fx1 = fc["x"] * src_w, (fc["x"] + fc["w"]) * src_w
        if gx < fx1 and gx + gw > fx0:  # overlaps the webcam column: move left or right if there is room
            if fx0 - gw >= 0 and fx0 > src_w / 2:
                gx = fx0 - gw
            elif fx1 + gw <= src_w and fx1 < src_w / 2:
                gx = fx1
        game = [_even(gw), _even(gh), _even(gx), _even((src_h - gh) / 2)]
        top = kind == "facecam_top"
        g["panels"] = [{"role": "facecam", "crop": cam, "out": [0, 0 if top else bh, W, th]}, {"role": "gameplay", "crop": game, "out": [0, th if top else 0, W, bh]}]
        # captions just below the seam (never over the face), hook over the gameplay
        g["caption_y"] = round((th + bh * 0.28) / H, 3) if top else round(bh * 0.62 / H, 3)
        g["hook_y"] = round((th + 110) / H, 3) if top else 0.09
        g["face_panel"] = [0, 0 if top else bh, W, th]
    elif kind == "track":
        cw = min(src_w, _even(src_h * 9 / 16)); ch = src_h if cw < src_w else _even(src_w * 16 / 9)
        g["panels"] = [{"role": "speaker", "crop": [cw, ch, None, 0], "out": [0, 0, W, H], "keys": layout.get("track") or [[0, 0.5]]}]
        g["caption_y"], g["hook_y"] = 0.70, 0.13
    elif kind == "split" and layout.get("speakers"):
        ph = H // 2
        panels = []
        for k, s in enumerate(layout["speakers"][:2]):
            cw = min(src_w, s["w"] * src_w * 3.2); chh = cw * ph / W
            if chh > src_h:
                chh = src_h; cw = chh * W / ph
            x = max(0, min(src_w - cw, s["cx"] * src_w - cw / 2)); y = max(0, min(src_h - chh, s["cy"] * src_h - chh * 0.42))
            panels.append({"role": f"speaker{k + 1}", "crop": [_even(cw), _even(chh), _even(x), _even(y)], "out": [0, k * ph, W, ph]})
        g["panels"] = panels
        g["caption_y"], g["hook_y"] = 0.5, 0.06
    else:
        g["kind"] = "blur"
        g["panels"] = [{"role": "full", "crop": [src_w, src_h, 0, 0], "out": [0, (H - _even(W * src_h / src_w)) // 2, W, _even(W * src_h / src_w)]}]
        g["caption_y"], g["hook_y"] = 0.72, 0.16
    return g


def _x_expr(keys, cw, src_w):
    """Piecewise-linear crop x(t) from tracking keyframes (normalised face centres)."""
    px = [(t, max(0, min(src_w - cw, x * src_w - cw / 2))) for t, x in keys]
    if len(px) == 1:
        return str(int(px[0][1]))
    e = str(int(px[-1][1]))
    for (t0, x0), (t1, x1) in reversed(list(zip(px, px[1:]))):
        e = f"if(lt(t,{t1}),{x0:.1f}+({x1 - x0:.1f})*(t-{t0})/{max(0.01, t1 - t0):.2f},{e})"
    return f"if(lt(t,{px[0][0]}),{px[0][1]:.1f},{e})"


def video_filter(g, src_w, src_h):
    p = g["panels"]
    if g["kind"] in ("facecam_top", "facecam_bottom"):
        a, b = p
        f = (f"[0:v]split=2[a][b];[a]crop={a['crop'][0]}:{a['crop'][1]}:{a['crop'][2]}:{a['crop'][3]},scale={W}:{a['out'][3]},setsar=1[pa];"
             f"[b]crop={b['crop'][0]}:{b['crop'][1]}:{b['crop'][2]}:{b['crop'][3]},scale={W}:{b['out'][3]},setsar=1[pb];")
        f += "[pa][pb]vstack=2" if a["out"][1] == 0 else "[pb][pa]vstack=2"
        return f + f",drawbox=x=0:y={a['out'][3] if a['out'][1] == 0 else b['out'][3]}-3:w={W}:h=6:color=black@0.9:t=fill[v]"
    if g["kind"] == "track":
        c = p[0]
        return f"[0:v]crop={c['crop'][0]}:{c['crop'][1]}:x='{_x_expr(c['keys'], c['crop'][0], src_w)}':y=0,scale={W}:{H},setsar=1[v]"
    if g["kind"] == "split":
        a, b = p
        return (f"[0:v]split=2[a][b];[a]crop={a['crop'][0]}:{a['crop'][1]}:{a['crop'][2]}:{a['crop'][3]},scale={W}:{a['out'][3]},setsar=1[pa];"
                f"[b]crop={b['crop'][0]}:{b['crop'][1]}:{b['crop'][2]}:{b['crop'][3]},scale={W}:{b['out'][3]},setsar=1[pb];[pa][pb]vstack=2[v]")
    fh = p[0]["out"][3]
    return (f"[0:v]split=2[bg][fg];[bg]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:2,eq=brightness=-0.10[bgb];"
            f"[fg]scale={W}:{fh},setsar=1[fgs];[bgb][fgs]overlay=0:{p[0]['out'][1]}[v]")


PRE = "highpass=f=70,acompressor=threshold=0.12:ratio=3:attack=5:release=180:makeup=2"


def measure(src):
    """Pass 1 of two-pass loudness: measure after the same pre-processing, so pass 2 can normalise linearly.
    One-pass loudnorm undershoots on short clips (it adapts as it goes)."""
    p = media.sh([media.FFMPEG, "-v", "info", "-i", src, "-af", PRE + ",loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], check=False, timeout=900)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr.decode(errors="ignore"), re.S)
    try:
        j = json.loads(m.group(0))
        vals = {k: float(j[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
        return vals if vals["input_i"] > -70 else None
    except Exception:
        return None


def audio_filter(dur, sfx=(), measured=None):
    ln = "loudnorm=I=-14:TP=-1.5:LRA=11"
    if measured:
        ln += (f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}"
               f":measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true")
    chain = PRE + "," + ln
    if not sfx:
        return f"[0:a]{chain},afade=t=out:st={max(0, dur - 0.25):.2f}:d=0.25[a]", []
    srcs, mix = [], ["[m0]"]
    f = f"[0:a]{chain}[m0];"
    for k, s in enumerate(sfx):
        if s.get("kind") == "whoosh":
            srcs.append(["-f", "lavfi", "-t", "0.45", "-i", "anoisesrc=color=pink:amplitude=0.25:d=0.45"])
            f += f"[{k + 1}:a]bandpass=f=1400:width_type=o:w=2,afade=t=in:d=0.2,afade=t=out:st=0.2:d=0.25,adelay={int(s['t'] * 1000)}|{int(s['t'] * 1000)}[s{k}];"
        else:  # short pop
            srcs.append(["-f", "lavfi", "-t", "0.12", "-i", "sine=frequency=880:duration=0.12"])
            f += f"[{k + 1}:a]volume=0.25,afade=t=out:st=0.04:d=0.08,adelay={int(s['t'] * 1000)}|{int(s['t'] * 1000)}[s{k}];"
        mix.append(f"[s{k}]")
    f += f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=first,afade=t=out:st={max(0, dur - 0.25):.2f}:d=0.25[a]"
    return f, srcs


def render(src, layout, cues, st, workdir, hook=None, sfx=(), name="clip"):
    """Render clean + final. Returns paths and the geometry used (the framing checker reads it)."""
    info = media.probe(src)
    g = geometry(layout, info["width"], info["height"])
    os.makedirs(workdir, exist_ok=True)
    clean = os.path.join(workdir, f"{name}_clean.mp4")
    final = os.path.join(workdir, f"{name}.mp4")
    af, extra = audio_filter(info["duration"], sfx if info["has_audio"] else (), measure(src) if info["has_audio"] else None)
    fc = video_filter(g, info["width"], info["height"])
    args = [media.FFMPEG, "-y", "-v", "error", "-i", src]
    for e in extra:
        args += e
    if info["has_audio"]:
        args += ["-filter_complex", fc + ";" + af, "-map", "[v]", "-map", "[a]"]
    else:
        args += ["-filter_complex", fc, "-map", "[v]"]
    args += ["-r", "30", "-c:v", "libx264", "-preset", os.environ.get("AC_X264_PRESET", "veryfast"), "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", f"{info['duration']:.3f}", clean]
    media.sh(args, timeout=3600)
    # captions + hook burned into the final file
    ass_path = os.path.join(workdir, f"{name}.ass")
    text = captions.ass(cues, st, y_frac=g["caption_y"])
    if hook and hook.get("text"):
        text = text.replace("\n\n[Events]", "\n" + HOOK_STYLE + "\n\n[Events]", 1) + hook_event(hook["text"], g["hook_y"], hook.get("until", 2.6))
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(text)
    _burn(workdir, clean, final, ass_path)
    return {"clean": clean, "final": final, "ass": ass_path, "geometry": g, "duration": info["duration"]}


def _burn(workdir, clean, final, ass_path):
    sub = f"subtitles=filename={os.path.basename(ass_path)}" + (f":fontsdir={FONTS_DIR}" if FONTS_DIR else "")
    import subprocess
    p = subprocess.run([media.FFMPEG, "-y", "-v", "error", "-i", os.path.basename(clean), "-vf", sub, "-c:v", "libx264", "-preset", os.environ.get("AC_X264_PRESET", "veryfast"),
                        "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", os.path.basename(final)], cwd=workdir, capture_output=True, timeout=3600)
    if p.returncode:
        raise media.MediaError("caption burn failed: " + p.stderr.decode(errors="ignore")[-400:])


HOOK_STYLE = "Style: Hook,Anton,70,&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,-1,3,18,0,5,80,80,80,1"


def hook_event(text, y_frac, until=2.6):
    t = text.upper().replace("{", "(").replace("}", ")")
    return f"Dialogue: 1,0:00:00.00,0:00:{until:05.2f},Hook,,0,0,0,,{{\\pos({W // 2},{int(y_frac * H)})\\fscx85\\fscy85\\t(0,120,\\fscx100\\fscy100)\\fad(0,200)}}{t}\n"
