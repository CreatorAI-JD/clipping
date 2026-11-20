# Things only you can do (saved for when you're back)

Kept up to date while building AutoClipper 3.0. Nothing here was done for you.

1. **Ship the code to GitHub**: this session can't push to `creatorai-jd/clipping` (403). Either add the repo to the session's sources, or say "yes" and I upload through your logged-in GitHub tab, or upload the zip yourself.
2. **Create a cloud server account** (needs your signup + payment method). See CLOUD.md for the recommended setup.
3. **Put your secrets on the server** (I never enter keys): OpenAI key, Twitch app Client ID + Secret, YouTube API key, Upload-Post key, an admin token you choose.
4. **Permission records for creators**: for every streamer you want monitored, confirm you have the right to clip them (your own channel, a clipping campaign, or written permission). The cloud only watches creators you mark as permitted.
5. **Enable GitHub Actions** in the repo (runs tests + the research worker).
6. **Real viral benchmarks**: the test reels are compared with short-form standards. For comparison with real top clips, the server needs your Twitch/YouTube keys (it reads public view counts, lengths and titles) or reference clips you upload that you're allowed to analyse.
7. **Point the control panel at your server**: Cloud studio → enter the server address and the admin token.
