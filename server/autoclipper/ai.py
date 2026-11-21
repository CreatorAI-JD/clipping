"""OpenAI calls (transcription, structured reasoning, moderation) with budget guard, cost record and retries.
Every function returns None when no key is configured, so callers can mark work "not verified" instead of guessing."""
import json
import os
import time

import requests

from . import budget, config, jobs


def enabled():
    return bool(config.CFG.openai_key)


def _post(path, **kw):
    url = config.CFG.openai_base.rstrip("/") + path
    for attempt in range(3):
        try:
            r = requests.post(url, headers={"Authorization": "Bearer " + config.CFG.openai_key}, timeout=300, **kw)
        except requests.RequestException as e:
            if attempt == 2:
                raise jobs.Temporary(f"OpenAI connection error: {e}")
            time.sleep(2 ** attempt)
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            if attempt == 2:
                raise jobs.Temporary(f"OpenAI {r.status_code}")
            time.sleep(2 ** attempt * 2)
            continue
        if r.status_code == 401:
            from . import notify
            notify.send("critical", "OpenAI rejected the API key (401). AI steps are paused until the key is fixed.", key="openai-401")
            raise jobs.Paused("OpenAI key rejected (401)", retry_in=1800)
        if not r.ok:
            raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:200]}")
        return r.json()


def transcribe(audio_path, ref=None):
    """Word-level transcript: {'text', 'words': [{'word','start','end'}], 'segments': [...]}."""
    if not enabled():
        return None
    secs = max(1.0, os.path.getsize(audio_path) / 32000)  # 16 kHz mono 16-bit WAV
    est = secs / 60 * budget.prices()["whisper_per_min"]
    budget.guard(est, "transcription")
    with open(audio_path, "rb") as f:
        j = _post("/audio/transcriptions", files={"file": (os.path.basename(audio_path), f, "audio/wav")},
                  data={"model": "whisper-1", "response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]})
    budget.record("openai:whisper", secs, est, ref)
    words = [{"word": str(w.get("word", "")).strip(), "start": float(w["start"]), "end": float(w["end"])} for w in j.get("words", []) if str(w.get("word", "")).strip()]
    return {"text": j.get("text", ""), "words": words, "segments": j.get("segments", [])}


def chat_json(system, user, ref=None, temperature=0.3, max_tokens=1500):
    if not enabled():
        return None
    est = (len(system) + len(user)) / 4 / 1e6 * budget.prices()["chat_in_per_1m"] + max_tokens / 1e6 * budget.prices()["chat_out_per_1m"]
    budget.guard(est, "AI analysis")
    j = _post("/chat/completions", json={"model": config.CFG.model, "temperature": temperature, "max_tokens": max_tokens, "response_format": {"type": "json_object"},
                                          "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    u = j.get("usage", {})
    usd = u.get("prompt_tokens", 0) / 1e6 * budget.prices()["chat_in_per_1m"] + u.get("completion_tokens", 0) / 1e6 * budget.prices()["chat_out_per_1m"]
    budget.record("openai:chat", u.get("total_tokens", 0), usd, ref)
    try:
        return json.loads(j["choices"][0]["message"]["content"] or "{}")
    except (ValueError, KeyError, IndexError):
        return {}


def moderate(text, ref=None):
    """Safety scan of what is said/written. None = could not run (no key)."""
    if not enabled() or not text.strip():
        return None
    j = _post("/moderations", json={"model": "omni-moderation-latest", "input": text[:20000]})
    r = (j.get("results") or [{}])[0]
    return {"flagged": bool(r.get("flagged")), "categories": [k for k, v in (r.get("categories") or {}).items() if v]}


def speech(text, out_path, voice="onyx", ref=None):
    """Text to speech (WAV). None without a key."""
    if not enabled() or not text.strip():
        return None
    est = len(text) / 1e6 * budget.prices()["tts_per_1m_chars"]
    budget.guard(est, "voiceover")
    url = config.CFG.openai_base.rstrip("/") + "/audio/speech"
    for attempt in range(3):
        try:
            r = requests.post(url, headers={"Authorization": "Bearer " + config.CFG.openai_key}, timeout=300,
                              json={"model": "tts-1", "voice": voice, "input": text[:4000], "response_format": "wav"})
        except requests.RequestException as e:
            if attempt == 2:
                raise jobs.Temporary(f"OpenAI connection error: {e}")
            time.sleep(2 ** attempt)
            continue
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
            time.sleep(2 ** attempt * 2)
            continue
        if r.status_code == 401:
            raise jobs.Paused("OpenAI key rejected (401)", retry_in=1800)
        if not r.ok:
            raise RuntimeError(f"OpenAI speech {r.status_code}: {r.text[:200]}")
        with open(out_path, "wb") as f:
            f.write(r.content)
        budget.record("openai:tts", len(text), est, ref)
        return out_path
