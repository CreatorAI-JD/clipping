/* AutoClipper — easier navigation.
   - Grouped sidebar on wide screens, a Menu sheet on phones (nav.css)
   - "Jump to…" search (Ctrl/Cmd K or /): every page, Assembly Line section and common action
   - Number keys 1–9/0 open pages, ? shows the shortcuts
   - Links to Assembly Line sections (#line/policies) and the browser Back button work
   - "Get set up" checklist on the Workshop that shows what's left and takes you there */
'use strict';
(function (FX) {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = FX.nav = {};
  const PAGES = [
    ['workshop', 'Workshop', 'home robots start line stop status', 'Live view of the robots, start/stop the line'],
    ['live', 'Live Watch', 'twitch stream chat spike hype watch live clip moment', 'Watch live streams, clip when chat spikes'],
    ['scout', 'Clip Scout', 'trending popular viral clips kick twitch youtube find hunt scavenge internet', 'Find clips blowing up right now'],
    ['clipper', 'Stream Clipper', 'vod upload video cut highlights campaign tjr', 'Drop a VOD, get vertical clips'],
    ['faceless', 'Faceless Generator', 'ai script voice faceless facts', 'AI-written faceless videos'],
    ['autopilot', 'Autopilot', 'schedule folder auto approve post', 'Clip a folder on a schedule'],
    ['line', 'Assembly Line', 'production records departments', 'Every video and its reports'],
    ['queue', 'Review Queue', 'approve reject pending inbox', 'Approve videos before they post'],
    ['stats', 'Stats', 'views likes analytics followers', 'How your posts are doing'],
    ['accounts', 'Accounts', 'connect tiktok youtube instagram upload-post socials', 'Connect the platforms you post to'],
    ['settings', 'Settings', 'openai key model voice hashtags caption color', 'API key, voice, hashtags'],
  ];
  const SUBS = [
    ['videos', 'Videos'], ['ideas', 'Ideas & VODs'], ['channel', 'Channel setup'], ['policies', 'Platform policies'], ['hooks', 'Hooks (ASMR split-screen)'],
    ['library', 'Asset library'], ['analytics', 'Analytics'], ['automation', 'Automation crew (Twitch watcher, scheduler)'], ['costs', 'Costs & limits'], ['audit', 'Audit log & backups'],
  ];
  const openTab = (id) => $(`nav button[data-tab="${id}"]`)?.click();
  const waitFor = async (sel, ms = 1500) => { for (let t = 0; t < ms; t += 50) { const el = $(sel); if (el) return el; await new Promise((r) => setTimeout(r, 50)); } return null; };
  N.openSub = async (sub) => {
    if (FX.openSub) await FX.openSub(sub);
    else { ls.set('fx_sub', sub); openTab('line'); (await waitFor(`#line [data-sub="${sub}"]`))?.click(); }
    if (location.hash !== '#line/' + sub) history.replaceState(null, '', '#line/' + sub);
  };
  const focusEl = async (tab, sel) => { openTab(tab); await waitFor(sel); setTimeout(() => { const el = $(sel); if (!el) return; el.closest('details')?.setAttribute('open', ''); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus?.({ preventScroll: true }); }, 250); };
  const clickEl = async (tab, sel) => { openTab(tab); (await waitFor(sel))?.click(); };

  /* ---------------- actions for the search ---------------- */
  const ACTIONS = [
    ['Start or pause the assembly line', 'run play pause', () => clickEl('workshop', '[data-act="run"]')],
    ['Emergency STOP', 'halt panic stop everything', () => clickEl('workshop', '[data-act="stop"]')],
    ['Start watching live streams', 'live twitch watch', () => { openTab('live'); setTimeout(() => (FX.live?.watching ? toast('Already watching.') : $('[data-live="start"]')?.click()), 100); }],
    ['Add a Twitch channel to Live Watch', 'live channel streamer', () => focusEl('live', '#lvChannels')],
    ['Hunt for clips blowing up', 'trending viral popular scout find', () => { openTab('scout'); setTimeout(() => FX.scout?.hunt(), 100); }],
    ['Drop a VOD into the Stream Clipper', 'upload video file', () => focusEl('clipper', '#vodDrop')],
    ['Pick a clipping campaign (TJR…)', 'campaign tjr content rewards', () => focusEl('clipper', '#campaignBox select, #campaignBox')],
    ['Make a faceless video', 'generate ai', () => focusEl('faceless', '#genBtn, #faceless button.primary')],
    ['Approve all pending videos', 'approve queue', () => clickEl('queue', '#approveAll')],
    ['Turn Autopilot on or off', 'autopilot toggle', () => focusEl('autopilot', '#apOn')],
    ['Choose the VOD folder', 'autopilot folder', () => focusEl('autopilot', '#pickFolder')],
    ['Paste your OpenAI key', 'settings api key', () => focusEl('settings', '#apiKey')],
    ['Test the OpenAI key', 'settings check key', () => clickEl('settings', '#testKey')],
    ['Paste your Upload-Post key', 'accounts api key', () => focusEl('accounts', '#upKey')],
    ['Connect TikTok / YouTube / Instagram', 'accounts socials login', () => focusEl('accounts', '#connectBtn, #accounts button.primary')],
    ['Connect Twitch', 'twitch oauth login', () => { openTab('live'); setTimeout(() => { const d = $('#live details:last-of-type'); if (d) d.open = true; $('#lvTwClient')?.focus(); }, 100); }],
    ['Download a backup', 'export json backup', () => N.openSub('audit')],
    ['Show keyboard shortcuts', 'help keys', () => N.help()],
  ];
  function items() {
    const out = PAGES.map(([id, name, kw, hint], i) => ({ type: 'Page', label: name, hint, kw, key: i < 10 ? String((i + 1) % 10) : '', go: () => openTab(id) }));
    for (const [id, name] of SUBS) out.push({ type: 'Assembly Line', label: name, hint: 'Assembly Line section', kw: id, go: () => N.openSub(id) });
    for (const [label, kw, go] of ACTIONS) out.push({ type: 'Action', label, hint: '', kw, go });
    return out;
  }
  const score = (it, q) => {
    if (!q) return it.type === 'Page' ? 2 : it.type === 'Action' ? 1 : 0;
    const hay = (it.label + ' ' + it.kw + ' ' + it.hint).toLowerCase(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.every((w) => hay.includes(w))) return -1;
    return (it.label.toLowerCase().startsWith(words[0]) ? 5 : 0) + (it.label.toLowerCase().includes(q.toLowerCase()) ? 3 : 0) + (it.type === 'Page' ? 1 : 0);
  };

  /* ---------------- the search box (command palette) ---------------- */
  const pal = document.createElement('div');
  pal.className = 'cmdk'; pal.hidden = true;
  pal.innerHTML = `<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="Jump to">
    <div class="cmdk-in">${ico('search')}<input id="cmdkInput" placeholder="Where do you want to go? Try “live”, “approve”, “key”…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="cmdkList"><kbd>Esc</kbd></div>
    <div id="cmdkList" class="cmdk-list" role="listbox"></div></div>`;
  document.body.appendChild(pal);
  let sel = 0, shown = [], back = null;
  function paint() {
    const q = $('#cmdkInput').value.trim();
    shown = items().map((it) => ({ it, s: score(it, q) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, q ? 12 : 14).map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    $('#cmdkList').innerHTML = shown.map((it, i) => `<div class="cmdk-item${i === sel ? ' on' : ''}" role="option" id="cmdk${i}" aria-selected="${i === sel}" data-i="${i}">
      <span class="cmdk-type">${esc(it.type)}</span><span class="cmdk-label">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}</div>`).join('') || '<div class="cmdk-none">Nothing matches. Try another word.</div>';
    $('#cmdkInput').setAttribute('aria-activedescendant', shown.length ? 'cmdk' + sel : '');
    $('#cmdk' + sel)?.scrollIntoView({ block: 'nearest' });
  }
  N.open = () => { back = document.activeElement; pal.hidden = false; $('#cmdkInput').value = ''; sel = 0; paint(); $('#cmdkInput').focus(); };
  N.close = () => { pal.hidden = true; back?.focus?.({ preventScroll: true }); };
  const run = (i) => { const it = shown[i]; if (!it) return; back = null; N.close(); closeMenu(); it.go(); };
  $('#cmdkInput').addEventListener('input', () => { sel = 0; paint(); });
  $('#cmdkInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); N.close(); }
  });
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) N.close(); });
  pal.addEventListener('click', (e) => { const r = e.target.closest('.cmdk-item'); if (r) run(+r.dataset.i); });
  $('#navSearch')?.addEventListener('click', N.open);

  /* ---------------- shortcuts help ---------------- */
  const help = document.createElement('div');
  help.className = 'cmdk'; help.hidden = true;
  help.innerHTML = `<div class="cmdk-box help-box" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div class="row"><h3>Keyboard shortcuts</h3><button class="help-x" aria-label="Close">${ico('x')}</button></div>
    <div class="keys"><span><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd></span><span>Search and jump anywhere</span>
    ${PAGES.map(([, n], i) => `<span><kbd>${(i + 1) % 10}</kbd></span><span>${esc(n)}</span>`).join('')}
    <span><kbd>?</kbd></span><span>This list</span><span><kbd>Esc</kbd></span><span>Close a window</span></div></div>`;
  document.body.appendChild(help);
  N.help = () => { help.hidden = false; help.querySelector('.help-x').focus(); };
  help.addEventListener('click', (e) => { if (e.target === help || e.target.closest('.help-x')) help.hidden = true; });

  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return pal.hidden ? N.open() : N.close(); }
    if (e.key === 'Escape') { if (!help.hidden) help.hidden = true; closeMenu(); return; }
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || !pal.hidden || !$('#fxRecord')?.hidden) return;
    if (e.key === '/') { e.preventDefault(); return N.open(); }
    if (e.key === '?') { e.preventDefault(); return N.help(); }
    if (/^[0-9]$/.test(e.key)) { const p = PAGES[(+e.key + 9) % 10]; if (p) { e.preventDefault(); openTab(p[0]); } }
  });

  /* ---------------- phone menu ---------------- */
  const menuBtn = $('#navMenu');
  function closeMenu() { document.body.classList.remove('menu-open'); menuBtn?.setAttribute('aria-expanded', 'false'); }
  menuBtn?.addEventListener('click', () => {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open); menuBtn.setAttribute('aria-expanded', String(open));
    if (open) $('nav button.active')?.focus();
  });
  $$('nav button[data-tab]').forEach((b) => b.addEventListener('click', closeMenu));
  document.addEventListener('click', (e) => { if (document.body.classList.contains('menu-open') && !e.target.closest('header')) closeMenu(); });

  /* ---------------- page title follows the page; Assembly Line sections in the URL ---------------- */
  const baseTitle = document.title;
  $$('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
    const p = PAGES.find((x) => x[0] === b.dataset.tab); document.title = p && p[0] !== 'workshop' ? `${p[1]} · AutoClipper` : baseTitle;
  }));
  document.addEventListener('click', (e) => { const s = e.target.closest('#line [data-sub]'); if (s && location.hash !== '#line/' + s.dataset.sub) history.replaceState(null, '', '#line/' + s.dataset.sub); });
  const fromHash = () => { const m = location.hash.match(/^#line\/(\w+)$/); if (m && SUBS.some(([id]) => id === m[1])) N.openSub(m[1]); };
  window.addEventListener('hashchange', fromHash);
  setTimeout(fromHash, 0);

  /* ---------------- "Fix it" buttons on warnings that name a place in the app ---------------- */
  // e.g. "Whose streams these are is not set (Assembly Line → Channel → Streams & rights)" gets a button that goes there
  const PLACES = [
    [/Channel → Streams & rights|Whose streams/i, () => N.openSub('channel').then(() => focusSoon('#ch_streamerRelation'))],
    [/Assembly Line → Channel/i, () => N.openSub('channel')], [/Assembly Line → Policies|checklist/i, () => N.openSub('policies')],
    [/Assembly Line → Costs/i, () => N.openSub('costs')], [/Upload-Post|connect.*account/i, () => openTab('accounts')], [/OpenAI key/i, () => focusEl('settings', '#apiKey')],
  ];
  const focusSoon = async (sel) => { await waitFor(sel); await new Promise((r) => setTimeout(r, 400)); const el = $(sel); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800); } };
  function addFixLinks(root) {
    root.querySelectorAll('.gate:not([data-fix])').forEach((g) => {
      g.dataset.fix = '1';
      const hit = PLACES.find(([rx]) => rx.test(g.textContent)); if (!hit) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fix-btn'; b.textContent = 'Fix it →';
      b.onclick = (e) => { e.stopPropagation(); hit[1](); };
      g.appendChild(b);
    });
  }
  const q = $('#queue'); if (q) new MutationObserver(() => addFixLinks(q)).observe(q, { childList: true, subtree: true });

  /* ---------------- Get set up checklist (Workshop) ---------------- */
  async function steps() {
    const live = (ls.get('fx_live', {}) || {}).channels;
    let clips = 0; try { clips = (await allClips()).length; } catch {}
    return [
      { done: !!val('apiKey'), label: 'Paste your OpenAI key', why: 'captions, titles, hype scores, safety checks', go: () => focusEl('settings', '#apiKey') },
      { done: !!val('upKey'), label: 'Paste your Upload-Post key', why: 'lets AutoClipper post for you', go: () => focusEl('accounts', '#upKey') },
      { done: typeof canPost === 'function' && canPost(), label: 'Connect your socials', why: 'TikTok, YouTube, Instagram…', go: () => openTab('accounts') },
      { done: !!(FX.channelReady && FX.channelReady()), label: 'Set up your channel', why: 'niche, brand tag, clip length', go: () => N.openSub('channel') },
      { done: !!live, label: 'Pick streamers for Live Watch', why: 'catch moments while they happen', go: () => focusEl('live', '#lvChannels') },
      { done: clips > 0, label: 'Make your first clip', why: 'drop a VOD in the Stream Clipper', go: () => openTab('clipper') },
    ];
  }
  const host = document.createElement('div'); host.id = 'setupCard';
  const ws = $('#workshop'); ws?.insertBefore(host, ws.children[1] || null);
  async function paintSetup() {
    if (ls.get('setupHidden', false)) { host.innerHTML = ''; return; }
    const st = await steps(), done = st.filter((x) => x.done).length;
    if (done === st.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="card setup"><div class="row"><h3>${ico('compass')}Get set up</h3><span class="muted small">${done} of ${st.length} done</span><button class="setup-hide" aria-label="Hide checklist" title="Hide">${ico('x')}</button></div>
      <div class="setup-bar"><i style="width:${(done / st.length) * 100}%"></i></div>
      <div class="setup-steps">${st.map((s, i) => `<button class="setup-step${s.done ? ' done' : ''}" data-step="${i}">${ico(s.done ? 'check' : 'circle')}<span><b>${esc(s.label)}</b><small>${esc(s.why)}</small></span></button>`).join('')}</div></div>`;
    host.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => st[+b.dataset.step].go()));
    host.querySelector('.setup-hide').onclick = () => { ls.set('setupHidden', true); paintSetup(); toast('Checklist hidden. Search "set up" to bring it back.'); };
  }
  ACTIONS.push(['Show the Get set up checklist', 'setup onboarding start checklist', () => { ls.set('setupHidden', false); openTab('workshop'); paintSetup(); }]);
  N.paintSetup = paintSetup;
  $('nav button[data-tab="workshop"]')?.addEventListener('click', paintSetup);
  document.addEventListener('change', () => setTimeout(paintSetup, 300));
  paintSetup();
})(window.FX);
