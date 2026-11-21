"""Watchlist: streamers you confirm allow clipping are watched 24/7 (permission 'attested'), their clips still wait for a person."""
from autoclipper import db, qc, sources


def test_watchlist_attests_and_watches(api):
    assert api.post("/api/watchlist", json={"streamers": ["wl_alpha"]}).status_code == 400  # must confirm
    r = api.post("/api/watchlist", json={"streamers": ["WL_Alpha", "kick:wl_kick", "https://www.twitch.tv/WL_Third"], "attest": True})
    assert r.status_code == 200, r.get_data(as_text=True)
    rows = {c["login"]: c for c in db.q("SELECT * FROM creators WHERE login IN ('wl_alpha','wl_kick','wl_third')")}
    assert set(rows) == {"wl_alpha", "wl_kick", "wl_third"}
    assert all(c["permission"] == "attested" and c["monitor"] == 1 for c in rows.values()), [(c["login"], c["permission"], c["monitor"]) for c in rows.values()]
    assert rows["wl_kick"]["platform"] == "kick"
    assert sources.creator_allowed(rows["wl_alpha"])
    # included in the 24/7 live check query
    assert db.q("SELECT id FROM creators WHERE monitor=1 AND permission IN ('own','granted','attested') AND login='wl_alpha'")


def test_watchlist_never_downgrades_granted(api):
    api.post("/api/campaigns", json={"url": "https://example.com/camp", "streamers": ["wl_camp"]})
    api.post("/api/watchlist", json={"streamers": ["wl_camp"], "attest": True})
    c = db.one("SELECT * FROM creators WHERE login='wl_camp'")
    assert c["permission"] == "granted" and c["permission_proof"] == "https://example.com/camp"

