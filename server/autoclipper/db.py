"""Persistent production database (SQLite in WAL mode on the server's volume).
Everything the cloud does is recorded here, so production history survives restarts."""
import json
import os
import sqlite3
import threading
import time

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, login TEXT NOT NULL, name TEXT, url TEXT, category TEXT,
  followers INTEGER, viewers INTEGER, live INTEGER DEFAULT 0, last_live_at REAL, stream_title TEXT, game TEXT,
  score REAL DEFAULT 0, metrics TEXT DEFAULT '{}', permission TEXT DEFAULT 'none', permission_proof TEXT, permission_at REAL,
  monitor INTEGER DEFAULT 0, source_url TEXT, discovered_at REAL, updated_at REAL, history TEXT DEFAULT '[]',
  UNIQUE(platform, login));
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, kind TEXT, creator_id INTEGER, path TEXT, url TEXT, duration REAL, status TEXT, created REAL, meta TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, creator_id INTEGER, started REAL, ended REAL, status TEXT, dir TEXT, last_segment INTEGER DEFAULT -1, stats TEXT DEFAULT '{}', heartbeat REAL);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY, source_id INTEGER, session_id INTEGER, creator_id INTEGER, start REAL, end REAL, peak REAL,
  signals TEXT DEFAULT '{}', transcript TEXT, words TEXT DEFAULT '[]', scores TEXT DEFAULT '{}', rank REAL, status TEXT DEFAULT 'new', reason TEXT, created REAL);
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY, candidate_id INTEGER, source_id INTEGER, creator_id INTEGER, status TEXT, title TEXT, description TEXT, category TEXT,
  start REAL, end REAL, layout TEXT DEFAULT '{}', facecam TEXT DEFAULT '{}', captions TEXT DEFAULT '[]', caption_style TEXT DEFAULT '{}',
  files TEXT DEFAULT '{}', scores TEXT DEFAULT '{}', qc TEXT DEFAULT '{}', revisions INTEGER DEFAULT 0, research TEXT DEFAULT '{}',
  ledger TEXT DEFAULT '[]', words TEXT DEFAULT '[]', publish TEXT DEFAULT '{}', metrics TEXT DEFAULT '{}', created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'queued', priority INTEGER DEFAULT 5,
  run_at REAL, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 4, lease_until REAL, worker TEXT, last_error TEXT,
  created REAL, updated REAL, result TEXT, dedupe_key TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_at, priority);
CREATE TABLE IF NOT EXISTS costs (id INTEGER PRIMARY KEY, at REAL, kind TEXT, units REAL, usd REAL, ref TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at REAL, agent TEXT, kind TEXT, text TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, at REAL, level TEXT, text TEXT, ref TEXT, read INTEGER DEFAULT 0, key TEXT);
CREATE TABLE IF NOT EXISTS research (id INTEGER PRIMARY KEY, kind TEXT, platform TEXT, ref TEXT, title TEXT, metrics TEXT DEFAULT '{}', data TEXT DEFAULT '{}', at REAL, UNIQUE(kind, platform, ref));
CREATE TABLE IF NOT EXISTS techniques (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE, description TEXT, example_ref TEXT, category TEXT, why TEXT, formats TEXT,
  discovered REAL, confidence REAL, tests TEXT DEFAULT '[]', evidence TEXT DEFAULT '{}', updated REAL);
CREATE TABLE IF NOT EXISTS benchmarks (id INTEGER PRIMARY KEY, metric TEXT, category TEXT, value REAL, n INTEGER, source TEXT, at REAL, UNIQUE(metric, category, source));
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, component TEXT, name TEXT, version TEXT, status TEXT, impl TEXT, license TEXT, source_url TEXT,
  eval TEXT DEFAULT '{}', decision TEXT, decided_at REAL, notes TEXT, created REAL, UNIQUE(component, name, version));
CREATE TABLE IF NOT EXISTS heartbeats (worker TEXT PRIMARY KEY, at REAL, info TEXT DEFAULT '{}');
"""

JSON_COLS = {"metrics", "history", "meta", "stats", "signals", "words", "scores", "layout", "facecam", "captions", "caption_style",
             "files", "qc", "research", "ledger", "payload", "result", "data", "tests", "evidence", "eval", "info", "value", "publish"}

_local = threading.local()
_init_lock = threading.Lock()
_inited = set()


def conn():
    path = config.CFG.db_path
    c = getattr(_local, "c", None)
    if c is None or getattr(_local, "path", None) != path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        c = sqlite3.connect(path, timeout=30, isolation_level=None, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=30000")
        c.execute("PRAGMA foreign_keys=ON")
        _local.c, _local.path = c, path
        with _init_lock:
            if path not in _inited:
                c.executescript(SCHEMA)
                _inited.add(path)
    return c


def reset():
    """Forget cached connections (tests, config reload)."""
    c = getattr(_local, "c", None)
    if c:
        c.close()
    _local.c = None
    _inited.clear()


def _dec(row):
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if k in JSON_COLS and isinstance(v, str):
            try:
                d[k] = json.loads(v)
            except ValueError:
                pass
    return d


def _enc(v):
    return json.dumps(v) if isinstance(v, (dict, list)) else v


def q(sql, args=()):
    return [_dec(r) for r in conn().execute(sql, [_enc(a) for a in args]).fetchall()]


def one(sql, args=()):
    r = conn().execute(sql, [_enc(a) for a in args]).fetchone()
    return _dec(r)


def run(sql, args=()):
    cur = conn().execute(sql, [_enc(a) for a in args])
    return cur.lastrowid


def insert(table, row):
    keys = list(row)
    return run(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [row[k] for k in keys])


def upsert(table, row, conflict):
    keys = list(row)
    upd = ",".join(f"{k}=excluded.{k}" for k in keys if k not in conflict)
    return run(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))}) ON CONFLICT({','.join(conflict)}) DO UPDATE SET {upd}", [row[k] for k in keys])


def update(table, key, val, **fields):
    if not fields:
        return
    sets = ",".join(f"{k}=?" for k in fields)
    run(f"UPDATE {table} SET {sets} WHERE {key}=?", [*fields.values(), val])


class tx:
    """BEGIN IMMEDIATE transaction: used where two workers could race (job claims, clip ids)."""
    def __enter__(self):
        conn().execute("BEGIN IMMEDIATE")
        return conn()

    def __exit__(self, et, e, tb):
        conn().execute("ROLLBACK" if et else "COMMIT")
        return False


def setting(key, default=None):
    r = one("SELECT value FROM settings WHERE key=?", (key,))
    return default if r is None else r["value"]


def set_setting(key, value):
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))


def event(agent, text, ref=None, kind="info"):
    run("INSERT INTO events (at, agent, kind, text, ref) VALUES (?,?,?,?,?)", (time.time(), agent, kind, str(text)[:500], ref))
    run("DELETE FROM events WHERE id < (SELECT MAX(id) - 5000 FROM events)")


def new_clip_id():
    day = time.strftime("%Y%m%d", time.gmtime())
    with tx():
        n = (setting("clip_seq", {}) or {})
        k = n.get("day") == day and n.get("n", 0) or 0
        set_setting("clip_seq", {"day": day, "n": k + 1})
    return f"CLIP-{day}-{k + 1:03d}"
