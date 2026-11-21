"""Control-panel API. The website (GitHub Pages) talks to this over HTTPS with an admin token.
Video files are served through short-lived signed links, so the token never appears in a URL."""
import hashlib
import hmac
import os
import re
import tempfile
import time

from flask import Flask, Response, abort, jsonify, request, send_file

from . import __version__, budget, captions, config, db, jobs, monitor, research, skills

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("AC_MAX_UPLOAD_GB", "8")) * 1024 ** 3
MEDIA_KINDS = ("final", "clean", "thumb", "source_frame", "source")


def _origin_ok(o):
    return o and any(o == a.strip() or (a.strip().endswith("*") and o.startswith(a.strip()[:-1])) for a in config.CFG.allowed_origins.split(","))


@app.after_request
def cors(r):
    o = request.headers.get("Origin")
    if _origin_ok(o) or (o and o.startswith("http://localhost")):
        r.headers["Access-Control-Allow-Origin"] = o
        r.headers["Vary"] = "Origin"
        r.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        r.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    return r


@app.before_request
def auth():
    if request.method == "OPTIONS":
        return Response(status=204)
    p = request.path
    if p in ("/api/health",) or p.startswith("/api/media/"):
        return None
    tok = config.CFG.admin_token
    if not tok:
        return jsonify(error="Server has no AC_ADMIN_TOKEN set"), 503
    got = (request.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(got, tok):
        return jsonify(error="unauthorized"), 401
    return None


def sign(clip_id, kind, ttl=3600):
    exp = int(time.time()) + ttl
    sig = hmac.new(config.CFG.admin_token.encode(), f"{clip_id}:{kind}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"/api/media/{clip_id}/{kind}?exp={exp}&sig={sig}"


@app.get("/api/health")
def health():
    hb = db.q("SELECT worker, at FROM heartbeats ORDER BY at DESC LIMIT 5")
    return jsonify(ok=True, version=__version__, workers_alive=sum(1 for h in hb if time.time() - h["at"] < 60))


@app.get("/api/status")
def status():
    now = time.time()
    hb = db.q("SELECT * FROM heartbeats ORDER BY at DESC")
    clips = {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM clips GROUP BY status")}
    cr = db.one("SELECT COUNT(*) n, SUM(permission IN ('own','granted')) ok, SUM(monitor=1) mon, SUM(live=1) live FROM creators")
    nxt = {r["kind"]: r["run_at"] for r in db.q("SELECT kind, MIN(run_at) run_at FROM jobs WHERE status='queued' GROUP BY kind")}
    return jsonify(version=__version__, now=now, integrations=config.CFG.public(), budget=budget.status(), jobs=jobs.counts(), clips=clips, creators=cr,
                   workers=[{"worker": h["worker"], "alive": now - h["at"] < 60, "last_seen": h["at"], "info": h["info"]} for h in hb],
                   sessions=db.q("SELECT s.*, c.name, c.login, c.platform FROM sessions s LEFT JOIN creators c ON c.id=s.creator_id WHERE s.status='live'"),
                   next=nxt, unread=db.one("SELECT COUNT(*) n FROM notifications WHERE read=0 AND level!='info'")["n"])


@app.get("/api/events")
def events():
    after = int(request.args.get("after", 0))
    return jsonify(db.q("SELECT * FROM events WHERE id>? ORDER BY id DESC LIMIT 200", (after,)))


@app.get("/api/notifications")
def notifications():
    return jsonify(db.q("SELECT * FROM notifications ORDER BY id DESC LIMIT 100"))


@app.post("/api/notifications/read")
def notes_read():
    db.run("UPDATE notifications SET read=1")
    return jsonify(ok=True)


SETTING_KEYS = ("faceless", "production", "live", "discovery", "publishing", "budget", "prices", "paused_jobs")


@app.get("/api/settings")
def get_settings():
    from . import faceless
    out = {k: db.setting(k, {} if k != "paused_jobs" else []) for k in SETTING_KEYS}
    out["faceless"] = faceless.settings()
    return jsonify(out | {"caption_presets": captions.presets(), "category_presets": {**captions.CATEGORY_PRESET, **(db.setting("category_presets", {}) or {})}})


@app.put("/api/settings")
def put_settings():
    body = request.get_json(force=True) or {}
    for k, v in body.items():
        if k in SETTING_KEYS:
            db.set_setting(k, v)
    db.event("manager", "Settings changed: " + ", ".join(k for k in body if k in SETTING_KEYS), kind="decision")
    return get_settings()


@app.get("/api/creators")
def creators():
    order = {"score": "score DESC", "viewers": "viewers DESC", "recent": "updated_at DESC"}.get(request.args.get("sort", "score"), "score DESC")
    where, args = "1=1", []
    if request.args.get("permitted"):
        where += " AND permission IN ('own','granted')"
    if request.args.get("q"):
        where += " AND (login LIKE ? OR name LIKE ?)"
        args += [f"%{request.args['q']}%"] * 2
    # creators you can clip always come first, so they never fall off the list
    return jsonify(db.q(f"SELECT * FROM creators WHERE {where} ORDER BY (permission IN ('own','granted')) DESC, {order} LIMIT 300", args))


@app.post("/api/creators")
def add_creator():
    b = request.get_json(force=True)
    if b.get("platform") not in ("twitch", "kick", "youtube", "custom") or not b.get("login"):
        abort(400, "platform and login required")
    login = re.sub(r"[^a-zA-Z0-9_\-]", "", b["login"]).lower()
    url = b.get("url") or {"twitch": f"https://www.twitch.tv/{login}", "kick": f"https://kick.com/{login}", "youtube": f"https://www.youtube.com/channel/{b['login']}"}.get(b["platform"], "")
    db.run("INSERT OR IGNORE INTO creators (platform, login, name, url, category, discovered_at, updated_at, permission, monitor, source_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
           (b["platform"], login, b.get("name") or b["login"], url, b.get("category", "gaming"), time.time(), time.time(), "none", 0, b.get("source_url")))
    return jsonify(db.one("SELECT * FROM creators WHERE platform=? AND login=?", (b["platform"], login)))


@app.post("/api/campaigns")
def add_campaign():
    """A clipping campaign you joined: every listed streamer gets permission 'granted' with the campaign page as proof,
    and is monitored. Body: {url, name?, platform?, streamers: ["name" or "kick:name" or a channel link, ...], monitor?: true}"""
    b = request.get_json(force=True) or {}
    url = (b.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        abort(400, "Campaign link (https://...) required as proof of permission")
    added = []
    for raw in b.get("streamers") or []:
        raw = str(raw).strip()
        if not raw:
            continue
        plat = b.get("platform") or "twitch"
        m = re.match(r"^(?:https?://)?(?:www\.)?(twitch\.tv|kick\.com|youtube\.com/(?:@|c/|channel/)?)/?([^/?#\s]+)", raw)
        if m:
            plat = "kick" if "kick" in m.group(1) else "youtube" if "youtube" in m.group(1) else "twitch"
            raw = m.group(2)
        elif ":" in raw and raw.split(":", 1)[0] in ("twitch", "kick", "youtube"):
            plat, raw = raw.split(":", 1)
        login = re.sub(r"[^a-zA-Z0-9_\-]", "", raw.lstrip("@")).lower()
        if not login:
            continue
        chan = {"twitch": f"https://www.twitch.tv/{login}", "kick": f"https://kick.com/{login}", "youtube": f"https://www.youtube.com/@{login}"}[plat]
        db.run("INSERT OR IGNORE INTO creators (platform, login, name, url, category, discovered_at, updated_at, permission, monitor) VALUES (?,?,?,?,?,?,?,?,?)",
               (plat, login, raw.lstrip("@"), chan, b.get("category", "gaming"), time.time(), time.time(), "none", 0))
        c = db.one("SELECT * FROM creators WHERE platform=? AND login=?", (plat, login))
        db.update("creators", "id", c["id"], permission="granted", permission_proof=url, permission_at=time.time(), monitor=0 if b.get("monitor") is False else 1, updated_at=time.time())
        added.append({"id": c["id"], "platform": plat, "login": login})
    if not added:
        abort(400, "List at least one streamer")
    db.event("rights", f"Campaign {b.get('name') or url}: {len(added)} streamer(s) granted with the campaign page as proof: " + ", ".join(a["login"] for a in added), kind="decision")
    jobs.enqueue("check_live", {}, priority=1)
    return jsonify(added=added)


@app.patch("/api/creators/<int:cid>")
def edit_creator(cid):
    b = request.get_json(force=True)
    c = db.one("SELECT * FROM creators WHERE id=?", (cid,)) or abort(404)
    f = {}
    if "permission" in b:
        if b["permission"] not in ("none", "requested", "granted", "own", "denied"):
            abort(400, "bad permission")
        if b["permission"] in ("granted", "own") and not (b.get("permission_proof") or c.get("permission_proof") or b["permission"] == "own"):
            abort(400, "Add the proof of permission (link to the message, contract or campaign page)")
        f.update(permission=b["permission"], permission_at=time.time())
        db.event("rights", f"Permission for {c['name'] or c['login']}: {b['permission']}", ref=f"creator:{cid}", kind="decision")
    for k in ("permission_proof", "source_url", "category", "name"):
        if k in b:
            f[k] = b[k]
    if "monitor" in b:
        if b["monitor"] and (f.get("permission") or c["permission"]) not in ("granted", "own"):
            abort(400, "Only creators with clipping permission can be monitored")
        f["monitor"] = 1 if b["monitor"] else 0
        if not b["monitor"]:
            monitor.stop_session(cid)
    if f:
        f["updated_at"] = time.time()
        db.update("creators", "id", cid, **f)
    return jsonify(db.one("SELECT * FROM creators WHERE id=?", (cid,)))


@app.post("/api/sources")
def upload_source():
    f = request.files.get("file") or abort(400, "file required")
    attest = request.form.get("attest") in ("1", "true", "yes")
    cid = request.form.get("creator_id", type=int)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(f.filename or "x.mp4")[1] or ".mp4", dir=config.CFG.data_dir)
    f.save(tmp.name)
    from . import sources
    try:
        sid = sources.add_file(tmp.name, cid, attest=attest, move=True, meta={"filename": f.filename})
    except PermissionError as e:
        os.unlink(tmp.name)
        return jsonify(error=str(e)), 403
    jid = jobs.enqueue("analyze_source", {"source_id": sid}, priority=3)
    return jsonify(source_id=sid, job_id=jid)


@app.post("/api/sources/url")
def url_source():
    b = request.get_json(force=True)
    c = db.one("SELECT * FROM creators WHERE id=?", (b.get("creator_id"),))
    if not c or c["permission"] not in ("own", "granted"):
        return jsonify(error="That creator has no clipping permission on record"), 403
    return jsonify(job_id=jobs.enqueue("import_url", {"url": b["url"], "creator_id": c["id"]}, priority=3))


def _clip_out(c, full=False):
    c = dict(c)
    c["media"] = {k: sign(c["id"], k) for k in MEDIA_KINDS if (c.get("files") or {}).get(k)}
    cr = db.one("SELECT name, login, platform, url, permission FROM creators WHERE id=?", (c.get("creator_id"),)) if c.get("creator_id") else None
    c["creator"] = cr
    s = db.one("SELECT kind, meta, duration FROM sources WHERE id=?", (c.get("source_id"),))
    c["source"] = {"kind": s["kind"], "filename": (s["meta"] or {}).get("filename"), "duration": s["duration"]} if s else None
    c.pop("files", None)
    if not full:
        for k in ("words", "ledger"):
            c.pop(k, None)
    return c


@app.get("/api/clips")
def clips():
    st = request.args.get("status")
    rows = db.q("SELECT * FROM clips WHERE status=? ORDER BY created DESC LIMIT 200", (st,)) if st else db.q("SELECT * FROM clips ORDER BY created DESC LIMIT 200")
    return jsonify([_clip_out(c) for c in rows])


@app.get("/api/clips/<cid>")
def clip(cid):
    return jsonify(_clip_out(db.one("SELECT * FROM clips WHERE id=?", (cid,)) or abort(404), full=True))


@app.get("/api/media/<cid>/<kind>")
def media_file(cid, kind):
    exp, sig = request.args.get("exp", "0"), request.args.get("sig", "")
    if kind not in MEDIA_KINDS or int(exp) < time.time():
        abort(403)
    good = hmac.new(config.CFG.admin_token.encode(), f"{cid}:{kind}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(good, sig):
        abort(403)
    c = db.one("SELECT files FROM clips WHERE id=?", (cid,)) or abort(404)
    p = (c["files"] or {}).get(kind)
    if not p or not os.path.exists(p):
        abort(404)
    r = send_file(p, conditional=True, max_age=300)
    r.headers["Access-Control-Allow-Origin"] = "*"
    return r


@app.put("/api/clips/<cid>")
def edit_clip(cid):
    """Review edits: title, description, captions (text/timing/position/style per cue), caption preset, facecam box, layout."""
    c = db.one("SELECT * FROM clips WHERE id=?", (cid,)) or abort(404)
    b = request.get_json(force=True)
    f, changed = {}, []
    for k in ("title", "description"):
        if k in b:
            f[k] = str(b[k])[:2000]; changed.append(k)
    if "captions" in b:
        cues = []
        for q in b["captions"]:
            if not str(q.get("text", "")).strip() or float(q["end"]) <= float(q["start"]):
                continue
            cue = {"start": round(float(q["start"]), 3), "end": round(float(q["end"]), 3), "text": str(q["text"]).strip()[:200]}
            old = next((o for o in c["captions"] or [] if abs(o["start"] - cue["start"]) < 0.05 and o["text"] == cue["text"]), None)
            if old and old.get("words"):
                cue["words"] = old["words"]
            if q.get("pos"):
                cue["pos"] = {"x": max(0.05, min(0.95, float(q["pos"].get("x", 0.5)))), "y": max(0.05, min(0.95, float(q["pos"].get("y", 0.66))))}
            if q.get("style"):
                cue["style"] = {k: v for k, v in q["style"].items() if k in ("color", "highlight", "font", "size", "anim", "outline", "outline_w", "upper", "box", "hl_mode")}
            cues.append(cue)
        f["captions"] = sorted(cues, key=lambda x: x["start"]); changed.append("captions")
    if "caption_style" in b:
        f["caption_style"] = {"preset": b["caption_style"].get("preset", "bold"), "overrides": b["caption_style"].get("overrides") or {}}; changed.append("caption style")
    if "layout" in b or "facecam" in b:
        lay = dict(c["layout"] or {})
        if b.get("layout"):
            lay["layout"] = b["layout"]
        if b.get("facecam"):
            fc = b["facecam"]
            lay["facecam"] = {k: round(max(0.0, min(1.0, float(fc[k]))), 4) for k in ("x", "y", "w", "h")}
        lay["user_set"] = True
        f["layout"] = lay; f["facecam"] = lay.get("facecam") or {}; changed.append("layout")
    if f:
        db.update("clips", "id", cid, updated=time.time(), **f)
        db.event("publishing", f"{cid}: you edited {', '.join(changed)}", ref=cid, kind="decision")
    return clip(cid)


@app.post("/api/clips/<cid>/rerender")
def rerender(cid):
    c = db.one("SELECT * FROM clips WHERE id=?", (cid,)) or abort(404)
    db.update("clips", "id", cid, status="producing", revisions=0, updated=time.time())
    return jsonify(job_id=jobs.enqueue("produce", {"clip_id": cid, "revision": {"by": "you"}}, priority=2))


@app.post("/api/clips/<cid>/revise")
def revise(cid):
    """AI revision from your words: the request is turned into concrete edits, then the clip is rebuilt and re-checked."""
    c = db.one("SELECT * FROM clips WHERE id=?", (cid,)) or abort(404)
    text = (request.get_json(force=True) or {}).get("request", "").strip() or abort(400, "request text required")
    from . import ai
    plan = None
    if ai.enabled():
        plan = ai.chat_json("You turn a video editor's revision request into concrete edits for a short clip. Only change what was asked.",
                            f"Clip: {c['title']} ({c['end'] - c['start']:.1f}s, layout {(c['layout'] or {}).get('layout')}, caption preset {(c['caption_style'] or {}).get('preset')}).\nRequest: {text}\n"
                            "Return JSON {\"start_shift\": seconds (+ later), \"end_shift\": seconds, \"title\": string|null, \"hook_text\": string|null, \"layout\": facecam_top|facecam_bottom|track|split|blur|null, \"preset\": bold|karaoke|clean|neon|minimal|bounce|null, \"rebuild_captions\": bool}", ref=cid)
    if plan is None:  # simple understanding without AI
        m = re.search(r"(start|begin)\D{0,20}(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s*(later|earlier)", text, re.I)
        e = re.search(r"(end|finish)\D{0,20}(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s*(later|earlier|sooner)", text, re.I)
        plan = {"start_shift": (float(m.group(2)) * (1 if m.group(3).lower() == "later" else -1)) if m else 0, "end_shift": (float(e.group(2)) * (1 if e.group(3).lower() == "later" else -1)) if e else 0}
        for lay in ("facecam_top", "facecam_bottom", "track", "split", "blur"):
            if lay.replace("_", " ") in text.lower():
                plan["layout"] = lay
    f = {"start": max(0, c["start"] + float(plan.get("start_shift") or 0)), "end": c["end"] + float(plan.get("end_shift") or 0), "status": "producing", "revisions": 0, "updated": time.time()}
    if f["end"] - f["start"] < 3:
        abort(400, "That would make the clip shorter than 3 seconds")
    if plan.get("start_shift") or plan.get("end_shift") or plan.get("rebuild_captions"):
        f["captions"] = []
    if plan.get("title"):
        f["title"] = plan["title"]
    r = dict(c["research"] or {})
    r.setdefault("requests", []).append({"at": time.time(), "text": text, "plan": plan})
    if plan.get("hook_text") is not None:
        r["hook_text"] = plan["hook_text"]
    f["research"] = r
    if plan.get("layout"):
        f["layout"] = {**(c["layout"] or {}), "layout": plan["layout"], "user_set": True}
    if plan.get("preset"):
        f["caption_style"] = {**(c["caption_style"] or {}), "preset": plan["preset"]}
    db.update("clips", "id", cid, **f)
    db.event("revision", f"{cid}: your request \"{text[:80]}\" → {plan}", ref=cid, kind="warn")
    return jsonify(job_id=jobs.enqueue("produce", {"clip_id": cid, "revision": {"by": "you", "request": text}}, priority=2), plan=plan)


@app.post("/api/clips/<cid>/approve")
def approve(cid):
    c = db.one("SELECT * FROM clips WHERE id=?", (cid,)) or abort(404)
    if c["status"] not in ("review", "exception"):
        return jsonify(error=f"Clip is {c['status']}"), 409
    if not c.get("qc") or not c["qc"].get("board"):
        return jsonify(error="Clip has not been checked"), 409
    from . import publish
    db.update("clips", "id", cid, status="approved", updated=time.time())
    db.event("publishing", f"{cid} approved by you", ref=cid, kind="done")
    jid = jobs.enqueue("publish", {"clip_id": cid}, priority=2, dedupe=f"publish:{cid}") if publish.enabled() else None
    return jsonify(ok=True, publish_job=jid, publishing=publish.enabled())


@app.post("/api/clips/<cid>/reject")
def reject(cid):
    db.update("clips", "id", cid, status="rejected", updated=time.time())
    db.event("publishing", f"{cid} rejected by you", ref=cid)
    return jsonify(ok=True)


@app.post("/api/clips/<cid>/metrics")
def metrics(cid):
    """Platform stats for a published clip (from Upload-Post analytics or entered by you)."""
    db.update("clips", "id", cid, metrics={**(request.get_json(force=True) or {}), "at": time.time()})
    return jsonify(ok=True)


@app.get("/api/research")
def get_research():
    return jsonify(techniques=db.q("SELECT * FROM techniques ORDER BY confidence DESC"), benchmarks=db.q("SELECT * FROM benchmarks ORDER BY category, metric"),
                   clips=db.q("SELECT * FROM research WHERE kind='clip' ORDER BY json_extract(metrics,'$.views') DESC LIMIT 50"),
                   references=db.q("SELECT * FROM research WHERE kind='reference' ORDER BY at DESC LIMIT 50"), learning=db.setting("learning", {}))


@app.post("/api/research/reference")
def reference():
    f = request.files.get("file") or abort(400)
    d = os.path.join(config.CFG.media_dir, "references"); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"{int(time.time())}_{os.path.basename(f.filename or 'ref.mp4')}")
    f.save(p)
    return jsonify(job_id=jobs.enqueue("reference", {"path": p, "label": request.form.get("label") or f.filename, "category": request.form.get("category", "gaming")}, priority=5))


@app.get("/api/skills")
def get_skills():
    return jsonify(db.q("SELECT * FROM skills ORDER BY component, status, created DESC"))


@app.post("/api/skills/<int:sid>/activate")
def act_skill(sid):
    try:
        skills.activate(sid)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True)


@app.get("/api/jobs")
def get_jobs():
    return jsonify(db.q("SELECT id, kind, status, attempts, max_attempts, run_at, last_error, updated, payload FROM jobs ORDER BY id DESC LIMIT 200"))


@app.post("/api/jobs")
def run_job():
    kind = (request.get_json(force=True) or {}).get("kind")
    if kind == "faceless":  # make one faceless reel now (on top of the daily schedule)
        return jsonify(job_id=jobs.enqueue("faceless", {"now": True}, priority=3))
    if kind not in ("discover", "check_live", "skills_discover", "learn", "cleanup"):
        abort(400, "unknown job")
    return jsonify(job_id=jobs.enqueue(kind, {}, priority=2))


@app.post("/api/jobs/<int:jid>/retry")
def retry(jid):
    db.run("UPDATE jobs SET status='queued', run_at=?, attempts=0 WHERE id=? AND status IN ('failed','dead')", (time.time(), jid))
    return jsonify(ok=True)


@app.get("/api/report")
def report():
    day = budget.day_start()
    n = lambda sql, a=(): db.one(sql, a)["n"]
    return jsonify(day=time.strftime("%Y-%m-%d", time.gmtime(day)),
                   research={"creators_seen": n("SELECT COUNT(*) n FROM creators WHERE updated_at>=?", (day,)), "new_creators": n("SELECT COUNT(*) n FROM creators WHERE discovered_at>=?", (day,)), "viral_clips_studied": n("SELECT COUNT(*) n FROM research WHERE at>=?", (day,))},
                   monitoring={"sessions": n("SELECT COUNT(*) n FROM sessions WHERE started>=?", (day,)), "live_moments": n("SELECT COUNT(*) n FROM jobs WHERE kind='live_window' AND created>=?", (day,))},
                   production={"candidates": n("SELECT COUNT(*) n FROM candidates WHERE created>=?", (day,)), "clips": n("SELECT COUNT(*) n FROM clips WHERE created>=?", (day,)),
                               "in_review": n("SELECT COUNT(*) n FROM clips WHERE status='review'"), "exceptions": n("SELECT COUNT(*) n FROM clips WHERE status='exception'"),
                               "revisions": db.one("SELECT COALESCE(SUM(revisions),0) n FROM clips WHERE created>=?", (day,))["n"]},
                   publishing={"approved": n("SELECT COUNT(*) n FROM clips WHERE status='approved'"), "published": n("SELECT COUNT(*) n FROM clips WHERE status='published' AND updated>=?", (day,))},
                   problems={"failed_jobs": n("SELECT COUNT(*) n FROM jobs WHERE status='failed' AND updated>=?", (day,)), "notifications": db.q("SELECT level, text FROM notifications WHERE at>=? AND level!='info' ORDER BY id DESC LIMIT 10", (day,))},
                   system={"budget": budget.status(), "workers": [{"worker": h["worker"], "alive": time.time() - h["at"] < 60} for h in db.q("SELECT * FROM heartbeats")]})


def main(host="0.0.0.0", port=None):
    db.conn()
    skills.seed()
    research.seed_techniques()
    app.run(host=host, port=port or int(os.environ.get("PORT", "8080")), threaded=True)
