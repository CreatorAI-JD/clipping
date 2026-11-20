"""End to end on the server: upload -> analysis -> clip production -> facecam -> captions -> render -> 12 checkers -> Review Queue,
then review edits, AI revision, approval, rights gate, budget pause, crash recovery and persistence."""
import io
import os
import time

from conftest import wait
from autoclipper import budget, captions, config, db, jobs, media


def _upload(api, path, **form):
    with open(path, "rb") as f:
        return api.post("/api/sources", data={"file": (io.BytesIO(f.read()), os.path.basename(path)), **form}, content_type="multipart/form-data")


def test_rights_gate(env, api):
    r = _upload(api, env["stream"])
    assert r.status_code == 403 and "permission" in r.get_json()["error"].lower()
    c = api.post("/api/creators", json={"platform": "twitch", "login": "SomeStreamer"}).get_json()
    assert c["permission"] == "none"
    r = api.patch(f"/api/creators/{c['id']}", json={"monitor": True})
    assert r.status_code == 400  # cannot monitor without permission
    r = api.patch(f"/api/creators/{c['id']}", json={"permission": "granted"})
    assert r.status_code == 400  # proof required


def test_full_production(env, api, worker):
    c = api.post("/api/creators", json={"platform": "custom", "login": "me", "name": "Jamo", "category": "gaming"}).get_json()
    assert api.patch(f"/api/creators/{c['id']}", json={"permission": "own"}).status_code == 200
    env["creator"] = c["id"]
    r = _upload(api, env["stream"], creator_id=str(c["id"]))
    assert r.status_code == 200, r.get_json()
    clip = wait(lambda: next((x for x in api.get("/api/clips").get_json() if x["status"] in ("review", "exception")), None), timeout=400)
    assert clip, api.get("/api/jobs").get_json()[:5]
    full = api.get(f"/api/clips/{clip['id']}").get_json()
    env["clip"] = full["id"]
    print("clip", full["id"], full["status"], full["qc"]["overall"], [t["problem"] for t in full["qc"]["tickets"]])
    assert full["status"] == "review", [t["problem"] for t in full["qc"]["tickets"]]
    # the scout picked the complete reaction (24-33 s), not just any loud second
    assert 20 <= full["start"] <= 27 and full["end"] >= 31, (full["start"], full["end"])
    assert full["research"]["why"] == "complete reaction" and full["research"]["rank_position"] == 1
    # facecam found and placed on top, checked on the rendered frames
    assert full["layout"]["layout"] == "facecam_top"
    fc = full["layout"]["facecam"]
    assert abs(fc["x"] - 1400 / 1920) < 0.03 and abs(fc["w"] - 480 / 1920) < 0.04
    b = full["qc"]["board"]
    assert len(b) == 12 and b["facecam"]["status"] == "pass" and b["facecam"]["score"] >= 80, b["facecam"]
    assert b["caption_accuracy"]["status"] == "pass" and b["caption_timing"]["status"] == "pass", (b["caption_accuracy"], b["caption_timing"])
    assert b["integrity"]["status"] == "pass" and b["rights"]["status"] == "pass"
    assert full["captions"] and all("words" in q for q in full["captions"])
    stages = [s["stage"] for s in full["ledger"]]
    assert stages[:7] == ["moment", "extract", "transcribe", "facecam + layout", "captions", "render", "quality check"]
    # the rendered file
    p = db.one("SELECT files FROM clips WHERE id=?", (full["id"],))["files"]
    info = media.probe(p["final"])
    assert (info["width"], info["height"]) == (1080, 1920) and info["has_audio"]
    L = media.loudness(p["final"])
    assert -16.5 < L["lufs"] < -11.5, L
    # signed media links work, raw paths are not exposed
    assert "files" not in full and api.get(full["media"]["final"]).status_code in (200, 206)
    assert api.get(full["media"]["final"].replace("sig=", "sig=x")).status_code == 403


def test_review_edits_and_rerender(env, api, worker):
    cid = env["clip"]
    full = api.get(f"/api/clips/{cid}").get_json()
    cues = full["captions"]
    cues[0] = {**cues[0], "text": "EDITED words", "pos": {"x": 0.5, "y": 0.7}, "style": {"color": "#FF0000", "anim": "bounce"}}
    r = api.put(f"/api/clips/{cid}", json={"captions": cues, "title": "My title", "facecam": {"x": 0.72, "y": 0.03, "w": 0.27, "h": 0.34}})
    assert r.status_code == 200 and r.get_json()["title"] == "My title"
    api.post(f"/api/clips/{cid}/rerender")
    done = wait(lambda: (lambda x: x if x["status"] in ("review", "exception") and x["updated"] > full["updated"] else None)(api.get(f"/api/clips/{cid}").get_json()), timeout=300)
    assert done and done["captions"][0]["text"] == "EDITED words"
    ass = open(db.one("SELECT files FROM clips WHERE id=?", (cid,))["files"]["ass"]).read()
    assert "EDITED" in ass and "&H000000FF" in ass.upper()  # red in ASS BGR
    assert done["layout"]["user_set"] and abs(done["layout"]["facecam"]["w"] - 0.27) < 0.001


def test_ai_revision_request(env, api, worker):
    cid = env["clip"]
    assert wait(lambda: not db.one("SELECT COUNT(*) n FROM jobs WHERE kind='produce' AND status IN ('queued','running')")["n"], timeout=400)
    before = api.get(f"/api/clips/{cid}").get_json()
    r = api.post(f"/api/clips/{cid}/revise", json={"request": "start a second later and use karaoke captions"})
    assert r.status_code == 200 and r.get_json()["plan"]["preset"] == "karaoke"
    idle = lambda: not db.one("SELECT COUNT(*) n FROM jobs WHERE kind='produce' AND status IN ('queued','running')")["n"]
    done = wait(lambda: (lambda x: x if x["status"] in ("review", "exception") and idle() else None)(api.get(f"/api/clips/{cid}").get_json()), timeout=400)
    assert done and abs(done["start"] - (before["start"] + 1.0)) < 0.5 and done["caption_style"]["preset"] == "karaoke"


def test_caption_sync_revision_loop(env, api, worker):
    """Captions out of sync in the render are caught by listening to the file, re-timed and re-rendered."""
    idle = lambda: not db.one("SELECT COUNT(*) n FROM jobs WHERE kind='produce' AND status IN ('queued','running')")["n"]
    assert wait(idle, timeout=400)
    cid = env["clip"]
    t0 = time.time()
    env["state"]["shift"] = 0.6
    try:
        db.update("clips", "id", cid, status="producing", revisions=0)
        jobs.enqueue("produce", {"clip_id": cid}, priority=1)
        ev = wait(lambda: db.one("SELECT * FROM events WHERE agent='revision' AND text LIKE ? AND at>?", (f"{cid}: round 1/3%retime_captions%", t0)), timeout=400)
        assert ev, [e["text"] for e in db.q("SELECT text FROM events WHERE at>? ORDER BY id", (t0,))][-12:]
        done = wait(lambda: (lambda x: x if x["status"] in ("review", "exception") and idle() else None)(api.get(f"/api/clips/{cid}").get_json()), timeout=500)
        assert done and done["status"] == "review" and done["revisions"] >= 1, done and (done["status"], done["qc"]["tickets"])
        assert done["qc"]["board"]["caption_timing"]["status"] == "pass", done["qc"]["board"]["caption_timing"]
        assert any(h.get("tickets") for h in done["qc"]["history"])
    finally:
        env["state"]["shift"] = 0.0


def test_approve_and_publishing_off(env, api):
    cid = env["clip"]
    c = api.get(f"/api/clips/{cid}").get_json()
    if c["status"] != "review":
        db.update("clips", "id", cid, status="review")
    r = api.post(f"/api/clips/{cid}/approve").get_json()
    assert r["ok"] and r["publishing"] is False and r["publish_job"] is None
    assert api.get(f"/api/clips/{cid}").get_json()["status"] == "approved"


def test_budget_pauses_paid_work(env):
    db.set_setting("budget", {"daily": 0.0001, "monthly": 100})
    try:
        budget.record("test", 1, 0.01)
        try:
            budget.guard(0.001, "test")
            assert False, "should pause"
        except jobs.Paused as e:
            assert "budget" in str(e).lower()
        j = jobs.enqueue("noop_paid", {})
        job = db.one("SELECT * FROM jobs WHERE id=?", (j,))
        db.run("UPDATE jobs SET status='running', attempts=1 WHERE id=?", (j,))
        assert jobs.fail(db.one("SELECT * FROM jobs WHERE id=?", (j,)), jobs.Paused("budget", retry_in=60)) == "paused"
        after = db.one("SELECT * FROM jobs WHERE id=?", (j,))
        assert after["status"] == "queued" and after["attempts"] == 0 and after["run_at"] > time.time() + 30
        assert db.one("SELECT COUNT(*) n FROM notifications WHERE text LIKE 'Daily budget%'")["n"] >= 1
    finally:
        db.set_setting("budget", {"daily": 5, "monthly": 100})
        db.run("DELETE FROM jobs WHERE kind='noop_paid'")


def test_crash_recovery_and_persistence(env):
    j = jobs.enqueue("noop_recover", {"x": 1})
    got = jobs.claim(["noop_recover"], lease=1)
    assert got["id"] == j
    time.sleep(1.2)  # the worker "dies": its lease runs out
    again = jobs.claim(["noop_recover"])
    assert again and again["id"] == j
    jobs.done(again)
    # a fresh connection (server restart) sees all production history
    db.reset()
    assert db.one("SELECT COUNT(*) n FROM clips")["n"] >= 1
    assert db.one("SELECT status FROM jobs WHERE id=?", (j,))["status"] == "done"
    assert db.one("SELECT COUNT(*) n FROM events")["n"] > 10


def test_status_and_report(env, api, worker):
    s = api.get("/api/status").get_json()
    assert s["integrations"]["openai"] is True and "sk-test" not in str(s)
    assert any(w["alive"] for w in s["workers"])
    rep = api.get("/api/report").get_json()
    assert rep["production"]["clips"] >= 1
    assert api.get("/api/status", headers={"Authorization": "Bearer wrong"}).status_code == 401
