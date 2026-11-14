/* AutoClipper — Clipping campaigns (paid clipping programs) + finance safety.
   A campaign is a creator's official clipping program (Content Rewards / Whop / Reach etc.). Picking one:
   - fills the Stream Clipper and Assembly Line with that campaign's settings (hashtags, no logos, no AI voice/images)
   - adds the campaign's required caption tags and any disclaimer to every caption, automatically
   - adds campaign checks to the publish gate (missing tag, AI content, non-English text)
   Finance campaigns also get a finance checker: profit promises ("guaranteed profits", "risk-free") are
   blocked in our own title/caption, and hype or buy/sell calls go to a person.
   The campaign's own page is the source of truth: rules change, so re-read it before each posting session. */
(function (FX) {
  'use strict';
  if (!FX) return;
  const item = FX.item, now = FX.now;

  /* ---------------- campaigns ---------------- */
  FX.CAMPAIGNS = {
    tjr: {
      id: 'tjr', creator: 'TJR', name: 'TJR Clipping Campaign by Reach', marketplace: 'Content Rewards',
      url: 'https://contentrewards.com/discover/70baf344-d80f-4ba2-910a-10340f2ea591',
      rulesUrl: 'https://reachclipping.com/TJR',
      checkedAt: '2026-11-14',
      pay: '$0.75 per 1K views on TikTok, Instagram and YouTube ($7.50 min, $750 max per clip per platform). Paid once a clip passes 5,000 views and is approved.',
      sources: [
        ['YouTube @TJRTrades', 'https://www.youtube.com/@TJRTrades'],
        ['YouTube @TRichesTrades', 'https://www.youtube.com/@TRichesTrades'],
        ['Kick: tjr', 'https://kick.com/tjr'],
        ['Instagram: tjr', 'https://www.instagram.com/tjr/'],
        ['TikTok: @.tjr.him', 'https://www.tiktok.com/@.tjr.him'],
      ],
      requiredTags: ['#TJR'],
      hashtags: '#TJR #trading #daytrading #futures #stockmarket',
      disclaimer: 'Not financial advice. For education and entertainment only.',
      finance: true, noAI: true, noLogos: true, english: true, submitWithinMin: 30, minViews: 5000,
      look: 'Funny moments, memorable quotes, reactions, trading lessons and stories told by TJR',
      rules: [
        'Every caption must include #TJR. It goes in the caption itself; a comment does not count.',
        'No AI-generated content: no AI voice, AI faces or AI visuals in the video. Using AI to find, cut and caption real clips is fine. One strike bans you from all Reach campaigns.',
        'No logos of any kind on the video. Your own brand tag is turned off for this campaign.',
        'Never show TJR in a negative light.',
        'English captions and on-screen text only.',
        'No reposts, recycled clips, botting or collab posts. Each clip must be your own cut.',
        'Thumbnails must match the clip and not repeat.',
        'Your audience must be at least 50% from the US, Canada, UK, Australia or New Zealand.',
        'Submit each clip link on Content Rewards within 30 minutes of posting it.',
      ],
      // Assembly Line channel settings for this campaign
      channel: {
        name: 'TJR trading clips', niche: 'TJR trading clips: funny moments, quotes, reactions and trading lessons',
        audience: 'People 18 to 35 in the US, UK, Canada and Australia who are into day trading, futures and the stock market',
        tone: 'Hyped and funny, always respectful of TJR, never promises money', personality: 'A fan clipping the best TJR moments and adding context so anyone gets it',
        style: 'Start right before the moment, cut dead air, big readable captions, one punchy hook line on screen', game: 'Trading streams and videos (TJR)',
        streamer: 'TJR', streamerRelation: 'permission', permissionProof: 'Official clipping campaign: https://contentrewards.com/discover/70baf344-d80f-4ba2-910a-10340f2ea591 (rules: https://reachclipping.com/TJR)',
        permissionDate: '2026-11-14', clipTag: '', introCommentary: false, music: false, useStock: false, useOpenverse: false, useAiImages: false, layout: 'blur',
        allowed: 'Funny moments, memorable quotes, reactions, trading stories and lessons from TJR\'s own channels',
        avoid: 'Anything that makes TJR look bad, profit promises or "guaranteed" claims, buy/sell calls, gambling or casino promos, logos, AI voice or AI visuals, non-English text, slurs or harassment',
        originality: 'Only clip TJR\'s own channels listed in the campaign. Every clip is our own cut with captions and a hook line. Never repost another clipper\'s video.',
        cta: 'Follow for daily TJR clips', subreddits: 'Daytrading, FuturesTrading, stocks', monetizationGoal: 'TJR clipping campaign payouts (Content Rewards)',
      },
    },
  };
  FX.campaign = () => FX.CAMPAIGNS[ls.get('fx_campaign', '') || ''] || null;

  /* ---------------- captions: required tags + disclaimer ---------------- */
  const hasTag = (text, tag) => new RegExp(`(^|\\s)${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text || '');
  FX.campaignCaption = (text, cp = FX.campaign()) => {
    let t = String(text || '').trim();
    if (!cp) return t;
    const add = [];
    if (cp.disclaimer && !/not financial advice/i.test(t)) add.push(cp.disclaimer);
    const tags = (cp.requiredTags || []).filter((g) => !hasTag(t, g));
    if (tags.length) add.push(tags.join(' '));
    return add.length ? `${t}${t ? '\n\n' : ''}${add.join(' ')}` : t;
  };
  FX.campaignMissing = (text, cp = FX.campaign()) => {
    if (!cp) return [];
    const miss = (cp.requiredTags || []).filter((g) => !hasTag(text, g));
    if (cp.disclaimer && !/not financial advice/i.test(text || '')) miss.push('"Not financial advice" disclaimer');
    return miss;
  };

  /* ---------------- finance checker ---------------- */
  // PROMISE: a promise of money. Blocked when it is our own words (title/caption); a person decides when the creator says it.
  const PROMISE = [
    [/\bguarantee[sd]?\b[^.!?\n]{0,30}\b(profits?|returns?|gains?|money|income|wins?|winners?|payouts?|results)\b/i, 'promises guaranteed profits'],
    [/\b(profits?|returns?|gains?|money|income|wins?)\b[^.!?\n]{0,20}\bguaranteed\b/i, 'promises guaranteed profits'],
    [/\b(risk[- ]free|no[- ]risk|zero[- ]risk)\b/i, 'calls trading risk-free'],
    [/\b(can'?t|cannot|never|won'?t) lose\b/i, 'says you cannot lose'],
    [/\b100\s?%\s*(win|winning|accurate|accuracy|success|profitable)\b/i, 'claims a 100% win rate'],
    [/\b(get rich quick|free money|easy money|money printer)\b/i, 'get-rich-quick wording'],
    [/\bdouble your (money|account|portfolio)\b/i, 'promises to double your money'],
    [/\b(quit your job|financial freedom|millionaire)\b[^.!?\n]{0,15}\b(in|within) \d+\s*(days?|weeks?|months?)\b/i, 'promises fast riches'],
  ];
  // HYPE: not a promise, but a person should look (buy/sell calls, signal selling, big-money bragging framed as easy).
  const HYPE = [
    [/\b(buy|sell|short|long) (this|it) (now|today|asap)\b/i, 'tells viewers what to buy or sell'],
    [/\bthis (stock|coin|token) (will|is going to) (moon|explode|10x|100x|double)\b/i, 'predicts a price move as fact'],
    [/\b(10x|100x|1000x)\b/i, '"10x / 100x" hype'],
    [/\b(signals? group|copy my trades|join my discord for (signals|trades))\b/i, 'promotes trade signals'],
    [/\b(all[- ]in|bet (it|everything)|yolo)\b/i, 'all-in / YOLO wording'],
    [/\b(casino|sportsbook|betting code|stake\.com)\b/i, 'gambling promotion'],
  ];
  FX.financeHits = (text) => {
    const t = String(text || ''), out = [];
    for (const [re, why] of PROMISE) { const m = t.match(re); if (m) out.push({ kind: 'promise', why, quote: m[0] }); }
    for (const [re, why] of HYPE) { const m = t.match(re); if (m) out.push({ kind: 'hype', why, quote: m[0] }); }
    return out;
  };
  // ours = text we wrote (title, caption, hook, on-screen text); otherwise it is what the creator says
  const financeItems = (text, where, ours) => FX.financeHits(text).map((h) => h.kind === 'promise'
    ? item(ours ? 'block' : 'high', `Finance · ${where}`, `${ours ? 'Our text' : 'The creator'} ${h.why}: "${h.quote}"`, ours ? 'Rewrite it. Never promise or imply profits. The checks run again after you edit.' : 'Watch it. Keep it only if the context makes clear it is not a promise to viewers, otherwise cut or reject.')
    : item(ours ? 'high' : 'medium', `Finance · ${where}`, `${ours ? 'Our text' : 'The creator'}: ${h.why} ("${h.quote}")`, ours ? 'Rewrite it so it informs instead of selling a result.' : 'Check the context before approving.'));
  FX.financeItems = financeItems;

  // anything that is clearly not English (CJK, Cyrillic, Arabic, Hebrew, Thai, Devanagari)
  const NON_EN = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ؀-ۿ֐-׿฀-๿ऀ-ॿ]/;

  function campaignItems(cp, { title = '', caption = '', transcript = '', kind = 'clip', synthetic = false }) {
    const items = [];
    if (cp.finance) {
      items.push(...financeItems(title, 'title', true), ...financeItems(caption, 'caption', true));
      if (transcript) items.push(...financeItems(transcript, 'what is said', false));
    }
    const miss = FX.campaignMissing(caption, cp);
    if (miss.length) items.push(item('high', `Campaign · ${cp.creator}`, `Caption is missing ${miss.join(' and ')}.`, 'Add it to the caption itself. A comment does not count.'));
    if (cp.english && NON_EN.test(`${title}\n${caption}`)) items.push(item('high', `Campaign · ${cp.creator}`, 'Title or caption has non-English text.', 'Use English only.'));
    if (cp.noAI && (kind === 'faceless' || synthetic)) items.push(item('block', `Campaign · ${cp.creator}`, 'This video has AI-generated voice or visuals. The campaign bans AI content and one strike removes you from every Reach campaign.', 'Post only real clips of the creator. Turn off AI intros, AI images and AI voice.'));
    if (cp.noLogos) items.push(item('low', `Campaign · ${cp.creator}`, 'No logos allowed (including broker, prop-firm or chart-platform logos on screen).', 'Check the frames; crop or reject if a logo is visible.'));
    items.push(item('low', `Campaign · ${cp.creator}`, `Submit the link on ${cp.marketplace} within ${cp.submitWithinMin} minutes of posting.`, cp.url));
    return items;
  }
  FX.campaignItems = campaignItems;

  /* ---------------- quick clipper path: Stream Clipper / Review Queue ---------------- */
  const baseGateClip = FX.gateClip;
  FX.gateClip = async (clip) => {
    const cp = FX.campaign();
    if (!cp || !['clip', 'faceless'].includes(clip.kind)) return baseGateClip(clip);
    if (clip.kind === 'clip') { clip.caption = FX.campaignCaption(clip.caption, cp); clip.campaign = cp.id; }
    const g = await baseGateClip(clip);
    // faceless videos are not campaign posts: only remind about the AI rule, do not block them
    const extra = clip.kind === 'clip' ? campaignItems(cp, clip)
      : [item('medium', `Campaign · ${cp.creator}`, 'AI faceless videos on the same account as a no-AI campaign can look like campaign posts.', 'Never submit this video to the campaign.')];
    g.items = [...g.items, ...extra];
    const v = g.items.some((i) => i.sev === 'block') ? 'BLOCK' : g.items.some((i) => i.sev === 'high') ? 'HUMAN_REVIEW' : g.items.some((i) => i.sev === 'medium') ? 'WARNING' : 'PASS';
    g.verdict = v;
    const blockers = g.items.filter((i) => i.sev === 'block');
    g.summary = v === 'PASS' ? 'All checks passed.' : v === 'BLOCK'
      ? (blockers.every((i) => /^Finance · (title|caption)$/.test(i.where || '')) ? 'Blocked: the title or caption promises profits. Edit it and the checks run again.' : 'Blocked: ' + blockers.map((i) => i.issue).join(' · '))
      : `${g.items.filter((i) => i.sev !== 'low').length} thing(s) to check.`;
    g.campaign = cp.id;
    clip.gate = g;
    return g;
  };

  /* ---------------- Assembly Line ---------------- */
  const R = FX.RUN;
  if (R?.prep) {
    const basePrep = R.prep;
    R.prep = async (r, say, o) => {
      const rep = await basePrep(r, say, o);
      const cp = FX.campaign();
      if (!cp || r.type !== 'clips' || !r.publishPrep) return rep;
      for (const m of Object.values(r.publishPrep.platforms || {})) {
        m.description = FX.campaignCaption(m.description, cp);
        for (const g of cp.requiredTags || []) if (!m.hashtags.some((h) => h.toLowerCase() === g.toLowerCase())) m.hashtags.unshift(g);
      }
      r.publishPrep.campaign = cp.id;
      rep.items = [...(rep.items || []), item('low', `Campaign · ${cp.creator}`, `Added ${(cp.requiredTags || []).join(' ')}${cp.disclaimer ? ' and the disclaimer' : ''} to every caption.`, '')];
      return rep;
    };
  }
  if (R?.guidelines) {
    const baseGuide = R.guidelines;
    R.guidelines = async (r, say, o) => {
      const rep = await baseGuide(r, say, o);
      const cp = FX.campaign();
      if (!cp || r.practice || r.type !== 'clips') return rep;
      const s = r.script || { scenes: [] };
      const ours = [s.title, r.clip?.hook, ...s.scenes.filter((x) => !x.streamAudio).map((x) => x.vo), ...s.scenes.map((x) => x.onScreen)].filter(Boolean).join(' | ');
      const said = s.scenes.filter((x) => x.streamAudio).map((x) => x.vo).join(' ');
      const add = cp.finance ? [...financeItems(ours, 'hook & on-screen text', true), ...financeItems(said, 'what is said', false)] : [];
      if (cp.noAI && r.disclosures?.containsSyntheticMedia) add.push(item('block', `Campaign · ${cp.creator}`, 'This clip has an AI voice intro or AI visuals. The campaign bans AI content.', 'Turn off commentary intros and AI images, then re-run.'));
      add.forEach((i) => { if (i.sev === 'block') { i.sev = 'high'; r.campaignBlock = `${cp.creator} campaign: ${i.issue}`; } });
      rep.items = [...(rep.items || []), ...add];
      if (add.some((i) => i.sev === 'high') && !['REJECTED', 'HUMAN_REVIEW'].includes(rep.verdict)) { rep.verdict = 'HUMAN_REVIEW'; rep.summary = 'Campaign or finance check flagged something. A person must decide.'; }
      return rep;
    };
  }
  const baseRecordGate = FX.recordGate;
  FX.recordGate = async (r) => {
    const g = await baseRecordGate(r);
    const cp = FX.campaign();
    if (!cp || r.type !== 'clips') return g;
    const why = [];
    if (cp.noAI && r.disclosures?.containsSyntheticMedia) why.push(`${cp.creator} campaign bans AI content and this clip has an AI voice or visuals`);
    for (const [p, m] of Object.entries(r.publishPrep?.platforms || {})) {
      const miss = FX.campaignMissing(m.description, cp);
      if (miss.length) why.push(`${p} caption is missing ${miss.join(' and ')}`);
      if (cp.finance) for (const h of FX.financeHits(`${m.title}\n${m.description}`).filter((x) => x.kind === 'promise')) why.push(`${p} title/caption ${h.why} ("${h.quote}")`);
    }
    if (!why.length) return g;
    const all = [...g.why, ...why];
    r.gate = { at: now(), ok: false, why: all };
    return { ok: false, why: all, sendBackTo: g.sendBackTo || 'prep' };
  };

  /* ---------------- AI caption writer for the Stream Clipper ---------------- */
  if (typeof window.clipMeta === 'function') {
    const baseMeta = window.clipMeta;
    window.clipMeta = async (transcript) => {
      const cp = FX.campaign();
      if (!cp) return baseMeta(transcript);
      const out = await chat(
        `Transcript of a short clip of ${cp.creator}${cp.finance ? ', a day trader who teaches futures trading' : ''}:\n"""${transcript.slice(0, 3000)}"""\n` +
        `Write in English only. Never promise or imply profits, never say "guaranteed" or "risk-free", never give buy/sell calls, never make ${cp.creator} look bad, and do not invent anything that is not in the transcript.\n` +
        `Return JSON {"title": short title (max 60 chars), "caption": punchy caption (max 110 chars, 1 emoji ok), ` +
        `"hashtags": 5 relevant hashtags in one string, including ${(cp.requiredTags || []).join(' ')}, "score": integer 1-10 for how likely this clip is to go viral (be strict)}`, true);
      const m = JSON.parse(out);
      m.score = Number(m.score) || null;
      return m;
    };
  }

  /* ---------------- no logos: the brand tag stays off during a no-logo campaign ---------------- */
  if (FX.hooks?.drawTag) {
    const baseTag = FX.hooks.drawTag;
    FX.hooks.drawTag = (...a) => (FX.campaign()?.noLogos ? undefined : baseTag(...a));
  }

  /* ---------------- niche preset ---------------- */
  if (FX.hooks?.NICHES) FX.hooks.NICHES['Trading / finance (TJR style)'] = {
    game: 'Trading streams and videos', niche: 'Trading clips: funny moments, quotes, reactions and lessons from trading streamers',
    audience: 'People 18 to 35 in the US, UK, Canada and Australia who are into day trading and the stock market', subreddits: 'Daytrading, FuturesTrading, stocks',
    cta: 'Follow for daily trading clips', allowed: 'Funny moments, memorable quotes, reactions, trading stories and lessons. Never profit promises or buy/sell calls.',
  };

  /* ---------------- apply / clear a campaign ---------------- */
  const setField = (id, v) => { const el = document.getElementById(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  FX.setCampaign = async (id) => {
    const cp = FX.CAMPAIGNS[id] || null, prev = ls.get('fx_campaign', '');
    ls.set('fx_campaign', cp ? cp.id : '');
    if (cp) {
      if (!ls.get('fx_campaignBackup', null)) ls.set('fx_campaignBackup', { hashtags: val('hashtags'), clipTag: val('clipTag'), layout: val('layout'), channel: FX.channel(), hooks: FX.hooks?.cfg?.() || null });
      setField('hashtags', cp.hashtags); setField('clipTag', '');
      if (['hook', 'split'].includes(val('layout'))) setField('layout', 'blur');
      await FX.saveChannel({ ...FX.channel(), ...cp.channel }, 'campaign preset');
      if (FX.hooks?.save) FX.hooks.save({ ...FX.hooks.cfg(), apply: 'off' });
      await FX.audit('campaign picked', cp.name, null, 'you');
    } else if (prev) {
      const b = ls.get('fx_campaignBackup', null);
      if (b) { setField('hashtags', b.hashtags); setField('clipTag', b.clipTag); setField('layout', b.layout); await FX.saveChannel(b.channel, 'campaign cleared'); if (b.hooks && FX.hooks?.save) FX.hooks.save(b.hooks); }
      ls.set('fx_campaignBackup', null);
      await FX.audit('campaign cleared', prev, null, 'you');
    }
    renderCampaign();
  };

  /* ---------------- UI: campaign card in the Stream Clipper ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderCampaign() {
    const box = document.getElementById('campaignBox'); if (!box) return;
    const cp = FX.campaign();
    const opts = [['', 'No campaign (my own clips)'], ...Object.values(FX.CAMPAIGNS).map((c) => [c.id, `${c.creator}: ${c.name}`])];
    box.innerHTML = `<div class="row"><label>Clipping campaign<select id="campaignPick">${opts.map(([v, t]) => `<option value="${v}" ${(cp?.id || '') === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>` +
      (cp ? `<p class="small"><strong>${esc(cp.pay)}</strong> Rules checked ${esc(cp.checkedAt)}: <a href="${esc(cp.url)}" target="_blank" rel="noopener">campaign page</a> · <a href="${esc(cp.rulesUrl)}" target="_blank" rel="noopener">full rules</a></p>
        <p class="small muted">Clip only from: ${cp.sources.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' · ')}. Look for: ${esc(cp.look)}.</p>
        <ul class="small campaign-rules">${cp.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <p class="small muted">Every caption gets ${esc((cp.requiredTags || []).join(' '))}${cp.disclaimer ? ` and "${esc(cp.disclaimer)}"` : ''} automatically. ${cp.noLogos ? 'Your brand tag is off. ' : ''}${cp.noAI ? 'AI voice intros, AI images and split-screen filler are off.' : ''}</p>`
        : '<p class="small muted">Pick a campaign when you clip a creator\'s paid clipping program. It sets the required tags, rules and checks for you.</p>');
  }
  document.addEventListener('change', (e) => { if (e.target.id === 'campaignPick') FX.setCampaign(e.target.value); });
  const boot = () => renderCampaign();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.FX);
