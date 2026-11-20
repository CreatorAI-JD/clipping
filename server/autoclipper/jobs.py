"""Persistent job queue with leases. A crashed or restarted worker never loses a job: its lease runs out
and another worker picks it up. Temporary failures retry with back-off; permanent ones are recorded."""
import json
import re
import os
import socket
import time
import traceback

from . import db

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


class Temporary(Exception):
    """Network hiccup, rate limit, 5xx: safe to retry."""


class Paused(Exception):
    """Budget or limit reached: try again later without using up an attempt."""
    def __init__(self, msg, retry_in=3600):
        super().__init__(msg)
        self.retry_in = retry_in


def enqueue(kind, payload=None, priority=5, delay=0, dedupe=None, max_attempts=4):
    now = time.time()
    try:
        return db.run("INSERT INTO jobs (kind, payload, status, priority, run_at, attempts, max_attempts, created, updated, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (kind, json.dumps(payload or {}), "queued", priority, now + delay, 0, max_attempts, now, now, dedupe))
    except Exception as e:  # duplicate dedupe key: the job already exists
        if "UNIQUE" in str(e):
            r = db.one("SELECT id FROM jobs WHERE dedupe_key=?", (dedupe,))
            return r and r["id"]
        raise


def claim(kinds=None, lease=900):
    """Atomically take the next ready job (or one whose lease expired)."""
    now = time.time()
    with db.tx():
        where = "((status='queued' AND run_at<=?) OR (status='running' AND lease_until<?))"
        args = [now, now]
        if kinds:
            where += f" AND kind IN ({','.join('?' * len(kinds))})"
            args += list(kinds)
        j = db.one(f"SELECT * FROM jobs WHERE {where} ORDER BY priority ASC, run_at ASC LIMIT 1", args)
        if not j:
            return None
        recovered = j["status"] == "running"
        db.run("UPDATE jobs SET status='running', lease_until=?, worker=?, attempts=attempts+?, updated=? WHERE id=?",
               (now + lease, WORKER_ID, 0 if recovered and j["attempts"] else 1, now, j["id"]))
    j = db.one("SELECT * FROM jobs WHERE id=?", (j["id"],))
    if recovered:
        db.event("manager", f"Recovered job #{j['id']} ({j['kind']}) after its worker stopped", ref=str(j["id"]), kind="warn")
    return j


def extend(job_id, lease=900):
    db.run("UPDATE jobs SET lease_until=?, updated=? WHERE id=?", (time.time() + lease, time.time(), job_id))


def done(job, result=None):
    db.run("UPDATE jobs SET status='done', result=?, updated=?, lease_until=NULL WHERE id=?", (json.dumps(result or {}), time.time(), job["id"]))


def fail(job, err):
    now = time.time()
    if isinstance(err, Paused):
        db.run("UPDATE jobs SET status='queued', run_at=?, attempts=MAX(0, attempts-1), last_error=?, updated=?, lease_until=NULL WHERE id=?",
               (now + err.retry_in, str(err), now, job["id"]))
        return "paused"
    temporary = isinstance(err, Temporary) or bool(re.search(r"timed out|temporar|connection|\b429\b|\b5\d\d\b", str(err), re.I))
    if temporary and job["attempts"] < job["max_attempts"]:
        back = min(3600, 30 * 2 ** job["attempts"])
        db.run("UPDATE jobs SET status='queued', run_at=?, last_error=?, updated=?, lease_until=NULL WHERE id=?", (now + back, str(err)[:1000], now, job["id"]))
        db.event("manager", f"Job #{job['id']} {job['kind']}: temporary error, retry {job['attempts']}/{job['max_attempts']} in {back}s: {err}", ref=str(job["id"]), kind="warn")
        return "retry"
    db.run("UPDATE jobs SET status='failed', last_error=?, updated=?, lease_until=NULL WHERE id=?", (str(err)[:2000], now, job["id"]))
    db.event("manager", f"Job #{job['id']} {job['kind']} failed: {err}", ref=str(job["id"]), kind="bad")
    return "failed"


def counts():
    return {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM jobs GROUP BY status")}


def trace(e):
    return "".join(traceback.format_exception_only(type(e), e)).strip()
