"""Publishing Manager: only clips you approved, only when publishing is switched on, once per clip (idempotency key)."""
import json
import time

import requests

from . import config, db, jobs


def enabled():
    return bool((db.setting("publishing", {}) or {}).get("enabled")) and bool(config.CFG.upload_post_key)


def publish(clip_id):
    c = db.one("SELECT * FROM clips WHERE id=?", (clip_id,))
    if c["status"] != "approved":
        raise RuntimeError(f"{clip_id} is {c['status']}, not approved")
    if (c.get("publish") or {}).get("request_id"):
        return c["publish"]
    cfg = db.setting("publishing", {}) or {}
    plats = cfg.get("platforms") or ["tiktok", "youtube", "instagram"]
    with open(c["files"]["final"], "rb") as f:
        r = requests.post(config.CFG.upload_post_api + "/upload", headers={"Authorization": "Apikey " + config.CFG.upload_post_key, "Idempotency-Key": clip_id},
                          data={"user": cfg.get("profile", "autoclipper"), "title": (c.get("title") or "")[:100], "description": c.get("description") or "", "platform[]": plats}, files={"video": (clip_id + ".mp4", f, "video/mp4")}, timeout=600)
    if r.status_code >= 500 or r.status_code == 429:
        raise jobs.Temporary(f"Upload-Post {r.status_code}")
    if not r.ok:
        db.update("clips", "id", clip_id, status="error", publish={"error": r.text[:300], "at": time.time()})
        raise RuntimeError(f"Upload-Post {r.status_code}: {r.text[:200]}")
    j = r.json()
    pub = {"at": time.time(), "platforms": plats, "request_id": j.get("request_id") or j.get("id") or "ok", "response": {k: j[k] for k in list(j)[:6]}}
    db.update("clips", "id", clip_id, status="published", publish=pub, updated=time.time())
    db.event("publishing", f"{clip_id} published to {', '.join(plats)}", ref=clip_id, kind="done")
    return pub
