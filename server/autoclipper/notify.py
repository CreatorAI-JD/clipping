"""Notifications: only important problems (critical) and decisions (action). Routine events go to the activity log
and the daily report. Optional webhook (Discord/Slack-compatible JSON) for alerts while you are away."""
import time

import requests

from . import config, db


def send(level, text, ref=None, key=None):
    if key and db.one("SELECT id FROM notifications WHERE key=? AND at>?", (key, time.time() - 86400)):
        return
    db.run("INSERT INTO notifications (at, level, text, ref, key) VALUES (?,?,?,?,?)", (time.time(), level, str(text)[:600], ref, key))
    db.event("manager", f"Notification ({level}): {text}", ref=ref, kind="bad" if level == "critical" else "warn")
    url = config.CFG.webhook_url
    if url and level in ("critical", "action"):
        try:
            requests.post(url, json={"content": f"AutoClipper [{level}] {text}", "text": f"AutoClipper [{level}] {text}"}, timeout=10)
        except Exception:
            pass
