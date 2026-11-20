"""ffmpeg / ffprobe helpers. All media work runs on the server (no browser)."""
import json
import os
import re
import subprocess

import numpy as np

FFMPEG = os.environ.get("AC_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("AC_FFPROBE", "ffprobe")


class MediaError(RuntimeError):
    pass


def sh(args, timeout=3600, check=True):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise MediaError(f"{os.path.basename(args[0])} failed: {p.stderr.decode(errors='ignore')[-600:]}")
    return p


def probe(path):
    p = sh([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=120)
    j = json.loads(p.stdout or b"{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    dur = float(j.get("format", {}).get("duration") or (v or {}).get("duration") or 0)
    fps = 0.0
    if v and v.get("avg_frame_rate", "0/0") != "0/0":
        n, d = v["avg_frame_rate"].split("/")
        fps = float(n) / float(d or 1)
    return {"duration": dur, "width": int(v["width"]) if v else 0, "height": int(v["height"]) if v else 0, "fps": round(fps, 2),
            "vcodec": v and v.get("codec_name"), "acodec": a and a.get("codec_name"), "has_audio": bool(a), "size": int(j.get("format", {}).get("size") or 0)}


def extract(src, dst, start, end, reencode=True):
    """Cut [start, end] from a source. Re-encodes so the cut is frame-accurate."""
    args = [FFMPEG, "-y", "-v", "error", "-ss", f"{max(0, start):.3f}", "-i", src, "-t", f"{max(0.1, end - start):.3f}"]
    args += (["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"] if reencode else ["-c", "copy"])
    sh(args + [dst])
    return dst


def wav16k(src, dst, start=None, dur=None):
    args = [FFMPEG, "-y", "-v", "error"]
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", src]
    if dur is not None:
        args += ["-t", f"{dur:.3f}"]
    sh(args + ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst])
    return dst


def pcm(src, rate=8000, start=None, dur=None):
    """Mono float32 samples (for energy / speech analysis)."""
    args = [FFMPEG, "-v", "error"]
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", src]
    if dur is not None:
        args += ["-t", f"{dur:.3f}"]
    p = sh(args + ["-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"], timeout=7200)
    return np.frombuffer(p.stdout, dtype=np.float32)


def envelope(samples, rate=8000, win=0.5):
    n = int(rate * win)
    if len(samples) < n:
        return np.array([20 * np.log10(np.sqrt(np.mean(samples ** 2)) + 1e-9)]) if len(samples) else np.array([-120.0])
    k = len(samples) // n
    x = samples[: k * n].reshape(k, n)
    return 20 * np.log10(np.sqrt((x ** 2).mean(axis=1)) + 1e-9)


def frames(src, fps=1.0, width=480, start=None, dur=None):
    """RGB frames as numpy arrays (sampled), with their timestamps."""
    info = probe(src)
    if not info["width"]:
        return [], []
    h = int(round(info["height"] * width / info["width"] / 2) * 2)
    args = [FFMPEG, "-v", "error"]
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", src]
    if dur is not None:
        args += ["-t", f"{dur:.3f}"]
    p = sh(args + ["-vf", f"fps={fps},scale={width}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], timeout=3600)
    buf = np.frombuffer(p.stdout, dtype=np.uint8)
    size = width * h * 3
    n = len(buf) // size
    arr = buf[: n * size].reshape(n, h, width, 3)
    t0 = start or 0.0
    return [arr[i] for i in range(n)], [t0 + i / fps for i in range(n)]


def loudness(src):
    """Integrated loudness (LUFS), true peak (dBTP), loudness range."""
    p = sh([FFMPEG, "-v", "info", "-i", src, "-af", "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json", "-f", "null", "-"], check=False, timeout=1800)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr.decode(errors="ignore"), re.S)
    if not m:
        return None
    j = json.loads(m.group(0))
    f = lambda k: float(j[k]) if j.get(k) not in (None, "-inf", "inf") else -99.0
    return {"lufs": f("input_i"), "true_peak": f("input_tp"), "lra": f("input_lra")}


def detect(src, flt, pattern, audio=False):
    p = sh([FFMPEG, "-v", "info", "-i", src, "-af" if audio else "-vf", flt, "-f", "null", "-"], check=False, timeout=1800)
    return re.findall(pattern, p.stderr.decode(errors="ignore"))


def silences(src, noise="-38dB", d=0.6):
    out = detect(src, f"silencedetect=noise={noise}:d={d}", r"silence_(start|end): ([\d.]+)", audio=True)
    res, cur = [], None
    for k, v in out:
        if k == "start":
            cur = float(v)
        elif cur is not None:
            res.append((cur, float(v)))
            cur = None
    return res


def blacks(src):
    return [(float(a), float(b)) for a, b in detect(src, "blackdetect=d=0.3:pix_th=0.10", r"black_start:([\d.]+) black_end:([\d.]+)")]


def freezes(src):
    st = [float(x) for x in detect(src, "freezedetect=n=0.003:d=2", r"freeze_start: ([\d.]+)")]
    en = [float(x) for x in detect(src, "freezedetect=n=0.003:d=2", r"freeze_end: ([\d.]+)")]
    return list(zip(st, en + [None] * (len(st) - len(en))))


def thumb(src, dst, t=1.0, width=540):
    sh([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1", "-vf", f"scale={width}:-2", dst])
    return dst
