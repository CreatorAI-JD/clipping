# Changelog

## 3.0 — Cloud clipping studio (2026-11-19)

All production now runs on an always-on server (`server/`, see CLOUD.md); the website is the control panel.

### Server
- SQLite (WAL) on a persistent volume; leased job queue (crash-safe claims, retries with back-off, budget pauses that don't use an attempt); always-on worker with scheduler, runners, heartbeat and watchdog. Survives restarts: running jobs and live sessions are recovered.
- Creator discovery (Twitch, YouTube, Kick public APIs) with a permission system: only `own` or `granted` (with proof) creators can be watched or clipped; uploads need a rights confirmation.
- 24/7 live monitoring: ffmpeg capture into 10 s segments with a 20-minute rolling buffer, tier-1 detection (audio energy vs baseline + Twitch chat velocity), then the surrounding window is analysed and produced.
- Detection: 10 scores (hook, entertainment, context, story, emotion, relevance, replay, pacing, audio, visual) with category profiles and learned weights.
- Vision: finds the webcam window (stable small face + window edges) or speakers; layouts facecam-top/bottom, speaker tracking, two-person split, blurred full frame.
- Captions: ASS/libass, six presets, per-word karaoke, per-cue text/timing/position/color/font/animation edits.
- 12 QC checkers on the rendered file (caption accuracy by re-transcription, timing, facecam on rendered frames, loudness/peaks, dead air, black/frozen frames, safety, rights, integrity); up to 3 targeted revisions, then the exception queue.
- Daily/monthly budget caps, webhook notifications only for important problems, skills registry (metadata only, never auto-installs code), viral benchmarks from public metadata, reference-video analysis, performance learning, optional Upload-Post publishing of approved clips only.

### Fixes found by test reels
- Clips are never shorter than the minimum length: the window grows with neighbouring phrases (within 2.5 s) or pads with footage.
- A single moving speaker is no longer mistaken for two people (split needs both on screen together and still); a two-person podcast is no longer mistaken for a webcam overlay.
- A revision can no longer shrink a clip to nothing or run past the source; QC handles a render without audio instead of crashing.
- Number-key page shortcuts unchanged by the new Cloud studio page.

### Tests
- `server/tests` (pytest): full production, review edits + re-render, AI revision, caption-sync revision loop, approve, budget pause, crash recovery + persistence, live HLS capture, discovery/benchmarks, skills, learning.
- `server/tools/test_reels.py`: renders gameplay+webcam, IRL and podcast reels and compares them with short-form standards.
- `tests/cloud-studio.test.mjs`: the Cloud studio page against the real server (connect, review, editor, save, approve, auth).

## 2.0 — AI production company (2026-11-19)

### Core engine
- **Stage ledger** on every video (`r.ledger`): for each stage the assigned agent, first start, last finish, total time, output, errors, quality score (0–100), verdict and every run with the Production Manager's decision (retry / revision n of 3 / escalated / blocked / waiting).
- **Production Manager decisions are explicit**: temporary errors retried up to 3 times with back-off, non-temporary errors escalated, limits pause instead of failing, failed checks go back for at most **3 targeted revisions** (was 2) before a person is asked. Nothing is skipped silently.
- Engine events (`stage:start`, `stage:end`, `revision`, `manager`) drive the UI.

### The AI production team (fx-agents.js, fx-command.js)
- 20 agents (Production Manager, Video Intelligence, Clip Scout, Hook Specialist, Context Checker, Retention Editor, Caption Specialist, Visual Editor, Audio Specialist, Sound Design, Background Specialist, Storytelling, Platform Optimization, Copyright & Rights, Content Guidelines, Quality Assurance, Viral Potential, Revision Agent, Publishing Manager, Performance Analyst), each mapped to the code that does its job.
- Workshop command center: every agent's status (Idle / Analyzing / Working / Reviewing / Waiting for another agent / Fixing an issue / Completed / Failed), current task and video, real progress, last completed task, errors, runs and average processing time, all computed from engine state and ledgers. Live activity feed of real events.

### Clip discovery (fx-clips.js)
- Whole-VOD analysis: audio energy across the entire VOD, plus optional **Deep analysis** (full transcript in 10-minute pieces, within your budget) so the Clip Scout finds stories and conversations, not just loud moments.
- Every candidate scored on 10 dimensions (opening, interest, story, context, entertainment, conversation, emotion, pacing, ending, clarity); weighted ranking with content-style presets (balanced, funny, story, clutch, reaction, conversation) and learned weights; near-duplicates removed (overlap or same words); min/max clip length.
- Without an OpenAI key only measurable dimensions get values; nothing is invented.

### Quality control (fx-inspect.js)
- **10 independent checkers on the rendered file**: caption accuracy (the export is transcribed again and aligned word by word), caption sync, audio (peaks/loudness measured), visual, hook (first seconds), context, rights, guidelines, rendering integrity (plays, 1080×1920, length, sound), overall.
- Tickets: problem, severity, timestamp, required action, assigned agent, status; resolved tickets are tracked across rounds.
- Fixable tickets are routed to the responsible agent; the Caption Specialist re-times or rebuilds captions from the final audio. A checker that cannot run reports "Not verified", never a pass.
- Viral Potential estimate from measured signals (labelled as an estimate).

### Editing (fx-captions.js)
- Caption presets (Bold Pop, Karaoke, Clean Box, Neon, Minimal, One-word bounce) and Custom: font, size, color, outline color/width, position, highlight color and mode (key words / word being said / none), words per caption, animation (pop/bounce/fade/slide/none), uppercase, background box, timing offset; rotation between presets per video; live preview.

### Autonomous operations (fx-ops.js, fx-director.js, worker/)
- Operations page: Assisted / Autopilot / Autonomous Business modes; explicit "Allow auto-publishing" switch; Autopilot only approves videos with Final QC passed, zero open must-fix tickets, zero unverified checkers, rights/policy clear, monetization risk not HIGH, quality ≥ your threshold, within your daily cap.
- Daily budget (estimated spend tracked per call; paid calls stop at the cap), warning threshold, health monitor (budget, API key failures, failure rate, publishing accounts, STOP) that pauses the line and notifies you.
- Notification center (critical / needs you; routine events go to the daily report) and a daily report built from records.
- Content Director + Content plan page: 7-day plan from background research and in-browser research, skips produced topics and near-repeats, expires stale research, feeds the line in plan order.
- **Background worker** (GitHub Actions, every 6 h, no browser): research agents (Google Trends, Google News, Wikipedia, Hacker News, Reddit, YouTube, Twitch, Kick), cross-source evidence and confidence, AI analyst that must cite evidence, 7-day plan, status; results on the `autoclipper-data` branch. See WORKER.md.

### Review, analytics, learning (fx-review.js, fx-insights.js)
- Review Queue cards show quality, hook, captions, context and viral scores, source video and timestamps; compare videos side by side.
- Record view: inspection board + tickets, "Why the AI chose this clip" (10 scores, rank among candidates, method, transcript), production ledger with revision history; edit captions (re-render + re-check), change title, re-render, request a revision that the agent reads.
- Stats → Production analytics with filters (date, platform, category, source, status), daily trend, agent success rates, strongest categories.
- Learning: performance database from published videos with stats, normalised to your median views; findings with sample sizes (correlation, not proof); gently re-weights the Clip Scout and Content Director; never changes settings.

### Other
- Navigation grouped as Command center / Production / AI agents / Review / Publishing / Analytics / Settings.
- Live Watch: several streams at once, Record all players, Kick channels, Connections card. Clip Scout (Kick/Twitch/YouTube trending clips).
- New tests: clip-discovery, captions, operations, director, worker, review-insights, multi-stream, clip-scout; e2e extended with the inspection + caption revision loop.
