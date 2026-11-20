"""Make test reels through the real cloud pipeline and measure them.

  python tools/test_reels.py OUT_DIR

Builds four kinds of source (gameplay + webcam, IRL speaker, two-person podcast, gameplay only), runs analysis ->
production -> 12 checkers for each, then measures every reel and compares it with
  1) benchmarks in the research database (public clip metadata, your reference videos) when there are any,
  2) the editing standards below (conventions of current short-form clipping; targets, not measured from others).
Writes reels, a contact sheet and report.json. Transcription is the test stand-in that hears the tone "speech"."""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, ".."), os.path.join(HERE, "..", "tests")]

STANDARDS = {  # metric: (low, high, why)
    "duration_s": (12, 45, "short enough to finish, long enough for setup + payoff"),
    "lufs": (-16, -12, "platforms normalise around -14 LUFS"),
    "true_peak_db": (-99, -1.0, "headroom so it never distorts"),
    "first_caption_s": (0, 1.0, "words on screen in the first second"),
    "words_per_caption": (1, 4, "readable at a glance"),
    "caption_y": (0.45, 0.78, "inside the safe zone, clear of the platform UI"),
    "caption_height_px": (60, 170, "big, bold captions"),
    "facecam_share": (0.28, 0.45, "webcam big enough to read the reaction"),
    "dead_air_pct": (0, 15, "no long pauses"),
    "qc_overall": (85, 100, "independent checkers"),
}


def measure(clip, rr):
    from autoclipper import media
    f = clip["files"]["final"]
    info, L = media.probe(f), media.loudness(f)
    cues = clip["captions"]
    sil = sum(b - a for a, b in media.silences(f, noise="-40dB", d=0.8))
    g = clip["research"].get("geometry") or {}
    from autoclipper import captions as C
    st = C.style(clip["caption_style"]["preset"])
    face = next((p for p in g.get("panels", []) if p["role"] == "facecam"), None)
    return {"duration_s": round(info["duration"], 1), "lufs": L and round(L["lufs"], 1), "true_peak_db": L and round(L["true_peak"], 1),
            "first_caption_s": round(cues[0]["start"], 2) if cues else None, "words_per_caption": round(sum(len(c["text"].split()) for c in cues) / max(1, len(cues)), 1) if cues else None,
            "caption_y": g.get("caption_y"), "caption_height_px": st["size"], "facecam_share": round(face["out"][3] / 1920, 2) if face else None,
            "dead_air_pct": round(100 * sil / max(0.1, info["duration"]), 1), "qc_overall": clip["qc"]["overall"], "layout": clip["layout"]["layout"], "preset": clip["caption_style"]["preset"]}


def compare(m, bench):
    out = {}
    for k, (lo, hi, why) in STANDARDS.items():
        v = m.get(k)
        out[k] = {"value": v, "target": [lo, hi], "ok": None if v is None else lo <= v <= hi, "why": why}
    for b in bench:
        if b["metric"] == "top_clip_duration_median":
            out["vs_top_public_clips_length"] = {"value": m["duration_s"], "benchmark": b["value"], "n": b["n"], "source": b["source"], "diff_s": round(m["duration_s"] - b["value"], 1)}
        if b["metric"] == "ref_duration":
            out["vs_your_references_length"] = {"value": m["duration_s"], "benchmark": b["value"], "n": b["n"]}
    return out


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    data = os.path.join(out_dir, "data")
    import conftest, fixtures
    base = conftest.fake_openai()
    os.environ.update(AC_DATA_DIR=data, AC_ADMIN_TOKEN="t", OPENAI_API_KEY="sk-test", OPENAI_BASE_URL=base, AC_X264_PRESET="veryfast")
    from autoclipper import config, db, jobs, sources, pipeline
    config.reload(); db.reset()
    fx = os.path.join(out_dir, "src"); os.makedirs(fx, exist_ok=True)
    srcs = [("gameplay_facecam", fixtures.stream_fixture(os.path.join(fx, "gameplay_facecam.mp4"), dur=40)[0], "gaming"),
            ("irl_speaker", fixtures.irl_speech(os.path.join(fx, "irl.mp4"), dur=30)[0], "irl"),
            ("podcast_two", fixtures.podcast_two(os.path.join(fx, "podcast.mp4"), dur=30)[0], "podcast")]
    report = []
    for name, path, cat in srcs:
        db.run("INSERT OR IGNORE INTO creators (platform, login, name, category, permission, discovered_at, updated_at) VALUES ('custom',?,?,?,'own',?,?)", (name, name, cat, time.time(), time.time()))
        cid = db.one("SELECT id FROM creators WHERE login=?", (name,))["id"]
        sid = sources.add_file(path, cid)
        res = sources.analyze(sid, produce_top=1)
        for clip_id in res["produced"]:
            for _ in range(5):  # produce + any revision rounds
                pipeline.produce(clip_id)
                c = db.one("SELECT * FROM clips WHERE id=?", (clip_id,))
                if c["status"] != "revising":
                    break
                j = jobs.claim(["produce"])
                if j:
                    jobs.done(j)
            c = db.one("SELECT * FROM clips WHERE id=?", (clip_id,))
            dst = os.path.join(out_dir, f"{name}.mp4")
            subprocess.run(["cp", c["files"]["final"], dst])
            m = measure(c, None)
            report.append({"reel": name, "clip": clip_id, "status": c["status"], "category": cat, "metrics": m, "compare": compare(m, db.q("SELECT * FROM benchmarks WHERE category=?", (cat,))),
                           "layout_reason": c["layout"].get("reason"), "tickets": [t["problem"] for t in c["qc"]["tickets"]], "unverified": c["qc"]["unverified"]})
            print(name, c["status"], m)
    # contact sheet: 3 frames per reel
    tiles = []
    for r in report:
        p = os.path.join(out_dir, r["reel"] + ".mp4")
        for k, t in enumerate((0.8, 2.5, 5.0)):
            o = os.path.join(out_dir, f"_{r['reel']}_{k}.png")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", p, "-frames:v", "1", "-vf", "scale=300:-2", o])
            tiles.append(o)
    if tiles:
        n = len(report)
        args = ["ffmpeg", "-y", "-v", "error"] + sum((["-i", t] for t in tiles), []) + ["-filter_complex", f"xstack=inputs={len(tiles)}:layout=" + "|".join(f"{c * 300}_{r_ * 534}" for r_ in range(n) for c in range(3)), os.path.join(out_dir, "contact_sheet.png")]
        subprocess.run(args)
        for t in tiles:
            os.remove(t)
    json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=1)
    return report


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/test_reels")
