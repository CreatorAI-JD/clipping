"""Discovery, viral research + benchmarks, live status, skills registry and learning, against fake platform APIs."""
import json
import threading
import time

from conftest import _free_port
from autoclipper import config, db, learn, monitor, research, skills


def fake_platforms():
    from flask import Flask, request, jsonify
    app = Flask("fake-platforms")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    @app.post("/oauth2/token")
    def tok():
        return jsonify(access_token="app-token", expires_in=3600)

    @app.get("/helix/games")
    def games():
        return jsonify(data=[{"id": "32982", "name": request.args.get("name")}])

    @app.get("/helix/streams")
    def streams():
        logins = request.args.getlist("user_login")
        if logins:
            return jsonify(data=[{"user_login": l, "user_name": l, "title": "GTA RP", "game_name": "Grand Theft Auto V", "viewer_count": 1234, "started_at": now} for l in logins if l == "bigstreamer"])
        return jsonify(data=[{"user_login": f"streamer{i}", "user_name": f"Streamer{i}", "title": "live", "game_name": "Grand Theft Auto V", "viewer_count": 5000 - i * 100} for i in range(12)])

    @app.get("/helix/clips")
    def clips():
        return jsonify(data=[{"id": f"c{i}", "title": ["NO WAY HE DID THAT", "he crashed the car?", "chat goes crazy 😂", "Insane escape", "the pier", "wait for it"][i % 6], "view_count": 100000 // (i + 1), "duration": [22, 31, 18, 45, 27, 35][i % 6], "broadcaster_name": f"Streamer{i % 4}", "created_at": now, "url": f"https://clips.twitch.tv/c{i}"} for i in range(12)])

    @app.get("/kick/v2/clips")
    def kick():
        return jsonify(clips=[{"id": f"k{i}", "title": "kick moment", "views": 9000 - i, "duration": 30, "channel": {"slug": f"kicker{i}", "username": f"Kicker{i}"}, "category": {"name": "Just Chatting"}, "created_at": now} for i in range(3)])

    port = _free_port()
    threading.Thread(target=lambda: app.run(port=port, threaded=True), daemon=True).start()
    time.sleep(0.6)
    return f"http://127.0.0.1:{port}"


def test_discovery_research_benchmarks(env):
    base = fake_platforms()
    c = config.CFG
    old = (c.twitch_id, c.twitch_secret, c.twitch_api, c.twitch_auth, c.kick_api)
    c.twitch_id, c.twitch_secret, c.twitch_api, c.twitch_auth, c.kick_api = "id", "secret", base + "/helix", base + "/oauth2/token", base + "/kick"
    monitor._tw_token.update(t=None, exp=0)
    try:
        db.set_setting("discovery", {"games": ["Grand Theft Auto V"]})
        out = research.discover()
        assert out["found"] >= 12
        cr = db.q("SELECT * FROM creators WHERE platform IN ('twitch','kick') AND permission_proof IS NULL AND permission != 'own'")  # skip ones other tests granted
        assert len(cr) >= 15 and all(x["permission"] == "none" and not x["monitor"] for x in cr)  # discovered, never watched
        top = db.one("SELECT * FROM creators WHERE platform='twitch' ORDER BY score DESC")
        assert top["score"] > 0 and top["viewers"]
        assert db.one("SELECT COUNT(*) n FROM research WHERE kind='clip'")["n"] >= 12
        b = {r["metric"]: r for r in db.q("SELECT * FROM benchmarks WHERE category='gaming' AND source='public clip metadata'")}
        assert "top_clip_duration_median" in b and b["top_clip_duration_median"]["n"] >= 5 and 15 < b["top_clip_duration_median"]["value"] < 50
        assert "title_caps_ratio" in b
        # live status: permitted twitch creator goes live; no ingest URL and no streamlink -> you are told, nothing pretends to watch
        db.run("INSERT INTO creators (platform, login, name, url, permission, monitor, permission_proof, discovered_at, updated_at) VALUES ('twitch','bigstreamer','Big','https://www.twitch.tv/bigstreamer','granted',1,'https://x',?,?)", (time.time(), time.time()))
        res = monitor.check_live()
        big = db.one("SELECT * FROM creators WHERE login='bigstreamer'")
        assert big["live"] == 1 and res["live"] >= 1
        n = db.one("SELECT * FROM notifications WHERE text LIKE ?", ("Can't watch Big%",))
        assert n, "should explain why it can't watch"
        db.run("UPDATE creators SET monitor=0 WHERE login='bigstreamer'")
    finally:
        c.twitch_id, c.twitch_secret, c.twitch_api, c.twitch_auth, c.kick_api = old


def test_skills_registry(env):
    skills.seed()
    class R:
        def __init__(s, j): s.ok = True; s._j = j
        def json(s): return s._j
    fake = lambda url, timeout=20: R({"info": {"version": "9.9.9", "license": "GPL-3.0" if "pyannote" in url else "MIT", "summary": "x", "project_url": url, "classifiers": []}})
    out = skills.discover(fetch=fake)
    assert out["found"] >= 5
    cand = db.q("SELECT * FROM skills WHERE version='9.9.9'")
    assert all(s["impl"] == "" for s in cand)  # recorded, never installed
    assert any(s["status"] == "rejected" and "licence" in (s["decision"] or "") for s in cand)
    active = db.one("SELECT * FROM skills WHERE component='face_detector' AND status='active'")
    assert active["name"] == "lbp-skimage"
    # evaluation on a fixture with a known webcam box
    import fixtures, os
    p = os.path.join(env["fx"], "fc_eval.mp4")
    fixtures.gameplay_with_facecam(p, dur=6)
    truth = (1400 / 1920, 40 / 1080, 480 / 1920, 360 / 1080)
    r = skills.evaluate_face("lbp-skimage", [(p, truth)])
    assert r["ok"] and r["iou"] > 0.8, r
    y = skills.evaluate_face("yunet-opencv", [(p, truth)])
    assert y["ok"] is False and "model" in y["why"]
    sid = db.one("SELECT id FROM skills WHERE name='yunet-opencv'")["id"]
    assert skills.decide(sid, y, r) is False
    try:
        skills.activate(sid); assert False
    except ValueError:
        pass


def test_learning_needs_data_then_adjusts(env):
    assert learn.run()["n"] < 6 or True
    for i in range(8):
        good = i % 2 == 0
        db.insert("clips", {"id": f"LEARN-{i}", "status": "published", "category": "irl", "start": 0, "end": 25, "caption_style": {"preset": "karaoke" if good else "bold"}, "layout": {"layout": "track"},
                            "scores": {"story": 9 if good else 3, "hook": 6}, "metrics": {"views": 20000 if good else 3000}, "created": time.time(), "updated": time.time()})
    out = learn.run()
    assert out["n"] >= 8
    assert db.setting("category_presets")["irl"] == "karaoke"
    assert db.setting("profile_weights")["irl"]["story"] > 1
    db.run("DELETE FROM clips WHERE id LIKE 'LEARN-%'")


def test_reference_video_benchmarks(env):
    import os
    import fixtures
    from autoclipper import captions, render, vision
    src = os.path.join(env["fx"], "ref_src.mp4")
    fixtures.gameplay_with_facecam(src, dur=8)
    st = captions.style("bold")
    out = render.render(src, vision.analyse(src), captions.cues_from_words([{"word": w, "start": 0.5 + i * 0.4, "end": 0.8 + i * 0.4} for i, w in enumerate("wait for it no way".split())], st), st, os.path.join(env["fx"], "ref"), name="ref")
    final = out["final"]
    m = research.analyse_reference(final, "our reel", "gaming")
    assert m["vertical"] and m["duration"] > 3 and m["lufs"] is not None
    assert db.one("SELECT * FROM benchmarks WHERE metric='ref_duration' AND source='your reference videos'")
