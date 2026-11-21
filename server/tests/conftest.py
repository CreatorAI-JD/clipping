import json
import os
import socket
import sys
import tempfile
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fixtures  # noqa: E402

STATE = {"shift": 0.0, "calls": {}, "score_hint": "coming"}


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def fake_openai():
    """A stand-in for the OpenAI API that really listens to the audio (see fixtures.hear)."""
    from flask import Flask, request, jsonify
    app = Flask("fake-openai")

    @app.post("/v1/audio/transcriptions")
    def tr():
        f = request.files["file"]
        STATE["calls"]["whisper"] = STATE["calls"].get("whisper", 0) + 1
        words = fixtures.hear(f.read())
        if f.filename.endswith("_qc.wav") and STATE["shift"]:
            words = [{**w, "start": w["start"] - STATE["shift"], "end": w["end"] - STATE["shift"]} for w in words]
        return jsonify(text=" ".join(w["word"] for w in words), words=words, segments=[])

    @app.post("/v1/chat/completions")
    def chat():
        b = request.get_json()
        STATE["calls"]["chat"] = STATE["calls"].get("chat", 0) + 1
        u = b["messages"][1]["content"]
        out = {}
        if "Candidates:" in u:
            cands = []
            for line in u.split("\n"):
                if line.startswith("#"):
                    i = int(line[1:line.index(" ")])
                    good = STATE["score_hint"] in line
                    a, bb = [float(x) for x in line[line.index("[") + 1: line.index("s]")].split("-")]
                    cands.append({"i": i, "hook": 8 if good else 4, "entertainment": 8 if good else 5, "context": 8 if good else 3, "story": 9 if good else 3, "emotion": 7, "relevance": 7, "replay": 6,
                                  "title": "He did NOT see it coming" if good else "Random moment", "hook_text": "He did NOT see it coming" if good else "", "skip": False, "concerns": [], "why": "complete reaction" if good else "no context", "category": "gaming"})
            out = {"candidates": cands}
        elif "Request:" in u:
            out = {"start_shift": 1.0, "end_shift": 0, "title": None, "hook_text": None, "layout": None, "preset": "karaoke", "rebuild_captions": False}
        elif "faceless channel" in b["messages"][0]["content"]:
            out = {"title": "Wait look at this car", "hook": "Wait look at this", "script": "wait look at this car. oh my god he did not see that coming. chat was insane",
                   "caption": "Nobody noticed this", "hashtags": ["gta6", "gaming"], "topic": "the car",
                   "claims": [{"text": "the car is in the game", "status": "confirmed"}, {"text": "it is the fastest", "status": "rumour"}]}
        elif "WHOLE transcript" in b["messages"][0]["content"]:
            out = {"moments": []}
        return jsonify(choices=[{"message": {"content": json.dumps(out)}}], usage={"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200})

    @app.post("/v1/audio/speech")
    def speech():
        STATE["calls"]["tts"] = STATE["calls"].get("tts", 0) + 1
        d = tempfile.mkdtemp()
        p = os.path.join(d, "v.wav")
        fixtures.speech_wav(p, 14, [(0.5, [15, 16, 17, 18, 19]), (4.0, [0, 1, 2, 3, 4, 5, 6, 7, 8]), (9.5, [9, 10, 11])])
        return open(p, "rb").read(), 200, {"Content-Type": "audio/wav"}

    @app.post("/v1/moderations")
    def mod():
        return jsonify(results=[{"flagged": False, "categories": {}}])

    port = _free_port()
    threading.Thread(target=lambda: app.run(port=port, threaded=True), daemon=True).start()
    time.sleep(0.6)
    return f"http://127.0.0.1:{port}/v1"


@pytest.fixture(scope="session")
def env():
    d = tempfile.mkdtemp(prefix="acsrv-")
    base = fake_openai()
    os.environ.update(AC_DATA_DIR=d, AC_ADMIN_TOKEN="test-token", OPENAI_API_KEY="sk-test", OPENAI_BASE_URL=base, AC_WORKERS="2", AC_X264_PRESET="ultrafast",
                      AC_DAILY_BUDGET_USD="5", AC_KICK_API="http://127.0.0.1:9/none", AC_TWITCH_API="http://127.0.0.1:9/none")
    from autoclipper import config, db
    config.reload(); db.reset()
    fx = os.path.join(d, "fx"); os.makedirs(fx)
    src, words = fixtures.stream_fixture(os.path.join(fx, "stream.mp4"), dur=40)
    return {"dir": d, "fx": fx, "stream": src, "words": words, "state": STATE}


@pytest.fixture(scope="session")
def worker(env):
    from autoclipper import worker as w
    t = threading.Thread(target=w.main, kwargs={"n": 2}, daemon=True)
    t.start()
    time.sleep(1)
    yield w
    w._stop.set()


@pytest.fixture(scope="session")
def api(env):
    from autoclipper.api import app
    c = app.test_client()
    c.environ_base["HTTP_AUTHORIZATION"] = "Bearer test-token"
    return c


def wait(fn, timeout=240, every=1.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None
