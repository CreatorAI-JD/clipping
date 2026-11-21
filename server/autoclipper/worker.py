"""Always-on worker: scheduler + job runners + live capture sessions + heartbeat.
Run one process per machine (`python -m autoclipper worker`). It survives restarts: jobs are leased from the
database, so anything interrupted is picked up again; live sessions restart on the next live check."""
import json
import os
import signal
import threading
import time

from . import budget, config, db, jobs, learn, monitor, notify, pipeline, publish, research, skills, sources

SCHEDULE = [  # (job kind, every seconds)
    ("check_live", 60), ("discover", 1800), ("skills_discover", 86400), ("learn", 6 * 3600), ("cleanup", 6 * 3600), ("watchdog", 300), ("faceless", 900),
]
HANDLERS = {}
_stop = threading.Event()


def handler(kind):
    def wrap(fn):
        HANDLERS[kind] = fn
        return fn
    return wrap


@handler("check_live")
def _live(p):
    return monitor.check_live()


@handler("discover")
def _disc(p):
    return research.discover()


@handler("skills_discover")
def _skills(p):
    return skills.discover()


@handler("learn")
def _learn(p):
    return learn.run()


@handler("analyze_source")
def _analyze(p):
    return sources.analyze(p["source_id"], produce_top=p.get("top"))


@handler("live_window")
def _win(p):
    return monitor.live_window(**p)


@handler("produce")
def _produce(p):
    return pipeline.produce(p["clip_id"], p.get("revision"))


@handler("publish")
def _pub(p):
    return publish.publish(p["clip_id"])


@handler("import_url")
def _imp(p):
    sid = sources.import_url(p["url"], p["creator_id"])
    jobs.enqueue("analyze_source", {"source_id": sid})
    return {"source_id": sid}


@handler("reference")
def _ref(p):
    return research.analyse_reference(p["path"], p["label"], p.get("category", "gaming"))


@handler("background")
def _bg(p):
    from . import faceless
    return faceless.prepare_background(p["source_id"])


@handler("faceless")
def _faceless(p):
    from . import faceless
    return faceless.make(p.get("cfg")) if p.get("now") else faceless.tick()


@handler("cleanup")
def _clean(p):
    """Delete media of rejected clips after 7 days and finished live buffers after 1 day."""
    import shutil
    n = 0
    for c in db.q("SELECT id, files FROM clips WHERE status='rejected' AND updated<?", (time.time() - 7 * 86400,)):
        d = os.path.join(config.CFG.media_dir, "clips", c["id"])
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True); n += 1
    for s in db.q("SELECT * FROM sessions WHERE status='ended' AND ended<?", (time.time() - 86400,)):
        if s["dir"] and os.path.isdir(s["dir"]):
            shutil.rmtree(s["dir"], ignore_errors=True); n += 1
    return {"removed": n}


@handler("watchdog")
def _watch(p):
    """Production Manager health checks: repeated failures, stuck jobs, budget."""
    hour = time.time() - 3600
    failed = db.one("SELECT COUNT(*) n FROM jobs WHERE status='failed' AND updated>?", (hour,))["n"]
    if failed >= 3:
        notify.send("critical", f"{failed} jobs failed in the last hour. Check Cloud → Activity.", key="fails-" + time.strftime("%Y%m%d%H"))
    stuck = db.q("SELECT id, kind FROM jobs WHERE status='running' AND lease_until<?", (time.time() - 3600,))
    return {"failed_last_hour": failed, "stuck": len(stuck), "budget": budget.status()}


def schedule():
    """Make sure each recurring job has exactly one upcoming run (dedupe key per time bucket)."""
    paused = set((db.setting("paused_jobs", []) or []))
    for kind, every in SCHEDULE:
        if kind in paused:
            continue
        bucket = int(time.time() // every)
        jobs.enqueue(kind, {}, priority=1 if kind == "check_live" else 6, dedupe=f"{kind}:{bucket}", max_attempts=2)


def runner(n, kinds=None):
    while not _stop.is_set():
        j = jobs.claim(kinds or list(HANDLERS))  # never take a job kind this worker can't run
        if not j:
            _stop.wait(2)
            continue
        fn = HANDLERS.get(j["kind"])
        try:
            if not fn:
                raise RuntimeError(f"No handler for {j['kind']}")
            stop_lease = threading.Event()

            def keep():  # long renders keep their lease
                while not stop_lease.wait(120):
                    jobs.extend(j["id"])
            threading.Thread(target=keep, daemon=True).start()
            res = fn(j["payload"] or {})
            stop_lease.set()
            jobs.done(j, res if isinstance(res, dict) else {"result": res})
        except Exception as e:
            stop_lease.set() if "stop_lease" in locals() else None
            outcome = jobs.fail(j, e)
            if outcome == "failed" and j["kind"] in ("produce", "analyze_source", "live_window", "publish"):
                ref = (j["payload"] or {}).get("clip_id")
                if ref:
                    db.update("clips", "id", ref, status="exception")
                notify.send("action", f"{j['kind']} failed{' for ' + ref if ref else ''}: {jobs.trace(e)[:200]}", ref=ref)


def heartbeat():
    while not _stop.is_set():
        db.run("INSERT INTO heartbeats (worker, at, info) VALUES (?,?,?) ON CONFLICT(worker) DO UPDATE SET at=excluded.at, info=excluded.info",
               (jobs.WORKER_ID, time.time(), json.dumps({"sessions": monitor.sessions(), "pid": os.getpid(), "threads": threading.active_count()})))
        try:
            schedule()
        except Exception as e:
            db.event("manager", f"Scheduler error: {e}", kind="bad")
        _stop.wait(10)


def main(n=None):
    n = n or config.CFG.workers
    os.makedirs(config.CFG.media_dir, exist_ok=True)
    db.conn()
    skills.seed()
    research.seed_techniques()
    # anything that was mid-run when the server stopped is released for another try
    db.run("UPDATE jobs SET status='queued', lease_until=NULL WHERE status='running' AND worker LIKE ?", (jobs.WORKER_ID.split(":")[0] + ":%",))
    db.run("UPDATE sessions SET status='ended', ended=? WHERE status='live'", (time.time(),))
    db.event("manager", f"Worker {jobs.WORKER_ID} started with {n} runner(s)", kind="done")
    try:
        signal.signal(signal.SIGTERM, lambda *a: _stop.set())
    except ValueError:  # not the main thread (tests, 'all' mode)
        pass
    threads = [threading.Thread(target=heartbeat, daemon=True)]
    threads += [threading.Thread(target=runner, args=(i, ["check_live", "watchdog"] if i == 0 and n > 1 else None), daemon=True) for i in range(n)]
    for t in threads:
        t.start()
    while not _stop.is_set():
        _stop.wait(1)
    for s in list(monitor._sessions.values()):
        s.stop_flag = True
    db.event("manager", f"Worker {jobs.WORKER_ID} stopping", kind="warn")
