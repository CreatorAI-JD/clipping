"""Faceless reels made on the server (no one else's footage) and campaign bulk permission."""
import time

from conftest import wait
from autoclipper import db, faceless, jobs


def test_faceless_reel_end_to_end(env, api, worker):
    r = api.post("/api/jobs", json={"kind": "faceless"})
    assert r.status_code == 200
    clip = wait(lambda: db.one("SELECT * FROM clips WHERE json_extract(research,'$.method')='faceless' AND status IN ('review','exception')"), timeout=420)
    assert clip, [dict(e) for e in db.q("SELECT agent, text FROM events ORDER BY id DESC LIMIT 15")]
    assert clip["title"] == "Wait look at this car"
    assert "#gta6" in clip["description"]
    full = api.get(f"/api/clips/{clip['id']}").get_json()
    assert full["captions"], "captions were made from the voiceover"
    assert full["qc"]["board"], "QC ran on the rendered file"
    assert any("rumour" in c.lower() for c in full["research"]["concerns"]), "rumours are flagged for the reviewer"
    src = db.one("SELECT * FROM sources WHERE id=?", (clip["source_id"],))
    assert src["kind"] == "faceless" and src["meta"]["script"].startswith("wait look")
    assert env["state"]["calls"].get("tts", 0) >= 1


def test_faceless_schedule_respects_quota(env):
    db.set_setting("faceless", {"per_day": 1})
    try:
        assert faceless.made_today() >= 1
        assert faceless.tick() == "quota met or one in progress"
        db.set_setting("faceless", {"enabled": False})
        assert faceless.tick() == "off"
    finally:
        db.set_setting("faceless", {})


def test_settings_expose_faceless_defaults(api):
    s = api.get("/api/settings").get_json()
    assert s["faceless"]["per_day"] == 3 and s["faceless"]["niche"]


def test_campaign_bulk_permission(env, api):
    assert api.post("/api/campaigns", json={"url": "", "streamers": ["a"]}).status_code == 400
    r = api.post("/api/campaigns", json={"url": "https://contentrewards.com/campaigns/test", "name": "Test camp",
                                         "streamers": ["StreamerOne", "https://kick.com/kickguy", "twitch:third_one", "https://www.twitch.tv/FourthGuy?x=1"]})
    assert r.status_code == 200, r.get_json()
    got = {(a["platform"], a["login"]) for a in r.get_json()["added"]}
    assert got == {("twitch", "streamerone"), ("kick", "kickguy"), ("twitch", "third_one"), ("twitch", "fourthguy")}
    for plat, login in got:
        c = db.one("SELECT * FROM creators WHERE platform=? AND login=?", (plat, login))
        assert c["permission"] == "granted" and c["monitor"] == 1 and c["permission_proof"].startswith("https://contentrewards")
    assert jobs.counts() is not None


def test_moderation_proxy_for_the_website(api):
    r = api.post("/api/moderate", json={"input": ["hello there"]})
    assert r.status_code == 200 and r.get_json()["results"][0]["flagged"] is False
    assert api.post("/api/moderate", json={"input": []}).status_code == 400


def test_gameplay_background_hides_the_webcam(env, api, worker):
    """Your own gameplay recording becomes the faceless background: webcam side cropped away, nothing of the face left."""
    import os
    import fixtures
    from autoclipper import faceless, media, vision
    src = fixtures.gameplay_with_facecam(os.path.join(env["fx"], "drive.mp4"), dur=40)
    src = src[0] if isinstance(src, tuple) else src
    assert api.post("/api/backgrounds", data={"file": (open(src, "rb"), "drive.mp4")}, content_type="multipart/form-data").status_code == 403
    r = api.post("/api/backgrounds", data={"file": (open(src, "rb"), "drive.mp4"), "attest": "1"}, content_type="multipart/form-data")
    assert r.status_code == 200
    sid = r.get_json()["source_id"]
    b = wait(lambda: db.one("SELECT * FROM sources WHERE id=? AND status='ready'", (sid,)), timeout=180)
    assert b and b["meta"]["cam"], "webcam found in the upload"
    out = os.path.join(env["fx"], "bg_out.mp4")
    assert faceless.gameplay_background(out, 8) == out
    info = media.probe(out)
    assert (info["width"], info["height"]) == (1080, 1920) and not info["has_audio"]
    seen = [f for fr in media.frames(out, fps=0.5, width=540)[0] for f in vision.faces(fr)]
    assert not seen, "no face visible in the cropped gameplay"
    lst = api.get("/api/backgrounds").get_json()
    assert any(x["id"] == sid and x["status"] == "ready" for x in lst)
    api.delete(f"/api/backgrounds/{sid}")
    assert not any(x["id"] == sid for x in api.get("/api/backgrounds").get_json())
