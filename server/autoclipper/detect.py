"""Video Intelligence + Clip Scout: find candidate moments in a whole source and rank them.

Tier 1 (cheap, always): audio energy bursts over the entire source, sustained-speech windows (conversations),
          chat-velocity spikes (live), visual activity.
Tier 2 (paid, only for candidates): word-level transcription of each candidate window (or the whole source in
          Deep analysis).
Tier 3 (paid, only for candidates): an analyst scores every candidate on 10 dimensions, compared side by side,
          with a category profile. Loudness is one signal, never the decision.
Unknown dimensions stay unknown (None) instead of being guessed."""
import json
import os

import numpy as np

from . import ai, db, media

DIMS = ["hook", "entertainment", "context", "story", "emotion", "relevance", "replay", "pacing", "audio", "visual"]
PROFILES = {  # how much each dimension counts per content category (learning adjusts these over time)
    "default": {"hook": 1.3, "entertainment": 1.2, "context": 1.2, "story": 1.1, "emotion": 1.0, "relevance": 1.0, "replay": 0.9, "pacing": 0.9, "audio": 0.7, "visual": 0.6},
    "gaming": {"hook": 1.4, "entertainment": 1.4, "context": 1.0, "story": 0.9, "emotion": 1.1, "relevance": 1.0, "replay": 1.1, "pacing": 1.0, "audio": 0.6, "visual": 0.8},
    "podcast": {"hook": 1.3, "entertainment": 1.0, "context": 1.5, "story": 1.4, "emotion": 1.0, "relevance": 1.2, "replay": 0.7, "pacing": 1.1, "audio": 1.0, "visual": 0.3},
    "irl": {"hook": 1.4, "entertainment": 1.3, "context": 1.2, "story": 1.1, "emotion": 1.3, "relevance": 0.9, "replay": 1.0, "pacing": 1.0, "audio": 0.8, "visual": 0.7},
    "sports": {"hook": 1.4, "entertainment": 1.2, "context": 1.1, "story": 0.9, "emotion": 1.4, "relevance": 1.2, "replay": 1.2, "pacing": 1.0, "audio": 0.7, "visual": 0.7},
    "interview": {"hook": 1.2, "entertainment": 0.9, "context": 1.5, "story": 1.4, "emotion": 1.0, "relevance": 1.3, "replay": 0.7, "pacing": 1.0, "audio": 1.0, "visual": 0.3},
    "comedy": {"hook": 1.4, "entertainment": 1.6, "context": 1.1, "story": 1.0, "emotion": 1.1, "relevance": 0.9, "replay": 1.3, "pacing": 1.2, "audio": 0.7, "visual": 0.4},
    "educational": {"hook": 1.3, "entertainment": 0.8, "context": 1.5, "story": 1.3, "emotion": 0.7, "relevance": 1.4, "replay": 0.8, "pacing": 1.1, "audio": 1.0, "visual": 0.5},
}


def profile(category):
    learned = db.setting("profile_weights", {}) or {}
    base = PROFILES.get((category or "").lower(), PROFILES["default"])
    adj = learned.get((category or "").lower()) or learned.get("default") or {}
    return {k: round(base[k] * adj.get(k, 1.0), 3) for k in DIMS}


def rank(scores, category=None):
    """Weighted mean of the dimensions that are known."""
    w = profile(category)
    num = sum(scores[k] * w[k] for k in DIMS if scores.get(k) is not None)
    den = sum(w[k] for k in DIMS if scores.get(k) is not None)
    return round(num / den, 2) if den else 0.0


# ---------------- tier 1 ----------------
def energy_candidates(env, win=0.5, clip_len=35.0, count=8):
    n = len(env)
    if n < 10:
        return []
    lin = 10 ** (env / 20)
    pre = np.concatenate([[0], np.cumsum(lin)])
    avg = lambda a, b: (pre[min(n, b)] - pre[max(0, a)]) / max(1, min(n, b) - max(0, a))
    short, long_ = int(6 / win), int(120 / win)
    score = np.array([avg(i - short // 2, i + short // 2 + 1) / (avg(i - long_, i + long_ + 1) + 1e-6) for i in range(n)])
    picks, gap = [], int(clip_len / win)
    for i in np.argsort(-score):
        if len(picks) >= count:
            break
        if env[i] < -50 or score[i] < 1.15:
            continue
        if all(abs(i - p) > gap for p in picks):
            picks.append(int(i))
    return [{"peak": p * win, "signal": "energy", "burst": round(float(score[p]), 2)} for p in picks]


def speech_candidates(env, win=0.5, length=40.0, count=4):
    """Sustained talk without a loud burst: where quiet but interesting conversations live."""
    if len(env) < 20:
        return []
    floor = np.percentile(env, 15)
    voiced = env > max(-45, floor + 10)
    k = int(length / win)
    if len(voiced) <= k:
        return [{"peak": len(env) * win / 2, "signal": "speech", "voiced": round(float(voiced.mean()), 2)}]
    pre = np.concatenate([[0], np.cumsum(voiced)])
    ratio = (pre[k:] - pre[:-k]) / k
    out, gap = [], k
    for i in np.argsort(-ratio):
        if len(out) >= count or ratio[i] < 0.55:
            break
        if all(abs(i - o) > gap for o in out):
            out.append(int(i))
    return [{"peak": (o + k / 2) * win, "signal": "speech", "voiced": round(float(ratio[o]), 2)} for o in out]


def visual_quality(src, start, dur):
    frs, _ = media.frames(src, fps=0.5, width=320, start=start, dur=dur)
    if not frs:
        return None, None
    g = [f.mean(axis=2) for f in frs]
    sharp = float(np.mean([np.var(np.diff(x, axis=0)) + np.var(np.diff(x, axis=1)) for x in g]))
    bright = float(np.mean([x.mean() for x in g]))
    motion = float(np.mean([np.abs(a - b).mean() for a, b in zip(g, g[1:])])) if len(g) > 1 else 0.0
    vis = max(1, min(10, round(3 + min(5, sharp / 40) + (2 if 40 < bright < 210 else 0))))
    return vis, round(motion, 2)


def audio_quality(env):
    if len(env) < 4:
        return None
    floor, top = np.percentile(env, 10), np.percentile(env, 90)
    snr = top - floor
    clip = float((env > -1.0).mean())
    return max(1, min(10, round(snr / 3.5) - (3 if clip > 0.05 else 0)))


# ---------------- tier 2 + 3 ----------------
def transcribe_window(src, start, dur, workdir, ref):
    wav = os.path.join(workdir, f"w_{int(start * 10)}.wav")
    media.wav16k(src, wav, start=start, dur=dur)
    tr = ai.transcribe(wav, ref=ref)
    try:
        os.remove(wav)
    except OSError:
        pass
    if tr:
        for w in tr["words"]:
            w["start"] += start
            w["end"] += start
    return tr


def deep_transcript(src, duration, workdir, ref, piece=600):
    words, text = [], []
    for a in np.arange(0, duration, piece):
        tr = transcribe_window(src, float(a), float(min(piece, duration - a)), workdir, ref)
        if tr:
            words += tr["words"]
            text.append(tr["text"])
    return {"words": words, "text": " ".join(text)}


def transcript_candidates(full, category, clip_len, ref, count=6):
    if not full or not full.get("words"):
        return []
    lines, cur = [], None
    for w in full["words"]:
        if cur is None or w["start"] - cur["t"] > 12:
            cur = {"t": w["start"], "w": []}
            lines.append(cur)
        cur["w"].append(w["word"])
    doc = "\n".join(f"[{int(l['t'])}] {' '.join(l['w'])}" for l in lines)[:90000]
    out = ai.chat_json(f"You are the clip scout for {category or 'stream'} content. Read the WHOLE transcript and find moments that work as standalone short videos: funny exchanges, surprising statements, complete stories, arguments, strong reactions, achievements. Prefer a clear setup and payoff over loud moments.",
                       f"Transcript (seconds in brackets):\n{doc}\n\nReturn JSON {{\"moments\":[{{\"start\":seconds,\"end\":seconds,\"why\":string}}]}}: up to {count} moments of 12-{int(clip_len)} seconds, not overlapping.", ref=ref)
    return [{"peak": (float(m["start"]) + float(m["end"])) / 2, "start": float(m["start"]), "end": float(m["end"]), "signal": "transcript", "why": m.get("why", "")} for m in (out or {}).get("moments", []) if m.get("end", 0) > m.get("start", 0)]


def score_candidates(cands, category, ref):
    """The analyst compares all candidates in one pass and scores each dimension 1-10."""
    with_t = [c for c in cands if c.get("transcript")]
    if not with_t or not ai.enabled():
        return False
    lines = "\n".join(f"#{i} [{c['start']:.0f}-{c['end']:.0f}s] signals: {json.dumps(c['signals'])} transcript: \"{c['transcript'][:900]}\"" for i, c in enumerate(cands) if c.get("transcript"))
    out = ai.chat_json(
        f"You score candidate short-form clips from {category or 'a stream'}. Compare them against each other; be calibrated (5 = average). A quiet but interesting conversation can beat a loud reaction. A clip must make sense to a stranger.",
        f"Candidates:\n{lines}\n\nFor each return 1-10 scores: hook (first 1-3 s), entertainment, context (makes sense alone), story (setup and payoff), emotion, relevance (to the audience of this category), replay (would people rewatch/share). "
        f"Also: title (short, honest), hook_text (on-screen, max 8 words, no claims beyond what happens), trim_start and trim_end (seconds, absolute, the tightest window that keeps the setup and ends on the payoff), skip (boolean), concerns (list: slurs, threats, personal info, copyrighted music, other creators' content), why (one sentence), category (gaming|podcast|irl|sports|interview|comedy|educational).\n"
        "Return JSON {\"candidates\":[{\"i\":n,...}]}", ref=ref, max_tokens=2500)
    for o in (out or {}).get("candidates", []):
        try:
            c = cands[int(o["i"])]
        except (KeyError, ValueError, IndexError):
            continue
        for k in ("hook", "entertainment", "context", "story", "emotion", "relevance", "replay"):
            if o.get(k) is not None:
                c["scores"][k] = max(1, min(10, float(o[k])))
        c.update({k: o.get(k) for k in ("title", "hook_text", "why", "concerns", "category") if o.get(k) is not None})
        c["skip"] = bool(o.get("skip"))
        if o.get("trim_start") is not None and o.get("trim_end") is not None and float(o["trim_end"]) - float(o["trim_start"]) >= 6:
            c["trim"] = [float(o["trim_start"]), float(o["trim_end"])]
    return True


def find(src, category=None, clip_len=35.0, min_len=10.0, deep=False, workdir="/tmp", ref=None, extra=(), max_candidates=10):
    """All candidates in a source, ranked. `extra` = live/chat markers [{'peak', 'signal', ...}]."""
    info = media.probe(src)
    dur = info["duration"]
    samples = media.pcm(src, 8000)
    env = media.envelope(samples, 8000, 0.5)
    cands = energy_candidates(env, 0.5, clip_len, count=6) + speech_candidates(env, 0.5, min(clip_len + 10, 45), count=4) + list(extra)
    full = None
    if deep and ai.enabled():
        full = deep_transcript(src, dur, workdir, ref)
        cands += transcript_candidates(full, category, clip_len, ref)
    # merge near-duplicates (the same event found by two signals)
    merged = []
    for c in sorted(cands, key=lambda c: {"transcript": 0, "chat": 1, "energy": 2, "speech": 3}.get(c["signal"], 4)):
        near = next((m for m in merged if abs(m["peak"] - c["peak"]) < clip_len * 0.5), None)
        if near:
            near["signals"][c["signal"]] = {k: v for k, v in c.items() if k not in ("peak", "signal")}
            if c.get("start") is not None and near.get("from_transcript") is None:
                near["start"], near["end"], near["from_transcript"] = c["start"], c["end"], True
            continue
        a = c.get("start", c["peak"] - clip_len * 0.6)
        b = c.get("end", c["peak"] + clip_len * 0.4)
        merged.append({"peak": c["peak"], "start": max(0.0, a - 4), "end": min(dur, b + 4), "signals": {c["signal"]: {k: v for k, v in c.items() if k not in ("peak", "signal")}}, "scores": {}, "from_transcript": c.get("start") is not None or None})
    merged = merged[:max_candidates]
    for c in merged:
        seg = env[int(c["start"] / 0.5): int(c["end"] / 0.5) + 1]
        c["scores"]["audio"] = audio_quality(seg)
        c["scores"]["visual"], c["motion"] = visual_quality(src, c["start"], c["end"] - c["start"])
        voiced = float((seg > max(-45, np.percentile(env, 15) + 10)).mean()) if len(seg) else 0
        c["scores"]["pacing"] = max(1, min(10, round(voiced * 10)))
        if full:
            ws = [w for w in full["words"] if c["start"] <= w["start"] <= c["end"]]
            c["words"], c["transcript"] = ws, " ".join(w["word"] for w in ws)
        elif ai.enabled():
            tr = transcribe_window(src, c["start"], c["end"] - c["start"], workdir, ref)
            c["words"], c["transcript"] = (tr or {}).get("words", []), (tr or {}).get("text", "")
        burst = (c["signals"].get("energy") or {}).get("burst")
        chat = (c["signals"].get("chat") or {}).get("ratio")
        if not ai.enabled():  # measurable only: loudness and chat stand in for entertainment, nothing else is guessed
            if burst or chat:
                c["scores"]["entertainment"] = max(1, min(10, round(2 + 3 * (burst or 1) + 1.5 * (chat or 0))))
            c["scores"]["hook"] = max(1, min(10, round(10 * float((env[int(c['start'] / 0.5) + 8: int(c['start'] / 0.5) + 14] > np.percentile(env, 60)).mean())))) if len(env) > 20 else None
    analysed = score_candidates(merged, category, ref)
    for c in merged:
        c["rank"] = rank(c["scores"], c.get("category") or category)
        c["method"] = ("full transcript + " if full else "") + ("10-dimension AI comparison" if analysed else "measured signals only (no OpenAI key)")
    merged.sort(key=lambda c: -c["rank"])
    # same words twice = same moment: keep the better one
    for i, a in enumerate(merged):
        for b in merged[i + 1:]:
            if a.get("dup") or b.get("dup") or not a.get("transcript") or not b.get("transcript"):
                continue
            A, B = set(a["transcript"].lower().split()), set(b["transcript"].lower().split())
            if A and B and len(A & B) / len(A | B) > 0.5:
                b["dup"] = f"same words as the {a['start']:.0f}s moment"
    return {"duration": dur, "candidates": merged, "full": bool(full)}
