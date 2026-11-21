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
