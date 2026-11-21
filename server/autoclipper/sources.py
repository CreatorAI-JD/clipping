"""Authorized sources only. A source enters production when one of these is true:
- you uploaded it and confirmed you have the right to clip it ('attested'),
- it belongs to a creator whose permission record is 'own' or 'granted'.
Discovery can find any public creator, but nothing from a creator without permission is ingested."""
import os
import shutil
import subprocess
import time

from . import config, db, detect, jobs, media

ALLOWED = ("own", "granted", "attested")  # attested: you confirmed the streamer allows clipping (no written proof on file)


def creator_allowed(creator):
    return bool(creator) and creator.get("permission") in ALLOWED


def _src_dir():
    d = os.path.join(config.CFG.media_dir, "sources")
    os.makedirs(d, exist_ok=True)
    return d


def add_file(path, creator_id=None, attest=False, kind="upload", meta=None, move=False):
    creator = db.one("SELECT * FROM creators WHERE id=?", (creator_id,)) if creator_id else None
    perm = creator.get("permission") if creator else None
    if not (attest or creator_allowed(creator)):
        raise PermissionError("No clipping permission: confirm you have the rights, or record permission for the creator first.")
    dst = os.path.join(_src_dir(), f"{int(time.time() * 1000)}_{os.path.basename(path)}")
    (shutil.move if move else shutil.copy2)(path, dst)
    info = media.probe(dst)
    sid = db.insert("sources", {"kind": kind, "creator_id": creator_id, "path": dst, "duration": info["duration"], "status": "new", "created": time.time(),
                                "meta": {**(meta or {}), "permission": "attested" if attest and perm not in ALLOWED else perm, "probe": info}})
    db.event("intel", f"Source #{sid} added ({info['duration']:.0f}s, {kind})", ref=f"source:{sid}")
    return sid


def resolve_stream(creator):
    """URL ffmpeg can read for a creator's live stream: their own relay/HLS/RTMP URL, or streamlink for a platform URL."""
    if creator.get("source_url"):
        return creator["source_url"]
    if shutil.which("streamlink") and creator.get("url"):
        p = subprocess.run(["streamlink", "--stream-url", creator["url"], "best"], capture_output=True, text=True, timeout=60)
        if p.returncode == 0 and p.stdout.strip().startswith("http"):
            return p.stdout.strip()
        raise jobs.Temporary("streamlink could not open the stream: " + (p.stderr or p.stdout)[-200:])
    raise RuntimeError("No ingest URL: set the creator's stream URL (their HLS/RTMP relay) or install streamlink on the server")


def import_url(url, creator_id, kind="url"):
    creator = db.one("SELECT * FROM creators WHERE id=?", (creator_id,))
    if not creator_allowed(creator):
        raise PermissionError("Creator has no clipping permission on record")
    tmp = os.path.join(_src_dir(), f"dl_{int(time.time())}.mp4")
    media.sh([media.FFMPEG, "-y", "-v", "error", "-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", tmp], timeout=4 * 3600)
    return add_file(tmp, creator_id, kind=kind, move=True, meta={"url": url})


def analyze(source_id, window=None, extra=(), produce_top=None):
    """Find, rank and store candidates; start production for the best ones above the threshold."""
    from . import pipeline
    s = db.one("SELECT * FROM sources WHERE id=?", (source_id,))
    creator = db.one("SELECT * FROM creators WHERE id=?", (s["creator_id"],)) if s.get("creator_id") else None
    cfg = db.setting("production", {}) or {}
    clip_len, min_len = float(cfg.get("clip_len", 40)), float(cfg.get("min_len", 12))
    deep = bool(cfg.get("deep", False))
    work = os.path.join(config.CFG.media_dir, "work", str(source_id))
    os.makedirs(work, exist_ok=True)
    db.update("sources", "id", source_id, status="analyzing")
    res = detect.find(s["path"], category=(creator or {}).get("category"), clip_len=clip_len, min_len=min_len, deep=deep, workdir=work, ref=f"source:{source_id}", extra=extra)
    ranked = [c for c in res["candidates"] if not c.get("dup") and not c.get("skip")]
    for k, c in enumerate(ranked):
        c["rank_position"], c["of"] = k + 1, len(ranked)
    ids = []
    for c in res["candidates"]:
        cid = db.insert("candidates", {"source_id": source_id, "creator_id": s.get("creator_id"), "start": c["start"], "end": c["end"], "peak": c["peak"], "signals": c["signals"],
                                       "transcript": c.get("transcript", ""), "words": c.get("words") or [], "scores": c["scores"], "rank": c["rank"],
                                       "status": "duplicate" if c.get("dup") else "skipped" if c.get("skip") else "scored", "reason": c.get("dup") or ("; ".join(c.get("concerns") or []) if c.get("skip") else c.get("why", "")), "created": time.time()})
        c["id"] = cid
        ids.append(cid)
    thr = float(cfg.get("threshold", 5.5))
    top = int(produce_top if produce_top is not None else cfg.get("clips_per_source", 3))
    chosen = [c for c in ranked if c["rank"] >= thr][:top] or ([ranked[0]] if ranked and not ai_needed_threshold(cfg) else [])
    made = []
    # never clip the same moment twice (also across earlier analyses of this source)
    existing = db.q("SELECT start, end FROM clips WHERE source_id=?", (source_id,))
    for c in chosen:
        if any(min(c["end"], e["end"]) - max(c["start"], e["start"]) > 0.4 * (c["end"] - c["start"]) for e in existing):
            continue
        clip = pipeline.create_from_candidate(c, s, creator)
        db.update("candidates", "id", c["id"], status="produced")
        jobs.enqueue("produce", {"clip_id": clip["id"]}, priority=4)
        made.append(clip["id"])
    db.update("sources", "id", source_id, status="analyzed")
    db.event("scout", f"Source #{source_id}: {len(res['candidates'])} candidates ({res['candidates'][0]['method'] if res['candidates'] else 'none'}), producing {len(made)}", ref=f"source:{source_id}", kind="done")
    return {"candidates": len(ids), "produced": made}


def ai_needed_threshold(cfg):
    return bool(cfg.get("strict_threshold", False))
