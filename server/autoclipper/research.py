"""Research department.

Streamer discovery: top live channels per category (Twitch Helix, YouTube Data API), creators behind clips that
are taking off (Twitch clips, Kick clips). Each creator is scored on audience, activity, frequency, engagement,
short-form popularity and clipping access. Discovered creators start with permission 'none' (never watched).

Viral clip research: public metadata of top clips (views, length, title, age) per category, from the official APIs.
From that it measures benchmarks (e.g. median length of top clips per category) and keeps a techniques database.
Techniques measured on video frames come only from reference videos you are allowed to analyse (uploaded by you)
and from our own renders; other creators' videos are never downloaded."""
import math
import re
import statistics as stats
import time

import requests

from . import config, db, media, monitor, vision


def _creator(platform, login, **f):
    now = time.time()
    ex = db.one("SELECT * FROM creators WHERE platform=? AND login=?", (platform, login.lower()))
    row = {"platform": platform, "login": login.lower(), "updated_at": now, **{k: v for k, v in f.items() if v is not None}}
    if not ex:
        row.update(discovered_at=now, permission="none", monitor=0)
        db.insert("creators", row)
    else:
        m = {**(ex.get("metrics") or {}), **(f.get("metrics") or {})}
        row["metrics"] = m
        db.update("creators", "id", ex["id"], **{k: v for k, v in row.items() if k not in ("platform", "login")})
    return db.one("SELECT * FROM creators WHERE platform=? AND login=?", (platform, login.lower()))


def score_creator(c):
    m = c.get("metrics") or {}
    hist = c.get("history") or []
    aud = math.log10(1 + (c.get("viewers") or m.get("peak_viewers") or 0)) * 2 + math.log10(1 + (c.get("followers") or 0))
    active = 2 if c.get("live") else 0
    freq = min(3, len([h for h in hist if h.get("live") and time.time() - h["at"] < 14 * 86400]) / 3)
    shortform = math.log10(1 + m.get("clip_views_7d", 0)) * 1.2
    access = 3 if c.get("permission") in ("own", "granted") else 2 if c.get("permission") == "attested" else 0
    return round(aud + active + freq + shortform + access, 2)


def discover():
    found = 0
    cfg = db.setting("discovery", {}) or {}
    games = cfg.get("games") or ["Grand Theft Auto V", "Just Chatting", "Fortnite", "Sports"]
    if config.CFG.twitch_id:
        for g in games:
            gj = monitor.helix("/games", [("name", g)]) or {}
            gid = (gj.get("data") or [{}])[0].get("id")
            if not gid:
                continue
            for s in (monitor.helix("/streams", [("game_id", gid), ("first", 40)]) or {}).get("data", []):
                c = _creator("twitch", s["user_login"], name=s["user_name"], url=f"https://www.twitch.tv/{s['user_login']}", category=_cat(s.get("game_name")), game=s.get("game_name"),
                             viewers=s.get("viewer_count"), live=1, stream_title=s.get("title"), last_live_at=time.time(), metrics={"peak_viewers": s.get("viewer_count")})
                found += 1
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7 * 86400))
            clips = (monitor.helix("/clips", [("game_id", gid), ("first", 50), ("started_at", since)]) or {}).get("data", [])
            per = {}
            for cl in clips:
                db.upsert("research", {"kind": "clip", "platform": "twitch", "ref": cl["id"], "title": cl["title"], "metrics": {"views": cl["view_count"], "duration": cl["duration"]},
                                       "data": {"creator": cl["broadcaster_name"], "game": g, "category": _cat(g), "created": cl["created_at"], "url": cl["url"]}, "at": time.time()}, ["kind", "platform", "ref"])
                per[cl["broadcaster_name"]] = per.get(cl["broadcaster_name"], 0) + cl["view_count"]
            for name, v in per.items():
                _creator("twitch", name, name=name, url=f"https://www.twitch.tv/{name.lower()}", category=_cat(g), metrics={"clip_views_7d": v})
    if config.CFG.youtube_key:
        for q in cfg.get("youtube_queries") or ["gta live", "podcast live", "just chatting live"]:
            r = requests.get(f"{config.CFG.youtube_api}/search", params={"part": "snippet", "eventType": "live", "type": "video", "order": "viewCount", "maxResults": 20, "q": q, "key": config.CFG.youtube_key}, timeout=20)
            for it in (r.json().get("items", []) if r.ok else []):
                sn = it["snippet"]
                _creator("youtube", sn["channelId"], name=sn["channelTitle"], url=f"https://www.youtube.com/channel/{sn['channelId']}", category=_cat(q), live=1, stream_title=sn["title"], last_live_at=time.time())
                found += 1
    try:
        r = requests.get(f"{config.CFG.kick_api}/v2/clips", params={"sort": "view", "time": "week"}, timeout=20, headers={"User-Agent": "AutoClipper/3.0"})
        for cl in (r.json().get("clips", []) if r.ok else []):
            ch = cl.get("channel") or {}
            if not ch.get("slug"):
                continue
            db.upsert("research", {"kind": "clip", "platform": "kick", "ref": str(cl["id"]), "title": cl.get("title"), "metrics": {"views": cl.get("views") or cl.get("view_count"), "duration": cl.get("duration")},
                                   "data": {"creator": ch.get("username"), "category": _cat((cl.get("category") or {}).get("name")), "created": cl.get("created_at")}, "at": time.time()}, ["kind", "platform", "ref"])
            _creator("kick", ch["slug"], name=ch.get("username"), url=f"https://kick.com/{ch['slug']}", category=_cat((cl.get("category") or {}).get("name")), metrics={"clip_views_7d": cl.get("views") or 0})
            found += 1
    except Exception:
        pass
    for c in db.q("SELECT * FROM creators"):
        db.update("creators", "id", c["id"], score=score_creator(c))
    benchmarks()
    db.event("scout", f"Discovery: {found} creators seen; {db.one('SELECT COUNT(*) n FROM creators')['n']} in the database", kind="done")
    return {"found": found}


def _cat(game):
    g = (game or "").lower()
    if "chat" in g or "irl" in g:
        return "irl"
    if "podcast" in g or "talk" in g:
        return "podcast"
    if any(s in g for s in ("sport", "nba", "fifa", "football", "ufc")):
        return "sports"
    return "gaming"


def benchmarks():
    """Measured from public clip metadata: how long the most-viewed clips are, per category."""
    rows = db.q("SELECT * FROM research WHERE kind='clip' AND at>?", (time.time() - 30 * 86400,))
    by = {}
    for r in rows:
        by.setdefault((r["data"] or {}).get("category") or "gaming", []).append(r)
    out = {}
    for cat, rs in by.items():
        rs.sort(key=lambda r: -((r["metrics"] or {}).get("views") or 0))
        top = rs[: max(5, len(rs) // 5)]
        d = [float((r["metrics"] or {}).get("duration") or 0) for r in top if (r["metrics"] or {}).get("duration")]
        t = [r["title"] or "" for r in top]
        if len(d) >= 5:
            for metric, val in (("top_clip_duration_median", stats.median(d)), ("top_clip_duration_p25", sorted(d)[len(d) // 4]), ("top_clip_duration_p75", sorted(d)[3 * len(d) // 4])):
                db.upsert("benchmarks", {"metric": metric, "category": cat, "value": round(val, 1), "n": len(d), "source": "public clip metadata", "at": time.time()}, ["metric", "category", "source"])
        if len(t) >= 5:
            caps = stats.mean(sum(ch.isupper() for ch in x) / max(1, sum(ch.isalpha() for ch in x)) for x in t)
            q = sum("?" in x for x in t) / len(t)
            emo = sum(bool(re.search(r"[\U0001F300-\U0001FAFF]", x)) for x in t) / len(t)
            for metric, val in (("title_caps_ratio", caps), ("title_question_share", q), ("title_emoji_share", emo)):
                db.upsert("benchmarks", {"metric": metric, "category": cat, "value": round(val, 3), "n": len(t), "source": "public clip metadata", "at": time.time()}, ["metric", "category", "source"])
        out[cat] = len(rs)
    return out


SEED_TECHNIQUES = [
    ("Facecam above gameplay", "Webcam crop in the top ~40%, gameplay below, captions on the seam.", "gaming", "Keeps the reaction and the cause on screen together.", "clip"),
    ("Speaker-tracking vertical crop", "9:16 crop that follows the person, with a dead zone so it does not jitter.", "irl,podcast", "Full-face framing for talking content.", "clip"),
    ("Word-by-word highlight captions", "2-3 words on screen, the spoken word highlighted.", "irl,podcast,gaming", "Readable without sound; draws the eye along the speech.", "clip"),
    ("Hook text card", "A short on-screen line in the first 2.5 s saying what is about to happen (honestly).", "all", "Gives the scroller a reason to stay.", "clip"),
    ("Dead-air jump cuts", "Pauses over ~1 s removed; never the punchline.", "all", "Faster pacing without losing context.", "clip"),
    ("-14 LUFS loudness", "Integrated loudness about -14 LUFS, true peak under -1 dBTP.", "all", "Matches what platforms normalise to; avoids quiet or distorted clips.", "clip"),
]


def seed_techniques():
    for name, desc, cat, why, fmt in SEED_TECHNIQUES:
        if not db.one("SELECT id FROM techniques WHERE name=?", (name,)):
            db.insert("techniques", {"name": name, "description": desc, "example_ref": "", "category": cat, "why": why, "formats": fmt, "discovered": time.time(), "confidence": 0.3,
                                     "tests": [], "evidence": {"source": "editing convention (not yet measured on your results)"}, "updated": time.time()})


def analyse_reference(path, label, category):
    """Measure an authorized reference video (one you uploaded): length, layout, cut rate, loudness, text bands."""
    info = media.probe(path)
    lay = vision.analyse(path, dur=min(60, info["duration"]))
    cuts = media.detect(path, "scdet=threshold=12", r"lavfi\.scd\.time: ([\d.]+)")
    L = media.loudness(path)
    m = {"duration": info["duration"], "vertical": info["height"] > info["width"], "layout": lay["layout"], "faces": lay["faces"][:2], "cuts_per_10s": round(len(cuts) / max(1, info["duration"]) * 10, 2), "lufs": L and L["lufs"]}
    db.upsert("research", {"kind": "reference", "platform": "upload", "ref": label, "title": label, "metrics": m, "data": {"category": category}, "at": time.time()}, ["kind", "platform", "ref"])
    for metric, val in (("ref_duration", m["duration"]), ("ref_cuts_per_10s", m["cuts_per_10s"]), ("ref_lufs", m["lufs"] or 0)):
        rows = db.q("SELECT metrics FROM research WHERE kind='reference' AND json_extract(data,'$.category')=?", (category,))
        key = {"ref_duration": "duration", "ref_cuts_per_10s": "cuts_per_10s", "ref_lufs": "lufs"}[metric]
        vals = [r["metrics"].get(key) for r in rows if r["metrics"].get(key) is not None]
        if vals:
            db.upsert("benchmarks", {"metric": metric, "category": category, "value": round(stats.median(vals), 2), "n": len(vals), "source": "your reference videos", "at": time.time()}, ["metric", "category", "source"])
    return m
