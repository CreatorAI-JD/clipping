/* AutoClipper Assembly Line — the departments.
   Each department receives a production record, does its job, and returns a report:
   { verdict: PASS | WARNING | FAIL | HUMAN_REVIEW | REJECTED | BLOCKED | WAIT, summary, items:[{sev, where, issue, fix}], ... }
   The production manager (fx-core.js) decides what happens next. */
'use strict';
(function (FX) {
  const R = FX.RUN, now = FX.now;
  const item = (sev, where, issue, fix = '') => ({ sev, where, issue, fix });
  const verdictFrom = (items) => items.some((i) => i.sev === 'high') ? 'FAIL' : items.some((i) => i.sev === 'medium') ? 'WARNING' : 'PASS';
  const needKey = (what) => ({ verdict: 'BLOCKED', summary: `Waiting for an OpenAI key (${what}). Add it in Settings; the line picks this video up again automatically.`, items: [] });
  const confirmedClaims = (r) => (r.research?.claims || []).filter((c) => c.status === 'confirmed' || c.status === 'time-sensitive');
  const allVO = (r) => (r.script?.scenes || []).map((s) => s.vo).join(' ');
  const cfgOf = (r) => ({ ...FX.channel() }); // departments always read the live channel config
  const jsonBlock = (o) => JSON.stringify(o, null, 1).slice(0, 12000);
  const channelBrief = (c) => `CHANNEL CONFIG (follow it):\nName: ${c.name}\nNiche: ${c.niche}\nAudience: ${c.audience}\nTone: ${c.tone}\nPersonality: ${c.personality}\nStyle: ${c.style}\nTarget length: ${c.lengthSec}s\nAllowed content: ${c.allowed}\nNEVER cover: ${c.avoid}\nOriginality policy: ${c.originality}\nMonetization goal: ${c.monetizationGoal}`;
  const learningsBrief = () => { const l = ls.get('fx_learnings', null); return l?.notes?.length ? `\nLESSONS FROM OUR OWN ANALYTICS (apply them):\n- ${l.notes.slice(0, 6).join('\n- ')}` : ''; };

  /* ===================================================================
     2. TREND RESEARCH & IDEA GENERATION
     Real trend signals that need no key: Wikipedia most-read articles and Reddit hot posts.
     YouTube most-popular is added when YouTube is connected directly. The AI turns signals into
     ORIGINAL concepts (it is told not to copy videos). An idea database prevents repeats.
     =================================================================== */
  const PRACTICE_TOPICS = ['Great Emu War', 'Library of Alexandria', 'Great Wall of China', 'Mariana Trench', 'Octopus', 'Honey', 'Eiffel Tower', 'Tardigrade', 'Leaning Tower of Pisa', 'Komodo dragon', 'Blue whale', 'Venus', 'Golden Gate Bridge', 'Statue of Liberty', 'Pompeii'];

  async function gatherSignals(c) {
    const out = [];
    for (const back of [1, 2]) { // yesterday's list is sometimes not published yet
      try {
        const d = new Date(now() - back * 864e5);
        const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
        const j = await FX.fetchJSON(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${dd}`, {}, 'Wikipedia');
        const arts = (j.items?.[0]?.articles || []).filter((a) => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Deaths_in|-)/.test(a.article)).slice(0, 40);
        out.push({ source: `Wikipedia most-read (${y}-${m}-${dd})`, url: `https://pageviews.wmcloud.org/topviews/?project=en.wikipedia.org&date=${y}-${m}-${dd}`, items: arts.map((a) => ({ title: a.article.replace(/_/g, ' '), metric: a.views + ' views' })) });
        break;
      } catch (e) { if (back === 2) out.push({ source: 'Wikipedia most-read', error: e.message, items: [] }); }
    }
    for (const sub of FX.lines(c.subreddits).slice(0, 3)) {
      try {
        const j = await FX.fetchJSON(`https://www.reddit.com/r/${encodeURIComponent(sub.replace(/^r\//, ''))}/hot.json?limit=15&raw_json=1`, {}, 'Reddit');
        out.push({ source: `Reddit r/${sub} (hot)`, url: `https://www.reddit.com/r/${sub}/hot`, items: (j.data?.children || []).filter((p) => !p.data.stickied && !p.data.over_18).map((p) => ({ title: p.data.title.slice(0, 160), metric: p.data.score + ' upvotes', url: 'https://www.reddit.com' + p.data.permalink })) });
      } catch (e) { out.push({ source: `Reddit r/${sub}`, error: e.message, items: [] }); }
    }
    if (ytToken()) {
      try {
        const j = await FX.fetchJSON('https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=US&maxResults=20', { headers: { Authorization: 'Bearer ' + ytToken() } }, 'YouTube');
        out.push({ source: 'YouTube most popular (US)', url: 'https://www.youtube.com/feed/trending', items: (j.items || []).map((v) => ({ title: v.snippet.title, metric: (+v.statistics.viewCount || 0).toLocaleString() + ' views', channel: v.snippet.channelTitle })) });
      } catch (e) { out.push({ source: 'YouTube most popular', error: e.message, items: [] }); }
    } else out.push({ source: 'YouTube most popular', error: 'Not connected (connect YouTube directly in Accounts to add this signal)', items: [] });
    out.push({ source: 'Google Trends', error: 'No public API that works from a browser. Not used.', items: [] });
    return out;
  }

  async function knownTopics() {
    const ideas = await FX.db.ideas.all();
    const recs = await FX.db.prod.all();
    return [...ideas.map((i) => i.topic), ...recs.map((r) => r.idea?.topic).filter(Boolean), ...ls.get('recentTopics', [])];
  }
  const isDuplicate = (topic, desc, known) => {
    const k = FX.keywords(topic + ' ' + (desc || ''));
    const kt = FX.keywords(topic);
    return known.find((t) => FX.jaccard(kt, FX.keywords(t)) >= 0.5 || FX.jaccard(k, FX.keywords(t)) >= 0.6) || null;
  };
  const rankIdea = (i) => {
    const s = i.scores || {}; const l = ls.get('fx_learnings', null);
    const boost = l?.hookBoost?.[i.hookStyle] ? Math.min(1.5, l.hookBoost[i.hookStyle]) : 1;
    return Math.round(((+s.relevance || 5) * 0.3 + (+s.interest || 5) * 0.3 + (+s.originality || 5) * 0.3 - (+s.difficulty || 5) * 0.1) * boost * 10) / 10;
  };

  FX.generateIdeas = async (r = null, n = 8) => {
    const c = FX.channel(), signals = await gatherSignals(c), known = await knownTopics();
    const made = [], dropped = [];
    if (!FX.hasAI()) {
      for (const t of PRACTICE_TOPICS) {
        if (made.length >= 3) break;
        const dup = isDuplicate(t, '', known); if (dup) continue;
        made.push({ id: 'idea_' + now().toString(36) + made.length, created: now(), practice: true, niche: c.niche, topic: t, description: `Practice idea: surprising, verifiable facts about ${t}.`, audience: c.audience, hook: `You have heard of ${t}, but not like this.`, hookStyle: 'bold claim', format: 'facts', research: ['Practice mode: built-in evergreen topic (no AI available)'], lengthSec: c.lengthSec, originality: { score: 5, notes: 'Practice topic; originality not assessed without AI.' }, concerns: [], scores: { relevance: 5, interest: 5, originality: 5, difficulty: 3 }, sources: [], status: 'new' });
      }
    } else {
      const sig = signals.filter((s) => s.items.length).map((s) => `${s.source}:\n${s.items.slice(0, 20).map((x) => `- ${x.title} (${x.metric})`).join('\n')}`).join('\n\n');
      const out = await FX.ai(r, 'trends', `You are the trend research department of a short-form video studio. You find content OPPORTUNITIES and invent ORIGINAL video concepts. You never copy or lightly rework an existing creator's video. ${channelBrief(c)}`,
        `Current trend signals (real data pulled today):\n${sig || '(no signals available today)'}\n\nAlready covered or planned (do NOT repeat or near-repeat): ${known.slice(-80).join('; ') || 'none'}\n${learningsBrief()}\n\n` +
        `Generate ${n} original video concepts that fit the channel niche. A signal is only a starting point; skip signals that do not fit the niche or touch avoided topics. Prefer evergreen topics with a timely angle. Return JSON {"ideas":[{` +
        `"topic": string, "description": string, "audience": string, "hook": string (spoken first line), "hookStyle": "question"|"bold claim"|"surprising stat"|"mini story", "format": "facts"|"story"|"explainer"|"myth vs fact"|"countdown", ` +
        `"research": [3-5 short supporting points to verify], "signals": [which signal(s) inspired it], "lengthSec": number, "originality": {"score": 1-10, "notes": string (what is our own angle)}, ` +
        `"concerns": [possible copyright or policy concerns, empty if none], "scores": {"relevance": 1-10, "interest": 1-10, "originality": 1-10, "difficulty": 1-10 (production difficulty)}}]}`);
      for (const [k, i] of (out?.ideas || []).entries()) {
        const dup = isDuplicate(i.topic || '', i.description, [...known, ...made.map((m) => m.topic)]);
        if (dup) { dropped.push({ topic: i.topic, reason: `Too close to "${dup}"` }); continue; }
        made.push({ id: 'idea_' + now().toString(36) + k, created: now(), niche: c.niche, status: 'new', ...i, scores: i.scores || {}, concerns: i.concerns || [], research: i.research || [] });
      }
    }
    for (const i of made) { i.rank = rankIdea(i); i.signalsUsed = signals.map((s) => s.source); await FX.db.ideas.put(i); }
    for (const d of dropped) await FX.db.ideas.put({ id: 'idea_' + now().toString(36) + Math.random().toString(36).slice(2, 5), created: now(), topic: d.topic, status: 'duplicate', description: d.reason, scores: {}, rank: 0 });
    FX.emit('ideas');
    return { made, dropped, signals };
  };

  R.trends = async (r, say) => {
    say('Looking for unused ideas in the idea database…');
    let pool = (await FX.db.ideas.all()).filter((i) => i.status === 'new' && !!i.practice === !!r.practice && now() - i.created < 14 * 864e5);
    let gen = null;
    if (!pool.length) {
      say('Pulling trend signals and generating new ideas…');
      gen = await FX.generateIdeas(r);
      pool = gen.made;
    }
    if (!pool.length) return { verdict: 'HUMAN_REVIEW', summary: 'Could not produce a new, non-duplicate idea. Add ideas yourself in the Ideas tab or widen the niche.', items: [] };
    pool.sort((a, b) => b.rank - a.rank);
    const idea = pool[0];
    idea.status = 'used'; idea.usedBy = r.id; await FX.db.ideas.put(idea);
    r.idea = idea;
    const items = (idea.concerns || []).map((x) => item('medium', 'Idea', x, 'Fact-check and script departments will keep this in mind.'));
    if ((idea.originality?.score || 5) < 5) items.push(item('medium', 'Originality', `Low originality score (${idea.originality.score}/10): ${idea.originality.notes || ''}`, 'Script must add our own angle.'));
    return {
      verdict: verdictFrom(items), summary: `Picked "${idea.topic}" (rank ${idea.rank}) from ${pool.length} candidate idea(s).`, items,
      method: r.practice ? 'practice (built-in topics)' : 'AI + live trend signals',
      data: { signals: gen ? gen.signals.map((s) => ({ source: s.source, url: s.url, error: s.error, count: s.items.length, top: s.items.slice(0, 5) })) : null, dropped: gen?.dropped || [], ranking: pool.slice(0, 8).map((i) => ({ topic: i.topic, rank: i.rank, scores: i.scores })) },
    };
  };

  /* ===================================================================
     3. RESEARCH & FACT-CHECKING
     Sources: Wikipedia (live API, no key). The AI must quote the exact supporting sentence;
     the app then checks the quote really exists in the source text and that every number in
     the claim appears in the quote. Anything that fails is marked unverified and cannot be used as fact.
     =================================================================== */
  async function wikiSources(query, limit = 3) {
    const s = await FX.fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`, {}, 'Wikipedia');
    const out = [];
    for (const [k, hit] of (s.query?.search || []).entries()) {
      try {
        const p = await FX.fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info|revisions&rvprop=timestamp&explaintext=1&inprop=url&pageids=${hit.pageid}&format=json&origin=*`, {}, 'Wikipedia');
        const pg = Object.values(p.query?.pages || {})[0]; if (!pg?.extract) continue;
        out.push({ id: 'S' + (k + 1), publisher: 'Wikipedia', title: pg.title, url: pg.fullurl || `https://en.wikipedia.org/?curid=${hit.pageid}`, retrieved: now(), lastEdited: pg.revisions?.[0]?.timestamp || null, text: pg.extract.replace(/\n{2,}/g, '\n').slice(0, 9000) });
      } catch {}
    }
    return out;
  }
  const quoteInSource = (quote, src) => {
    const q = FX.norm(quote); if (!q || q.length < 12 || !src) return false;
    const t = FX.norm(src.text);
    if (t.includes(q)) return true;
    const parts = q.split(' '); // tolerate small edits: 85% of an 8-word window must match
    for (let i = 0; i + 8 <= parts.length; i += 4) if (!t.includes(parts.slice(i, i + 8).join(' '))) return false;
    return parts.length >= 8;
  };
  const TIME_WORDS = /\b(currently|now|today|this year|latest|recent(ly)?|record|still|as of)\b/i;

  R.factcheck = async (r, say) => {
    const topic = r.idea?.topic; if (!topic) return { verdict: 'FAIL', sendBackTo: 'trends', summary: 'No idea to research.', items: [] };
    say(`Finding sources for "${topic}"…`);
    let sources = await wikiSources(topic, 3);
    if (!sources.length) sources = await wikiSources(FX.keywords(topic).slice(0, 4).join(' '), 3);
    if (!sources.length) {
      if (r.idea.id) { r.idea.status = 'rejected'; r.idea.rejectReason = 'No reliable sources found'; await FX.db.ideas.put(r.idea); }
      r.idea = null;
      return { verdict: 'FAIL', sendBackTo: 'trends', summary: `No reliable sources found for "${topic}". Picking another idea.`, items: [item('high', 'Sources', 'Wikipedia search returned nothing usable.')] };
    }
    let claims = [], method, conflicts = [];
    if (r.practice || !FX.hasAI()) {
      // extractive: claims are sentences copied from the source itself, so they are supported by definition
      method = 'extractive (no AI): sentences taken directly from the source';
      const sents = FX.sentences(sources[0].text.slice(0, 3500)).filter((s) => s.length > 50 && s.length < 260 && (/\d/.test(s) || (s.match(/\b[A-Z][a-z]+/g) || []).length >= 3));
      claims = sents.slice(0, 6).map((s) => ({ text: s, kind: 'fact', status: 'confirmed', sources: [sources[0].id], quote: s, note: 'Copied from source' }));
    } else {
      method = 'AI claim extraction + automatic quote verification';
      say('Checking claims against the sources…');
      const out = await FX.ai(r, 'factcheck', 'You are a strict fact-checker. You only accept a claim if one of the provided sources states it. You copy the supporting sentence EXACTLY as written in the source.',
        `Topic: ${topic}\nVideo concept: ${r.idea.description}\nPoints the idea wants to make (verify each, do not assume): ${(r.idea.research || []).join(' | ')}\n\nSOURCES:\n${sources.map((s) => `[${s.id}] ${s.title} (${s.url}, last edited ${s.lastEdited})\n${s.text.slice(0, 6000)}`).join('\n\n')}\n\n` +
        `List 6-12 specific, interesting claims a short video about this topic could make (names, dates, numbers, events). Include the idea's points even if unsupported so we can flag them. Return JSON {"claims":[{"text": string, "kind": "fact"|"opinion", "status": "confirmed"|"conflicting"|"unverified"|"outdated", "sources": ["S1"], "quote": exact supporting sentence copied from the source or "", "note": string}], "conflicts": [strings describing disagreements between sources]}`,
        { temperature: 0.2 });
      claims = out?.claims || []; conflicts = out?.conflicts || [];
    }
    const items = [];
    claims.forEach((c, i) => {
      c.id = 'C' + (i + 1);
      if (c.kind === 'opinion') { c.status = 'opinion'; return; }
      if (c.status === 'confirmed') {
        const src = sources.find((s) => (c.sources || []).includes(s.id)) || null;
        if (!quoteInSource(c.quote, src)) { c.status = 'unverified'; c.note = 'AI-cited quote not found in the source text'; }
        else {
          const qn = new Set(FX.numbers(c.quote)); const missing = FX.numbers(c.text).filter((n) => !qn.has(n));
          if (missing.length) { c.status = 'unverified'; c.note = `Number(s) ${missing.join(', ')} not in the quoted source`; }
          else if (TIME_WORDS.test(c.text)) { c.status = 'time-sensitive'; c.note = 'Time-sensitive wording; phrase as "as of <date>" or drop'; }
        }
      }
      if (c.status !== 'confirmed') items.push(item(c.status === 'time-sensitive' ? 'low' : 'medium', c.id, `${c.status.toUpperCase()}: "${c.text}"${c.note ? ' — ' + c.note : ''}`, c.status === 'time-sensitive' ? 'May be used with a date qualifier.' : 'Removed from the plan. The script may not present it as fact.'));
    });
    conflicts.forEach((x) => items.push(item('medium', 'Conflict', x, 'Script must not take a side on this without a source.')));
    for (const s of sources) if (s.lastEdited && now() - Date.parse(s.lastEdited) > 3 * 365 * 864e5) items.push(item('low', s.id, `Source not edited in 3+ years (${s.lastEdited.slice(0, 10)})`, 'Fine for history; re-check if the topic is current.'));
    r.research = { sources, claims, conflicts, method, at: now() };
    const ok = confirmedClaims(r).length;
    if (ok < 3) {
      if (r.idea.id) { r.idea.status = 'rejected'; r.idea.rejectReason = `Only ${ok} verifiable claims`; await FX.db.ideas.put(r.idea); }
      r.idea = null;
      return { verdict: 'FAIL', sendBackTo: 'trends', summary: `Only ${ok} claim(s) could be verified. Not enough to make a factual video. Returning to Trend Research for a different idea.`, items, method };
    }
    const rejected = claims.filter((c) => !['confirmed', 'time-sensitive', 'opinion'].includes(c.status)).length;
    return { verdict: items.some((i) => i.sev === 'medium') ? 'WARNING' : 'PASS', summary: `${ok} claim(s) verified against ${sources.length} source(s); ${rejected} removed as unverified.`, items, method };
  };

  /* ===================================================================
     4. SCRIPT WRITING — only verified claims, channel voice, scene-by-scene production format
     =================================================================== */
  const HOOKS = ['question', 'bold claim', 'surprising stat', 'mini story'];
  function pickHookStyle(r) {
    const l = ls.get('fx_learnings', null);
    if (l?.bestHook && Math.random() < 0.7) return { style: l.bestHook, why: 'analytics: best-performing hook so far' };
    if (r.idea?.hookStyle && HOOKS.includes(r.idea.hookStyle)) return { style: r.idea.hookStyle, why: 'idea suggested it' };
    const used = ls.get('fx_hookRot', 0); ls.set('fx_hookRot', used + 1);
    return { style: HOOKS[used % HOOKS.length], why: 'rotating styles to learn which works' };
  }
  const WPS = 2.6; // spoken words per second at speed 1.0
  function timeScenes(scenes, speed = 1) {
    let t = 0;
    for (const s of scenes) { const d = Math.max(1.6, FX.words(s.vo).length / (WPS * speed)); s.start = Math.round(t * 10) / 10; t += d + 0.3; s.end = Math.round(t * 10) / 10; }
    return t;
  }

  R.script = async (r, say) => {
    const c = cfgOf(r), facts = confirmedClaims(r), hook = pickHookStyle(r);
    if (r.script) r.scriptHistory.push({ ...r.script, replacedAt: now() });
    const fix = r.revisionNote && ['scriptqc', 'finalqc', 'guidelines', 'monetization'].includes(r.revisionNote.from)
      ? `\n\nTHIS IS A REVISION. Fix exactly these problems found by ${FX.dept(r.revisionNote.from).name}:\n${(r.reports[r.revisionNote.from]?.items || []).filter((i) => i.sev !== 'low').map((i) => `- [${i.where}] ${i.issue} → ${i.fix}`).join('\n')}\nPrevious script:\n${jsonBlock(r.script?.scenes)}` : '';
    let s;
    if (r.practice || !FX.hasAI()) {
      if (!r.practice) return needKey('script writing');
      const sc = [{ vo: r.idea.hook || `Here is something about ${r.idea.topic} you probably never heard.`, onScreen: r.idea.topic.toUpperCase().slice(0, 30), footage: { query: r.idea.topic, kind: 'image' }, sfx: 'whoosh', transition: 'cut' }];
      facts.slice(0, 4).forEach((f, i) => sc.push({ vo: f.text.length > 180 ? f.text.slice(0, f.text.lastIndexOf(' ', 175)) + '.' : f.text, onScreen: `FACT #${i + 1}`, footage: { query: r.idea.topic, kind: 'image' }, sfx: i % 2 ? 'pop' : 'whoosh', transition: ['fade', 'flash', 'zoom', 'cut'][i % 4], claims: [f.id] }));
      sc.push({ vo: `${c.cta}.`, onScreen: 'FOLLOW FOR MORE', footage: { query: r.idea.topic, kind: 'generated' }, sfx: 'pop', transition: 'fade' });
      s = { title: r.idea.topic, hookStyle: 'bold claim', format: 'facts', scenes: sc, cta: c.cta, method: 'practice template (no AI)' };
    } else {
      say(`Writing a ${hook.style} script…`);
      const out = await FX.ai(r, 'script', `You are the head writer of a short-form video channel. You write ORIGINAL scripts specifically for this channel. Never imitate or rework another creator's script. ${channelBrief(c)}`,
        `Write a ~${c.lengthSec}s vertical short about: ${r.idea.topic}\nConcept: ${r.idea.description}\nAudience: ${r.idea.audience || c.audience}\nOpening hook style to use: ${hook.style}\nCall to action: ${c.cta}\n\n` +
        `VERIFIED FACTS (the ONLY facts you may state; cite their ids per scene):\n${facts.map((f) => `${f.id}: ${f.text}${f.status === 'time-sensitive' ? ' [time-sensitive: add "as of" wording]' : ''}`).join('\n')}\n` +
        `Do not state any other names, numbers, dates or claims as fact. Opinions must be framed as opinion.${learningsBrief()}${fix}\n\n` +
        `Rules: ${Math.round(c.lengthSec * WPS)} spoken words total (±15%). 5-8 scenes. Scene 1 is the hook: under 14 words, gets to the subject in the first 3 seconds. Build with small reveals. Natural spoken style, short sentences, no filler. Ending must feel complete, then the call to action. On-screen text max 6 words. Footage instructions must describe generic visuals findable as stock or generatable (no logos, no real copyrighted clips, no identifiable private people).\n` +
        `Return JSON {"title": string, "hookStyle": string, "format": string, "scenes": [{"n": number, "vo": narration, "onScreen": string, "footage": {"query": 2-4 word stock search, "kind": "stock video"|"image"|"generated", "prompt": image prompt if generated}, "sfx": "whoosh"|"pop"|"riser"|"none", "transition": "cut"|"fade"|"flash"|"zoom", "claims": ["C1"]}], "cta": string}`);
      if (!out?.scenes?.length) throw new FX.TempError('Script writer returned no scenes');
      s = { ...out, method: 'AI' };
    }
    s.scenes = s.scenes.map((x, i) => ({ n: i + 1, vo: String(x.vo || '').trim(), onScreen: String(x.onScreen || '').trim(), footage: x.footage || { query: r.idea.topic, kind: 'image' }, sfx: x.sfx || 'none', transition: x.transition || 'cut', claims: x.claims || [] }));
    s.duration = timeScenes(s.scenes, +c.speed || 1);
    s.version = (r.scriptHistory.length || 0) + 1; s.hookWhy = hook.why; s.at = now();
    r.script = s;
    return { verdict: 'PASS', summary: `Script v${s.version}: ${s.scenes.length} scenes, ~${Math.round(s.duration)}s, ${FX.words(allVO(r)).length} words (${s.hookStyle} hook).`, items: [], method: s.method };
  };

  /* ===================================================================
     5. SCRIPT QC — deterministic checks + an independent AI reviewer
     =================================================================== */
  function scriptRules(r) {
    const c = cfgOf(r), sc = r.script.scenes, items = [];
    const words = FX.words(allVO(r)).length, target = c.lengthSec * WPS;
    sc.forEach((s) => { for (const f of ['vo', 'onScreen']) if (!s[f]) items.push(item('high', `Scene ${s.n}`, `Missing ${f === 'vo' ? 'voiceover narration' : 'on-screen text'}`, 'Every scene needs narration, on-screen text, footage, SFX and a transition.')); if (!s.footage?.query) items.push(item('high', `Scene ${s.n}`, 'Missing background footage instructions')); });
    const hookW = FX.words(sc[0]?.vo).length;
    if (hookW > 16) items.push(item('medium', 'Scene 1 (hook)', `Hook is ${hookW} words: "${sc[0].vo}"`, 'Cut the hook to under 14 words.'));
    if (Math.abs(words - target) / target > 0.3) items.push(item('medium', 'Whole script', `${words} words for a ${c.lengthSec}s target (~${Math.round(target)} words)`, words > target ? 'Cut unnecessary sentences.' : 'Add one more development.'));
    const seen = {};
    FX.sentences(allVO(r)).forEach((t) => { const k = FX.norm(t); if (k.length > 10 && seen[k]) items.push(item('medium', 'Repetition', `Sentence repeated: "${t}"`, 'Remove the duplicate.')); seen[k] = 1; });
    const freq = {}; FX.keywords(allVO(r)).forEach((w) => (freq[w] = (freq[w] || 0) + 1));
    Object.entries(freq).filter(([w, n]) => n >= 5 && !FX.keywords(r.idea?.topic).includes(w)).forEach(([w, n]) => items.push(item('low', 'Repetition', `"${w}" used ${n} times`, 'Vary the wording.')));
    // every number on screen or in narration must come from a verified claim
    const allowed = new Set(confirmedClaims(r).flatMap((x) => FX.numbers(x.text)));
    sc.forEach((s) => {
      for (const sent of FX.sentences(s.vo + ' ' + s.onScreen)) {
        const bad = FX.numbers(sent).filter((n) => +n > 10 && !allowed.has(n) && !(s.onScreen.includes('#' + n)));
        if (bad.length) items.push(item('high', `Scene ${s.n}`, `Unsupported number ${bad.join(', ')} in: "${sent}"`, 'Use only numbers from verified claims, or remove it.'));
      }
    });
    for (const a of FX.lines(c.avoid)) if (a.length > 3 && FX.norm(allVO(r)).includes(FX.norm(a))) items.push(item('high', 'Channel rules', `Mentions avoided topic "${a}"`, 'Remove it; the channel config bans this topic.'));
    const last = sc[sc.length - 1]?.vo || '';
    if (!/[.!?]["']?$/.test(last.trim())) items.push(item('medium', `Scene ${sc.length}`, 'Ending looks cut off', 'Finish the final sentence.'));
    return items;
  }
  async function similarScripts(r) {
    const mine = FX.ngrams(allVO(r)); const out = [];
    for (const o of await FX.db.prod.all()) {
      if (o.id === r.id || !o.script) continue;
      const sim = FX.jaccard(mine, FX.ngrams(o.script.scenes.map((s) => s.vo).join(' ')));
      if (sim > 0.08) out.push({ id: o.id, title: o.script.title, sim: Math.round(sim * 100) / 100, published: !!o.publish });
    }
    return out.sort((a, b) => b.sim - a.sim);
  }

  R.scriptqc = async (r, say) => {
    say('Running script checks…');
    const items = scriptRules(r);
    const sim = await similarScripts(r);
    if (sim[0]?.sim >= 0.3) items.push(item('high', 'Originality', `Script is ${Math.round(sim[0].sim * 100)}% similar to ${sim[0].id} ("${sim[0].title}")`, 'Rewrite with a different angle and structure.'));
    let hookScore = null, method = 'rules only';
    if (!r.practice && FX.hasAI()) {
      say('Independent AI reviewer reading the script…');
      method = 'rules + independent AI review';
      const out = await FX.ai(r, 'scriptqc', 'You are a strict script editor and compliance reviewer. You did NOT write this script. Be specific: quote the exact sentence and the scene number for every problem. Do not invent problems.',
        `${channelBrief(cfgOf(r))}\n\nVERIFIED CLAIMS:\n${confirmedClaims(r).map((f) => `${f.id}: ${f.text}`).join('\n')}\n\nSCRIPT:\n${r.script.scenes.map((s) => `Scene ${s.n} [${s.start}-${s.end}s]\nVO: ${s.vo}\nON-SCREEN: ${s.onScreen}\nFOOTAGE: ${s.footage?.query}`).join('\n\n')}\n\n` +
        `Check: hook quality, grammar, spelling, sentence structure, storytelling, repetition, factual accuracy vs the verified claims, unsupported statements, originality (does it read like a copy of a known creator's script?), community-guidelines risks, advertiser-suitability risks, whether the ending makes sense.\n` +
        `Return JSON {"hookScore": 1-10, "issues": [{"severity": "high"|"medium"|"low", "scene": number|null, "sentence": exact text, "category": string, "issue": string, "fix": exact replacement or instruction}]}. Use "high" only for factual errors, unsupported claims, policy risks, or a broken script.`, { temperature: 0.2 });
      hookScore = out?.hookScore ?? null;
      (out?.issues || []).forEach((i) => items.push(item(i.severity || 'low', `${i.scene ? 'Scene ' + i.scene : 'Script'} · ${i.category || ''}`, `${i.issue}${i.sentence ? ` — "${i.sentence}"` : ''}`, i.fix || '')));
      if (hookScore != null && hookScore < 5) items.push(item('medium', 'Scene 1 (hook)', `Hook scored ${hookScore}/10`, 'Write a stronger first line.'));
    } else if (!r.practice) return needKey('script review');
    const verdict = verdictFrom(items);
    return { verdict, sendBackTo: 'script', summary: verdict === 'FAIL' ? `Returned to Script Writing: ${items.filter((i) => i.sev === 'high').length} must-fix problem(s).` : verdict === 'WARNING' ? `Approved with ${items.filter((i) => i.sev === 'medium').length} recommended change(s).` : 'Script approved.', items, method, data: { hookScore, similar: sim.slice(0, 3) } };
  };

  /* ===================================================================
     6. VOICEOVER — per-scene narration, so a failed scene is regenerated on its own
     =================================================================== */
  const applyPron = (text, dict) => { let t = text; for (const line of String(dict || '').split('\n')) { const [a, b] = line.split('='); if (a && b) t = t.replace(new RegExp(`\\b${a.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), b.trim()); } return t; };
  // longest-common-subsequence word alignment (scripts are short)
  FX.align = (ref, hyp) => {
    const a = ref.map(FX.norm), b = hyp.map(FX.norm), n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pairs = []; let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
    return { pairs, matched: pairs.length, accuracy: n ? pairs.length / n : 1, missing: a.map((w, k) => (pairs.some((p) => p[0] === k) ? null : k)).filter((k) => k != null), extra: b.map((w, k) => (pairs.some((p) => p[1] === k) ? null : k)).filter((k) => k != null) };
  };
  function analyzeVoice(buf, text) {
    const d = buf.getChannelData(0); let peak = 0, clip = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; if (v > 0.995) clip++; }
    const env = FX.envelope(buf, 0.1); const gaps = []; let run = 0;
    env.forEach((db, i) => { if (db < -45) run++; else { if (run >= 12 && i - run > 3) gaps.push({ at: (i - run) * 0.1, len: run * 0.1 }); run = 0; } });
    const loud = env.filter((x) => x > -45); const rmsDb = loud.length ? 10 * Math.log10(loud.reduce((a, x) => a + 10 ** (x / 10), 0) / loud.length) : -120;
    return { dur: buf.duration, peak, clip, rmsDb: Math.round(rmsDb * 10) / 10, gaps, rate: FX.words(text).length / Math.max(0.5, buf.duration) };
  }

  R.voice = async (r, say) => {
    const c = cfgOf(r), sc = r.script.scenes;
    if (!r.practice && !FX.hasAI()) return needKey('voiceover');
    const prev = r.voice && r.voice.scriptVersion === r.script.version ? r.voice : null;
    const v = { voiceName: r.practice ? 'silent placeholder' : c.voice, speed: +c.speed || 1, scriptVersion: r.script.version, scenes: [], at: now(), method: r.practice ? 'practice: silent placeholder audio (no OpenAI key)' : 'OpenAI tts-1, one file per scene, checked with Whisper' };
    const items = []; let regenerated = 0;
    for (const s of sc) {
      const old = prev?.scenes.find((x) => x.n === s.n && x.text === s.vo && !x.redo);
      if (old) { v.scenes.push(old); continue; }
      say(`Voicing scene ${s.n}/${sc.length}…`);
      let blob;
      if (r.practice) { const len = Math.max(1.6, FX.words(s.vo).length / WPS); blob = FX.toWav([new Float32Array(Math.round(len * 24000))], 24000); }
      else blob = await FX.tts(r, 'voice', applyPron(s.vo, c.pronunciations), { voice: c.voice, speed: +c.speed || 1 });
      const buf = await FX.decode(blob);
      const fileId = await FX.saveFile(blob, `${r.id}_scene${s.n}.${blob.type.includes('wav') ? 'wav' : 'mp3'}`, { recId: r.id, role: 'voice' });
      const st = analyzeVoice(buf, s.vo);
      const entry = { n: s.n, text: s.vo, fileId, ...st, takes: (prev?.scenes.find((x) => x.n === s.n)?.takes || 0) + 1, issues: [] };
      if (!r.practice) {
        const tr = await FX.whisper(r, 'voice', buf);
        const al = FX.align(s.vo.split(/\s+/), (tr?.text || '').split(/\s+/));
        entry.transcript = tr?.text || ''; entry.accuracy = Math.round(al.accuracy * 100) / 100;
        const missing = al.missing.map((k) => s.vo.split(/\s+/)[k]);
        if (al.accuracy < 0.85) entry.issues.push(item('high', `Scene ${s.n}`, `Narration doesn't match the script (${Math.round(al.accuracy * 100)}% of words heard). Missing/misheard: ${missing.slice(0, 8).join(', ')}`, 'Regenerate this scene; add a pronunciation entry if a word keeps failing.'));
        else if (missing.length) entry.issues.push(item('low', `Scene ${s.n}`, `Possible mispronunciation: ${missing.slice(0, 6).join(', ')}`, 'Add to Pronunciations in Channel if it sounds wrong.'));
        if (st.clip > 20) entry.issues.push(item('high', `Scene ${s.n}`, `Audio clipping (${st.clip} samples)`, 'Regenerate.'));
        if (st.rmsDb < -32 || st.rmsDb > -10) entry.issues.push(item('medium', `Scene ${s.n}`, `Level ${st.rmsDb} dBFS is outside the normal range`, 'Gain is normalized automatically in the edit.'));
        st.gaps.forEach((g) => entry.issues.push(item('medium', `Scene ${s.n} @ ${FX.ts(g.at)}`, `Unnatural pause of ${g.len.toFixed(1)}s`, 'Regenerate this scene.')));
        if (st.rate > 3.9) entry.issues.push(item('medium', `Scene ${s.n}`, `Very fast delivery (${st.rate.toFixed(1)} words/sec)`, 'Lower the voice speed in Channel.'));
        if (st.rate < 1.6) entry.issues.push(item('medium', `Scene ${s.n}`, `Very slow delivery (${st.rate.toFixed(1)} words/sec)`, 'Raise the voice speed in Channel.'));
      }
      entry.redo = entry.issues.some((i) => i.sev === 'high');
      if (prev) regenerated++;
      v.scenes.push(entry);
    }
    // consistent volume: gain each scene to the median level
    const levels = v.scenes.map((x) => x.rmsDb).filter((x) => x > -100).sort((a, b) => a - b); const med = levels[Math.floor(levels.length / 2)] ?? -20;
    v.scenes.forEach((x) => { x.gainDb = x.rmsDb > -100 ? Math.max(-6, Math.min(9, -18 - x.rmsDb)) : 0; if (Math.abs(x.rmsDb - med) > 4 && x.rmsDb > -100) x.issues.push(item('low', `Scene ${x.n}`, `Level differs from other scenes by ${Math.abs(x.rmsDb - med).toFixed(1)} dB`, `Normalized automatically (${x.gainDb.toFixed(1)} dB gain).`)); });
    v.total = v.scenes.reduce((a, x) => a + x.dur, 0);
    v.scenes.forEach((x) => items.push(...x.issues));
    r.voice = v;
    if (r.practice) items.push(item('medium', 'All scenes', 'Practice record: narration is silent placeholder audio.', 'Add an OpenAI key and start a new video for real narration.'));
    const failed = v.scenes.filter((x) => x.redo).map((x) => x.n);
    if (failed.length) return { verdict: 'FAIL', sendBackTo: 'voice', summary: `Scene(s) ${failed.join(', ')} failed the voiceover check and will be regenerated (only those scenes).`, items, method: v.method };
    return { verdict: verdictFrom(items), summary: `Narration approved: ${v.scenes.length} scenes, ${v.total.toFixed(1)}s${regenerated ? `, ${regenerated} scene(s) regenerated` : ''}.`, items, method: v.method };
  };

  /* ===================================================================
     7. ASSETS — every asset carries a license record; unverified assets are rejected or sent to a human
     =================================================================== */
  const LICENSES = {
    'Pexels License': { commercial: true, attribution: false, url: 'https://www.pexels.com/license/' },
    'Pixabay Content License': { commercial: true, attribution: false, url: 'https://pixabay.com/service/license-summary/' },
    CC0: { commercial: true, attribution: false, url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    'Public Domain Mark': { commercial: true, attribution: false, url: 'https://creativecommons.org/publicdomain/mark/1.0/' },
    'CC BY': { commercial: true, attribution: true },
    'Original work (generated in AutoClipper)': { commercial: true, attribution: false, url: '' },
    'AI-generated (OpenAI image output)': { commercial: true, attribution: false, url: 'https://openai.com/policies/terms-of-use/' },
    'AI voice (OpenAI TTS output)': { commercial: true, attribution: false, url: 'https://openai.com/policies/terms-of-use/' },
    'Owned by me (confirmed)': { commercial: true, attribution: false, url: '' },
  };
  FX.LICENSES = LICENSES;
  // the licensing checker: complete record + a license we know allows commercial reuse with edits
  FX.checkLicense = (a) => {
    const miss = ['name', 'source', 'license', 'acquired'].filter((k) => !a[k]);
    if (miss.length) return { status: 'rejected', reason: 'Incomplete license record: missing ' + miss.join(', ') };
    if (a.license === 'User-supplied (unconfirmed)') return { status: 'manual_review', reason: 'You uploaded this. Confirm you own it or have a license in the Library.' };
    if (/BY-SA/i.test(a.license)) return { status: 'manual_review', reason: 'Share-alike license: a video using it may have to be shared under the same license. Needs a human decision.' };
    if (/ND|NC/i.test(a.license)) return { status: 'rejected', reason: `${a.license} does not allow commercial use or edits` };
    const L = LICENSES[a.license.replace(/ \d.*$/, '')] || LICENSES[a.license];
    if (!L) return { status: 'rejected', reason: `Unknown license "${a.license}" — never assume online footage is free to use` };
    if (a.commercial !== true) return { status: 'rejected', reason: 'Commercial use not confirmed' };
    if (L.attribution && !a.attributionText) return { status: 'rejected', reason: 'Attribution required but creator/attribution text missing' };
    if (!a.licenseUrl && L.url !== '') return { status: 'rejected', reason: 'No link to the license documentation' };
    return { status: 'verified', reason: L.attribution ? 'Verified — attribution will be added to the description' : 'Verified' };
  };
  const fetchBlob = async (url, max = 45e6) => {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const b = await res.blob(); if (b.size > max) throw new Error('File too large');
    return b;
  };
  const mkAsset = (scene, o) => ({ id: 'a_' + now().toString(36) + Math.random().toString(36).slice(2, 6), scene, acquired: new Date().toISOString(), ...o });

  const SOURCES = {
    async library(r, s, q) {
      const recent = new Set((await FX.db.prod.all()).filter((o) => o.id !== r.id).sort((a, b) => b.created - a.created).slice(0, 4).flatMap((o) => (o.assets || []).map((a) => a.libraryId)));
      const kw = FX.keywords(q);
      const lib = (await FX.db.library.all()).filter((a) => a.status === 'verified' && !recent.has(a.id) && FX.jaccard(kw, a.tags || []) > 0.25);
      if (!lib.length) return [];
      const a = lib[0];
      return [{ ...mkAsset(s.n, { ...a, id: undefined, libraryId: a.id, note: 'Reused from the content library' }), fileId: a.fileId, prefetched: true }];
    },
    async pexels(r, s, q) {
      const k = FX.keys().pexels; if (!k) return [];
      FX.use('stock');
      const j = await FX.fetchJSON(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=6`, { headers: { Authorization: k } }, 'Pexels');
      return (j.videos || []).map((v) => {
        const f = (v.video_files || []).filter((x) => x.file_type === 'video/mp4' && x.height >= 1280 && x.height <= 2160).sort((a, b) => a.height - b.height)[0] || v.video_files?.[0];
        return f && mkAsset(s.n, { name: `Pexels video ${v.id}`, kind: 'video', source: 'Pexels', creator: v.user?.name, creatorUrl: v.user?.url, pageUrl: v.url, url: f.link, width: f.width, height: f.height, license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', commercial: true, attribution: 'not required', ext: 'pexels:' + v.id });
      }).filter(Boolean);
    },
    async pixabay(r, s, q) {
      const k = FX.keys().pixabay; if (!k) return [];
      FX.use('stock');
      const j = await FX.fetchJSON(`https://pixabay.com/api/videos/?key=${encodeURIComponent(k)}&q=${encodeURIComponent(q)}&per_page=6&safesearch=true`, {}, 'Pixabay');
      return (j.hits || []).map((h) => { const f = h.videos?.medium || h.videos?.small; return f?.url && mkAsset(s.n, { name: `Pixabay video ${h.id}`, kind: 'video', source: 'Pixabay', creator: h.user, pageUrl: h.pageURL, url: f.url, width: f.width, height: f.height, license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', commercial: true, attribution: 'not required', ext: 'pixabay:' + h.id }); }).filter(Boolean);
    },
    async openverse(r, s, q) {
      if (!FX.channel().useOpenverse) return [];
      FX.use('stock');
      const j = await FX.fetchJSON(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial,modification&page_size=8&mature=false`, {}, 'Openverse');
      const map = { by: 'CC BY', 'by-sa': 'CC BY-SA', cc0: 'CC0', pdm: 'Public Domain Mark', 'by-nd': 'CC BY-ND', 'by-nc': 'CC BY-NC' };
      return (j.results || []).filter((x) => (x.height || 0) >= 600).map((x) => mkAsset(s.n, {
        name: x.title || `Openverse image ${x.id}`, kind: 'image', source: `Openverse (${x.source || x.provider})`, creator: x.creator || '', creatorUrl: x.creator_url, pageUrl: x.foreign_landing_url,
        url: x.url, thumb: `https://api.openverse.org/v1/images/${x.id}/thumb/`, width: x.width, height: x.height,
        license: (map[x.license] || x.license.toUpperCase()) + (x.license_version ? ' ' + x.license_version : ''), licenseUrl: x.license_url, commercial: !/nc/.test(x.license),
        attribution: /by/.test(x.license) ? 'required' : 'not required', attributionText: x.attribution || (x.creator ? `"${x.title}" by ${x.creator} (${map[x.license] || x.license})` : ''), ext: 'openverse:' + x.id,
      }));
    },
    async aiImage(r, s, q) {
      if (!FX.channel().useAiImages || !FX.hasAI() || r.practice) return [];
      return [mkAsset(s.n, { name: `AI image: ${q}`, kind: 'image', source: 'OpenAI gpt-image-1', creator: 'Generated for this video', license: 'AI-generated (OpenAI image output)', licenseUrl: 'https://openai.com/policies/terms-of-use/', commercial: true, attribution: 'not required', aiGenerated: true, generate: (s.footage?.prompt || `${q}, vertical 9:16 photo, cinematic, no text, no logos, no real people`) })];
    },
    async mine(r, s) {
      if (!FX.channel().useMyBackgrounds || !bgFiles.length) return [];
      const f = bgFiles[(s.n - 1) % bgFiles.length];
      const lib = (await FX.db.library.all()).find((a) => a.name === f.name && a.license === 'Owned by me (confirmed)');
      return [mkAsset(s.n, { name: f.name, kind: 'video', source: 'Your uploaded background', creator: 'You', license: lib ? 'Owned by me (confirmed)' : 'User-supplied (unconfirmed)', licenseUrl: '', commercial: lib ? true : 'unknown', attribution: 'not required', localFile: f })];
    },
  };

  async function acquire(r, a) {
    if (a.prefetched) return a;
    let blob;
    if (a.generate) blob = await FX.image(r, 'assets', a.generate);
    else if (a.localFile) blob = a.localFile;
    else { try { blob = await fetchBlob(a.url); } catch (e) { if (a.thumb) blob = await fetchBlob(a.thumb); else throw e; a.note = 'Used the API thumbnail (original host blocks browser downloads)'; } }
    a.fileId = await FX.saveFile(blob, a.name, { recId: r.id, role: 'asset' });
    a.size = blob.size; delete a.localFile; delete a.generate;
    if (a.kind === 'image') { try { const bm = await createImageBitmap(blob); a.width = bm.width; a.height = bm.height; bm.close?.(); } catch { throw new Error('Downloaded file is not a readable image'); } }
    return a;
  }

  R.assets = async (r, say) => {
    const c = cfgOf(r), items = [], rejected = [];
    const keep = (r.assets || []).filter((a) => a.status === 'verified' && a.scene && !a.redo && r.script.scenes.find((s) => s.n === a.scene));
    const assets = [...keep];
    for (const s of r.script.scenes) {
      if (assets.find((a) => a.scene === s.n)) continue;
      const q = s.footage?.query || r.idea.topic;
      say(`Scene ${s.n}: finding "${q}"…`);
      const order = s.footage?.kind === 'generated' ? ['library', 'aiImage', 'openverse'] : s.footage?.kind === 'image' ? ['library', 'openverse', 'aiImage', 'pexels'] : ['library', 'pexels', 'pixabay', 'openverse', 'aiImage'];
      if (c.useMyBackgrounds) order.splice(1, 0, 'mine');
      let got = null;
      for (const src of order) {
        let cands = [];
        try { cands = await SOURCES[src](r, s, q); } catch (e) { if (e.limit) throw e; rejected.push({ scene: s.n, name: src, reason: 'Source error: ' + e.message }); continue; }
        for (const a of cands.slice(0, 4)) {
          const chk = FX.checkLicense(a);
          a.status = chk.status; a.check = chk.reason;
          if (chk.status === 'rejected') { rejected.push({ scene: s.n, name: a.name, source: a.source, reason: chk.reason }); continue; }
          try { await acquire(r, a); got = a; break; } catch (e) { if (e.limit) throw e; rejected.push({ scene: s.n, name: a.name, source: a.source, reason: 'Could not download: ' + e.message }); }
        }
        if (got) break;
      }
      if (!got) got = mkAsset(s.n, { name: `Generated animated background (scene ${s.n})`, kind: 'generated', source: 'AutoClipper renderer', creator: 'AutoClipper', license: 'Original work (generated in AutoClipper)', licenseUrl: '', commercial: true, attribution: 'not required', status: 'verified', check: 'Verified — made from scratch by the app', note: 'No licensed footage found; using an original generated background' });
      assets.push(got);
      if (got.status === 'verified' && got.fileId && !got.libraryId && got.source !== 'Your uploaded background') {
        const libId = 'lib_' + (got.ext || got.id).replace(/[^\w:-]/g, '');
        await FX.db.library.put({ ...got, id: libId, tags: FX.keywords(q + ' ' + (got.name || '')), addedFrom: r.id, addedAt: now() });
        got.libraryId = libId;
      }
    }
    // narration, music and sound effects get license records too
    assets.push(
      mkAsset(0, { name: 'Narration', kind: 'audio', source: r.practice ? 'Silent placeholder' : 'OpenAI tts-1 (voice: ' + c.voice + ')', creator: 'Generated for this video', license: r.practice ? 'Original work (generated in AutoClipper)' : 'AI voice (OpenAI TTS output)', licenseUrl: r.practice ? '' : 'https://openai.com/policies/terms-of-use/', commercial: true, attribution: 'not required', aiGenerated: !r.practice, status: 'verified', check: 'Verified — synthetic voice must be disclosed' }),
      mkAsset(0, { name: 'Background music (generated pad)', kind: 'audio', source: 'AutoClipper WebAudio synth', creator: 'AutoClipper', license: 'Original work (generated in AutoClipper)', licenseUrl: '', commercial: true, attribution: 'not required', status: 'verified', check: 'Verified — composed in the app, no samples' }),
      mkAsset(0, { name: 'Sound effects (whoosh/pop/riser)', kind: 'audio', source: 'AutoClipper WebAudio synth', creator: 'AutoClipper', license: 'Original work (generated in AutoClipper)', licenseUrl: '', commercial: true, attribution: 'not required', status: 'verified', check: 'Verified — synthesized in the app' }),
    );
    r.assets = assets; r.assetRejects = rejected;
    assets.filter((a) => a.status === 'manual_review').forEach((a) => items.push(item('high', `Scene ${a.scene} · ${a.name}`, a.check, 'Confirm ownership in Library, or send back to replace it.')));
    assets.filter((a) => a.kind === 'generated').forEach((a) => items.push(item('low', `Scene ${a.scene}`, 'No licensed footage found; using an original animated background.', 'Add a Pexels/Pixabay key in Channel for real stock video.')));
    assets.filter((a) => a.width && a.height && Math.min(a.width, a.height) < 720).forEach((a) => items.push(item('low', `Scene ${a.scene}`, `Low resolution source (${a.width}×${a.height}) will be upscaled`, 'Prefer higher resolution footage.')));
    const manual = assets.filter((a) => a.status === 'manual_review').length;
    return { verdict: manual ? 'HUMAN_REVIEW' : verdictFrom(items), summary: `${assets.filter((a) => a.scene).length} scene asset(s) licensed and organized by scene; ${rejected.length} candidate(s) rejected by the licensing checker${manual ? `; ${manual} need your review` : ''}.`, items, data: { rejected: rejected.slice(0, 30) } };
  };

  /* ===================================================================
     shared: narration timeline (the edit uses the same layout so captions line up)
     =================================================================== */
  const LEAD = 0.15, PAUSE = 0.3, TAIL = 0.7;
  async function buildNarration(r) {
    const ac = getAudioCtx(), sr = ac.sampleRate, bufs = [];
    for (const s of r.voice.scenes) bufs.push(await FX.decode(await FX.getFile(s.fileId)));
    const offs = []; let pos = LEAD;
    bufs.forEach((b, i) => { offs.push({ n: r.voice.scenes[i].n, voiceStart: pos, voiceEnd: pos + b.duration, gain: 10 ** ((r.voice.scenes[i].gainDb || 0) / 20) }); pos += b.duration + PAUSE; });
    const dur = offs[offs.length - 1].voiceEnd + TAIL;
    offs.forEach((o, i) => { o.start = i === 0 ? 0 : o.voiceStart - PAUSE / 2; o.end = i === offs.length - 1 ? dur : offs[i + 1].voiceStart - PAUSE / 2; });
    const out = ac.createBuffer(1, Math.ceil(dur * sr), sr), d = out.getChannelData(0);
    bufs.forEach((b, i) => { const src = b.getChannelData(0), at = Math.round(offs[i].voiceStart * sr), g = offs[i].gain; for (let k = 0; k < src.length && at + k < d.length; k++) d[at + k] = src[k] * g; });
    return { buffer: out, buffers: bufs, offsets: offs, duration: dur };
  }
  FX.buildNarration = buildNarration; FX.analyzeVoice = analyzeVoice; FX.similarScripts = similarScripts; FX.scriptRules = scriptRules; FX.item = item; FX.verdictFrom = verdictFrom;

  /* ===================================================================
     8. CAPTIONS — from the approved voiceover (transcribed), corrected to the script's spelling
     =================================================================== */
  R.captions = async (r, say) => {
    const c = cfgOf(r), items = [];
    say('Building the narration timeline…');
    const nar = await buildNarration(r);
    let words = [], method;
    if (!r.practice && FX.hasAI()) {
      say('Transcribing the approved voiceover…');
      method = 'Whisper transcription of the final voiceover, aligned to the script';
      const tr = await FX.whisper(r, 'captions', nar.buffer);
      const heard = (tr?.words || []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
      const scriptTok = r.script.scenes.flatMap((s) => s.vo.split(/\s+/).filter(Boolean));
      const al = FX.align(scriptTok, heard.map((w) => w.word));
      const map = new Map(al.pairs.map(([i, j]) => [j, i]));
      heard.forEach((w, j) => {
        if (map.has(j)) { const sw = scriptTok[map.get(j)]; if (FX.norm(sw) !== FX.norm(w.word)) items.push(item('low', FX.ts(w.start), `Heard "${w.word}", script says "${sw}"`, 'Caption uses the script spelling.')); words.push({ ...w, word: sw.replace(/[",]/g, '') }); }
        else { words.push(w); items.push(item('low', FX.ts(w.start), `Extra/unknown word "${w.word}"`, 'Check spelling.')); }
      });
      if (al.missing.length) {
        const sev = al.missing.length / scriptTok.length > 0.1 ? 'high' : 'medium';
        items.push(item(sev, 'Narration', `${al.missing.length} script word(s) not heard: ${al.missing.slice(0, 10).map((k) => scriptTok[k]).join(', ')}`, sev === 'high' ? 'Voiceover is missing sentences; regenerate.' : 'Captions follow what is actually spoken.'));
      }
    } else {
      method = r.practice ? 'practice: timing estimated from the script (no transcription)' : null;
      if (!r.practice) return needKey('caption transcription');
      r.script.scenes.forEach((s, i) => { const o = nar.offsets[i]; const w = s.vo.split(/\s+/).filter(Boolean); const per = (o.voiceEnd - o.voiceStart) / Math.max(1, w.length); w.forEach((x, k) => words.push({ word: x, start: o.voiceStart + k * per, end: o.voiceStart + (k + 1) * per })); });
      items.push(item('medium', 'All', 'Caption timing is estimated, not transcribed (practice).', 'Real videos are transcribed from the voiceover.'));
    }
    let cues = wordsToChunks(words).map((k) => ({ start: Math.round(k.start * 100) / 100, end: Math.round(k.until * 100) / 100, text: k.text.replace(/[,;:]$/, '') }));
    // timing: merge cues that flash by too fast
    const merged = [];
    for (const q of cues) { const prev = merged[merged.length - 1]; if (prev && (prev.end - prev.start < 0.3) && q.start - prev.end < 0.15 && prev.text.split(' ').length < 4) { prev.text += ' ' + q.text; prev.end = q.end; } else merged.push({ ...q }); }
    cues = merged;
    const emph = new Set([...r.script.scenes.flatMap((s) => FX.keywords(s.onScreen)), ...FX.keywords(r.idea?.topic)]);
    cues.forEach((q) => { q.hl = q.text.split(' ').map((w) => /\d/.test(w) || emph.has(FX.norm(w))); const cps = q.text.length / Math.max(0.05, q.end - q.start); if (q.end - q.start < 0.25 || cps > 22) items.push(item('medium', FX.ts(q.start), `Caption "${q.text}" on screen ${(q.end - q.start).toFixed(2)}s (${Math.round(cps)} chars/sec) — too fast to read`, 'Slow the voice slightly or shorten the line.')); });
    if (c.captionPos < 0.5 || c.captionPos > 0.76) items.push(item('medium', 'Style', `Caption position ${Math.round(c.captionPos * 100)}% from top is outside the platform-safe zone (50–76%)`, 'Change it in Channel.'));
    if (c.captionSize < 56) items.push(item('medium', 'Style', `Caption size ${c.captionSize}px is small on phones`, 'Use 64px or more.'));
    if (c.captionSize > 110) items.push(item('low', 'Style', `Caption size ${c.captionSize}px may wrap a lot`, 'Use 80–100px.'));
    const srt = cues.map((q, i) => `${i + 1}\n${srtT(q.start)} --> ${srtT(q.end)}\n${q.text}\n`).join('\n');
    const vtt = 'WEBVTT\n\n' + cues.map((q) => `${srtT(q.start).replace(',', '.')} --> ${srtT(q.end).replace(',', '.')}\n${q.text}\n`).join('\n');
    r.captions = { cues, method, style: { color: c.captionColor, highlight: c.highlightColor, pos: c.captionPos, size: c.captionSize }, srtFile: await FX.saveFile(new Blob([srt], { type: 'text/plain' }), r.id + '.srt', { recId: r.id, role: 'captions' }), vttFile: await FX.saveFile(new Blob([vtt], { type: 'text/vtt' }), r.id + '.vtt', { recId: r.id, role: 'captions' }), at: now() };
    r.timeline = nar.offsets.map(({ n, start, end, voiceStart, voiceEnd }) => ({ n, start, end, voiceStart, voiceEnd })); r.duration = nar.duration;
    const v = verdictFrom(items);
    return { verdict: v, sendBackTo: 'voice', summary: v === 'FAIL' ? 'Narration is missing words; sending back to Voiceover.' : `${cues.length} captions timed to the voiceover.`, items, method };
  };
  const srtT = (s) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

  /* ===================================================================
     9. EDITING & EXPORT — saved edit project + real 1080×1920 render with burned-in captions
     =================================================================== */
  function buildProject(r) {
    const c = cfgOf(r), fix = r.editFix || {};
    const scenes = r.script.scenes.map((s, i) => {
      const tl = r.timeline[i], a = (r.assets || []).find((x) => x.scene === s.n);
      return { n: s.n, start: tl.start, end: tl.end, voiceStart: tl.voiceStart, voiceEnd: tl.voiceEnd, onScreen: s.onScreen, transition: i === 0 ? 'cut' : (s.transition || 'cut'), sfx: s.sfx || 'none', motion: i % 2 ? 'out' : 'in', asset: a ? { fileId: a.fileId || null, kind: a.kind, name: a.name } : { kind: 'generated' } };
    });
    return {
      version: (r.editHistory?.length || 0) + 1, at: now(), width: W, height: H, fps: FPS, duration: r.duration,
      scenes, captions: r.captions.cues, captionStyle: r.captions.style,
      audio: { voiceFiles: r.voice.scenes.map((v) => ({ n: v.n, fileId: v.fileId, gainDb: v.gainDb || 0 })), music: c.music ? { kind: 'generated pad', volume: Math.max(0.02, (+c.musicVolume || 0.18) * 10 ** ((fix.musicGainDb || 0) / 20)), duck: 0.4 } : null, sfx: scenes.filter((s) => s.sfx !== 'none' && s.n > 1).map((s) => ({ t: s.start, kind: s.sfx })), masterGainDb: fix.masterGainDb || 0 },
      export: { container: (pickMime() || 'video/webm').split(';')[0], ratio: '9:16', resolution: `${W}x${H}`, fps: FPS, audio: pickMime().includes('mp4a') ? 'AAC' : 'Opus', captions: 'burned in' },
      fixesApplied: fix,
    };
  }

  // ---- audio mix (offline, so it is exact and fast) ----
  function noiseBuf(ac, len) { const b = ac.createBuffer(1, Math.ceil(len * ac.sampleRate), ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
  async function renderStem(project, nar, which) {
    const sr = 48000, ac = new OfflineAudioContext(2, Math.ceil(project.duration * sr), sr);
    if (which === 'voice') {
      nar.buffers.forEach((b, i) => { const s = ac.createBufferSource(); s.buffer = b; const g = ac.createGain(); g.gain.value = nar.offsets[i].gain; s.connect(g).connect(ac.destination); s.start(nar.offsets[i].voiceStart); });
    } else {
      const m = project.audio.music;
      if (m) {
        const bus = ac.createGain(); const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; bus.connect(lp).connect(ac.destination);
        bus.gain.setValueAtTime(0, 0); bus.gain.linearRampToValueAtTime(m.volume, 1.2);
        for (const o of nar.offsets) { bus.gain.setTargetAtTime(m.volume * m.duck, Math.max(1.2, o.voiceStart - 0.1), 0.08); bus.gain.setTargetAtTime(m.volume, o.voiceEnd + 0.05, 0.15); }
        bus.gain.setTargetAtTime(0, Math.max(0, project.duration - 0.8), 0.2);
        const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]];
        for (let t = 0, k = 0; t < project.duration; t += 4, k++) {
          for (const f of chords[k % 4]) for (const det of [-3, 3]) {
            const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.detune.value = det;
            const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.8); g.gain.setValueAtTime(0.06, t + 3.4); g.gain.linearRampToValueAtTime(0, t + 4.2);
            o.connect(g).connect(bus); o.start(t); o.stop(Math.min(project.duration, t + 4.3));
          }
        }
      }
      for (const fx of project.audio.sfx) {
        const t = Math.max(0, fx.t - (fx.kind === 'riser' ? 0.8 : 0.12));
        if (fx.kind === 'pop') { const o = ac.createOscillator(); o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(300, t + 0.09); const g = ac.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.15); continue; }
        const len = fx.kind === 'riser' ? 0.9 : 0.45, s = ac.createBufferSource(); s.buffer = noiseBuf(ac, len);
        const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2; bp.frequency.setValueAtTime(fx.kind === 'riser' ? 300 : 2500, t); bp.frequency.exponentialRampToValueAtTime(fx.kind === 'riser' ? 4000 : 400, t + len);
        const g = ac.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.12, t + len * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        s.connect(bp).connect(g).connect(ac.destination); s.start(t); s.stop(t + len);
      }
    }
    return ac.startRendering();
  }
  async function mixAudio(project, nar) {
    const [voice, bed] = await Promise.all([renderStem(project, nar, 'voice'), renderStem(project, nar, 'bed')]);
    const ac = getAudioCtx(), mix = ac.createBuffer(2, voice.length, voice.sampleRate), mg = 10 ** ((project.audio.masterGainDb || 0) / 20);
    for (let ch = 0; ch < 2; ch++) {
      const a = voice.getChannelData(ch), b = bed.getChannelData(ch), o = mix.getChannelData(ch);
      for (let i = 0; i < o.length; i++) { const x = (a[i] + b[i]) * mg; o[i] = Math.abs(x) > 0.9 ? Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) / 0.1)) : x; } // soft limiter
      const fade = Math.round(0.25 * mix.sampleRate); for (let i = 0; i < fade; i++) o[o.length - 1 - i] *= i / fade;
    }
    return { mix, voice, bed };
  }
  FX.mixAudio = mixAudio;

  // ---- drawing ----
  function drawCue(cue, st, t) {
    const size = st.size || 84, pop = 1 + 0.1 * (1 - Math.min(1, (t - cue.start) / 0.12));
    ctx.save(); ctx.font = `900 ${size}px Impact, "Arial Black", system-ui, sans-serif`; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#000';
    const words = cue.text.toUpperCase().split(' '), lines = [[]]; let lw = 0; const max = W * 0.84, sp = ctx.measureText(' ').width;
    words.forEach((w, i) => { const ww = ctx.measureText(w).width; if (lw + ww > max && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push({ w, ww, hl: cue.hl?.[i] }); lw += ww + sp; });
    const y0 = H * (st.pos || 0.64) - (lines.length - 1) * size * 0.56;
    ctx.translate(W / 2, H * (st.pos || 0.64)); ctx.scale(pop, pop); ctx.translate(-W / 2, -H * (st.pos || 0.64));
    lines.forEach((ln, li) => {
      const total = ln.reduce((a, x) => a + x.ww, 0) + sp * (ln.length - 1); let x = (W - total) / 2; const y = y0 + li * size * 1.12;
      for (const p of ln) { ctx.strokeText(p.w, x, y); ctx.fillStyle = p.hl ? (st.highlight || '#ffd400') : (st.color || '#fff'); ctx.fillText(p.w, x, y); x += p.ww + sp; }
    });
    ctx.restore();
  }
  function drawOnScreen(text, lt) {
    if (!text) return;
    const a = Math.min(1, lt / 0.3); ctx.save(); ctx.globalAlpha = a;
    ctx.font = '800 60px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapText(text.toUpperCase(), W - 220).slice(0, 2), y = H * 0.16 + (1 - a) * -30;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 70, bh = lines.length * 72 + 34;
    ctx.fillStyle = 'rgba(10,8,16,.78)'; ctx.beginPath(); ctx.roundRect?.((W - bw) / 2, y - bh / 2, bw, bh, 28); if (!ctx.roundRect) ctx.rect((W - bw) / 2, y - bh / 2, bw, bh); ctx.fill();
    ctx.fillStyle = '#fff'; lines.forEach((l, i) => ctx.fillText(l, W / 2, y + (i - (lines.length - 1) / 2) * 72));
    ctx.restore();
  }
  function drawScene(p, i, t, v) {
    const sc = p.scenes[i], lt = t - sc.start, sd = Math.max(0.1, sc.end - sc.start), pr = Math.min(1, Math.max(0, lt / sd));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    let zoom = 1.04 + 0.1 * (sc.motion === 'in' ? pr : 1 - pr);
    if (sc.transition === 'zoom' && lt < 0.35) zoom += (0.35 - lt) * 0.9;
    const src = v?.kind === 'video' ? (v.el.videoWidth ? v.el : null) : v?.kind === 'image' ? v.el : null;
    if (src) {
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height, [, , cw, ch] = coverRect(sw, sh, 0, 0, W, H);
      const w = cw * zoom, h = ch * zoom, pan = (sc.motion === 'in' ? 1 : -1) * (pr - 0.5) * Math.max(0, w - W) * 0.5;
      ctx.drawImage(src, (W - w) / 2 + pan, (H - h) / 2, w, h);
    } else drawAnimatedBg(t + i * 2.3);
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(0.3, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    drawOnScreen(sc.onScreen, lt);
    const cue = p.captions.find((q) => t >= q.start && t < q.end); if (cue) drawCue(cue, p.captionStyle, t);
    if (i > 0 && lt < 0.25) { const a = 1 - lt / 0.25; if (sc.transition === 'fade') { ctx.fillStyle = `rgba(0,0,0,${a * 0.85})`; ctx.fillRect(0, 0, W, H); } else if (sc.transition === 'flash') { ctx.fillStyle = `rgba(255,255,255,${a * 0.7})`; ctx.fillRect(0, 0, W, H); } }
    if (t > p.duration - 0.4) { ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, (t - (p.duration - 0.4)) / 0.4)})`; ctx.fillRect(0, 0, W, H); }
  }
  FX.drawScene = drawScene; FX.drawCue = drawCue; FX.drawOnScreen = drawOnScreen; FX.srtT = (x) => srtT(x);

  async function loadVisuals(p) {
    const vis = [];
    for (const sc of p.scenes) {
      let v = { kind: 'generated' };
      const blob = sc.asset?.fileId ? await FX.getFile(sc.asset.fileId) : null;
      if (blob && (blob.type.startsWith('video') || sc.asset.kind === 'video')) {
        const el = document.createElement('video'); el.muted = true; el.loop = true; el.playsInline = true; el.src = URL.createObjectURL(blob);
        await new Promise((res) => { el.onloadeddata = res; el.onerror = res; setTimeout(res, 10000); });
        if (el.videoWidth) v = { kind: 'video', el };
      } else if (blob) { try { v = { kind: 'image', el: await createImageBitmap(blob) }; } catch {} }
      vis.push(v);
    }
    return vis;
  }
  async function renderVideo(p, mix, say) {
    const ac = getAudioCtx(); await ac.resume();
    if (ac.state !== 'running') throw new FX.TempError('The browser paused audio. Click anywhere on the page so the line can render.');
    const vis = await loadVisuals(p);
    const dest = ac.createMediaStreamDestination(), src = ac.createBufferSource(); src.buffer = mix; src.connect(dest);
    drawScene(p, 0, 0, vis[0]);
    const rec = startRecorder(dest.stream);
    const startAt = ac.currentTime + 0.12; src.start(startAt);
    let cur = -1, lastT = -1, stuck = 0, lastPct = -1;
    await renderLoop(() => {
      const t = Math.max(0, ac.currentTime - startAt);
      let i = p.scenes.findIndex((s) => t >= s.start && t < s.end); if (i < 0) i = p.scenes.length - 1;
      if (i !== cur) { if (vis[cur]?.kind === 'video') vis[cur].el.pause(); cur = i; if (vis[i].kind === 'video') vis[i].el.play().catch(() => {}); }
      drawScene(p, i, t, vis[i]);
      const pct = Math.floor((t / p.duration) * 20); if (pct !== lastPct) { lastPct = pct; say(`Rendering ${Math.min(100, pct * 5)}% (real-time, ${Math.round(p.duration)}s)…`); }
      stuck = t === lastT ? stuck + 1 : 0; lastT = t;
      if (stuck > FPS * 6) throw new FX.TempError('Audio clock stopped while rendering (tab audio blocked?)');
      return t >= p.duration;
    });
    vis.forEach((v) => { if (v.kind === 'video') { v.el.pause(); URL.revokeObjectURL(v.el.src); } else v.el?.close?.(); });
    return rec.stop();
  }

  R.edit = async (r, say) => {
    say('Building the editing timeline…');
    if (r.edit) r.editHistory.push({ version: r.edit.version, at: r.edit.at, fixesApplied: r.edit.fixesApplied });
    const p = buildProject(r);
    say('Mixing narration, music and sound effects…');
    const nar = await buildNarration(r);
    const { mix } = await mixAudio(p, nar);
    const blob = await exclusive(() => renderVideo(p, mix, say));
    const items = [];
    if (!blob || blob.size < 10000) return { verdict: 'FAIL', sendBackTo: 'edit', summary: 'Export produced an empty file.', items: [item('high', 'Export', 'Empty or tiny file')] };
    const container = blob.type.includes('mp4') ? 'MP4' : 'WebM';
    if (container !== 'MP4') items.push(item('medium', 'Export', 'This browser exported WebM, not MP4.', 'Use a recent Chrome or Edge for MP4/AAC. Most platforms still accept WebM.'));
    const fileId = await FX.saveFile(blob, `${r.id}.${container.toLowerCase()}`, { recId: r.id, role: 'export' });
    const projFile = await FX.saveFile(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${r.id}_edit_v${p.version}.json`, { recId: r.id, role: 'edit-project' });
    r.edit = { ...p, projectFile: projFile };
    r.export = { fileId, size: blob.size, mime: blob.type, container, width: W, height: H, fps: FPS, duration: p.duration, audio: blob.type.includes('mp4') ? 'AAC' : 'Opus', captions: 'embedded', at: now(), editVersion: p.version };
    r.editFix = null;
    return { verdict: verdictFrom(items), summary: `Exported ${container} 1080×1920 @ ${FPS}fps, ${p.duration.toFixed(1)}s, ${(blob.size / 1e6).toFixed(1)} MB (edit project v${p.version} saved).`, items, data: { fixesApplied: p.fixesApplied } };
  };

  /* ===================================================================
     10. AUDIO QC — inspects the exported file's audio (falls back to the export mix if the browser can't decode it)
     =================================================================== */
  R.audioqc = async (r, say) => {
    say('Decoding the exported audio…');
    const items = []; let buf, method = 'decoded the exported file';
    try { buf = await FX.decode(await FX.getFile(r.export.fileId)); } catch { method = 'browser could not decode the export; analyzed the exact mix used for it'; }
    const nar = await buildNarration(r);
    const { mix, voice, bed } = await mixAudio(r.edit, nar);
    if (!buf) { buf = mix; items.push(item('low', 'Method', 'Exported audio could not be decoded here; the identical pre-export mix was analyzed.', '')); }
    const d = buf.getChannelData(0), sr = buf.sampleRate; let clips = 0, firstClip = null;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.995) { clips++; if (firstClip == null) firstClip = i / sr; }
    if (clips > 30) items.push(item('high', FX.ts(firstClip), `Clipping/distortion: ${clips} clipped samples`, 'Lower master gain by 3 dB.'));
    const env = FX.envelope(buf, 0.1), quiet = r.practice ? -200 : -50;
    let run = 0;
    env.forEach((db, i) => { if (db < quiet) run++; else { if (run >= 15 && (i - run) * 0.1 > 1 && i * 0.1 < buf.duration - 1) items.push(item('high', FX.ts((i - run) * 0.1), `Unexpected silence for ${(run * 0.1).toFixed(1)}s`, 'Check that the scene narration is placed in the timeline.')); run = 0; } });
    const lead = env.findIndex((x) => x > -45) * 0.1;
    if (!r.practice && lead > 0.8) items.push(item('medium', '00:00.0', `Audio starts ${lead.toFixed(1)}s late`, 'Trim the opening.'));
    const tailDb = FX.db20(FX.rms(d, d.length - Math.round(0.05 * sr)));
    if (tailDb > -30) items.push(item('medium', FX.ts(buf.duration - 0.05), 'Audio ends abruptly (no fade)', 'Add a fade-out.'));
    if (Math.abs(buf.duration - r.edit.duration) > 1.2) items.push(item('high', 'Sync', `Audio length ${buf.duration.toFixed(1)}s vs timeline ${r.edit.duration.toFixed(1)}s`, 'Re-export; audio and video are out of sync.'));
    // narration must stay understandable over music: voice ≥ 10 dB above the bed while speaking
    let worst = null;
    if (!r.practice && r.edit.audio.music) {
      const vEnv = FX.envelope(voice, 0.5), bEnv = FX.envelope(bed, 0.5);
      vEnv.forEach((vdb, i) => { if (vdb > -40) { const gap = vdb - bEnv[i]; if (!worst || gap < worst.gap) worst = { gap, t: i * 0.5 }; } });
      if (worst && worst.gap < 10) items.push(item(worst.gap < 6 ? 'high' : 'medium', FX.ts(worst.t), `Music only ${worst.gap.toFixed(1)} dB under the narration`, `Lower music by ${Math.ceil(12 - worst.gap)} dB.`));
    }
    // scene-to-scene loudness
    const sceneDb = r.edit.scenes.map((s) => FX.db20(FX.rms(d, Math.round(s.voiceStart * sr), Math.round(s.voiceEnd * sr))));
    const med = [...sceneDb].sort((a, b) => a - b)[Math.floor(sceneDb.length / 2)];
    if (!r.practice) sceneDb.forEach((x, i) => { if (Math.abs(x - med) > 6) items.push(item('medium', `Scene ${i + 1} @ ${FX.ts(r.edit.scenes[i].voiceStart)}`, `Loudness differs by ${Math.abs(x - med).toFixed(1)} dB from the rest`, 'Normalize scene gain.')); });
    if (r.practice) items.push(item('medium', 'All', 'Practice record has silent narration, so speech checks were skipped.', ''));
    const v = verdictFrom(items);
    if (v === 'FAIL') {
      r.editFix = { ...(r.editFix || {}) };
      if (worst && worst.gap < 6) r.editFix.musicGainDb = (r.edit.fixesApplied?.musicGainDb || 0) - Math.ceil(12 - worst.gap);
      if (clips > 30) r.editFix.masterGainDb = (r.edit.fixesApplied?.masterGainDb || 0) - 3;
    }
    return { verdict: v, sendBackTo: 'edit', summary: v === 'FAIL' ? 'Sent back to Editing with exact timestamps and fixes.' : `Audio approved (${method}).`, items, method, data: { clips, worstVoiceOverMusicDb: worst ? Math.round(worst.gap * 10) / 10 : null, sceneDb: sceneDb.map((x) => Math.round(x * 10) / 10) } };
  };

  /* ===================================================================
     11. VISUAL QC — watches the actual exported file, start to finish
     =================================================================== */
  async function sampleVideo(blob, p, every = 0.25) {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Exported video will not play in this browser')); setTimeout(res, 15000); });
    const c = document.createElement('canvas'); c.width = 36; c.height = 64; const g = c.getContext('2d', { willReadFrequently: true });
    const tc = document.createElement('canvas'); tc.width = 135; tc.height = 240; const tg = tc.getContext('2d');
    const cover = document.createElement('canvas'); cover.width = 540; cover.height = 960;
    const samples = [], thumbs = {}; let prev = null, lastT = -1, coverBlob = null;
    const mids = p.scenes.map((s) => (s.start + s.end) / 2);
    const grab = () => {
      const t = v.currentTime; if (t - lastT < every * 0.8 && lastT >= 0) return; lastT = t;
      g.drawImage(v, 0, 0, 36, 64); const px = g.getImageData(0, 0, 36, 64).data; let l = 0, diff = 0; const cur = new Uint8Array(36 * 64);
      for (let i = 0, k = 0; i < px.length; i += 4, k++) { cur[k] = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0; l += cur[k]; if (prev) diff += Math.abs(cur[k] - prev[k]); }
      samples.push({ t, luma: l / cur.length, diff: prev ? diff / cur.length : 99 }); prev = cur;
      mids.forEach((m, i) => { if (!thumbs[i] && t >= m) { tg.drawImage(v, 0, 0, 135, 240); thumbs[i] = tc.toDataURL('image/jpeg', 0.6); } });
      if (!coverBlob && t >= 1.2) { cover.getContext('2d').drawImage(v, 0, 0, 540, 960); coverBlob = 'pending'; cover.toBlob((b) => (coverBlob = b), 'image/jpeg', 0.85); }
    };
    v.playbackRate = 4;
    await v.play().catch(() => {});
    await new Promise((res) => {
      const iv = setInterval(grab, 40);
      if (v.requestVideoFrameCallback) { const cb = () => { grab(); if (!v.ended) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
      const done = () => { clearInterval(iv); res(); };
      v.onended = done; setTimeout(done, (p.duration / 4 + 25) * 1000);
    });
    await sleep(200);
    const out = { width: v.videoWidth, height: v.videoHeight, duration: isFinite(v.duration) ? v.duration : lastT, lastT, samples, thumbs, cover: coverBlob instanceof Blob ? coverBlob : null };
    v.pause(); URL.revokeObjectURL(v.src);
    return out;
  }

  R.visualqc = async (r, say) => {
    say('Watching the exported video (4× speed)…');
    const p = r.edit, s = await sampleVideo(await FX.getFile(r.export.fileId), p);
    const items = [];
    if (s.width !== W || s.height !== H) items.push(item('high', 'Format', `Video is ${s.width}×${s.height}, expected 1080×1920 (9:16)`, 'Re-export at 1080×1920.'));
    if (Math.abs(s.lastT - p.duration) > 1.5 && s.samples.length) items.push(item(s.lastT < p.duration - 3 ? 'high' : 'medium', 'Length', `Playback ended at ${s.lastT.toFixed(1)}s, timeline is ${p.duration.toFixed(1)}s`, 'Re-export; scenes may be missing.'));
    const inFade = (t) => p.scenes.some((sc) => sc.transition === 'fade' && t >= sc.start && t < sc.start + 0.3) || t > p.duration - 0.5;
    let run = []; const flush = (kind) => { if (run.length) { const a = run[0].t, b = run[run.length - 1].t; if (kind === 'black' && b - a >= 0.4) items.push(item('high', `${FX.ts(a)}–${FX.ts(b)}`, `Black screen for ${(b - a).toFixed(1)}s`, 'Check the scene asset; it may have failed to load.')); if (kind === 'frozen' && b - a >= 2.5) items.push(item(b - a >= 4 ? 'high' : 'medium', `${FX.ts(a)}–${FX.ts(b)}`, `Frozen picture for ${(b - a).toFixed(1)}s`, 'Use footage with motion or add movement.')); } run = []; };
    s.samples.forEach((x) => { if (x.luma < 10 && !inFade(x.t)) run.push(x); else flush('black'); }); flush('black');
    s.samples.forEach((x) => { if (x.diff < 0.35) run.push(x); else flush('frozen'); }); flush('frozen');
    const first = s.samples.filter((x) => x.t < 1), last = s.samples.filter((x) => x.t > p.duration - 1.5 && x.t < p.duration - 0.5);
    if (first.length && first.every((x) => x.luma < 10)) items.push(item('high', '00:00', 'Opening second is black', 'Fix the first scene.'));
    if (last.length && last.every((x) => x.luma < 10)) items.push(item('medium', FX.ts(p.duration - 1.5), 'Final seconds are black before the fade', 'Fix the last scene.'));
    p.scenes.forEach((sc, i) => {
      const ss = s.samples.filter((x) => x.t >= sc.start && x.t < sc.end);
      if (!ss.length) items.push(item('high', `Scene ${sc.n}`, 'No frames found for this scene', 'Scene missing from the export.'));
      if (i > 0 && sc.start < p.scenes[i - 1].start) items.push(item('high', `Scene ${sc.n}`, 'Scene order is wrong in the timeline', 'Rebuild timeline.'));
    });
    for (const a of (r.assets || []).filter((x) => x.scene && x.width && x.height)) {
      const ratio = a.width / a.height; if (ratio > 1.2) items.push(item('low', `Scene ${a.scene}`, `Landscape source (${a.width}×${a.height}) is cropped to vertical; only ~${Math.round((0.5625 / ratio) * 100)}% of the width shows`, 'Prefer portrait footage.'));
    }
    let method = 'frame sampling (black, frozen, missing scenes, format, length)';
    if (!r.practice && FX.hasAI() && Object.keys(s.thumbs).length) {
      say('Checking that visuals match the narration…');
      method += ' + AI look at one frame per scene';
      const idx = Object.keys(s.thumbs).map(Number).slice(0, 8);
      const out = await FX.ai(r, 'visualqc', 'You inspect frames from a vertical short video. Be practical; generic stock visuals that loosely fit are fine.',
        `For each frame (in order) say whether the visual reasonably fits the narration, and flag anything inappropriate for YouTube/TikTok/Instagram (nudity, gore, hateful symbols, real logos/watermarks, recognisable private people) or visibly broken (stretched, glitchy, unreadable caption). Narration per frame:\n${idx.map((i, k) => `Frame ${k + 1} (scene ${i + 1}): ${r.script.scenes[i]?.vo}`).join('\n')}\nReturn JSON {"frames":[{"frame": number, "fits": boolean, "inappropriate": boolean, "broken": boolean, "note": string}]}`,
        { images: idx.map((i) => s.thumbs[i]), temperature: 0.1 });
      (out?.frames || []).forEach((f) => {
        const sc = idx[f.frame - 1] + 1;
        if (f.inappropriate) items.push(item('high', `Scene ${sc}`, 'Possibly inappropriate visual: ' + f.note, 'Replace the asset.'));
        else if (f.broken) items.push(item('medium', `Scene ${sc}`, 'Visual problem: ' + f.note, 'Re-export or replace the asset.'));
        else if (!f.fits) items.push(item('low', `Scene ${sc}`, 'Visual does not match narration well: ' + f.note, 'Consider a better asset.'));
      });
    }
    if (s.cover) r.coverFile = await FX.saveFile(s.cover, r.id + '_cover.jpg', { recId: r.id, role: 'cover' });
    const v = verdictFrom(items), inapp = items.some((i) => /inappropriate/i.test(i.issue));
    if (v === 'FAIL') (r.assets || []).forEach((a) => { if (items.some((i) => i.sev === 'high' && i.where.startsWith('Scene ' + a.scene))) a.redo = true; });
    const sendBackTo = items.some((i) => i.sev === 'high' && /Scene \d/.test(i.where) && /asset|inappropriate/i.test(i.issue + i.fix)) ? 'assets' : 'edit';
    return { verdict: inapp ? 'HUMAN_REVIEW' : v, sendBackTo, summary: inapp ? 'A frame may be inappropriate; a person should look.' : v === 'FAIL' ? `Sent back to ${FX.dept(sendBackTo).name} with timestamps.` : `Watched all ${s.lastT.toFixed(1)}s (${s.samples.length} frames sampled).`, items, method, data: { frames: s.thumbs, samples: s.samples.length, width: s.width, height: s.height } };
  };

  /* ===================================================================
     12. COPYRIGHT & IP — documentation review, not a legal guarantee
     =================================================================== */
  const DISCLAIMER_CR = 'This is an internal documentation check. It cannot guarantee a video is copyright-safe; some rights questions need a person (or a lawyer).';
  R.copyright = async (r, say) => {
    say('Checking every asset\'s license record…');
    const items = [], rows = [];
    for (const a of r.assets || []) {
      const chk = FX.checkLicense(a); rows.push({ name: a.name, scene: a.scene, source: a.source, license: a.license, commercial: a.commercial, attribution: a.attribution, status: chk.status, reason: chk.reason, licenseUrl: a.licenseUrl, pageUrl: a.pageUrl });
      if (chk.status === 'rejected') items.push(item('high', `${a.scene ? 'Scene ' + a.scene : 'Audio'} · ${a.name}`, chk.reason, 'Replace the asset.'));
      if (chk.status === 'manual_review' && !r.overrides?.['asset:' + a.id]) items.push(item('review', `${a.scene ? 'Scene ' + a.scene : 'Audio'} · ${a.name}`, chk.reason, 'A person must confirm the rights.'));
    }
    r.attributions = (r.assets || []).filter((a) => a.attribution === 'required' && a.attributionText).map((a) => a.attributionText + (a.licenseUrl ? ` (${a.licenseUrl})` : ''));
    if (r.attributions.length) items.push(item('low', 'Attribution', `${r.attributions.length} asset(s) need credit; it will be added to every description.`, ''));
    if (!r.practice && FX.hasAI()) {
      const out = await FX.ai(r, 'copyright', 'You flag possible third-party intellectual property in a short video script. Mentioning a name or a fact is fine. Flag quoted song lyrics, long quotes from books/films, catchphrases, characters, or brand logos/footage requested in visuals.',
        `Script and visual instructions:\n${r.script.scenes.map((s) => `Scene ${s.n}: VO "${s.vo}" | ON-SCREEN "${s.onScreen}" | VISUAL "${s.footage?.query}"`).join('\n')}\nReturn JSON {"flags":[{"scene": number, "what": string, "risk": "low"|"medium"|"high", "fix": string}]}`, { temperature: 0.1 });
      (out?.flags || []).forEach((f) => items.push(item(f.risk === 'high' ? 'review' : f.risk === 'medium' ? 'medium' : 'low', `Scene ${f.scene}`, 'Third-party material: ' + f.what, f.fix)));
    }
    const review = items.some((i) => i.sev === 'review'), high = items.some((i) => i.sev === 'high');
    items.forEach((i) => { if (i.sev === 'review') i.sev = 'high'; });
    return { verdict: high && !review ? 'FAIL' : review ? 'HUMAN_REVIEW' : verdictFrom(items), sendBackTo: 'assets', summary: review ? 'Some rights are unclear. Publishing is stopped until a person resolves them.' : high ? 'An asset failed the rights check; sending back to Asset Production.' : `${rows.length} asset(s) documented with licenses.`, items, disclaimer: DISCLAIMER_CR, data: { rows } };
  };

  /* ===================================================================
     13. COMMUNITY GUIDELINES — one stored checklist per platform
     =================================================================== */
  const DISCLAIMER_POL = 'Internal policy review against our own checklist summaries. Platforms make the final decision and their rules change; this is not a guarantee of approval.';
  R.guidelines = async (r, say) => {
    const c = cfgOf(r), plats = (c.platforms || []).length ? c.platforms : ['youtube'];
    const text = `${allVO(r)} ${r.script.scenes.map((s) => s.onScreen).join(' ')} ${r.script.title || ''}`.toLowerCase();
    const items = [], per = {};
    r.disclosures = { aiVoice: r.type === 'clips' ? !!r.clip?.intro : !r.practice, aiImagery: (r.assets || []).some((a) => a.aiGenerated && a.kind === 'image'), containsSyntheticMedia: (r.type === 'clips' ? !!r.clip?.intro : !r.practice) || (r.assets || []).some((a) => a.aiGenerated && a.kind === 'image'), madeForKids: false };
    let ai = null;
    if (!r.practice && FX.hasAI()) {
      say('Reviewing narration, on-screen text and visuals against each platform\'s checklist…');
      const frames = r.reports.visualqc?.items?.filter((i) => /Scene/.test(i.where)).map((i) => i.issue).join('; ');
      const clipsCtx = r.type === 'clips';
      const said = clipsCtx ? r.script.scenes.filter((s) => s.streamAudio).map((s) => s.vo).join(' ') : '';
      const intro = clipsCtx ? r.script.scenes.filter((s) => !s.streamAudio).map((s) => s.vo).join(' ') : '';
      ai = await FX.ai(r, 'guidelines', 'You are a trust-and-safety reviewer for short videos. Judge ONLY against the checklist given for each platform. Do not invent violations. Video-game violence (shooting, car chases, police chases in GTA) is fictional gameplay and allowed; real-world threats, slurs, hate, sexual content, doxxing, harassment of real people and gambling promotion are not.',
        (clipsCtx
          ? `This is a clip of a live stream of ${FX.channel().game || 'a video game'}.\nWHAT THE STREAMER/PLAYERS SAY (stream transcript): ${said}\nAI COMMENTARY INTRO (our AI voice): ${intro || '(none)'}\nON-SCREEN HOOK: ${r.script.scenes.map((s) => s.onScreen).join(' | ')}\nTITLE: ${r.script.title || ''}${frames ? `\nVISUAL QC NOTES: ${frames}` : ''}\nDISCLOSURE FACTS: AI voice intro: ${!!intro}\n\n`
          : `NARRATION: ${allVO(r)}\nON-SCREEN TEXT: ${r.script.scenes.map((s) => s.onScreen).join(' | ')}\nVISUALS: ${r.script.scenes.map((s) => s.footage?.query).join(' | ')}${frames ? `\nVISUAL QC NOTES: ${frames}` : ''}\nDISCLOSURE FACTS: narration is an AI voice; AI images used: ${r.disclosures.aiImagery}\n\n`) +
        plats.map((p) => { const pol = FX.policy(p); return `PLATFORM ${p} checklist:\n${pol.rules.map((x) => `- [${x.id}] (${x.severity}) ${x.text}`).join('\n') || '- (no checklist stored)'}`; }).join('\n\n') +
        `\n\nReturn JSON {"platforms": {"<platform>": {"status": "ok"|"review"|"violation", "findings": [{"rule": id, "where": string, "issue": string, "fix": string}], "disclosures": [required disclosures/labels]}}}`, { temperature: 0.1 });
    }
    for (const p of plats) {
      const pol = FX.policy(p), out = { status: 'ok', items: [], disclosures: [], policyVersion: pol.version, reviewedAt: pol.reviewedAt };
      for (const rule of pol.rules) for (const k of rule.keywords || []) if (FX.hasPhrase(text, k)) out.items.push(item(rule.severity === 'block' ? 'high' : 'medium', `${pol.name} · ${rule.id}`, `Matches "${k}" — ${rule.text}`, 'Rephrase or remove.'));
      const a = ai?.platforms?.[p];
      (a?.findings || []).forEach((f) => { const rule = pol.rules.find((x) => x.id === f.rule); out.items.push(item(a.status === 'violation' && rule?.severity === 'block' ? 'high' : 'medium', `${pol.name} · ${f.rule || ''} · ${f.where || ''}`, f.issue, f.fix || '')); });
      out.disclosures = [...new Set([...(a?.disclosures || []), ...(r.disclosures.containsSyntheticMedia ? ['AI-generated / synthetic content label'] : [])])];
      if (!pol.rules.length) out.items.push(item('medium', pol.name, 'No policy checklist stored for this platform', 'Add one in Policies before publishing here.'));
      if (FX.policyStale(pol)) out.items.push(item('medium', pol.name, pol.reviewedAt ? `Checklist last reviewed ${new Date(pol.reviewedAt).toLocaleDateString()} (over 30 days)` : 'You have not reviewed this checklist against the official rules yet', 'Open Policies, re-read the official links, then mark it reviewed.'));
      out.status = out.items.some((i) => i.sev === 'high') ? 'violation' : out.items.some((i) => i.sev === 'medium') ? 'review' : 'ok';
      per[p] = out; items.push(...out.items);
    }
    if (r.practice) items.push(item('medium', 'Method', 'Practice record: only keyword checks ran (no AI review).', ''));
    const serious = items.some((i) => i.sev === 'high');
    return { verdict: serious ? 'HUMAN_REVIEW' : verdictFrom(items), summary: serious ? 'Possible serious policy issue. A person must decide.' : `Reviewed against ${plats.length} platform checklist(s).`, items, disclaimer: DISCLAIMER_POL, data: { platforms: per, disclosures: r.disclosures }, method: ai ? 'keyword rules + AI review per platform' : 'keyword rules' };
  };

  /* ===================================================================
     14. MONETIZATION PROTECTION — channel-level repetition + per-video risk
     =================================================================== */
  const DISCLAIMER_MON = 'Risk estimate only. YouTube reviews monetization at the channel level and passing this check does not guarantee YouTube Partner Program acceptance or full ad eligibility. The same applies to TikTok and Instagram programs.';
  R.monetization = async (r, say) => {
    say('Comparing with every previous video…');
    const c = cfgOf(r), items = [], all = (await FX.db.prod.all()).filter((o) => o.id !== r.id && o.script);
    const recent = all.sort((a, b) => b.created - a.created).slice(0, 10);
    let score = 0;
    const sims = await similarScripts(r), top = sims[0];
    if (top?.sim >= 0.3) { score += 3; items.push(item('high', 'Repetition', `Script ${Math.round(top.sim * 100)}% similar to ${top.id}`, 'Rewrite with a different structure.')); }
    else if (top?.sim >= 0.15) { score += 1; items.push(item('medium', 'Repetition', `Script ${Math.round(top.sim * 100)}% similar to ${top.id}`, 'Vary phrasing and structure.')); }
    const open = FX.words(r.script.scenes[0].vo).slice(0, 4).join(' ');
    const sameOpen = recent.filter((o) => FX.words(o.script.scenes[0]?.vo).slice(0, 4).join(' ') === open);
    if (sameOpen.length) { score += 2; items.push(item('medium', 'Hook', `Same opening words as ${sameOpen.map((o) => o.id).join(', ')}: "${open}…"`, 'Write a fresh opening line.')); }
    const sig = (o) => `${o.script.hookStyle}|${o.script.format}|${o.script.scenes.length}`;
    const sameSig = recent.filter((o) => sig(o) === sig(r)).length;
    if (recent.length >= 5 && sameSig / recent.length >= 0.6) { score += 2; items.push(item('medium', 'Format', `${sameSig} of the last ${recent.length} videos use the same structure (${sig(r)})`, 'Rotate formats (story, myth vs fact, countdown…).')); }
    const used = new Set(recent.flatMap((o) => (o.assets || []).map((a) => a.libraryId || a.ext).filter(Boolean)));
    const reused = (r.assets || []).filter((a) => (a.libraryId || a.ext) && used.has(a.libraryId || a.ext));
    if (reused.length) { score += Math.min(2, reused.length); items.push(item('medium', 'Reused material', `${reused.length} asset(s) also used in the last 10 videos`, 'Use fresh footage.')); }
    const day = all.filter((o) => o.created > now() - 864e5).length + 1;
    if (day > (+c.maxPerDay || 6)) { score += 2; items.push(item('medium', 'Cadence', `${day} videos produced in 24 hours (your limit is ${c.maxPerDay})`, 'Slow down; mass-produced patterns hurt channel-level review.')); }
    const orig = r.idea?.originality?.score ?? 5;
    if (orig < 5) { score += 2; items.push(item('medium', 'Originality', `Idea originality ${orig}/10`, 'Add a distinct angle or commentary.')); }
    if (!r.practice) { score += 1; items.push(item('low', 'Automation', 'AI voice + stock/AI visuals. Allowed, but channels made only of templated AI narration risk "inauthentic/repetitive content" review.', 'Mix in your own voice, commentary or original visuals sometimes.')); }
    if (r.reports.guidelines?.verdict === 'WARNING') score += 1;
    let ai = null;
    if (!r.practice && FX.hasAI()) {
      ai = await FX.ai(r, 'monetization', 'You estimate advertiser-friendliness (YouTube advertiser-friendly content guidelines style) and value-added originality for a short video. Be calibrated, not alarmist.',
        `Title: ${r.script.title}\nScript: ${allVO(r)}\nReturn JSON {"advertiserFriendly": "yes"|"limited"|"no", "reasons": [strings], "valueAdded": 1-10, "notes": string}`, { temperature: 0.1 });
      if (ai?.advertiserFriendly === 'limited') { score += 2; items.push(item('medium', 'Advertisers', 'May get limited ads: ' + (ai.reasons || []).join('; '), 'Soften sensitive wording, especially early on.')); }
      if (ai?.advertiserFriendly === 'no') { score += 4; items.push(item('high', 'Advertisers', 'Likely not advertiser-friendly: ' + (ai.reasons || []).join('; '), 'Rework the topic or wording.')); }
      if ((ai?.valueAdded ?? 10) < 5) { score += 1; items.push(item('medium', 'Value added', `Low value-added score ${ai.valueAdded}/10: ${ai.notes}`, 'Add explanation, context or a clear takeaway.')); }
    }
    const disclose = r.disclosures?.containsSyntheticMedia ? ['Mark "altered or synthetic content" on YouTube', 'Turn on TikTok AI-generated label', 'Use Instagram "AI info" label'] : [];
    const level = score >= 6 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';
    const published = all.filter((o) => o.publish).length;
    r.monetization = { level, score, disclose, at: now(), channel: { videos: all.length + 1, published, last24h: day } };
    return { verdict: level === 'HIGH' ? 'HUMAN_REVIEW' : level === 'MEDIUM' ? 'WARNING' : 'PASS', summary: `Monetization risk: ${level} (score ${score}).`, items, disclaimer: DISCLAIMER_MON, data: { level, score, disclose, similar: sims.slice(0, 3), ai } };
  };

  /* ===================================================================
     15. FINAL QC — combines every report; never lets unresolved problems through automatically
     =================================================================== */
  const REQUIRED = { factcheck: 'Research approval', scriptqc: 'Script approval', voice: 'Voiceover approval', assets: 'Asset licensing approval', captions: 'Caption approval', edit: 'Export verification', audioqc: 'Audio approval', visualqc: 'Visual approval', copyright: 'Copyright approval', guidelines: 'Community Guidelines approval', monetization: 'Monetization review' };
  FX.REQUIRED = REQUIRED;
  R.finalqc = async (r) => {
    const rows = [], items = [];
    for (const [k, label] of Object.entries(REQUIRED)) {
      const rep = r.reports[k], ov = r.overrides?.[k];
      const v = ov ? 'APPROVED BY HUMAN' : rep?.verdict || 'MISSING';
      rows.push({ key: k, label, verdict: v });
      if (!rep && !ov) items.push(item('high', label, 'Report missing — department did not run', 'Run it.'));
      else if (!ov && rep.verdict === 'FAIL') items.push(item('high', label, rep.summary, 'Department must fix it.'));
      else if (!ov && rep.verdict === 'HUMAN_REVIEW') items.push(item('review', label, rep.summary, 'Needs a human decision.'));
      else if (rep?.verdict === 'WARNING' || ov) items.push(item('low', label, ov ? `Overridden by you: ${ov.note || ''}` : rep.summary, 'Non-blocking, documented.'));
    }
    if (!r.export?.fileId) items.push(item('high', 'Export verification', 'No exported video file', 'Re-run Editing.'));
    if (r.practice) items.push(item('low', 'Practice', 'Practice record: publishing is locked.', 'Add an OpenAI key and start a real video.'));
    const prodKeys = ['scriptqc', 'voice', 'captions', 'edit', 'audioqc', 'visualqc'], polKeys = ['copyright', 'guidelines', 'assets'];
    const grp = (keys) => { const v = keys.map((k) => r.overrides?.[k] ? 'WARNING' : r.reports[k]?.verdict || 'MISSING'); return v.some((x) => x === 'FAIL' || x === 'MISSING') ? 'FAILED' : v.some((x) => x === 'HUMAN_REVIEW') ? 'NEEDS HUMAN' : v.some((x) => x === 'WARNING') ? 'PASSED WITH WARNINGS' : 'PASSED'; };
    const approvals = { production: grp(prodKeys), policy: grp(polKeys), monetization: r.monetization?.level || 'UNKNOWN' };
    const missing = rows.find((x) => x.verdict === 'MISSING'), failed = rows.find((x) => x.verdict === 'FAIL');
    let decision, verdict, sendBackTo;
    const seriousPolicy = r.reports.guidelines?.verdict === 'HUMAN_REVIEW' && !r.overrides?.guidelines;
    const unclearRights = r.reports.copyright?.verdict === 'HUMAN_REVIEW' && !r.overrides?.copyright;
    if (missing || failed) { decision = 'NEEDS REVISION'; verdict = 'FAIL'; sendBackTo = (missing || failed).key; }
    else if (unclearRights || seriousPolicy || items.some((i) => i.sev === 'review')) { decision = 'HUMAN REVIEW'; verdict = 'HUMAN_REVIEW'; }
    else if (items.some((i) => i.sev === 'low' || i.sev === 'medium')) { decision = 'APPROVED WITH WARNING'; verdict = 'WARNING'; }
    else { decision = 'APPROVED'; verdict = 'PASS'; }
    items.forEach((i) => { if (i.sev === 'review') i.sev = 'high'; });
    r.final = { decision, at: now(), approvals, rows, note: 'Internal approvals only. None of these is a guarantee of platform, copyright or monetization approval.' };
    r.approvals = approvals;
    return { verdict, sendBackTo, summary: `${decision}. Production: ${approvals.production} · Policy: ${approvals.policy} · Monetization risk: ${approvals.monetization}.`, items, disclaimer: r.final.note, data: { rows, approvals } };
  };

  /* ===================================================================
     16. PUBLISHING PREP — different metadata per platform
     =================================================================== */
  const CLICKBAIT = ['guaranteed', '100%', 'you won\'t believe', 'banned', 'exposed', 'shocking truth', 'doctors hate', 'secret they'];
  R.prep = async (r, say) => {
    const c = cfgOf(r), plats = (c.platforms || []).length ? c.platforms : ['youtube'], items = [];
    const credits = (r.attributions || []).length ? `\n\nCredits: ${r.attributions.join(' · ')}` : '';
    const sources = (r.research?.sources || []).length ? `\n\nSources: ${r.research.sources.map((s) => s.url).join(' ')}` : '';
    const aiLine = r.disclosures?.containsSyntheticMedia ? (r.type === 'clips' ? '\n\nIntro voice is AI-generated.' : '\n\nNarration is AI-generated.') : '';
    let meta = {};
    if (!r.practice && FX.hasAI()) {
      say('Writing titles, descriptions and hashtags for each platform…');
      const out = await FX.ai(r, 'prep', `You write honest, platform-native metadata for short videos. Never promise or imply anything the video does not deliver. ${channelBrief(c)}`,
        `Video title idea: ${r.script.title}\nScript: ${allVO(r)}\n${r.type === 'clips' ? `This is a clip from ${FX.channel().streamer || 'a'} stream (${FX.channel().game}). Credit the streamer. Do not claim things that did not happen in the clip.` : `Verified facts: ${confirmedClaims(r).map((x) => x.text).join(' | ')}`}\nPlatforms: ${plats.join(', ')}\n` +
        `Return JSON {"platforms": {"<platform>": {"titles": [3 options, YouTube max 90 chars], "description": string (YouTube: 2-4 sentences; TikTok/Instagram: punchy caption under 150 chars), "hashtags": [5-8 without #], "category": string, "youtubeCategoryId": "27" for Education or other id}}}. Write each platform separately, in its own style.`);
      meta = out?.platforms || {};
    }
    const res = {};
    for (const p of plats) {
      const m = meta[p] || { titles: [r.script.title, `${r.idea.topic}: what most people miss`, `The truth about ${r.idea.topic}`], description: `${r.idea.description}`, hashtags: r.type === 'clips' ? ['gta', 'gtarp', 'gta5', 'gaming', 'streamer', 'clips'].concat(FX.keywords(c.streamer).slice(0, 1)) : FX.keywords(r.idea.topic).slice(0, 4).concat(['facts', 'learnontiktok', 'shorts']), category: r.type === 'clips' ? 'Gaming' : 'Education', youtubeCategoryId: r.type === 'clips' ? '20' : '27' };
      if (r.type === 'clips' && !meta[p]) m.description = `${r.clip?.hook || r.script.title}${c.streamer ? ` — clip from ${c.streamer}'s stream` : ''}`;
      const tags = (m.hashtags || []).map((h) => '#' + String(h).replace(/^#/, '').replace(/\s+/g, ''));
      const title = (m.titles?.[0] || r.script.title).slice(0, p === 'youtube' ? 90 : 150);
      const desc = p === 'youtube' ? `${m.description}${aiLine}${sources}${credits}\n\n${tags.join(' ')}` : `${m.description} ${tags.join(' ')}${aiLine}${credits}`;
      res[p] = { titles: m.titles || [title], title, description: desc.slice(0, p === 'youtube' ? 5000 : 2200), hashtags: tags, category: r.type === 'clips' ? 'Gaming' : (m.category || 'Education'), youtubeCategoryId: r.type === 'clips' ? '20' : (m.youtubeCategoryId || '27'), connected: !!connected[p], disclosures: r.reports.guidelines?.data?.platforms?.[p]?.disclosures || [] };
      const allowed = new Set(r.type === 'clips' ? FX.numbers(allVO(r) + ' ' + (r.idea?.topic || '')) : confirmedClaims(r).flatMap((x) => FX.numbers(x.text)));
      for (const t of [title, m.description]) {
        const bad = FX.numbers(t).filter((n) => +n > 10 && !allowed.has(n)); if (bad.length) items.push(item('high', `${platName(p)} metadata`, `Number ${bad.join(', ')} isn't in the verified facts: "${t}"`, 'Remove or correct it.'));
        const cb = CLICKBAIT.find((w) => String(t).toLowerCase().includes(w)); if (cb) items.push(item('medium', `${platName(p)} metadata`, `Possibly misleading wording "${cb}"`, 'Make it accurate.'));
      }
      if (!connected[p]) items.push(item('medium', platName(p), 'Account not connected; this platform will be skipped.', 'Connect it in Accounts.'));
    }
    if (!r.practice && !FX.hasAI() && r.type !== 'clips') return needKey('metadata');
    const hi = items.filter((i) => i.sev === 'high');
    if (hi.length) for (const p of plats) { res[p].title = res[p].titles.find((t) => !FX.numbers(t).some((n) => +n > 10)) || r.idea.topic; }
    r.publishPrep = { platforms: res, cover: r.coverFile || null, disclosures: r.disclosures, attributions: r.attributions || [], at: now() };
    return { verdict: hi.length ? 'WARNING' : verdictFrom(items), status: 'awaiting_approval', summary: `Metadata ready for ${plats.map(platName).join(', ')}. Waiting for your approval.`, items: hi.length ? items.map((i) => (i.sev === 'high' ? { ...i, sev: 'medium', fix: i.fix + ' (auto-switched to a safe title option)' } : i)) : items };
  };

  /* ===================================================================
     17. HUMAN APPROVAL — the line waits here; nothing goes out before a person says yes
     =================================================================== */
  R.approval = async (r) => {
    if (r.approval?.approved) return { verdict: 'PASS', summary: `Approved by you ${new Date(r.approval.at).toLocaleString()}${r.approval.note ? ': ' + r.approval.note : ''}.`, items: [] };
    const c = FX.channel(), humanCount = ls.get('fx_humanApprovals', 0);
    if (c.autoPublish && humanCount >= 1 && r.final?.decision === 'APPROVED' && !r.practice && !FX.stopped()) {
      r.approval = { approved: true, by: 'auto rule', at: now(), note: 'Clean APPROVED decision; your auto-publish rule allowed it' };
      await FX.audit('auto-approved for publishing', 'Final QC: APPROVED with no warnings', r.id, 'system');
      return { verdict: 'PASS', summary: 'Auto-approved under your rule (clean Final QC, after your first human approval).', items: [] };
    }
    return { verdict: 'WAIT', status: 'awaiting_approval', summary: 'Waiting for your approval in the publishing dashboard.' };
  };
  FX.approve = async (id, { note = '', when = null } = {}) => {
    const r = await FX.db.prod.get(id);
    if (r.practice) throw new Error('Practice records cannot be published.');
    if (FX.stopped()) throw new Error('Emergency stop is on. Release it first.');
    r.approval = { approved: true, by: 'you', at: now(), note, when };
    r.status = 'queued'; FX.hist(r, 'approval', 'approved', note || 'Approved by you');
    ls.set('fx_humanApprovals', ls.get('fx_humanApprovals', 0) + 1);
    await FX.saveRecord(r); await FX.audit('approved for publishing', note, id, 'you');
    return FX.runStage(r, { manual: true }).then((x) => (x.stage === 'publish' ? FX.runStage(x, { manual: true }) : x));
  };

  /* ===================================================================
     18. PUBLISHING — official integrations only (Upload-Post API, YouTube Data API)
     =================================================================== */
  async function uploadPost(r, blob, platforms, when) {
    if (!FX.gatePassed?.has(r.id)) throw new Error('Publish gate: this video has not passed the guideline checks');
    const pp = r.publishPrep.platforms, fd = new FormData(), first = pp[platforms[0]];
    fd.append('user', upProfile());
    platforms.forEach((p) => fd.append('platform[]', p));
    fd.append('title', (pp.tiktok || first).description.slice(0, 2000));
    fd.append('video', new File([blob], `${r.id}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: blob.type }));
    for (const p of platforms) if (pp[p] && p !== 'youtube') fd.append(`${p}_title`, pp[p].description.slice(0, 2200));
    if (pp.youtube) { fd.append('youtube_title', pp.youtube.title + (/#shorts/i.test(pp.youtube.title) ? '' : ' #Shorts')); fd.append('youtube_description', pp.youtube.description); fd.append('categoryId', pp.youtube.youtubeCategoryId || '27'); }
    fd.append('privacyStatus', privateTest() ? 'private' : 'public'); fd.append('privacy_level', val('tiktokPrivacy') || 'PUBLIC_TO_EVERYONE');
    fd.append('async_upload', 'true'); fd.append('external_id', r.id);
    if (r.disclosures?.containsSyntheticMedia) { fd.append('tiktok_is_ai_generated', 'true'); fd.append('is_ai_generated', 'true'); fd.append('containsSyntheticMedia', 'true'); }
    fd.append('selfDeclaredMadeForKids', 'false');
    if (when) { fd.append('scheduled_date', new Date(when).toISOString()); fd.append('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone); }
    FX.use('uploads');
    const idem = `${r.id}-${r.attempts?.publish || 1}`; // same key on retries = Upload-Post won't post twice
    return FX.retry(async () => { try { return await upFetch('/upload', { method: 'POST', body: fd, headers: { 'Idempotency-Key': idem } }); } catch (e) { throw /5\d\d|429|network|fetch/i.test(e.message) ? new FX.TempError(e.message) : e; } }, 'upload');
  }

  R.publish = async (r, say) => {
    if (r.practice) return { verdict: 'WAIT', status: 'practice_done', summary: 'Practice record — the line ends here and nothing is published. Add an OpenAI key and start a real video.' };
    if (FX.stopped()) return { verdict: 'WAIT', status: 'stopped', summary: 'Emergency stop is on; not publishing.' };
    if (!r.approval?.approved) return { verdict: 'FAIL', sendBackTo: 'approval', summary: 'No human approval on record; returning to Human Approval.', items: [] };
    const c = FX.channel(), plats = testModePlatforms((c.platforms || []).filter((p) => connected[p]));
    if (!plats.length) return { verdict: 'BLOCKED', summary: privateTest() ? 'Private test mode (TikTok "Only me") only posts to TikTok and YouTube; neither is connected.' : 'No connected accounts for this channel\'s platforms. Connect them in Accounts; the line will retry.', items: [] };
    const blob = await FX.getFile(r.export.fileId); if (!blob) throw new Error('Exported video file is missing');
    const when = r.approval.when ? Math.max(Date.parse(r.approval.when) || 0, now() + 5 * 60e3) : (val('apAutoPost') ? nextSlot() : null);
    say(`Uploading to ${plats.map(platName).join(', ')}…`);
    const ytDirect = plats.includes('youtube') && connected.youtube?.direct && ytToken();
    const viaUp = plats.filter((p) => !(p === 'youtube' && ytDirect));
    const out = { at: now(), scheduledFor: when || now(), platforms: plats, results: [] };
    const clip = { id: 'fx_' + r.id, prodId: r.id, kind: r.type === 'clips' ? 'clip' : 'faceless', title: r.publishPrep.platforms[plats[0]].title, blob, caption: r.publishPrep.platforms[plats[0]].description, score: null, created: now(), status: 'scheduled', scheduledFor: when || now() };
    if (viaUp.length) {
      const j = await uploadPost(r, blob, viaUp, when);
      out.requestId = j.request_id || null; out.jobId = j.job_id || null; clip.requestId = out.requestId; clip.jobId = out.jobId;
      out.results.push(`Upload-Post (${viaUp.join(', ')}): ${j.request_id || j.job_id || 'accepted'}`);
      FX.cost(r, 'publish', 'upload-post', viaUp.length, FX.prices().upload_post_each * viaUp.length);
    }
    if (ytDirect) {
      const y = r.publishPrep.platforms.youtube;
      const url = await ytUpload({ ...clip, title: y.title, caption: y.description, synthetic: !!r.disclosures?.containsSyntheticMedia, categoryId: y.youtubeCategoryId || (r.type === 'clips' ? '20' : '27') }, when);
      out.youtubeUrl = url; clip.ytId = url.split('/').pop(); out.results.push('YouTube: ' + url);
    }
    await putClip(clip); updateCount();
    r.publish = out;
    await FX.audit(when ? 'scheduled' : 'published', `${plats.join(', ')}${when ? ' for ' + new Date(when).toLocaleString() : ''}`, r.id);
    log(`📤 ${r.id} ${when ? 'scheduled' : 'sent'} → ${plats.join(', ')}`);
    return { verdict: 'PASS', status: when ? 'scheduled' : 'live', summary: `${when ? 'Scheduled for ' + new Date(when).toLocaleString() : 'Sent'} to ${plats.map(platName).join(', ')}. Platform confirmation arrives via Monitoring.`, items: [] };
  };

  /* ===================================================================
     19. MONITORING — performance over time + platform notices
     =================================================================== */
  async function ytAnalytics(videoId, since) {
    const tok = ytToken(); if (!tok || !videoId) return null;
    const start = new Date(since - 864e5).toISOString().slice(0, 10), end = new Date().toISOString().slice(0, 10);
    const base = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&filters=video==${videoId}`;
    const h = { headers: { Authorization: 'Bearer ' + tok } };
    const out = {};
    try { const j = await FX.fetchJSON(`${base}&metrics=views,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares`, h, 'YouTube Analytics'); const row = j.rows?.[0]; if (row) j.columnHeaders.forEach((c, i) => (out[c.name] = row[i])); } catch (e) { out.error = e.message; }
    try { const j = await FX.fetchJSON(`${base}&metrics=audienceWatchRatio&dimensions=elapsedVideoTimeRatio`, h, 'YouTube Analytics'); out.retention = (j.rows || []).map((x) => [x[0], x[1]]); } catch {}
    return out;
  }
  FX.snapshot = async (r) => {
    const clip = await getClip('fx_' + r.id); if (!clip) return r;
    const tot = clipTotals(clip), cache = ls.get('statsCache', {});
    if (clip.status === 'failed' && r.status !== 'error') { r.status = 'error'; r.error = 'Platform upload failed: ' + (clip.error || ''); await FX.alert(`${r.id}: upload failed — ${clip.error || 'see Review Queue'}`, r.id); }
    else if (['posted'].includes(clip.status) || (clip.status === 'scheduled' && clip.scheduledFor <= now())) { if (r.status === 'scheduled') { r.status = 'live'; FX.hist(r, 'monitor', 'live', 'Platform accepted the post'); } }
    const ytId = clip.ytId || (clip.metrics?.youtube?.url || '').split('/').pop() || null;
    let ya = null; if (ytId && ytToken()) ya = await ytAnalytics(ytId, r.publish?.at || r.created);
    const snap = { at: now(), views: tot.views, likes: tot.likes, comments: tot.comments, shares: tot.shares, per: clip.metrics || {}, followers: Object.values(cache.account || {}).reduce((a, x) => a + (toNum(x.followers ?? x.follower_count ?? x.subscribers) || 0), 0) || null, yt: ya ? { avgViewDuration: ya.averageViewDuration, avgViewPct: ya.averageViewPercentage, subsGained: ya.subscribersGained, error: ya.error } : null };
    if (ya?.retention?.length) r.retention = ya.retention;
    const last = r.metricsHistory[r.metricsHistory.length - 1];
    if (!last || last.views !== snap.views || last.likes !== snap.likes || now() - last.at > 6 * 3600e3) r.metricsHistory.push(snap);
    r.metricsHistory = r.metricsHistory.slice(-200);
    r.urls = Object.fromEntries(Object.entries(clip.metrics || {}).map(([p, m]) => [p, m.url]).filter(([, u]) => u));
    if (r.publish?.youtubeUrl) r.urls.youtube ||= r.publish.youtubeUrl;
    return r;
  };
  R.monitor = async (r) => { await FX.snapshot(r); return { verdict: 'WAIT', status: r.status === 'error' ? 'error' : (r.status === 'scheduled' ? 'scheduled' : 'live'), summary: 'Monitoring performance.' }; };
  R.monitorSweep = async () => {
    const recs = (await FX.db.prod.all()).filter((r) => r.stage === 'monitor' && r.publish);
    if (!recs.length) return;
    if ((val('upKey') || ytToken()) && now() - (ls.get('statsCache', {}).at || 0) > 1800e3) await refreshStats(true).catch(() => {});
    for (const r of recs) { await FX.snapshot(r); await FX.saveRecord(r); }
    await FX.autoBackup().catch(() => {});
  };

  /* ===================================================================
     20. ANALYTICS — what works, fed back into research and scripting
     =================================================================== */
  const views = (r) => r.metricsHistory?.[r.metricsHistory.length - 1]?.views ?? null;
  FX.computeAnalytics = async () => {
    const recs = (await FX.db.prod.all()).filter((r) => r.publish && views(r) != null);
    const groupBy = (fn) => { const g = {}; for (const r of recs) { const k = fn(r); if (k == null) continue; (g[k] ||= []).push(views(r)); } return Object.entries(g).map(([k, v]) => ({ k, n: v.length, avg: v.reduce((a, x) => a + x, 0) / v.length })).sort((a, b) => b.avg - a.avg); };
    const all = recs.map(views), avgAll = all.length ? all.reduce((a, x) => a + x, 0) / all.length : 0;
    const dims = {
      hook: groupBy((r) => r.script?.hookStyle), format: groupBy((r) => r.script?.format),
      length: groupBy((r) => (r.duration ? (r.duration < 35 ? 'under 35s' : r.duration < 50 ? '35–50s' : '50s+') : null)),
      hour: groupBy((r) => (r.publish ? new Date(r.publish.scheduledFor).getHours() + ':00' : null)),
      captionStyle: groupBy((r) => (r.captions ? `${r.captions.style.size}px @${Math.round(r.captions.style.pos * 100)}%` : null)),
      topic: groupBy((r) => r.idea?.topic),
    };
    const eng = recs.map((r) => { const m = r.metricsHistory[r.metricsHistory.length - 1]; return m.views ? ((m.likes || 0) + (m.comments || 0) + (m.shares || 0)) / m.views : null; }).filter((x) => x != null);
    const drops = recs.filter((r) => r.retention?.length).map((r) => { const i = r.retention.findIndex((x) => x[1] < 0.5); return i >= 0 ? r.retention[i][0] * (r.duration || 45) : null; }).filter((x) => x != null);
    const notes = [], hookBoost = {};
    for (const [name, rows] of Object.entries(dims)) {
      const ok = rows.filter((x) => x.n >= 3); if (ok.length < 2 || !avgAll) continue;
      const best = ok[0], worst = ok[ok.length - 1];
      if (best.avg > worst.avg * 1.3) notes.push(`${name === 'hook' ? 'Hook style' : name[0].toUpperCase() + name.slice(1)} "${best.k}" averages ${fmtNum(Math.round(best.avg))} views vs ${fmtNum(Math.round(worst.avg))} for "${worst.k}" (n=${best.n}/${worst.n})`);
      if (name === 'hook') ok.forEach((x) => (hookBoost[x.k] = Math.round((x.avg / avgAll) * 100) / 100));
    }
    if (drops.length >= 3) notes.push(`Viewers drop below 50% retention around ${Math.round(drops.reduce((a, x) => a + x, 0) / drops.length)}s on average — tighten that part of scripts`);
    const bestHook = dims.hook.filter((x) => x.n >= 3)[0]?.k || null;
    const out = { at: now(), n: recs.length, avgViews: avgAll, engagement: eng.length ? eng.reduce((a, x) => a + x, 0) / eng.length : null, dims, notes, hookBoost, bestHook, dropAvg: drops.length ? drops.reduce((a, x) => a + x, 0) / drops.length : null, top: recs.sort((a, b) => views(b) - views(a)).slice(0, 5).map((r) => ({ id: r.id, title: r.script?.title, views: views(r) })), bottom: recs.slice(-3).map((r) => ({ id: r.id, title: r.script?.title, views: views(r) })) };
    if (recs.length >= 3) ls.set('fx_learnings', { at: out.at, notes, hookBoost, bestHook });
    return out;
  };
  FX.department_scores = async () => {
    const recs = await FX.db.prod.all(), out = {};
    for (const d of FX.DEPTS) out[d.key] = { runs: 0, pass: 0, warn: 0, fail: 0, human: 0, revisions: 0, cost: 0, ms: 0 };
    for (const r of recs) {
      for (const h of r.reportHistory || []) { const o = out[h.key]; if (!o) continue; o.runs++; if (h.verdict === 'PASS') o.pass++; else if (h.verdict === 'WARNING') o.warn++; else if (h.verdict === 'FAIL') o.fail++; else if (h.verdict === 'HUMAN_REVIEW') o.human++; }
      for (const v of r.revisions || []) if (out[v.to]) out[v.to].revisions++;
      for (const c of r.costs || []) if (out[c.dept]) out[c.dept].cost += c.usd;
      for (const [k, rep] of Object.entries(r.reports || {})) if (out[k] && rep.ms) out[k].ms += rep.ms;
    }
    return out;
  };
  FX.weeklyReport = async ({ force = false } = {}) => {
    const reps = ls.get('fx_weekly', []);
    if (!force && reps[0] && now() - reps[0].at < 7 * 864e5) return null;
    const a = await FX.computeAnalytics();
    if (!force && !a.n) return null;
    const recs = await FX.db.prod.all(), week = recs.filter((r) => r.created > now() - 7 * 864e5);
    const rep = { id: 'w_' + now(), at: now(), period: `${new Date(now() - 7 * 864e5).toLocaleDateString()} – ${new Date().toLocaleDateString()}`, produced: week.length, published: week.filter((r) => r.publish).length, rejected: week.filter((r) => r.status === 'rejected').length, cost: week.reduce((s, r) => s + FX.recCost(r), 0), analytics: { n: a.n, avgViews: a.avgViews, engagement: a.engagement, top: a.top, notes: a.notes }, summary: '', ideas: [] };
    if (FX.hasAI() && a.n) {
      try {
        const out = await FX.ai(null, 'analytics', 'You are a short-form video analyst. Be concrete, use the numbers, no fluff.', `Channel: ${FX.channel().niche}\nData: ${JSON.stringify({ top: a.top, bottom: a.bottom, dims: Object.fromEntries(Object.entries(a.dims).map(([k, v]) => [k, v.slice(0, 5)])), notes: a.notes, dropAvg: a.dropAvg })}\nReturn JSON {"summary": 4-6 sentence weekly report, "experiments": [2-3 things to test next week], "ideas": [{"topic": string, "description": string, "hook": string, "hookStyle": string}]}`);
        rep.summary = out?.summary || ''; rep.experiments = out?.experiments || [];
        for (const i of (out?.ideas || []).slice(0, 3)) { const idea = { id: 'idea_' + now().toString(36) + Math.random().toString(36).slice(2, 5), created: now(), status: 'new', from: 'analytics', topic: i.topic, description: i.description, hook: i.hook, hookStyle: i.hookStyle, scores: { relevance: 7, interest: 7, originality: 6, difficulty: 4 }, concerns: [], research: [] }; idea.rank = rankIdea(idea) + 0.5; await FX.db.ideas.put(idea); rep.ideas.push(i.topic); }
      } catch (e) { rep.summary = 'AI summary failed: ' + e.message; }
    } else rep.summary = a.n ? a.notes.join('. ') || 'Not enough published videos to see patterns yet (need 3+ per group).' : 'No published videos with stats yet.';
    reps.unshift(rep); ls.set('fx_weekly', reps.slice(0, 26));
    FX.emit('analytics');
    return rep;
  };
  R.analyticsWeekly = () => FX.weeklyReport();

  /* ===================================================================
     1. CHANNEL SETUP — a line-wide department; videos can't start without it
     =================================================================== */
  FX.channelCheck = () => {
    const c = FX.channel(), items = [];
    for (const [k, label] of [['niche', 'Niche'], ['audience', 'Target audience'], ['tone', 'Tone'], ['avoid', 'Topics to avoid'], ['originality', 'Originality policy']]) if (!String(c[k] || '').trim()) items.push(item('high', label, 'Missing', 'Fill it in.'));
    if (!(c.platforms || []).length) items.push(item('high', 'Platforms', 'No platforms chosen'));
    if (c.lengthSec < 15 || c.lengthSec > 180) items.push(item('medium', 'Length', `${c.lengthSec}s is unusual for shorts`, '30–60s works best.'));
    if (!FX.channelReady()) items.push(item('high', 'Saved', 'Channel config has never been saved', 'Review and save it once.'));
    return { verdict: verdictFrom(items), items, version: FX.channelVersion() };
  };
})(window.FX);
