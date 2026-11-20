"""24/7 watching: a permitted creator's live stream (a real HLS stream served locally) is detected as live,
captured into segments, tier-1 detection fires on the reaction, and the moment becomes a checked clip in Review."""
import functools
import http.server
import os
import subprocess
import threading
import time

from conftest import _free_port, wait
from autoclipper import db, jobs, monitor


def test_live_stream_to_review(env, api, worker):
    live = os.path.join(env["dir"], "hls")
    os.makedirs(live, exist_ok=True)
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-re", "-stream_loop", "-1", "-i", env["stream"], "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "8",
                           "-hls_flags", "delete_segments+omit_endlist", os.path.join(live, "live.m3u8")])
    port = _free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(http.server.SimpleHTTPRequestHandler, directory=live))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        assert wait(lambda: os.path.exists(os.path.join(live, "live.m3u8")), timeout=30)
        c = api.post("/api/creators", json={"platform": "custom", "login": "livetest", "name": "Live Test", "category": "gaming", "source_url": f"http://127.0.0.1:{port}/live.m3u8"}).get_json()
        assert api.patch(f"/api/creators/{c['id']}", json={"permission": "granted", "permission_proof": "https://example.com/permission"}).status_code == 200
        assert api.patch(f"/api/creators/{c['id']}", json={"monitor": True}).status_code == 200
        db.set_setting("live", {"burst": 2.0, "chat": 3.0, "cooldown": 60})
        jobs.enqueue("check_live", {}, priority=0)
        assert wait(lambda: db.one("SELECT * FROM sessions WHERE creator_id=? AND status='live'", (c["id"],)), timeout=120), "session did not start"
        assert wait(lambda: db.one("SELECT live FROM creators WHERE id=?", (c["id"],))["live"] == 1, timeout=30)
        fired = wait(lambda: db.one("SELECT * FROM jobs WHERE kind='live_window' AND payload LIKE ?", (f'%"creator_id": {c["id"]}%',)), timeout=240)
        assert fired, db.one("SELECT stats FROM sessions WHERE creator_id=?", (c["id"],))
        clip = wait(lambda: db.one("SELECT * FROM clips WHERE creator_id=? AND status IN ('review','exception')", (c["id"],)), timeout=500)
        assert clip, db.q("SELECT kind, status, last_error FROM jobs ORDER BY id DESC LIMIT 6")
        src = db.one("SELECT * FROM sources WHERE id=?", (clip["source_id"],))
        assert src["kind"] == "live"
        assert clip["qc"]["board"]["rights"]["status"] == "pass"
        print("live clip", clip["id"], clip["status"], clip["start"], clip["end"], [t["problem"] for t in clip["qc"]["tickets"]])
    finally:
        monitor.stop_session(c["id"]) if "c" in locals() else None
        ff.terminate(); srv.shutdown()
        if "c" in locals():
            api.patch(f"/api/creators/{c['id']}", json={"monitor": False})
