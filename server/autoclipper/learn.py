"""Performance Analyst: compares published clips by creator, category, length, layout, caption preset and hook,
normalised to the median views of the account so audience size doesn't skew results. Needs 6 clips with stats.
Findings re-weight the scoring profiles and the caption preset per category, a little at a time. Correlation only."""
import statistics as st
import time

from . import db


def run():
    rows = [c for c in db.q("SELECT * FROM clips WHERE status='published'") if (c.get("metrics") or {}).get("views") is not None]
    out = {"n": len(rows), "at": time.time(), "findings": []}
    if len(rows) < 6:
        out["note"] = f"{len(rows)} of 6 published clips with stats: nothing re-weighted yet"
        db.set_setting("learning", out)
        return out
    med = st.median(r["metrics"]["views"] for r in rows) or 1
    for r in rows:
        r["rel"] = r["metrics"]["views"] / med
        r["len_b"] = "under 20 s" if r["end"] - r["start"] < 20 else "20-40 s" if r["end"] - r["start"] < 40 else "40 s+"
        r["preset"] = (r.get("caption_style") or {}).get("preset")
        r["lay"] = (r.get("layout") or {}).get("layout")
    for feat in ("category", "len_b", "preset", "lay", "creator_id"):
        groups = {}
        for r in rows:
            groups.setdefault(r.get(feat), []).append(r["rel"])
        for k, v in groups.items():
            if k is None or len(v) < 3 or len(v) == len(rows):
                continue
            rest = [r["rel"] for r in rows if r.get(feat) != k]
            out["findings"].append({"feature": feat, "value": k, "n": len(v), "vs_rest": round(st.median(v) / (st.median(rest) or 1), 2), "weak": len(v) < 5})
    # caption preset per category: switch only with a clear, repeated difference
    cp = db.setting("category_presets", {}) or {}
    for cat in {r["category"] for r in rows}:
        by = {}
        for r in rows:
            if r["category"] == cat:
                by.setdefault(r["preset"], []).append(r["rel"])
        good = [(st.median(v), k) for k, v in by.items() if len(v) >= 3]
        if len(good) >= 2:
            good.sort(reverse=True)
            if good[0][0] > good[1][0] * 1.3:
                cp[cat] = good[0][1]
    db.set_setting("category_presets", cp)
    # scoring profiles: dimensions whose scores go together with better results count a bit more
    dims = ["hook", "entertainment", "context", "story", "emotion", "relevance", "replay", "pacing"]
    pw = db.setting("profile_weights", {}) or {}
    for cat in {r["category"] for r in rows}:
        rs = [r for r in rows if r["category"] == cat]
        if len(rs) < 6:
            continue
        adj = {}
        for d in dims:
            xs = [(r["scores"].get(d), r["rel"]) for r in rs if (r.get("scores") or {}).get(d) is not None]
            if len(xs) < 6:
                continue
            hi = [v for s, v in xs if s >= 7]; lo = [v for s, v in xs if s <= 5]
            if hi and lo:
                adj[d] = round(max(0.85, min(1.25, (st.median(hi) / (st.median(lo) or 1)) ** 0.25)), 3)
        pw[cat] = adj
    db.set_setting("profile_weights", pw)
    out["category_presets"], out["profile_weights"] = cp, pw
    db.set_setting("learning", out)
    db.event("performance", f"Learning from {len(rows)} published clips: {len(out['findings'])} findings", kind="done")
    return out
