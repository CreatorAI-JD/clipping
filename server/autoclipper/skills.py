"""Skill registry: versioned, replaceable components of the pipeline.

Discovery only reads metadata (PyPI JSON, licences, release dates) for known component categories. It never
downloads or runs code. A candidate becomes usable only when a developer adds an implementation to this repo
(reviewed, pinned in requirements.txt) and it beats the active skill on the evaluation fixtures. Activation is a
database switch, so every change can be rolled back."""
import os
import time

import requests

from . import db

BUILTIN = [
    ("face_detector", "lbp-skimage", "1", "active", "vision:lbp", "BSD-3-Clause", "https://scikit-image.org"),
    ("face_detector", "yunet-opencv", "2023mar", "candidate", "vision:yunet", "MIT", "https://github.com/opencv/opencv_zoo"),
    ("transcriber", "openai-whisper-1", "1", "active", "ai:whisper-1", "API", "https://platform.openai.com/docs/guides/speech-to-text"),
    ("caption_renderer", "libass-ass", "1", "active", "captions:ass", "ISC", "https://github.com/libass/libass"),
    ("layout_engine", "facecam-v1", "1", "active", "render:geometry", "own", ""),
    ("clip_scorer", "ten-dimension-v1", "1", "active", "detect:score", "own", ""),
]
# components worth watching and the PyPI projects that could replace parts of the pipeline
WATCH = {"transcriber": ["faster-whisper", "whisperx", "openai-whisper"], "speaker_diarization": ["pyannote.audio"], "face_detector": ["mediapipe", "insightface", "opencv-python"],
         "audio_enhancement": ["noisereduce", "deepfilternet"], "scene_detection": ["scenedetect"], "video_processing": ["moviepy", "av"]}
OK_LICENSES = ("MIT", "BSD", "Apache", "ISC", "PSF", "MPL")


def seed():
    for comp, name, ver, status, impl, lic, url in BUILTIN:
        if not db.one("SELECT id FROM skills WHERE component=? AND name=? AND version=?", (comp, name, ver)):
            db.insert("skills", {"component": comp, "name": name, "version": ver, "status": status, "impl": impl, "license": lic, "source_url": url, "created": time.time(),
                                 "notes": "built in" if status == "active" else "implemented; needs its model file (Dockerfile downloads it) and must win the evaluation"})


def discover(fetch=requests.get):
    found = 0
    for comp, pkgs in WATCH.items():
        for p in pkgs:
            try:
                r = fetch(f"https://pypi.org/pypi/{p}/json", timeout=20)
                if not r.ok:
                    continue
                j = r.json()["info"]
            except Exception:
                continue
            lic = (j.get("license") or "") or next((c.split("::")[-1].strip() for c in j.get("classifiers", []) if c.startswith("License ::")), "")
            ok = any(k.lower() in lic.lower() for k in OK_LICENSES)
            ex = db.one("SELECT id, status FROM skills WHERE component=? AND name=? AND version=?", (comp, p, j["version"]))
            if ex:
                continue
            db.insert("skills", {"component": comp, "name": p, "version": j["version"], "status": "candidate" if ok else "rejected", "impl": "", "license": lic[:80], "source_url": j.get("project_url") or j.get("home_page") or "",
                                 "decision": None if ok else "licence not on the allow-list", "decided_at": None if ok else time.time(), "created": time.time(),
                                 "notes": (j.get("summary") or "")[:200] + " | Not installed: needs a reviewed implementation + evaluation before use."})
            found += 1
    db.event("manager", f"Skill discovery: {found} new candidate version(s) recorded (metadata only, nothing installed)", kind="info")
    return {"found": found}


def evaluate_face(name, fixtures):
    """Detection accuracy on fixtures with known webcam boxes: IoU of the found facecam window."""
    from . import vision
    old = vision._det
    try:
        if name == "yunet-opencv" and not os.path.exists(os.environ.get("AC_YUNET_MODEL", "/models/face_detection_yunet_2023mar.onnx")):
            return {"ok": False, "why": "model file not installed"}
        vision._det = None
        if name == "lbp-skimage":
            os.environ["AC_YUNET_MODEL"] = "/nonexistent"
        scores, t0 = [], time.time()
        for path, truth in fixtures:
            a = vision.analyse(path)
            fc = a.get("facecam")
            scores.append(vision._iou((fc["x"], fc["y"], fc["w"], fc["h"]), truth) if fc else 0.0)
        return {"ok": True, "iou": round(sum(scores) / max(1, len(scores)), 3), "seconds": round(time.time() - t0, 1), "n": len(scores)}
    finally:
        vision._det = old


def decide(skill_id, result, baseline):
    s = db.one("SELECT * FROM skills WHERE id=?", (skill_id,))
    better = result.get("ok") and result.get("iou", 0) > baseline.get("iou", 0) + 0.02
    db.update("skills", "id", skill_id, eval={"result": result, "baseline": baseline}, status="approved" if better else "rejected", decided_at=time.time(),
              decision="beat the active skill on the fixtures" if better else "did not beat the active skill")
    return better


def activate(skill_id):
    s = db.one("SELECT * FROM skills WHERE id=?", (skill_id,))
    if s["status"] not in ("approved", "inactive"):
        raise ValueError("Only an approved skill can be activated")
    for o in db.q("SELECT id FROM skills WHERE component=? AND status='active'", (s["component"],)):
        db.update("skills", "id", o["id"], status="inactive")
    db.update("skills", "id", skill_id, status="active", decided_at=time.time())
    db.event("manager", f"Activated {s['component']}: {s['name']} {s['version']} (previous one kept as inactive for rollback)", kind="decision")
