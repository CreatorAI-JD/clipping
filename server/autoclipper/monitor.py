"""24/7 stream watching for creators with clipping permission.

check_live (every minute): asks each platform whether permitted creators are live (Twitch Helix, Kick, YouTube Data API).
A live creator gets a capture session in the worker: ffmpeg records the stream into 10-second segments (a rolling
buffer, oldest deleted). Tier 1 runs on every new segment and costs nothing: audio energy against the stream's own
baseline, plus Twitch chat velocity (anonymous, read-only IRC). When tier 1 fires, the surrounding minute is cut
from the buffer and sent to tier 2/3 (transcription + AI scoring) like any other source."""
import glob
import os
import re
import socket
import ssl
import subprocess
import threading
import time
from collections import deque

import numpy as np
import requests

from . import config, db, jobs, media, sources

SEG = 10  # seconds per segment
BUFFER_MIN = 20
_sessions = {}  # creator_id -> Session
_lock = threading.Lock()
_tw_token = {"t": None, "exp": 0}


def twitch_token():
    c = config.CFG
    if not (c.twitch_id and c.twitch_secret):
        return None
    if _tw_token["t"] and _tw_token["exp"] > time.time() + 60:
        return _tw_token["t"]
    r = requests.post(c.twitch_auth, params={"client_id": c.twitch_id, "client_secret": c.twitch_secret, "grant_type": "client_credentials"}, timeout=20)
    if not r.ok:
        raise jobs.Temporary(f"Twitch auth {r.status_code}")
    j = r.json()
    _tw_token.update(t=j["access_token"], exp=time.time() + j.get("expires_in", 3600))
    return _tw_token["t"]


def helix(path, params=None):
    tok = twitch_token()
    if not tok:
        return None
    r = requests.get(config.CFG.twitch_api + path, params=params, headers={"Client-Id": config.CFG.twitch_id, "Authorization": "Bearer " + tok}, timeout=20)
    if r.status_code == 401:
        _tw_token["t"] = None
        raise jobs.Temporary("Twitch token expired")
    if not r.ok:
        raise jobs.Temporary(f"Twitch {r.status_code}")
    return r.json()


def live_status(creators):
    """{creator_id: {'live': bool, 'title', 'game', 'viewers', 'started'}} for every creator we can check."""
    out = {}
    tw = [c for c in creators if c["platform"] == "twitch"]
    for i in range(0, len(tw), 100):
        j = helix("/streams", [("user_login", c["login"]) for c in tw[i:i + 100]] + [("first", 100)])
        if j is None:
            break
        live = {s["user_login"].lower(): s for s in j.get("data", [])}
        for c in tw[i:i + 100]:
            s = live.get(c["login"].lower())
            out[c["id"]] = {"live": bool(s), "title": s and s.get("title"), "game": s and s.get("game_name"), "viewers": s and s.get("viewer_count"), "started": s and s.get("started_at")}
    for c in [c for c in creators if c["platform"] == "kick"]:
        try:
            r = requests.get(f"{config.CFG.kick_api}/v2/channels/{c['login']}", timeout=20, headers={"User-Agent": "AutoClipper/3.0"})
            j = r.json() if r.ok else {}
            ls = j.get("livestream")
            out[c["id"]] = {"live": bool(ls), "title": ls and ls.get("session_title"), "game": ls and (ls.get("categories") or [{}])[0].get("name"), "viewers": ls and ls.get("viewer_count"), "started": ls and ls.get("start_time")}
        except Exception as e:
            out[c["id"]] = {"error": str(e)}
    for c in [c for c in creators if c["platform"] == "youtube" and config.CFG.youtube_key]:
        r = requests.get(f"{config.CFG.youtube_api}/search", params={"part": "snippet", "channelId": c["login"], "eventType": "live", "type": "video", "key": config.CFG.youtube_key}, timeout=20)
        items = r.json().get("items", []) if r.ok else []
        out[c["id"]] = {"live": bool(items), "title": items and items[0]["snippet"]["title"], "video": items and items[0]["id"]["videoId"]}
    for c in [c for c in creators if c["platform"] == "custom"]:
        out[c["id"]] = {"live": bool(c.get("source_url")) and _probe_ok(c["source_url"])}
    return out


def _probe_ok(url):
    try:
        p = subprocess.run([media.FFPROBE, "-v", "error", "-rw_timeout", "8000000", "-show_entries", "format=format_name", "-of", "csv", url], capture_output=True, timeout=25)
        return p.returncode == 0
    except Exception:
        return False


def check_live():
    cs = db.q("SELECT * FROM creators WHERE monitor=1 AND permission IN ('own','granted')")
    st = live_status(cs)
    now = time.time()
    started = []
    for c in cs:
        s = st.get(c["id"]) or {}
        if "live" not in s:
            continue
        hist = (c.get("history") or [])[-200:]
        if s["live"] != bool(c["live"]):
            hist.append({"at": now, "live": s["live"]})
            db.event("intel", f"{c['name'] or c['login']} is {'LIVE' if s['live'] else 'offline'}", ref=f"creator:{c['id']}", kind="done" if s["live"] else "info")
        db.update("creators", "id", c["id"], live=1 if s["live"] else 0, last_live_at=now if s["live"] else c["last_live_at"], stream_title=s.get("title") or c["stream_title"], game=s.get("game") or c["game"],
                  viewers=s.get("viewers") or c["viewers"], history=hist, updated_at=now)
        if s["live"] and len(_sessions) < config.CFG.max_live_sessions:
            if start_session(db.one("SELECT * FROM creators WHERE id=?", (c["id"],))):
                started.append(c["id"])
        elif not s["live"]:
            stop_session(c["id"], "offline")
    return {"checked": len(cs), "live": sum(1 for v in st.values() if v.get("live")), "started": started}


class Chat(threading.Thread):
    """Anonymous, read-only Twitch chat: counts messages and distinct chatters per second."""
    def __init__(self, login):
        super().__init__(daemon=True)
        self.login, self.stop, self.per_sec = login.lower(), False, deque(maxlen=3600)

    def run(self):
        host = os.environ.get("AC_TWITCH_IRC", "irc.chat.twitch.tv:6697")
        h, p = host.split(":")
        while not self.stop:
            try:
                raw = socket.create_connection((h, int(p)), timeout=30)
                s = ssl.create_default_context().wrap_socket(raw, server_hostname=h) if p == "6697" else raw
                s.sendall(f"PASS SCHMOOPIIE\r\nNICK justinfan{int(time.time()) % 90000 + 10000}\r\nJOIN #{self.login}\r\n".encode())
                buf = b""
                while not self.stop:
                    data = s.recv(4096)
                    if not data:
                        break
                    buf += data
                    *lines, buf = buf.split(b"\r\n")
                    for ln in lines:
                        t = ln.decode(errors="ignore")
                        if t.startswith("PING"):
                            s.sendall(b"PONG :tmi.twitch.tv\r\n")
                        m = re.match(r"^(?:@\S+ )?:(\w+)!\S+ PRIVMSG #\w+ :", t)
                        if m:
                            sec = int(time.time())
                            if not self.per_sec or self.per_sec[-1][0] != sec:
                                self.per_sec.append([sec, 0, set()])
                            self.per_sec[-1][1] += 1
                            self.per_sec[-1][2].add(m.group(1))
            except Exception:
                time.sleep(5)

    def rate(self, a, b):
        rows = [r for r in list(self.per_sec) if a <= r[0] < b]
        return sum(r[1] for r in rows), len(set().union(*[r[2] for r in rows])) if rows else 0


class Session(threading.Thread):
    def __init__(self, creator, url, sid, dirn):
        super().__init__(daemon=True)
        self.c, self.url, self.sid, self.dir = creator, url, sid, dirn
        self.stop_flag, self.proc, self.t0 = False, None, time.time()
        self.energy = deque(maxlen=int(BUFFER_MIN * 60 / 0.5))
        self.last_fire = 0
        self.chat = Chat(creator["login"]) if creator["platform"] == "twitch" else None

    def run(self):
        if self.chat:
            self.chat.start()
        pattern = os.path.join(self.dir, "seg_%06d.ts")
        self.proc = subprocess.Popen([media.FFMPEG, "-v", "error", "-rw_timeout", "15000000", "-i", self.url, "-c", "copy", "-f", "segment", "-segment_time", str(SEG), "-reset_timestamps", "1", pattern],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        seen = -1
        try:
            while not self.stop_flag:
                segs = sorted(glob.glob(os.path.join(self.dir, "seg_*.ts")))
                done = segs[:-1] if self.proc.poll() is None else segs  # the newest one is still being written
                for f in done:
                    n = int(re.search(r"seg_(\d+)", f).group(1))
                    if n <= seen:
                        continue
                    seen = n
                    self.tier1(n, f)
                for f in segs[: max(0, len(segs) - BUFFER_MIN * 60 // SEG)]:  # rolling buffer
                    try:
                        os.remove(f)
                    except OSError:
                        pass
                db.update("sessions", "id", self.sid, last_segment=seen, heartbeat=time.time())
                if self.proc.poll() is not None:
                    break
                time.sleep(2)
        finally:
            self.finish("stream ended" if self.proc.poll() is not None else "stopped")

    def tier1(self, n, f):
        try:
            x = media.pcm(f, 8000)
        except Exception:
            return
        env = media.envelope(x, 8000, 0.5)
        self.energy.extend(env.tolist())
        cfg = db.setting("live", {}) or {}
        need = float(cfg.get("burst", 2.2))
        base = np.median(10 ** (np.array(self.energy) / 20)) if len(self.energy) > 60 else None
        now_lin = 10 ** (env / 20)
        burst = float(now_lin.max() / (base + 1e-6)) if base is not None else 0
        chat_ratio = 0.0
        if self.chat:
            t = time.time()
            msgs, users = self.chat.rate(t - SEG, t)
            past = [self.chat.rate(t - k * SEG, t - (k - 1) * SEG)[0] for k in range(2, 20)]
            med = np.median(past) if past else 0
            chat_ratio = msgs / max(1.0, med) if users >= 3 else 0.0
        fire = (burst >= need or chat_ratio >= float(cfg.get("chat", 3.0))) and time.time() - self.last_fire > float(cfg.get("cooldown", 90))
        st = {"segments": n + 1, "burst": round(burst, 2), "chat": round(chat_ratio, 2), "at": time.time()}
        db.update("sessions", "id", self.sid, stats=st)
        if fire:
            self.last_fire = time.time()
            peak_seg = n
            db.event("intel", f"{self.c['name'] or self.c['login']}: live moment (audio x{burst:.1f}, chat x{chat_ratio:.1f}) at segment {n}", ref=f"creator:{self.c['id']}", kind="warn")
            jobs.enqueue("live_window", {"session_id": self.sid, "creator_id": self.c["id"], "dir": self.dir, "peak_seg": peak_seg, "signals": {"energy": {"burst": round(burst, 2)}, "chat": {"ratio": round(chat_ratio, 2)}}}, priority=2, delay=20)

    def finish(self, why):
        if self.chat:
            self.chat.stop = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        db.update("sessions", "id", self.sid, status="ended", ended=time.time())
        with _lock:
            _sessions.pop(self.c["id"], None)
        db.event("intel", f"Stopped watching {self.c['name'] or self.c['login']}: {why}", ref=f"creator:{self.c['id']}")


def start_session(creator):
    with _lock:
        if creator["id"] in _sessions:
            return False
    try:
        url = sources.resolve_stream(creator)
    except Exception as e:
        from . import notify
        notify.send("action", f"Can't watch {creator['name'] or creator['login']}: {e}", ref=f"creator:{creator['id']}", key=f"ingest-{creator['id']}")
        return False
    d = os.path.join(config.CFG.media_dir, "live", f"{creator['id']}_{int(time.time())}")
    os.makedirs(d, exist_ok=True)
    sid = db.insert("sessions", {"creator_id": creator["id"], "started": time.time(), "status": "live", "dir": d, "heartbeat": time.time()})
    s = Session(creator, url, sid, d)
    with _lock:
        _sessions[creator["id"]] = s
    s.start()
    db.event("intel", f"Watching {creator['name'] or creator['login']} live (session #{sid})", ref=f"creator:{creator['id']}", kind="done")
    return True


def stop_session(creator_id, why="stopped"):
    with _lock:
        s = _sessions.get(creator_id)
    if s:
        s.stop_flag = True


def live_window(session_id, creator_id, dir, peak_seg, signals):
    """Cut the minute around a live moment from the buffer and send it to tier 2/3."""
    pre, post = 4, 2  # segments before / after the peak (40 s + 20 s)
    segs = [os.path.join(dir, f"seg_{k:06d}.ts") for k in range(max(0, peak_seg - pre), peak_seg + post + 1)]
    segs = [s for s in segs if os.path.exists(s)]
    if not segs:
        raise RuntimeError("Segments already rotated out of the buffer")
    lst = os.path.join(dir, f"win_{peak_seg}.txt")
    with open(lst, "w") as f:
        f.write("".join(f"file '{os.path.basename(s)}'\n" for s in segs))
    out = os.path.join(dir, f"win_{peak_seg}.mp4")
    media.sh([media.FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", out], timeout=900)
    sid = sources.add_file(out, creator_id, kind="live", move=True, meta={"session": session_id, "peak_seg": peak_seg})
    peak = (peak_seg - max(0, peak_seg - pre)) * SEG + SEG / 2
    return sources.analyze(sid, extra=[{"peak": peak, "signal": "chat" if signals.get("chat", {}).get("ratio", 0) >= 1 else "energy", **signals.get("chat", {})}], produce_top=1)


def sessions():
    return [{"creator_id": k, "session": v.sid, "running": v.is_alive(), "since": v.t0} for k, v in list(_sessions.items())]
