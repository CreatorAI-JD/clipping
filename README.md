# AutoClipper

AI stream clipper + faceless short-video generator that auto-posts to TikTok, Instagram, YouTube, Facebook, X and Threads.

**Live app:** https://creatorai-jd.github.io/clipping/ (use Chrome or Edge on a computer)

## Setup (one time)
1. **Settings** → paste an OpenAI API key (AI scripts, voiceover, captions, hype scores).
2. **Accounts** → paste an Upload-Post API key (free at app.upload-post.com) → **Connect / manage accounts** → log in to each platform.
3. **Autopilot** → choose a VOD folder, set faceless videos per day, turn on auto-approve / auto-post, flip the switch on. Leave the tab open.

Everything runs in your browser; keys are stored only on your computer.

## Live Watch (catch moments while the stream is live)

Live Watch tab → type the Twitch channel(s) → **Start watching**. Keep the tab open.

- It reads each channel's public chat anonymously (no login) and learns that chat's normal pace over the first few minutes.
- When the last 10 seconds jump well above normal, with enough *different* people reacting (hype emotes, "clip it", copy-paste waves, raids), that's a moment. One person spamming can't trigger it (each chatter counts for at most 3 points).
- On a moment it can: make a **Twitch clip** instantly, save the **VOD timestamp** (when you drop that VOD later, the Moment Scout ranks those spots first), and beep + send a desktop notification. These two need Twitch connected (Live Watch → Twitch connection; it now asks for the `clips:edit` permission, so press Reconnect once if you connected before).
- **Record clips from this player**: share this tab when Chrome asks (keep "Also share tab audio" on and unmute the player). AutoClipper keeps a rolling recording of the player, and each moment becomes a captioned 1080×1920 clip in your Review Queue (25 s before the spike + 10 s after by default; change it under "What to do when a moment hits"). The raw recording is kept so you can download it.
- **Test a spike** fakes a burst of chat so you can see the whole flow without waiting.
- Sensitivity: "Only huge moments", "Balanced", "Catch more moments", plus minimum score, chatters needed and the wait between moments.

Nothing is posted from Live Watch: every clip still goes through the publish gate and your approval. Only clip channels you are allowed to post (your own, a clipping campaign, or written permission).

## Getting around

- Pages are grouped in the sidebar (Make clips / Automate / Publish / Setup). On a phone, tap the menu button.
- **Jump to…** (Ctrl K, Cmd K or `/`) searches every page, every Assembly Line section and common actions ("approve", "openai key", "stop", "live"…).
- Number keys 1–9 and 0 open the pages in sidebar order; `?` lists the shortcuts.
- The Back button works between pages, and Assembly Line sections have links (e.g. `#line/policies`).
- **Get set up** on the Workshop shows what's left (keys, accounts, channel, Live Watch, first clip) and takes you to each one. Warnings in the Review Queue that name a setting get a **Fix it** button.

## Assembly line (Workshop + Assembly Line tabs)
A department-based production line with a central production manager. The main line is **GTA streamer clips**: drop VODs (or choose a VOD folder on Autopilot) → Moment Scout finds hype moments → context check → clip plan (cut, hook, title, optional AI commentary intro) → clip QC → intro voice → rights records → captions from the stream audio → 1080×1920 export → audio/visual/copyright/guidelines/monetization QC → Final QC → per-platform metadata → **your approval** → publishing → monitoring → analytics. A faceless "researched facts" channel type uses the same 20 departments.

- **Workshop** tab: live full-page view of the 20 robot stations; tap a robot for its reports and track record. Start/pause the line and the emergency **STOP** live here.
- **Review Queue** is the one place you approve videos: Assembly Line videos waiting on you are listed first, then Stream Clipper and Faceless clips. "Approve all" asks before it publishes, and auto-approve stays off without an OpenAI key.
- **Assembly Line** tab: Videos (one production record per video), Ideas & VODs, Channel config, Policies (one checklist per platform), Library (licensed assets), Analytics, Costs & limits, Audit log & backups.
- Internal checks are never a guarantee of platform, copyright or monetization approval. Nothing is published without a human approval (an optional auto rule unlocks only after your first approval).
- **Clip quality** (Channel tab → Streams & rights): the cut snaps to word boundaries and finishes the last sentence; quiet dead air is jump-cut (never loud game action or the hype peak); punch-in zoom + shake on the peak; any commentary intro plays over the lead-in footage (no frozen frame); stream audio is levelled, compressed and limited to about −14 LUFS; captions are short, readable groups. Pick **Facecam top / gameplay bottom** for facecam streamers and use **Preview layout on a VOD frame** to line up the facecam box.
- **Hooks (ASMR)** (Assembly Line → Hooks): split-screen retention hooks. Your clip on top, a muted satisfying/ASMR loop underneath, and your brand tag (default "Nuggiez Clips") on the line in the middle. Six loops are drawn by the app itself (ramp car stunts, smoothie blender, kinetic sand cutting, marble run, hydraulic press, paint swirl), so they are copyright-free. You can add your own recordings or free stock (Pexels / Pixabay / CC0, with a search built in); every filler is saved with its license, and anything else is refused. Fillers rotate automatically, or pick one. The Copyright robot checks the filler's license on every clip, and the Monetization robot warns that split-screen filler alone is not "original" (keep captions and commentary intros on). Also works on the Stream Clipper tab (layout "Split-screen hook").
- **Any niche**: Channel tab → Identity → Quick niche preset (GTA 6 launch, any game, Just Chatting / IRL, podcast, sports). The AI prompts use the Game field, so the clip line is no longer GTA-only.
- Files: `fx-core.js` (records, manager, costs, STOP), `fx-depts.js` (departments), `fx-clips.js` (GTA clip versions), `fx-quality.js` (cut planning, captions, layouts, loudness), `fx-scout.js` (footage frames, retention scorecard, moment search), `fx-hooks.js` (split-screen hooks, brand tag, niche presets), `fx-ui.js` + `fx.css` (screens).

## Moment Scout: footage, retention and search (`fx-scout.js`)
- **Looks at the footage:** with an OpenAI key, the scout grabs 3 small frames around each hype peak (before, on, after) and sends them with the transcript to the ranking. Silent action (a crash, a chase) now counts, and each moment gets an "On screen" line. Cost: about $0.0003 extra per VOD scan on gpt-4o-mini.
- **Retention scorecard (0-100):** hook (first 3 seconds), pacing (measured from the word timings: words per second, time to first word, quiet time), story and payoff, plus edit tips. It is 20% of the moment's rank and the tips are passed to the clip plan when it picks the trim and hook. It's an estimate, not a promise of views.
- **Search moments** (Assembly Line → Ideas & VODs): type words that were said, a title or what's on screen to filter instantly, or press **Ask AI** for plain-English searches like "when he drives off the pier".
- Test: `node tests/moment-scout.test.mjs`

## Automation crew (Assembly Line → Automation)
Less babysitting, same safeguards (you approve the first videos, rights/policy questions always wait for you, STOP halts everything):
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
`node tests/publish-gate.test.mjs` (gate, rights, policies, Twitch watcher) and `node tests/assembly-line-e2e.test.mjs` (a test VOD through all 20 departments; needs ffmpeg). Both use Playwright with fake OpenAI / Upload-Post / Twitch servers, so no keys are needed and nothing is posted. `node tests/live-watch.test.mjs` checks Live Watch (fake Twitch chat and API, tab recording) and the navigation (Jump to, number keys, Back button, phone menu, setup checklist).

## Site basics: favicon, legal pages, custom domain
- **Favicon:** `favicon.svg` (with `favicon-32.png` and `apple-touch-icon.png` fallbacks), the same robot logo as the header.
- **Legal pages:** `privacy.html` (what is stored and where: keys and settings in browser local storage, videos in IndexedDB, nothing on a server) and `terms.html`. Both are linked in the app footer. They are a plain-language starting point, not legal advice; have a lawyer look at them before you charge money or take on other users.
- **Custom domain (owner step):** the site runs at `creatorai-jd.github.io/clipping` until you buy a domain.
  1. Buy a domain (Namecheap, Cloudflare, Porkbun or similar), for example `nuggiezclips.com`.
  2. At your registrar, add DNS records. For a subdomain like `app.nuggiezclips.com`: one `CNAME` record from `app` to `creatorai-jd.github.io`. For the bare domain: four `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`, plus a `CNAME` from `www` to `creatorai-jd.github.io`.
  3. On GitHub: repo **Settings → Pages → Custom domain**, enter the domain and save. GitHub adds a `CNAME` file to the repo.
  4. When the DNS check passes (minutes to a few hours), tick **Enforce HTTPS**.
  5. Your saved keys live in the browser per web address, so after the move paste your OpenAI and Upload-Post keys again on the new domain. If you use direct YouTube posting, add the new domain as an Authorized JavaScript origin in Google Cloud.

## Clipping campaigns (TJR)

Stream Clipper has a **Clipping campaign** box. Picking **TJR** (Reach campaign on Content Rewards, rules checked 2026-11-14):
- adds `#TJR` and "Not financial advice. For education and entertainment only." to every caption automatically
- turns off the brand tag (no logos), AI voice intros, AI images, stock footage, music and split-screen filler. AI still finds, cuts and captions the real clips
- adds finance checks to the publish gate: profit promises in our own title or caption ("guaranteed profits", "risk-free", "can't lose", "100% win rate") are blocked until edited; hype or buy/sell calls, or TJR saying something like that, go to a person
- flags missing tags, non-English text and AI content
- reminds you to submit each link on Content Rewards within 30 minutes of posting

Clearing the campaign puts your old settings back. Tests: `node tests/campaign.test.mjs`.
