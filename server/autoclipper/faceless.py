"""Faceless reels made entirely on the server: AI script (confirmed facts stated as facts, rumours labelled as rumours),
voiceover, animated background, then the normal production line (captions, render, 12 QC checks) and the Review Queue.
No one else's footage is used, so no creator permission is needed. Nothing is published without approval."""
import os
import subprocess
import tempfile
import time

from . import ai, config, db, jobs, media, pipeline, sources

DEFAULTS = {"enabled": True, "per_day": 3, "niche": "GTA 6 facts & secrets", "voice": "onyx", "words": 120}

SYSTEM = """You write scripts for 30-50 second vertical short videos (TikTok/Shorts/Reels) for a faceless channel.
Rules:
- Only state as fact things that are officially confirmed or widely documented. Anything unconfirmed must be said as a rumour
  ("rumoured", "leaks suggest", "fans think"). Never invent numbers, quotes, dates or features.
- First sentence is the hook: a question or a surprising claim that makes people stay. No greetings, no "in this video".
- Short spoken sentences. About {words} words. End with a payoff or a question that invites comments.
- Pick a topic that is NOT in the recent list.
Return JSON: {{"title": str (max 60 chars), "hook": str (max 7 words, shown on screen), "script": str,
"caption": str (max 120 chars, no hashtags), "hashtags": [str], "claims": [{{"text": str, "status": "confirmed"|"rumour"|"opinion"}}],
"topic": str}}"""


def settings():
    return {**DEFAULTS, **(db.setting("faceless", {}) or {})}


def made_today():
    t0 = time.time() - (time.time() % 86400)
    return db.one("SELECT COUNT(*) n FROM clips WHERE created>=? AND json_extract(research,'$.method')='faceless'", (t0,))["n"]


def in_progress():
    return db.one("SELECT COUNT(*) n FROM clips WHERE status IN ('producing','revising') AND json_extract(research,'$.method')='faceless'")["n"]


def recent_topics(n=30):
    return [r["title"] for r in db.q("SELECT title FROM clips WHERE json_extract(research,'$.method')='faceless' ORDER BY created DESC LIMIT ?", (n,))]


def write(cfg):
    d = ai.chat_json(SYSTEM.format(words=cfg["words"]), f"Niche: {cfg['niche']}\nRecent topics (do not repeat):\n- " + "\n- ".join(recent_topics() or ["(none)"]), temperature=0.8, max_tokens=900)
    if not d or not (d.get("script") or "").strip():
        raise jobs.Temporary("The script writer returned nothing")
    return d


def background(out, dur):
    """Animated gradient background, 1080x1920 (made here, so no licence questions)."""
    cmd = [media.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
           f"gradients=s=1080x1920:c0=0x1a0033:c1=0x5b21b6:c2=0xdb2777:c3=0x0ea5e9:n=4:type=linear:speed=0.015:d={dur:.2f}:r=30,"
           f"eq=saturation=1.2:brightness=-0.05,noise=alls=2:allf=t,vignette=PI/4", "-t", f"{dur:.2f}", "-c:v", "libx264", "-preset", os.environ.get("AC_X264_PRESET", "veryfast"), "-pix_fmt", "yuv420p", out]
    p = subprocess.run(cmd, capture_output=True, timeout=900)
    if p.returncode != 0:  # older ffmpeg without the gradients source: slow colour cycle instead
        subprocess.run([media.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x5b21b6:s=1080x1920:r=30:d={dur:.2f}",
                        "-vf", "hue=h=40*sin(t/3):s=1.2,vignette=PI/4", "-t", f"{dur:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", out],
                       check=True, capture_output=True, timeout=900)
    return out


def make(cfg=None):
    """Write, voice and assemble one faceless reel, then send it down the normal production line."""
    cfg = {**settings(), **(cfg or {})}
    if not ai.enabled():
        raise RuntimeError("Faceless reels need the OpenAI key on the server")
    d = write(cfg)
    script = d["script"].strip()
    mod = ai.moderate(script)
    if mod and mod["flagged"]:
        db.event("guidelines", f"Faceless script refused by the safety scan ({', '.join(mod['categories'])}): {d.get('title')}", kind="warn")
        return None
    tmp = tempfile.mkdtemp(prefix="faceless_", dir=config.CFG.media_dir)
    voice = ai.speech(script, os.path.join(tmp, "voice.wav"), voice=cfg["voice"])
    dur = media.probe(voice)["duration"] + 0.8
    bg = background(os.path.join(tmp, "bg.mp4"), dur)
    out = os.path.join(tmp, "faceless.mp4")
    subprocess.run([media.FFMPEG, "-y", "-v", "error", "-i", bg, "-i", voice, "-filter_complex", "[1:a]adelay=400|400,apad[a]", "-map", "0:v", "-map", "[a]",
                    "-t", f"{dur:.2f}", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", out], check=True, capture_output=True, timeout=600)
    rumours = [c["text"] for c in d.get("claims") or [] if c.get("status") == "rumour"]
    sid = sources.add_file(out, attest=True, kind="faceless", move=True,
                           meta={"script": script, "claims": d.get("claims") or [], "topic": d.get("topic"), "made_by": "server (AI script + voice + generated background)"})
    src = db.one("SELECT * FROM sources WHERE id=?", (sid,))
    tags = " ".join("#" + t.lstrip("#") for t in (d.get("hashtags") or [])[:6])
    cand = {"start": 0, "end": src["duration"], "title": (d.get("title") or cfg["niche"])[:80], "hook_text": d.get("hook") or "", "category": "gaming", "method": "faceless",
            "why": f"Faceless explainer on '{d.get('topic') or d.get('title')}' (niche: {cfg['niche']}). Claims: "
                   + "; ".join(f"[{c.get('status')}] {c.get('text')}" for c in (d.get("claims") or [])[:6]),
            "concerns": ([f"Says as a rumour: {r}" for r in rumours] + ["Facts are not checked against sources: confirm before posting"])}
    clip = pipeline.create_from_candidate(cand, src)
    db.update("clips", "id", clip["id"], description=f"{d.get('caption') or ''} {tags}".strip())
    db.event("director", f"{clip['id']}: faceless reel written ('{cand['title']}'), voiced and assembled; sent to production", ref=clip["id"])
    jobs.enqueue("produce", {"clip_id": clip["id"]}, priority=4)
    return clip["id"]


def tick():
    """Scheduled: keep today's faceless quota going, one at a time."""
    cfg = settings()
    if not cfg["enabled"] or not ai.enabled():
        return "off"
    if made_today() >= int(cfg["per_day"]) or in_progress():
        return "quota met or one in progress"
    return make(cfg)
