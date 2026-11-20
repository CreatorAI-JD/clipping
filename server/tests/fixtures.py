"""Synthetic test sources (no downloads): gameplay with a webcam overlay, an IRL single-person stream, gameplay only.
The face is the public-domain NASA astronaut portrait bundled with scikit-image."""
import os
import subprocess

import numpy as np
from PIL import Image
from skimage import data

FF = os.environ.get("AC_FFMPEG", "ffmpeg")


def _run(args):
    subprocess.run(args, check=True, capture_output=True)


def face_png(path, size=(480, 360), crop=(0, 0, 330, 260)):
    img = Image.fromarray(data.astronaut()).crop((60, 0, 390, 260)).resize(size)
    img.save(path)
    return path


def audio_expr(dur, bursts=((8, 11), (21, 24))):
    loud = "+".join(f"0.8*between(t\\,{a}\\,{b})" for a, b in bursts) or "0"
    return f"aevalsrc='(0.06+{loud})*sin(2*PI*(220+120*sin(3*t))*t)':s=44100:d={dur}"


def gameplay_with_facecam(dst, dur=30, cam=(1400, 40, 480, 360), bursts=((8, 11), (21, 24))):
    d = os.path.dirname(dst)
    face = face_png(os.path.join(d, "face_cam.png"), size=(cam[2], cam[3]))
    x, y, w, h = cam
    _run([FF, "-y", "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={dur}", "-loop", "1", "-i", face, "-f", "lavfi", "-i", audio_expr(dur, bursts),
          "-filter_complex", f"[1:v]scale={w}:{h},drawbox=x=0:y=0:w={w}:h={h}:color=white:t=6[cam];[0:v][cam]overlay={x}:{y}:shortest=1[v]",
          "-map", "[v]", "-map", "2:a", "-t", str(dur), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", dst])
    return dst


def irl_single(dst, dur=20):
    d = os.path.dirname(dst)
    face = face_png(os.path.join(d, "face_big.png"), size=(1100, 870))
    _run([FF, "-y", "-f", "lavfi", "-i", f"color=c=0x334455:size=1920x1080:rate=30:duration={dur}", "-loop", "1", "-i", face, "-f", "lavfi", "-i", audio_expr(dur, ((5, 8),)),
          "-filter_complex", "[0:v][1:v]overlay=x='300+200*sin(t/3)':y=100:shortest=1[v]", "-map", "[v]", "-map", "2:a", "-t", str(dur),
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", dst])
    return dst


def gameplay_only(dst, dur=20):
    _run([FF, "-y", "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={dur}", "-f", "lavfi", "-i", audio_expr(dur, ((6, 9),)),
          "-t", str(dur), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", dst])
    return dst


# ---------------- "speech" that a fake transcriber can really hear ----------------
# Each word is a 0.28 s tone; its pitch encodes which word it is, so word timing survives cuts and renders.
VOCAB = ["oh", "my", "god", "he", "did", "not", "see", "that", "coming", "chat", "was", "insane", "no", "way", "bro", "wait", "look", "at", "this", "car"]
F0, STEP = 500.0, 60.0


def word_freq(k):
    return F0 + STEP * k


def speech_wav(path, dur, phrases, rate=44100, loud=()):
    """phrases: [(start_s, [word indexes])]; loud: [(a, b)] louder sections (reactions)."""
    import wave
    t = np.arange(int(dur * rate)) / rate
    x = 0.02 * np.sin(2 * np.pi * 110 * t)  # quiet game hum
    words = []
    for start, ids in phrases:
        for j, k in enumerate(ids):
            a = start + j * 0.42
            i0, i1 = int(a * rate), int((a + 0.28) * rate)
            if i1 >= len(x):
                break
            env = np.hanning(i1 - i0)
            amp = 0.35
            for la, lb in loud:
                if la <= a <= lb:
                    amp = 0.85
            x[i0:i1] += amp * env * np.sin(2 * np.pi * word_freq(k) * t[i0:i1])
            words.append({"word": VOCAB[k], "start": round(a, 3), "end": round(a + 0.28, 3)})
    x = np.clip(x, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((x * 32767).astype(np.int16).tobytes())
    return words


def hear(wav_bytes):
    """What the fake Whisper 'hears' in a 16 kHz WAV: one word per tone, identified by its pitch."""
    import io
    import wave
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    win = int(rate * 0.02)
    n = len(x) // win
    if n < 3:
        return []
    e = np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(axis=1))
    thr = max(0.05, np.percentile(e, 50) * 3)
    on = e > thr
    out, i = [], 0
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            if (j - i) * 0.02 >= 0.12:
                seg = x[i * win: j * win]
                spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
                f = np.fft.rfftfreq(len(seg), 1 / rate)[int(spec.argmax())]
                k = int(round((f - F0) / STEP))
                if 0 <= k < len(VOCAB) and abs(f - word_freq(k)) < STEP * 0.35:
                    out.append({"word": VOCAB[k], "start": round(i * 0.02, 3), "end": round(j * 0.02, 3)})
            i = j
        else:
            i += 1
    return out


def stream_fixture(dst, dur=40, cam=(1400, 40, 480, 360)):
    """Gameplay + webcam + speech: a quiet complete sentence early, a loud reaction later."""
    d = os.path.dirname(dst)
    wav = os.path.join(d, os.path.basename(dst) + ".wav")
    phr = [(4.0, [3, 4, 1, 1, 18, 19]), (12.0, [15, 16, 17, 18, 19]), (24.0, [0, 1, 2, 3, 4, 5, 6, 7, 8]), (29.0, [9, 7, 10, 11, 12, 13, 14])]
    words = speech_wav(wav, dur, phr, loud=((24, 33),))
    face = face_png(os.path.join(d, "face_cam.png"), size=(cam[2], cam[3]))
    x, y, w, h = cam
    _run([FF, "-y", "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={dur}", "-loop", "1", "-i", face, "-i", wav,
          "-filter_complex", f"[1:v]scale={w}:{h},drawbox=x=0:y=0:w={w}:h={h}:color=white:t=6[cam];[0:v][cam]overlay={x}:{y}:shortest=1[v]",
          "-map", "[v]", "-map", "2:a", "-t", str(dur), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", dst])
    return dst, words


def podcast_two(dst, dur=30):
    """Two people side by side (podcast / interview), with speech."""
    d = os.path.dirname(dst)
    wav = os.path.join(d, os.path.basename(dst) + ".wav")
    words = speech_wav(wav, dur, [(2.0, [15, 16, 17, 18, 19]), (6.0, [3, 4, 5, 6, 7, 8]), (12.0, [12, 13, 14, 9, 10, 11]), (20.0, [0, 1, 2])], loud=((12, 15),))
    a = face_png(os.path.join(d, "p1.png"), size=(720, 900))
    Image.open(a).transpose(Image.FLIP_LEFT_RIGHT).save(os.path.join(d, "p2.png"))
    _run([FF, "-y", "-f", "lavfi", "-i", f"color=c=0x2a2f3a:size=1920x1080:rate=30:duration={dur}", "-loop", "1", "-i", a, "-loop", "1", "-i", os.path.join(d, "p2.png"), "-i", wav,
          "-filter_complex", "[0:v][1:v]overlay=150:90:shortest=1[t];[t][2:v]overlay=1050:90:shortest=1[v]", "-map", "[v]", "-map", "3:a", "-t", str(dur),
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", dst])
    return dst, words


def irl_speech(dst, dur=30):
    d = os.path.dirname(dst)
    wav = os.path.join(d, os.path.basename(dst) + ".wav")
    words = speech_wav(wav, dur, [(3.0, [15, 16, 17, 18]), (9.0, [0, 1, 2, 3, 4, 5, 6, 7, 8]), (16.0, [12, 13, 14])], loud=((9, 13),))
    face = face_png(os.path.join(d, "face_big.png"), size=(1100, 870))
    _run([FF, "-y", "-f", "lavfi", "-i", f"color=c=0x334455:size=1920x1080:rate=30:duration={dur}", "-loop", "1", "-i", face, "-i", wav,
          "-filter_complex", "[0:v][1:v]overlay=x='300+200*sin(t/3)':y=100:shortest=1[v]", "-map", "[v]", "-map", "2:a", "-t", str(dur),
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", dst])
    return dst, words
