"""Spending ledger + daily/monthly caps. Every paid call is estimated before it runs and recorded after.
When a cap is reached, expensive work raises Paused (the job waits) instead of spending more."""
import calendar
import time

from . import config, db, jobs

# USD estimates; editable through the settings API ("prices")
PRICES = {"whisper_per_min": 0.006, "chat_in_per_1m": 0.15, "chat_out_per_1m": 0.60, "moderation": 0.0, "tts_per_1m_chars": 15.0, "render_cpu_min": 0.0}


def prices():
    return {**PRICES, **(db.setting("prices", {}) or {})}


def caps():
    s = db.setting("budget", {}) or {}
    return {"daily": float(s.get("daily", config.CFG.daily_budget)), "monthly": float(s.get("monthly", config.CFG.monthly_budget)), "warn": float(s.get("warn", 0.8))}


def spent(since):
    r = db.one("SELECT COALESCE(SUM(usd),0) s FROM costs WHERE at>=?", (since,))
    return r["s"] or 0.0


def day_start(t=None):
    t = time.gmtime(t or time.time())
    return calendar.timegm((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0))


def month_start(t=None):
    t = time.gmtime(t or time.time())
    return calendar.timegm((t.tm_year, t.tm_mon, 1, 0, 0, 0))


def status():
    c = caps()
    d, m = spent(day_start()), spent(month_start())
    return {"today": round(d, 4), "month": round(m, 4), **c, "paused": (c["daily"] > 0 and d >= c["daily"]) or (c["monthly"] > 0 and m >= c["monthly"])}


def guard(est_usd=0.0, what="AI call"):
    s = status()
    if s["daily"] > 0 and s["today"] + est_usd > s["daily"]:
        from . import notify
        notify.send("critical", f"Daily budget reached (${s['today']:.2f} of ${s['daily']:.2f}). Paid work paused until tomorrow.", key="budget-day-" + time.strftime("%Y%m%d"))
        raise jobs.Paused(f"Daily budget reached before {what}", retry_in=max(600, day_start() + 86400 - time.time()))
    if s["monthly"] > 0 and s["month"] + est_usd > s["monthly"]:
        from . import notify
        notify.send("critical", f"Monthly budget reached (${s['month']:.2f} of ${s['monthly']:.2f}). Paid work paused.", key="budget-month-" + time.strftime("%Y%m"))
        raise jobs.Paused(f"Monthly budget reached before {what}", retry_in=6 * 3600)
    if s["daily"] > 0 and s["today"] >= s["daily"] * s["warn"]:
        from . import notify
        notify.send("action", f"Spending at ${s['today']:.2f}, {round(100 * s['today'] / s['daily'])}% of today's budget.", key="budget-warn-" + time.strftime("%Y%m%d"))


def record(kind, units, usd, ref=None):
    db.run("INSERT INTO costs (at, kind, units, usd, ref) VALUES (?,?,?,?,?)", (time.time(), kind, units, round(usd, 6), ref))
