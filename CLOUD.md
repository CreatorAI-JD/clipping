# AutoClipper 3.0: cloud clipping studio

The website stays on GitHub Pages as the **control panel**. All work runs on an always-on **cloud server**
(`server/`): research, creator discovery, 24/7 stream watching, clip detection, facecam framing, captions,
rendering, quality checks and revisions. It keeps running when your browser or computer is off.

## Architecture

```
GitHub Pages (control panel)  --HTTPS + admin token-->  AutoClipper server (one Docker container)
                                                        ├─ API (Flask + gunicorn)      /api/...
                                                        ├─ Worker (always on)
                                                        │   ├─ scheduler: live checks every 60 s, discovery every 30 min,
                                                        │   │   skill discovery daily, learning every 6 h, cleanup, watchdog
                                                        │   ├─ job runners (leased jobs: crash-safe, retried with back-off)
                                                        │   └─ live capture sessions (ffmpeg → 10 s segments, 20 min rolling buffer)
                                                        ├─ SQLite (WAL) on a persistent volume: creators, sources, sessions,
                                                        │   candidates, clips, jobs, costs, events, notifications, research,
                                                        │   techniques, benchmarks, skills
                                                        └─ Media on the same volume (sources, live buffers, renders)
```

### Production pipeline (per clip, every stage written to the clip's ledger)
1. **Source**: your upload (you confirm the rights), an import link, or a live window from a permitted creator.
2. **Video Intelligence / Clip Scout**: tier 1 over the whole video (audio energy, sustained speech, chat spikes),
   tier 2 transcription of candidates only (or the whole video with Deep analysis), tier 3 AI comparison of all
   candidates on 10 scores (hook, entertainment, context, story, emotion, relevance, replay, pacing, audio, visual)
   with a category profile (gaming, podcast, IRL, sports, interview, comedy, educational). Duplicates removed.
3. **Hook Specialist / Retention Editor**: starts on the setup, ends on a finished sentence.
4. **Visual Editor**: finds the webcam window (stable small face + window edges) or the speaker, and picks
   facecam-above-gameplay, facecam-below, speaker tracking (smoothed, speed-limited), two-person split, or blurred full frame.
   The gameplay crop slides away from the webcam; captions never sit on the face.
5. **Caption Specialist**: word-level timing, presets (Bold Pop, Karaoke, Clean Box, Neon, Minimal, One-word bounce)
   chosen per category, safe-zone placement, burned in with libass.
6. **Audio Specialist / Sound Design**: high-pass, compression, loudness to −14 LUFS, optional whoosh under the hook.
7. **Render**: 1080×1920 H.264/AAC, 30 fps; a clean version (for live caption preview) and the final.
8. **Quality Assurance**: 12 checkers on the rendered file (caption accuracy by re-transcribing the final audio,
   caption timing, facecam position on rendered frames, framing, audio loudness/peaks, hook, context, pacing,
   consistency, rights, platform guidelines, rendering integrity). Tickets with timestamp, action and owner.
9. **Revision Agent**: up to 3 targeted fixes (re-time/rebuild captions, reframe facecam, trim the start, cut dead air,
   re-render), then the **exception queue** for you. Unverified checks are never counted as passes.
10. **Review Queue** (Cloud studio → Review, and the Review Queue page): you edit, approve or reject.
11. **Publishing** (optional, off by default): only approved clips, once each, through Upload-Post.

## Setup on Fly.io (recommended: about 15 minutes, roughly $5–15/month)

Needs: a Fly.io account with a payment method (your step), and `flyctl` on your computer.

```bash
cd server
fly launch --no-deploy --copy-config          # pick a name; replace autoclipper-REPLACE-ME in fly.toml
fly volumes create autoclipper_data --size 20 # 20 GB for sources, live buffers and renders
fly secrets set AC_ADMIN_TOKEN=$(openssl rand -hex 24) OPENAI_API_KEY=sk-... \
  TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... YOUTUBE_API_KEY=... UPLOAD_POST_API_KEY=...
fly deploy
fly secrets list                               # the token is not shown again: keep your copy
```
Then open AutoClipper → **Cloud studio**, enter `https://<your-app>.fly.dev` and the admin token.

### Any other host (VPS, home server, Railway, Render with a disk)
`cp .env.example .env`, fill it in, then `docker compose up -d`. The machine must stay on and have a persistent disk.

## Permissions (nothing unauthorized enters production)
- Discovered creators start as `none`. Only `own` or `granted` (with a proof link) can be watched or clipped.
- Uploads require you to confirm you have the rights.
- Live ingest uses the creator's own stream URL (their relay/HLS/RTMP) or `streamlink` for a permitted creator's
  public stream. Check each platform's terms and the creator's permission before turning monitoring on.
- Other creators' videos are never downloaded for research: viral research uses public API metadata (views, length,
  titles); visual benchmarks come from reference videos you upload and are allowed to analyse.

## Costs (estimates; your provider bills are the truth)
- Server: Fly shared-cpu-2x 2 GB ≈ $10–15/month + 20 GB volume ≈ $3/month.
- OpenAI per 30 s clip: transcription ≈ $0.003 × 2 (candidate + final check), scoring ≈ $0.001, moderation free.
  A 2-hour VOD with Deep analysis ≈ $0.72 of transcription. Live: only candidate windows are transcribed.
- Daily and monthly caps (Cloud studio → Settings): paid work pauses itself at the cap.

## Required keys
| Key | What it unlocks | Without it |
| --- | --- | --- |
| `AC_ADMIN_TOKEN` | the control panel can talk to the server | server refuses requests |
| `OPENAI_API_KEY` | transcription, captions, AI scoring, caption-accuracy check, safety scan | clips have no captions; scoring uses measured signals only; those checks say "not verified" |
| `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` | live status, discovery, viral clip research | Twitch creators can't be checked or discovered |
| `YOUTUBE_API_KEY` | YouTube live discovery and status | no YouTube |
| `UPLOAD_POST_API_KEY` | publishing approved clips | approve only (download and post yourself) |
| `AC_NOTIFY_WEBHOOK` | alerts to Discord/Slack while you're away | alerts only in the panel |

## Tests
`cd server && pip install -r requirements.txt && pytest -q`. The suite renders real clips with ffmpeg from synthetic
fixtures (a public-domain face in a webcam window over gameplay; "speech" made of tones a fake transcriber really
hears), and checks the full pipeline, review edits, revisions, budget pause, crash recovery and restart persistence,
plus live capture from a local HLS stream.
