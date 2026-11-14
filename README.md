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
- **Hooks (ASMR)** (Assembly Line → Hooks): split-screen retention hooks. Your clip on top, a muted satisfying/ASMR loop underneath, and your brand tag (default "Nuggiez Clips") on the line in the middle. Six loops are drawn by the app itself (ramp car stunts, smoothie blender, kinetic sand cutting, marble run, hydraulic press, paint swirl), so they are copyright-free. You can add your own recordings or free stock (Pexels / Pixabay / CC0, with a search built in); every filler is saved with its license, and anything else is refused. Fillers rotate automatically, or pick one. The Copyright robot checks the filler's license on every clip, and the Monetization robot warns that split-screen filler alone is not "original" (keep captions and commentary intros on). Also works on the Stream Clipper tab (layout "Split-screen hook").
- **Any niche**: Channel tab → Identity → Quick niche preset (GTA 6 launch, any game, Just Chatting / IRL, podcast, sports). The AI prompts use the Game field, so the clip line is no longer GTA-only.
- Files: `fx-core.js` (records, manager, costs, STOP), `fx-depts.js` (departments), `fx-clips.js` (GTA clip versions), `fx-quality.js` (cut planning, captions, layouts, loudness), `fx-hooks.js` (split-screen hooks, brand tag, niche presets), `fx-ui.js` + `fx.css` (screens).

## Automation crew (Assembly Line → Automation)
Less babysitting, same safeguards (you approve the first videos, rights/policy questions always wait for you, 🛑 STOP halts everything):
- **Mechanic (self-repair):** retries failed steps twice, swaps a clip that keeps failing quality checks for the next-best moment, frees slots when a VOD has no usable moments. Key/billing/permission errors still come to you.
- **Smart scheduler:** approved videos without a set time go to the best open slot (GTA-audience starting guess blended with how your own posts did by hour), with a daily cap and spacing.
- **Earned auto-approve:** the line approves a video only if every warning on it is a kind you've approved yourself several times (and not rejected lately), rights are fully verified, and recent auto posts aren't failing or underperforming; otherwise it pauses itself.
- **Twitch watcher:** checks your Twitch channel(s) for new VODs (official Helix API) and uses the clips viewers made as hype markers in the Moment Scout. Saving the VOD file is still your step.
- **Stay awake + catch-up:** keeps the screen awake while the line runs and summarizes what happened while you were away.

## Publish gate (guideline, rights & monetization checks)
Every upload path goes through `fx-gate.js`: the Assembly Line **and** the quick Stream Clipper / Faceless / Autopilot / Review Queue path. The low-level upload functions refuse any video that didn't pass it.
- **Safety scan:** OpenAI's free moderation model checks what is said (stream transcript), the commentary intro, on-screen text, title/caption and sampled frames. Hate/slurs, threats, sexual content, self-harm → a person must decide; sexual content involving minors → blocked forever. GTA gameplay violence alone is fine. If the scan can't run (no key, no credit), nothing auto-posts.
- **Platform checklists (Nov 2026):** YouTube reused + inauthentic content (permission doesn't exempt a clip; added value must be visible), Shorts over 60s with a Content ID claim are blocked worldwide, TikTok For You originality + Creator Rewards (original videos 60s+ only), Instagram's 2026 originality rule, AI labels. Saved checklists get new rules merged in and must be re-reviewed. Keyword rules match whole words only.
- **Clips monetization:** rights must be set (own streams / written permission), duplicate moments from the same VOD are flagged, music + over-60s Shorts flagged, Rockstar/Take-Two video-policy note.
- **Right before upload:** every inspection report must exist and be resolved, the video must not have been re-edited after inspection, the final title/description is re-scanned, and auto-approval is refused for HIGH risk or hand-approved steps.
- **Quick path:** Autopilot only auto-approves clips that pass every check; anything with warnings waits in the Review Queue, where you confirm you watched it before it can post.
- **Private test mode:** TikTok privacy "Only me" uploads YouTube as Private and skips Instagram/Facebook/X/Threads (they can't post privately). Uploads send an `Idempotency-Key` so retries never double-post.

## Tests
`node tests/publish-gate.test.mjs` (gate, rights, policies, Twitch watcher) and `node tests/assembly-line-e2e.test.mjs` (a test VOD through all 20 departments; needs ffmpeg). Both use Playwright with fake OpenAI / Upload-Post / Twitch servers, so no keys are needed and nothing is posted.
