/* Accessibility + navigation polish layered on top of app.js / fx-*.js.
   Kept in its own file so it doesn't collide with feature branches. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const tabs = $$('nav button[data-tab]');
  const known = new Set(tabs.map((b) => b.dataset.tab));

  /* ---- tabs: aria-current, URL hash, keep the active tab visible in the phone nav ---- */
  const syncNav = () => {
    tabs.forEach((b) => (b.classList.contains('active') ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    const a = $('nav button.active');
    const nav = $('nav');
    if (a && nav && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2 });
  };
  tabs.forEach((b) => b.addEventListener('click', () => {
    syncNav();
    if (location.hash.slice(1) !== b.dataset.tab) history.replaceState(null, '', '#' + b.dataset.tab);
    window.scrollTo({ top: 0 });
  }));
  // in-page buttons that jump to a tab (e.g. "Open Review Queue") go through the nav buttons, so they're covered too
  const fromHash = () => { const id = location.hash.slice(1); if (known.has(id)) $(`nav button[data-tab="${id}"]`).click(); };
  window.addEventListener('hashchange', fromHash);
  fromHash(); syncNav();

  /* nav fade hints on small screens: show which side has more tabs */
  const nav = $('nav');
  const navEdges = () => {
    nav.classList.toggle('more-l', nav.scrollLeft > 4);
    nav.classList.toggle('more-r', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
  };
  nav.addEventListener('scroll', navEdges, { passive: true });
  window.addEventListener('resize', navEdges);
  navEdges();

  /* ---- live regions so screen readers hear progress and results ---- */
  $$('.status').forEach((el) => { el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); });
  $('#apSummary')?.setAttribute('aria-live', 'polite');

  /* ---- file drop zones: reachable and usable from the keyboard ---- */
  const fixDrops = () => $$('.drop').forEach((d) => {
    if (d.dataset.kb) return;
    const inp = d.querySelector('input[type=file]'); if (!inp) return;
    d.dataset.kb = '1'; d.tabIndex = 0; d.setAttribute('role', 'button');
  });
  document.addEventListener('keydown', (e) => {
    const d = e.target.closest?.('.drop[data-kb]');
    if (d && e.target === d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.querySelector('input[type=file]')?.click(); }
  });

  /* ---- record dialog: dialog semantics, move focus in, give it back on close, keep Tab inside ---- */
  const rec = $('#fxRecord');
  let back = null;
  if (rec) {
    rec.setAttribute('role', 'dialog'); rec.setAttribute('aria-modal', 'true'); rec.setAttribute('tabindex', '-1');
    new MutationObserver(() => {
      if (!rec.hidden) {
        if (rec.contains(document.activeElement)) return;
        if (!back) back = document.activeElement;
        const h = rec.querySelector('h2'); if (h) { h.id = h.id || 'fxRecTitle'; rec.setAttribute('aria-labelledby', h.id); }
        rec.focus({ preventScroll: true });
      } else if (back) { back.focus?.({ preventScroll: true }); back = null; }
    }).observe(rec, { attributes: true, attributeFilter: ['hidden'] });
    rec.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = $$('button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])', rec).filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === rec)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* re-apply after the app re-renders panes (the Ideas & VODs drop zone etc.) */
  let t = null;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(fixDrops, 200); }).observe($('main'), { childList: true, subtree: true });
  fixDrops();
})();
