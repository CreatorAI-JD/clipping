"""Production: candidate -> finished, checked clip in the Review Queue. Every stage is written to the clip's ledger.
Runs inside the worker (job kind 'produce'); a crash mid-way resumes from the job queue, the ledger shows where."""
import os
import shutil
import time

from . import ai, captions, db, media, qc, render, vision

MAX_REVISIONS = 3


def _dir(clip_id):
    from . import config
    d = os.path.join(config.CFG.media_dir, "clips", clip_id)
    os.makedirs(d, exist_ok=True)
    return d


def _stage(clip, stage, agent, fn):
    t0 = time.time()
    entry = {"stage": stage, "agent": agent, "start": t0, "status": "running"}
    clip["ledger"].append(entry)
    db.update("clips", "id", clip["id"], ledger=clip["ledger"], updated=time.time())
    db.event(agent, f"{clip['id']}: {stage} started", ref=clip["id"])
    try:
        out = fn()
        entry.update(status="completed", end=time.time(), ms=int((time.time() - t0) * 1000), output=(out if isinstance(out, str) else (out or {}).get("summary", "")) if out is not None else "")
        db.event(agent, f"{clip['id']}: {stage} done: {entry['output']}"[:400], ref=clip["id"], kind="done")
        return out
    except Exception as e:
        entry.update(status="failed", end=time.time(), ms=int((time.time() - t0) * 1000), error=str(e)[:500])
        db.event(agent, f"{clip['id']}: {stage} failed: {e}", ref=clip["id"], kind="bad")
        raise
    finally:
        db.update("clips", "id", clip["id"], ledger=clip["ledger"], updated=time.time())


def save(clip, **extra):
    clip.update(extra)
    fields = {k: clip[k] for k in ("status", "title", "description", "category", "start", "end", "layout", "facecam", "captions", "caption_style", "files", "scores", "qc", "revisions", "research", "ledger", "words") if k in clip}
    db.update("clips", "id", clip["id"], updated=time.time(), **fields)


def create_from_candidate(cand, source, creator=None):
    cid = db.new_clip_id()
    now = time.time()
    a, b = cand.get("trim") or [cand["start"], cand["end"]]
    row = {"id": cid, "candidate_id": cand.get("id"), "source_id": source["id"], "creator_id": source.get("creator_id"), "status": "producing", "title": cand.get("title") or f"{(creator or {}).get('name') or 'Clip'} @ {int(a // 60)}:{int(a % 60):02d}",
           "description": "", "category": cand.get("category") or (creator or {}).get("category") or "gaming", "start": a, "end": b, "scores": cand.get("scores") or {},
           "research": {"why": cand.get("why", ""), "hook_text": cand.get("hook_text", ""), "concerns": cand.get("concerns") or [], "signals": cand.get("signals") or {}, "rank": cand.get("rank"), "method": cand.get("method"),
                        "rank_position": cand.get("rank_position"), "of": cand.get("of"), "source_permission": source.get("meta", {}).get("permission"),
                        "peak": cand.get("peak"), "ai_trim": bool(cand.get("trim"))},
           "words": cand.get("words") or [], "ledger": [], "created": now, "updated": now}
    db.insert("clips", row)
    return db.one("SELECT * FROM clips WHERE id=?", (cid,))


def _context_words(clip, words):
    return [w for w in words if clip["start"] - 0.05 <= w["start"] and w["end"] <= clip["end"] + 0.3]


def produce(clip_id, revision=None):
    clip = db.one("SELECT * FROM clips WHERE id=?", (clip_id,))
    src_row = db.one("SELECT * FROM sources WHERE id=?", (clip["source_id"],))
    creator = db.one("SELECT * FROM creators WHERE id=?", (clip["creator_id"],)) if clip.get("creator_id") else None
    d = _dir(clip_id)
    clip["files"] = clip.get("files") or {}
    if not src_row or not os.path.exists(src_row["path"] or ""):
        save(clip, status="error")
        raise RuntimeError("Source file is gone")
    src = src_row["path"]
    info = media.probe(src)

    def moment():
        # Hook Specialist + Retention Editor: start on a word, end on a finished sentence, keep the setup
        ws = sorted(clip.get("words") or [], key=lambda w: w["start"])
        a, b = clip["start"], clip["end"]
        r = clip.get("research") or {}
        if any(l["stage"] == "render" and l["status"] == "completed" for l in clip["ledger"][:-1]):
            # already produced once: keep the window (and the captions that belong to it) unless a revision moved it
            return f"kept {a:.1f}-{b:.1f}s ({b - a:.1f}s)"
        if ws and not r.get("ai_trim") and r.get("peak") is not None and not (revision or {}).get("by"):
            # no AI trim: take the phrase around the peak (phrases are split by pauses over 1 s), plus its setup
            inside = [w for w in ws if a - 0.3 <= w["start"] <= b]
            phrases, cur = [], []
            for w in inside:
                if cur and w["start"] - cur[-1]["end"] > 1.0:
                    phrases.append(cur); cur = []
                cur.append(w)
            if cur:
                phrases.append(cur)
            pk = r["peak"]
            k = next((i for i, ph in enumerate(phrases) if ph[0]["start"] - 1 <= pk <= ph[-1]["end"] + 1), None)
            if k is None and phrases:
                k = min(range(len(phrases)), key=lambda i: abs((phrases[i][0]["start"] + phrases[i][-1]["end"]) / 2 - pk))
            if k is not None:
                lo, hi = k, k
                maxlen = float((db.setting("production", {}) or {}).get("clip_len", 40))
                while lo > 0 and phrases[lo][0]["start"] - phrases[lo - 1][-1]["end"] < 2.5 and phrases[hi][-1]["end"] - phrases[lo - 1][0]["start"] <= maxlen and phrases[hi][-1]["end"] - phrases[lo][0]["start"] < 8:
                    lo -= 1
                while hi + 1 < len(phrases) and phrases[hi + 1][0]["start"] - phrases[hi][-1]["end"] < 0.8 and phrases[hi + 1][-1]["end"] - phrases[lo][0]["start"] <= maxlen:
                    hi += 1
                # never shorter than the minimum: add the setup before it first, then what follows
                minlen = float((db.setting("production", {}) or {}).get("min_len", 12))
                # only neighbouring phrases that follow on (gap <= 2.5 s); across a long silence, pad with footage instead
                near_lo = lambda: lo > 0 and phrases[lo][0]["start"] - phrases[lo - 1][-1]["end"] <= 2.5
                near_hi = lambda: hi + 1 < len(phrases) and phrases[hi + 1][0]["start"] - phrases[hi][-1]["end"] <= 2.5
                while phrases[hi][-1]["end"] - phrases[lo][0]["start"] < minlen and (near_lo() or near_hi()):
                    if near_lo() and (not near_hi() or pk - phrases[lo - 1][0]["start"] < phrases[hi + 1][-1]["end"] - pk + 4):
                        lo -= 1
                    else:
                        hi += 1
                a, b = max(0, phrases[lo][0]["start"] - 0.6), phrases[hi][-1]["end"] + 0.6
                clip["start"], clip["end"] = a, b
        if ws:
            first = next((w for w in ws if w["start"] >= a - 0.3), None)
            if first and first["start"] - a > 1.2:
                a = max(0, first["start"] - 0.25)
            last = [w for w in ws if w["end"] <= b + 1.5]
            if last:
                # extend to the end of the sentence (up to 3 s) so it never cuts mid-sentence
                tail = [w for w in ws if last[-1]["end"] <= w["start"] <= last[-1]["end"] + 3]
                end_w = last[-1]
                for w in tail:
                    end_w = w
                    if w["word"].rstrip().endswith((".", "!", "?")):
                        break
                b = min(info["duration"], end_w["end"] + 0.35)
        # every branch: never shorter than the minimum length. Grow after the payoff first (the reaction),
        # then before it (the setup), starting on a word so the hook doesn't open on silence.
        minlen = float((db.setting("production", {}) or {}).get("min_len", 12))
        if b - a < minlen:
            b = min(info["duration"], a + minlen)
            if b - a < minlen:
                na = max(0, b - minlen)
                starts = [w["start"] for w in ws if na - 1.5 <= w["start"] < a]
                a = max(0, starts[0] - 0.25) if starts else na
        clip["start"], clip["end"] = round(a, 3), round(min(info["duration"], b), 3)
        save(clip)
        return f"{clip['start']:.1f}-{clip['end']:.1f}s ({clip['end'] - clip['start']:.1f}s)"

    def extract():
        out = os.path.join(d, "source_clip.mp4")
        keep = clip.get("keep")
        media.extract(src, out, clip["start"], clip["end"])
        clip["files"]["source"] = out
        media.thumb(out, os.path.join(d, "source_frame.jpg"), t=min(1.0, (clip["end"] - clip["start"]) / 3), width=960)
        clip["files"]["source_frame"] = os.path.join(d, "source_frame.jpg")
        save(clip)
        return f"extracted {media.probe(out)['duration']:.1f}s"

    def transcribe():
        ws = _context_words(clip, clip.get("words") or [])
        if not ws and ai.enabled():
            tr = ai.transcribe(media.wav16k(clip["files"]["source"], os.path.join(d, "clip.wav")), ref=clip_id)
            ws = [{**w, "start": w["start"] + clip["start"], "end": w["end"] + clip["start"]} for w in (tr or {}).get("words", [])]
        clip["words_local"] = [{"word": w["word"], "start": round(w["start"] - clip["start"], 3), "end": round(w["end"] - clip["start"], 3)} for w in ws]
        return f"{len(ws)} words" if ws else "no transcript (needs an OpenAI key)"

    def framing():
        if revision and revision.get("layout"):
            lay = revision["layout"]
        elif clip.get("layout") and clip["layout"].get("user_set"):
            lay = clip["layout"]
        elif (src_row or {}).get("kind") == "faceless":  # generated 1080x1920 background: nothing to frame
            lay = {"layout": "blur", "facecam": None, "confidence": 1.0, "reason": "Faceless reel: generated vertical background, used full frame"}
        else:
            lay = vision.analyse(clip["files"]["source"])
        clip["layout"] = lay
        clip["facecam"] = lay.get("facecam") or {}
        save(clip)
        return f"{lay['layout']}: {lay.get('reason', '')}"

    def caption():
        key = (clip.get("caption_style") or {}).get("preset") or captions.preset_for(clip.get("category"))
        st = captions.style(key, (clip.get("caption_style") or {}).get("overrides"))
        if not clip.get("captions") or (revision and revision.get("rebuild_captions")):
            clip["captions"] = captions.cues_from_words(clip.get("words_local") or [], st, hook_words=(clip.get("research") or {}).get("hook_text", "").split())
        clip["caption_style"] = {"preset": key, "overrides": (clip.get("caption_style") or {}).get("overrides") or {}}
        save(clip)
        return f"{len(clip['captions'])} captions, preset {st['name']}"

    def do_render():
        key = clip["caption_style"]["preset"]
        st = captions.style(key, clip["caption_style"].get("overrides"))
        hook = (clip.get("research") or {}).get("hook_text")
        sfx = [{"t": 0.0, "kind": "whoosh"}] if hook else []
        out = render.render(clip["files"]["source"], clip["layout"], clip["captions"], st, d, hook={"text": hook} if hook else None, sfx=sfx, name="final")
        clip["files"].update(clean=out["clean"], final=out["final"], ass=out["ass"])
        media.thumb(out["final"], os.path.join(d, "thumb.jpg"), t=min(1.2, out["duration"] / 2))
        clip["files"]["thumb"] = os.path.join(d, "thumb.jpg")
        clip["_render"] = out
        clip["geometry"] = out["geometry"]
        save(clip, research={**(clip.get("research") or {}), "geometry": out["geometry"]})
        return f"rendered {out['duration']:.1f}s 1080x1920 ({clip['layout']['layout']})"

    def check():
        res = qc.run(clip, clip["_render"], d, creator=creator or {"permission": (src_row.get("meta") or {}).get("permission")})
        clip["qc"] = {**res, "round": (clip.get("qc") or {}).get("round", 0) + 1, "at": time.time(), "history": ((clip.get("qc") or {}).get("history") or []) + ([{"round": (clip.get("qc") or {}).get("round"), "overall": (clip.get("qc") or {}).get("overall"), "tickets": len((clip.get("qc") or {}).get("tickets") or [])}] if clip.get("qc") else [])}
        sc = clip.get("scores") or {}
        b = res["board"]
        clip["scores"] = {**sc, "quality": res["overall"], "hook_qc": b["hook"]["score"], "caption_qc": b["caption_accuracy"]["score"] if b["caption_accuracy"]["score"] is not None else b["caption_timing"]["score"], "facecam_qc": b["facecam"]["score"]}
        save(clip)
        return f"round {clip['qc']['round']}: {len([t for t in res['tickets'] if t['severity'] == 'high'])} must-fix, {len(res['unverified'])} unverified, overall {res['overall']}"

    _stage(clip, "moment", "hook", moment)
    _stage(clip, "extract", "intel", extract)
    _stage(clip, "transcribe", "captions", transcribe)
    _stage(clip, "facecam + layout", "visual", framing)
    _stage(clip, "captions", "captions", caption)
    _stage(clip, "render", "visual", do_render)
    _stage(clip, "quality check", "qa", check)
    return decide(clip, creator)


def decide(clip, creator):
    """Production Manager: fix what can be fixed (max 3 rounds), escalate the rest, never pass an unchecked clip."""
    tickets = clip["qc"]["tickets"]
    fixable = [t for t in tickets if t["severity"] == "high" and t.get("fix")]
    human = [t for t in tickets if t["severity"] == "high" and not t.get("fix")]
    if fixable and clip.get("revisions", 0) < MAX_REVISIONS:
        clip["revisions"] = clip.get("revisions", 0) + 1
        fixes = sorted({t["fix"] for t in fixable})
        save(clip, status="revising")
        db.event("revision", f"{clip['id']}: round {clip['revisions']}/{MAX_REVISIONS}: {', '.join(fixes)} ({'; '.join(t['problem'] for t in fixable[:3])})", ref=clip["id"], kind="warn")
        apply_fixes(clip, fixes)
        return {"status": "revising", "fixes": fixes}
    if fixable or human:
        save(clip, status="exception")
        from . import notify
        why = (fixable + human)[0]["problem"]
        notify.send("action", f"{clip['id']} needs you: {why}" + (" (still failing after 3 revisions)" if fixable else ""), ref=clip["id"])
        return {"status": "exception"}
    save(clip, status="review")
    db.event("publishing", f"{clip['id']} is in the Review Queue (quality {clip['qc']['overall']}, {len(clip['qc']['unverified'])} unverified)", ref=clip["id"], kind="done")
    return {"status": "review"}


def apply_fixes(clip, fixes):
    """Targeted revisions, then the clip is rendered and checked again by a new 'produce' job."""
    from . import jobs
    rev = {}
    heard = clip.get("_heard")
    if ("rebuild_captions" in fixes or "retime_captions" in fixes) and heard and heard.get("words"):
        st = captions.style(clip["caption_style"]["preset"], clip["caption_style"].get("overrides"))
        if "rebuild_captions" in fixes:
            clip["captions"] = captions.cues_from_words(heard["words"], st)
        else:
            pairs = qc.align([w for c in clip["captions"] for w in c["text"].split()], [w["word"] for w in heard["words"]])
            idx = [(i, c) for i, c in enumerate(clip["captions"]) for _ in c["text"].split()]
            for ci, hi in pairs:
                qi, c = idx[ci]
                first = next(k for k, (q, _) in enumerate(idx) if q == qi)
                if ci == first:
                    shift = heard["words"][hi]["start"] - c["start"]
                    c["start"] = round(c["start"] + shift, 3); c["end"] = round(c["end"] + shift, 3)
                    for w in c.get("words") or []:
                        w["s"] = round(w["s"] + shift, 3); w["e"] = round(w["e"] + shift, 3)
            for a, b in zip(clip["captions"], clip["captions"][1:]):
                if a["end"] > b["start"]:
                    a["end"] = b["start"]
    if "reframe" in fixes:
        lay = clip.get("layout") or {}
        fc = lay.get("facecam")
        if fc and clip["revisions"] < 3:
            # widen the webcam crop around its centre by 20%
            cx, cy = fc["x"] + fc["w"] / 2, fc["y"] + fc["h"] / 2
            w, h = min(1, fc["w"] * 1.2), min(1, fc["h"] * 1.2)
            lay["facecam"] = {**fc, "x": max(0, min(1 - w, cx - w / 2)), "y": max(0, min(1 - h, cy - h / 2)), "w": w, "h": h}
        else:  # still wrong: fall back to a layout without a separate facecam panel
            lay = {**lay, "layout": "blur", "facecam": None, "reason": "Fallback after facecam checks failed"}
        lay["user_set"] = True
        clip["layout"] = lay
    if "trim_start" in fixes:
        ws = clip.get("words_local") or []
        if ws and ws[0]["start"] > 0.6:
            clip["start"] = round(clip["start"] + ws[0]["start"] - 0.2, 3)
            clip["captions"] = []
        else:
            clip["start"] = round(clip["start"] + 1.5, 3)
            clip["captions"] = []
    if "jump_cuts" in fixes:
        # tighten: drop leading/trailing dead air; long pauses inside are cut by shortening the window to the speech
        ws = clip.get("words_local") or []
        if ws:
            clip["end"] = round(clip["start"] + ws[-1]["end"] + 0.4, 3)
            clip["start"] = round(clip["start"] + max(0, ws[0]["start"] - 0.2), 3)
            clip["captions"] = []
    src = db.one("SELECT duration FROM sources WHERE id=?", (clip["source_id"],))
    dur = (src or {}).get("duration") or clip["end"]
    clip["end"] = min(dur, clip["end"])
    if clip["end"] - clip["start"] < 5:  # a fix must never shrink the clip to nothing
        clip["start"] = max(0, clip["end"] - 5)
    save(clip, words=clip.get("words") or [])
    jobs.enqueue("produce", {"clip_id": clip["id"], "revision": rev}, priority=3)
