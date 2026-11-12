# AutoClipper ✂️

AI stream clipper + faceless short-video generator that auto-posts to TikTok, Instagram, YouTube, Facebook, X and Threads.

**Live app:** https://creatorai-jd.github.io/clipping/ (use Chrome or Edge on a computer)

## Setup (one time)
1. **Settings** → paste an OpenAI API key (AI scripts, voiceover, captions, hype scores).
2. **Accounts** → paste an Upload-Post API key (free at app.upload-post.com) → **Connect / manage accounts** → log in to each platform.
3. **Autopilot** → choose a VOD folder, set faceless videos per day, turn on auto-approve / auto-post, flip the switch on. Leave the tab open.

Everything runs in your browser; keys are stored only on your computer.

## Assembly line (Workshop + Assembly Line tabs)
A department-based production line with a central production manager. The main line is **GTA streamer clips**: drop VODs (or choose a VOD folder on Autopilot) → Moment Scout finds hype moments → context check → clip plan (cut, hook, title, optional AI commentary intro) → clip QC → intro voice → rights records → captions from the stream audio → 1080×1920 export → audio/visual/copyright/guidelines/monetization QC → Final QC → per-platform metadata → **your approval** → publishing → monitoring → analytics. A faceless "researched facts" channel type uses the same 20 departments.

- **Workshop** tab: live full-page view of the 20 robot stations; tap a robot for its reports and track record. Start/pause the line and the emergency **STOP** live here.
- **Assembly Line** tab: Needs you (publishing dashboard), Videos (one production record per video), Ideas & VODs, Channel config, Policies (one checklist per platform), Library (licensed assets), Analytics, Costs & limits, Audit log & backups.
- Internal checks are never a guarantee of platform, copyright or monetization approval. Nothing is published without a human approval (an optional auto rule unlocks only after your first approval).
- Files: `fx-core.js` (records, manager, costs, STOP), `fx-depts.js` (departments), `fx-clips.js` (GTA clip versions), `fx-ui.js` + `fx.css` (screens).

## Automation crew (Assembly Line → Automation)
Less babysitting, same safeguards (you approve the first videos, rights/policy questions always wait for you, 🛑 STOP halts everything):
- **Mechanic (self-repair):** retries failed steps twice, swaps a clip that keeps failing quality checks for the next-best moment, frees slots when a VOD has no usable moments. Key/billing/permission errors still come to you.
- **Smart scheduler:** approved videos without a set time go to the best open slot (GTA-audience starting guess blended with how your own posts did by hour), with a daily cap and spacing.
- **Earned auto-approve:** the line approves a video only if every warning on it is a kind you've approved yourself several times (and not rejected lately), rights are fully verified, and recent auto posts aren't failing or underperforming; otherwise it pauses itself.
- **Twitch watcher:** checks your Twitch channel(s) for new VODs (official Helix API) and uses the clips viewers made as hype markers in the Moment Scout. Saving the VOD file is still your step.
- **Stay awake + catch-up:** keeps the screen awake while the line runs and summarizes what happened while you were away.
