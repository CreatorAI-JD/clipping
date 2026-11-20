"""Quality Assurance: independent checkers that inspect the actual rendered file.
Each problem is a ticket: checker, problem, severity, timestamp, required action, assigned specialist, fix.
A checker that cannot run says 'unverified'; that is never counted as a pass."""
import numpy as np

from . import ai, captions, media, vision

CHECKERS = ["caption_accuracy", "caption_timing", "facecam", "framing", "audio", "hook", "context", "pacing", "consistency", "rights", "guidelines", "integrity"]
NAMES = {"caption_accuracy": "Caption accuracy", "caption_timing": "Caption timing", "facecam": "Facecam positioning", "framing": "Visual framing", "audio": "Audio clarity",
         "hook": "Hook strength", "context": "Context", "pacing": "Pacing", "consistency": "Editing consistency", "rights": "Rights & permissions", "guidelines": "Platform guidelines", "integrity": "Rendering integrity"}
OWNER = {"caption_accuracy": "captions", "caption_timing": "captions", "facecam": "visual", "framing": "visual", "audio": "audio", "hook": "hook", "context": "context",
         "pacing": "retention", "consistency": "visual", "rights": "rights", "guidelines": "guidelines", "integrity": "visual"}
FIX = {"caption_accuracy": "rebuild_captions", "caption_timing": "retime_captions", "facecam": "reframe", "framing": "reframe", "audio": "audio", "hook": "trim_start",
       "pacing": "jump_cuts", "integrity": "rerender", "consistency": "rerender"}


def ts(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def align(ref, hyp):
    """Longest common subsequence alignment of two word lists -> matched index pairs."""
    a = [w.lower().strip(".,!?;:'\"") for w in ref]
    b = [w.lower().strip(".,!?;:'\"") for w in hyp]
    n, m = len(a), len(b)
    if not n or not m:
        return []
    dp = np.zeros((n + 1, m + 1), dtype=np.int32)
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i, j] = dp[i + 1, j + 1] + 1 if a[i] == b[j] else max(dp[i + 1, j], dp[i, j + 1])
    i = j = 0
    pairs = []
    while i < n and j < m:
        if a[i] == b[j]:
            pairs.append((i, j)); i += 1; j += 1
        elif dp[i + 1, j] >= dp[i, j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def heard(path, workdir, ref):
    wav = path.rsplit(".", 1)[0] + "_qc.wav"
    media.wav16k(path, wav)
    return ai.transcribe(wav, ref=ref)


def run(clip, render_out, workdir, creator=None, min_len=8, max_len=90):
    final = render_out["final"]
    g = render_out["geometry"]
    cues = clip["captions"]
    B = {k: {"status": "pass", "score": 100, "method": "", "notes": "", "tickets": []} for k in CHECKERS}
    T = lambda k, problem, sev, at, action: B[k]["tickets"].append({"checker": k, "name": NAMES[k], "problem": problem, "severity": sev, "at": at, "action": action, "agent": OWNER[k], "fix": FIX.get(k)})

    # integrity first
    info = media.probe(final)
    B["integrity"]["method"] = "ffprobe + black/freeze detection on the final file"
    if info["width"] != 1080 or info["height"] != 1920:
        T("integrity", f"Video is {info['width']}x{info['height']}, not 1080x1920", "high", "", "Re-render at 1080x1920.")
    if not info["has_audio"]:
        T("integrity", "No audio track in the render", "high", "", "Re-render with audio.")
    if abs(info["duration"] - render_out["duration"]) > 1.0:
        T("integrity", f"Render is {info['duration']:.1f}s, expected {render_out['duration']:.1f}s", "high", "", "Re-render.")
    for a, b in media.blacks(final):
        if b - a >= 0.4:
            T("integrity", f"Black screen for {b - a:.1f}s", "high", f"{ts(a)}-{ts(b)}", "Re-render; check the source segment.")
    for a, b in media.freezes(final):
        if b is None or b - a >= 3:
            T("integrity", "Frozen picture", "medium", ts(a), "Check the source; re-render.")

    # audio
    L = media.loudness(final)
    B["audio"]["method"] = "integrated loudness, true peak and long silences measured on the final file"
    if L:
        B["audio"]["notes"] = f"{L['lufs']:.1f} LUFS, true peak {L['true_peak']:.1f} dBTP"
        if L["lufs"] < -18 or L["lufs"] > -10:
            T("audio", f"Loudness {L['lufs']:.1f} LUFS (target -14)", "medium" if -20 < L["lufs"] < -8 else "high", "", "Re-level the mix.")
        if L["true_peak"] > -0.5:
            T("audio", f"True peak {L['true_peak']:.1f} dBTP: risk of distortion", "medium", "", "Lower the limiter ceiling.")
    else:
        B["audio"]["status"] = "unverified"
    sil = media.silences(final, noise="-40dB", d=1.2) if info["has_audio"] else []
    dead = sum(b - a for a, b in sil)
    B["pacing"]["method"] = "silence detection on the final file"
    B["pacing"]["notes"] = f"{dead:.1f}s of silence"
    for a, b in sil:
        if b - a >= 1.5 and a > 0.5 and b < info["duration"] - 0.5:
            T("pacing", f"Dead air for {b - a:.1f}s", "high" if b - a >= 2.5 else "medium", f"{ts(a)}-{ts(b)}", "Jump-cut the pause.")
    if info["duration"] and dead / info["duration"] > 0.3:
        T("pacing", f"{round(100 * dead / info['duration'])}% of the clip is silent", "high", "", "Tighten the cut.")

    # captions vs what is heard in the final file
    tr = heard(final, workdir, clip["id"]) if ai.enabled() and info["has_audio"] else None
    capw = [(w, i) for i, c in enumerate(cues) for w in c["text"].split()]
    if not cues:
        B["caption_accuracy"]["status"] = B["caption_timing"]["status"] = "unverified"
        B["caption_accuracy"]["notes"] = "No captions (no transcription available)"
        T("caption_accuracy", "Clip has no captions", "medium", "", "Add an OpenAI key so the audio can be transcribed.")
    elif tr is None:
        B["caption_accuracy"]["status"] = "unverified"
        B["caption_accuracy"]["notes"] = "Needs an OpenAI key to listen to the final file"
    else:
        B["caption_accuracy"]["method"] = "final audio re-transcribed and aligned word by word with the captions"
        pairs = align([w for w, _ in capw], [w["word"] for w in tr["words"]])
        acc = len(pairs) / max(1, len(capw))
        B["caption_accuracy"]["score"] = round(acc * 100)
        B["caption_accuracy"]["notes"] = f"{round(acc * 100)}% of caption words heard"
        matched = {p[0] for p in pairs}
        bad = sorted({capw[k][1] for k in range(len(capw)) if k not in matched})
        if acc < 0.8:
            T("caption_accuracy", f"Captions don't match the audio ({round(acc * 100)}% heard)", "high", f"{ts(cues[bad[0]]['start'])}-{ts(cues[bad[-1]]['end'])}" if bad else "", "Re-transcribe and rebuild the captions.")
        elif len(bad) > 2:
            T("caption_accuracy", f"{len(bad)} captions contain words that are not heard", "medium", f"{ts(cues[bad[0]]['start'])}-{ts(cues[bad[-1]]['end'])}", "Correct the affected captions.")
        B["caption_timing"]["method"] = "caption start vs when its first word is heard"
        offs = []
        for ci, hi in pairs:
            qi = capw[ci][1]
            if next(k for k, (_, q) in enumerate(capw) if q == qi) == ci:
                offs.append((qi, cues[qi]["start"] - tr["words"][hi]["start"]))
        if offs:
            med = float(np.median([abs(d) for _, d in offs]))
            B["caption_timing"]["notes"] = f"median offset {med * 1000:.0f} ms"
            B["caption_timing"]["score"] = max(0, round(100 - med * 200))
            late = [q for q, d in offs if abs(d) > 0.4]
            if med > 0.3:
                T("caption_timing", f"Captions are out of sync by about {med:.2f}s", "high", f"{ts(cues[late[0]]['start'])}-{ts(cues[late[-1]]['end'])}" if late else "", "Re-time captions to the final audio.")
            elif len(late) > 1:
                T("caption_timing", f"{len(late)} captions off by more than 0.4s", "medium", f"{ts(cues[late[0]]['start'])}-{ts(cues[late[-1]]['end'])}", "Re-time those captions.")
    clip["_heard"] = tr

    # facecam + framing: watch the rendered frames
    frs, tms = media.frames(final, fps=2, width=540)
    B["facecam"]["method"] = f"face detection on {len(frs)} frames of the final render ({vision.detector_name()})"
    sc = 540 / 1080
    fp = g.get("face_panel")
    if g["kind"] in ("facecam_top", "facecam_bottom") and fp:
        x0, y0, w0, h0 = [v * sc for v in fp]
        inside, cut, tiny, bad_t = 0, 0, 0, []
        for f, t in zip(frs, tms):
            fs = [b for b in vision.faces(f)]
            H_, W_ = f.shape[:2]
            hit = None
            for b in fs:
                bx, by, bw, bh = b[0] * W_, b[1] * H_, b[2] * W_, b[3] * H_
                if y0 <= by + bh / 2 <= y0 + h0:
                    hit = (bx, by, bw, bh)
                    break
            if hit:
                inside += 1
                bx, by, bw, bh = hit
                if by < y0 + 2 or by + bh > y0 + h0 - 2 or bx < 2 or bx + bw > W_ - 2:
                    cut += 1; bad_t.append(t)
                if bh < h0 * 0.18:
                    tiny += 1
            else:
                bad_t.append(t)
        n = max(1, len(frs))
        B["facecam"]["score"] = round(100 * inside / n)
        B["facecam"]["notes"] = f"face inside the facecam panel in {inside}/{n} frames"
        if inside / n < 0.6:
            T("facecam", f"Streamer's face is not inside the facecam panel ({inside}/{n} frames)", "high", ts(bad_t[0]) if bad_t else "", "Re-detect the webcam window and reframe.")
        if cut / n > 0.2:
            T("facecam", f"Face is cut off at the panel edge in {cut} frames", "high", ts(bad_t[0]) if bad_t else "", "Widen the facecam crop.")
        if inside and tiny / max(1, inside) > 0.5:
            T("facecam", "Face is very small in the facecam panel", "medium", "", "Crop tighter on the webcam.")
    elif g["kind"] == "track":
        seen = sum(1 for f in frs if vision.faces(f))
        B["facecam"]["score"] = round(100 * seen / max(1, len(frs)))
        B["facecam"]["notes"] = f"speaker visible in {seen}/{len(frs)} frames"
        if seen / max(1, len(frs)) < 0.6:
            T("facecam", "Speaker is out of frame in many frames", "high", "", "Re-run speaker tracking.")
    else:
        B["facecam"]["status"] = "pass"
        B["facecam"]["notes"] = "No facecam in this layout"
    B["framing"]["method"] = "layout geometry: caption/hook vs face panel, safe zones, gameplay crop vs webcam"
    cy = g["caption_y"]
    if fp and fp[1] / 1920 <= cy <= (fp[1] + fp[3]) / 1920:
        T("framing", "Captions sit on top of the facecam", "high", "", "Move captions below the facecam panel.")
    for c in cues:
        y = (c.get("pos") or {}).get("y", cy)
        if y < 0.08 or y > 0.80:
            T("framing", f"Caption '{c['text'][:20]}' outside the safe zone (y={y:.2f})", "medium", ts(c["start"]), "Move it between 8% and 80% of the height.")
            break
        if fp and fp[1] / 1920 <= y <= (fp[1] + fp[3]) / 1920:
            T("framing", f"Caption '{c['text'][:20]}' covers the facecam", "high", ts(c["start"]), "Move it off the facecam panel.")
            break
    if g["kind"] in ("facecam_top", "facecam_bottom") and clip["layout"].get("facecam"):
        game = next(p for p in g["panels"] if p["role"] == "gameplay")
        fc, sw = clip["layout"]["facecam"], clip["layout"]["source"]["w"]
        gx0, gx1 = game["crop"][2] / sw, (game["crop"][2] + game["crop"][0]) / sw
        ov = max(0, min(gx1, fc["x"] + fc["w"]) - max(gx0, fc["x"])) / max(1e-6, fc["w"])
        if ov > 0.5:
            T("framing", "Gameplay panel also shows the webcam (duplicated face)", "medium", "", "Slide the gameplay crop away from the webcam.")

    # hook: energy/speech in the first 2.5 s
    s = media.pcm(final, 8000, 0, 3) if info["has_audio"] else []
    env = media.envelope(s, 8000, 0.25) if len(s) else []
    whole = media.envelope(media.pcm(final, 8000), 8000, 0.25) if info["has_audio"] else []
    B["hook"]["method"] = "audio activity in the first 2.5 s vs the whole clip + hook text"
    if len(whole) and len(env):
        act = float((env[:10] > np.percentile(whole, 50)).mean())
        B["hook"]["score"] = round(40 + 60 * act)
        if act < 0.3:
            T("hook", "Nothing is happening in the first 2.5 seconds", "high", "00:00-00:02.5", "Start later, on the first line of the setup.")
    if len((clip.get("research") or {}).get("hook_text", "").split()) > 9:
        T("hook", "On-screen hook is too long to read", "medium", "00:00", "Cut it to 8 words.")

    # context
    sc_ = clip.get("scores") or {}
    B["context"]["method"] = "Clip Scout context score + flagged concerns"
    if sc_.get("context") is None:
        B["context"]["status"] = "unverified"
        B["context"]["notes"] = "Context needs the AI analyst (OpenAI key)"
    elif sc_["context"] < 5:
        T("context", f"May not make sense on its own (context {sc_['context']}/10)", "medium", "", "Widen the window to include the setup.")
    for cn in (clip.get("research") or {}).get("concerns") or []:
        T("context", f"Concern: {cn}", "high" if any(w in str(cn).lower() for w in ("slur", "threat", "personal", "dox")) else "medium", "", "A person should check this.")

    # consistency
    B["consistency"]["method"] = "format, frame rate, length and caption style"
    if info["fps"] and abs(info["fps"] - 30) > 1:
        T("consistency", f"Frame rate {info['fps']} (expected 30)", "medium", "", "Re-render at 30 fps.")
    if info["duration"] < min_len or info["duration"] > max_len:
        T("consistency", f"Length {info['duration']:.0f}s outside {min_len}-{max_len}s", "medium", "", "Adjust the cut.")

    # rights
    B["rights"]["method"] = "creator permission record"
    perm = (creator or {}).get("permission") or (clip.get("research") or {}).get("source_permission")
    if perm not in ("granted", "own", "attested"):
        T("rights", f"No clipping permission on record (permission: {perm or 'none'})", "high", "", "Record permission for this creator, or reject the clip.")

    # guidelines
    text = " ".join(c["text"] for c in cues) + " " + (clip.get("title") or "")
    mod = ai.moderate(text, ref=clip["id"]) if text.strip() else None
    B["guidelines"]["method"] = "safety scan of what is said and written"
    if mod is None:
        B["guidelines"]["status"] = "unverified"
        B["guidelines"]["notes"] = "Needs an OpenAI key (moderation is free)"
    elif mod["flagged"]:
        T("guidelines", "Safety scan flagged: " + ", ".join(mod["categories"]), "high", "", "A person must decide.")

    for k, b in B.items():
        hi = sum(t["severity"] == "high" for t in b["tickets"]); me = sum(t["severity"] == "medium" for t in b["tickets"])
        if b["status"] != "unverified":
            b["status"] = "fail" if hi else "warn" if me else "pass"
            b["score"] = min(b["score"], max(0, 100 - 40 * hi - 12 * me))
        else:
            b["score"] = None
    scored = [b["score"] for b in B.values() if b["score"] is not None]
    tickets = [t for b in B.values() for t in b["tickets"]]
    return {"board": B, "tickets": tickets, "overall": round(sum(scored) / max(1, len(scored))), "unverified": [k for k, b in B.items() if b["status"] == "unverified"]}
