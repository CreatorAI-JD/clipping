# AutoClipper background worker

The website (GitHub Pages) is the control center. A web page can only run while it is open, so AutoClipper has a
**background worker** that runs on GitHub's servers on a schedule, with your browser closed.

## What runs where

| Job | Where it runs | Runs with the browser closed? |
| --- | --- | --- |
| Research department (trends, news, Wikipedia, Hacker News, Reddit, YouTube, Twitch, Kick) | Worker (GitHub Actions, every 6 h) | **Yes** |
| Content Director: 7-day plan, replaces outdated ideas, avoids repeats | Worker (and again in the app, with your performance data) | **Yes** |
| Production (clip discovery, editing, rendering, captions) | App tab | No: needs the tab open |
| 10 quality checkers + revisions | App tab | No |
| Scheduled publishing | Upload-Post holds scheduled posts on its servers once queued | Queued posts go out on time; new approvals need the tab |
| Performance collection + learning | App tab (hourly) | No |
| Health monitor, budget cap, notifications | App tab (every minute) | No |

Rendering and quality control use the browser's video engine (canvas, MediaRecorder, Web Audio) and your VOD files on
your computer. Moving them off the browser means a different renderer (ffmpeg on a server), a database for production
records and secure key storage on that server. See "What full browser-free production needs" below.

## Setup (about 5 minutes)

1. The workflow file is already in the repo: `.github/workflows/autoclipper-worker.yml`.
2. Open your repo on GitHub → **Actions**. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
3. Repo → **Settings → Secrets and variables → Actions**.
   **Secrets** (all optional; each one turns on more research):
   - `OPENAI_API_KEY`: the analyst writes why / audience / format / hook / risks for each opportunity, with citations.
   - `YOUTUBE_API_KEY`: most-viewed recent videos for your keywords (Google Cloud → YouTube Data API v3 → API key).
   - `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`: top clips per game (dev.twitch.tv → your app → *New Secret*; this is
     the app's own login, no personal account access).
   **Variables** (tab next to Secrets):
   - `AC_NICHE`, for example `GTA 6 news and streamer moments`
   - `AC_KEYWORDS`, for example `GTA 6,GTA VI,Rockstar Games,Kai Cenat`
   - `AC_SUBREDDITS`, for example `GTA6,GTA,LivestreamFail`
   - `AC_GAMES`, for example `Grand Theft Auto VI,Just Chatting`
   - `AC_CHANNEL_TYPE`: `clips`, `faceless` or `both`
   - `AC_PER_DAY`: videos per day in the plan (default 3)
   - `AC_MAX_USD_PER_DAY`: the worker's own OpenAI budget (default 0.25)
4. **Actions → AutoClipper worker → Run workflow** once. After that it runs every 6 hours.
5. In the app open **Content plan**: the worker status shows the last run. The app reads the results from
   `https://raw.githubusercontent.com/<you>/<repo>/autoclipper-data/data/` (filled in automatically on github.io).

Email: GitHub emails you when a scheduled run fails (your GitHub *Settings → Notifications → Actions*).

## What it never does

- It never downloads or re-uploads anyone's video and never publishes.
- It never invents trends: every opportunity lists its sources; confidence comes from how many independent sources
  mention it, and the AI analyst must cite evidence ids or its suggestion is dropped.
- Keys stay in GitHub Secrets; they are not written to the data files.

The `autoclipper-data` branch is public if your repo is public. It contains only research results and the plan.

## What full browser-free production needs

To also render, check and publish with no browser open, AutoClipper needs:
1. A renderer that does not need a browser (ffmpeg in a worker) and the clip/caption layouts ported to it.
2. Source videos the worker can reach legally: your own uploads to cloud storage, or VODs from your own connected
   Twitch account (not other people's streams).
3. A small database for production records instead of browser storage, plus the Upload-Post key as a server secret.
GitHub Actions can host steps 1–3 for faceless videos (no VOD needed). That is the next build step; until then,
keep one AutoClipper tab open on a computer that does not sleep for unattended production.
