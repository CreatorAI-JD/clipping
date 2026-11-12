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
- **Clip quality** (Channel tab → Streams & rights): the cut snaps to word boundaries and finishes the last sentence; quiet dead air is jump-cut (never loud game action or the hype peak); punch-in zoom + shake on the peak; any commentary intro plays over the lead-in footage (no frozen frame); stream audio is levelled, compressed and limited to about −14 LUFS; captions are short, readable groups. Pick **Facecam top / gameplay bottom** for facecam streamers and use **Preview layout on a VOD frame** to line up the facecam box.
- Files: `fx-core.js` (records, manager, costs, STOP), `fx-depts.js` (departments), `fx-clips.js` (GTA clip versions), `fx-quality.js` (cut planning, captions, layouts, loudness), `fx-ui.js` + `fx.css` (screens).
