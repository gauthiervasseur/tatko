/* Tatko - application controller: state, drag & drop, shelves, filters, sheets. */
(function () {
  'use strict';
  const T = window.Tatko;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let uidN = 1;
  const uid = (p) => p + uidN++ + Math.random().toString(36).slice(2, 6);
  const VERSION = '1.0.0';

  /* =============================================================== storage */

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tatko.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tatko.' + k, JSON.stringify(v)); } catch (e) { /* private mode / quota */ } },
  };

  /* ================================================================= sound */

  const SFX = {
    on: store.get('sfx', true),
    ctx: null,
    tunes: {
      pick: [[523, 0.035], [784, 0.045]],
      drop: [[988, 0.06], [1319, 0.14]],          // the classic coin
      remove: [[392, 0.05], [262, 0.05], [196, 0.09]],
      click: [[1046, 0.025]],
      start: [[523, 0.08], [659, 0.08], [784, 0.08], [1046, 0.18]],
      error: [[196, 0.12], [147, 0.2]],
      filter: [[880, 0.03], [1175, 0.05]],
    },
    play(name) {
      if (!this.on) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const ctx = this.ctx;
        let t = ctx.currentTime + 0.005;
        for (const [f, d] of this.tunes[name] || []) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'square'; o.frequency.value = f;
          g.gain.setValueAtTime(0.035, t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d);
          o.connect(g).connect(ctx.destination);
          o.start(t); o.stop(t + d + 0.01);
          t += d;
        }
      } catch (e) { /* audio unavailable */ }
    },
  };

  /* ================================================================= state */

  const S = {
    ds: null, idx: null,
    sheets: [], active: 0, filters: [],
    theme: null, themeCss: null, themeWarnings: [],
    leftTab: 'fields', fieldSearch: '',
    lastPivot: null, pendingGame: null,
  };

  function newSheet(name) {
    return {
      id: uid('s'), name, mark: 'auto',
      shelves: { columns: [], rows: [], values: [], color: [] },
      opts: { totals: true, subtotals: true, heat: false, sort: 'label', labels: false },
      pivotSort: null,
    };
  }
  const sheet = () => S.sheets[S.active];
  const SHELVES = ['columns', 'rows', 'values', 'color'];

  function defaultGrain(f) {
    const [a, b] = T.extent(S.ds, f);
    if (a === null) return 'year';
    const days = (b - a) / 86400000;
    return days > 6 * 365 ? 'year' : days > 60 ? 'month' : 'day';
  }
  function aggFor(f, shelf) {
    if (shelf === 'values' && f.role === 'dimension' && f.type !== 'date') return 'countd';
    return T.defaultAgg(f);
  }
  function newPill(field, shelf) {
    const f = S.ds.byName[field];
    return { id: uid('p'), field, agg: aggFor(f, shelf), grain: f.type === 'date' ? defaultGrain(f) : null };
  }
  const isMeasureField = (f) => f.type === 'records' || f.role === 'measure';

  function refilter() { S.idx = S.ds ? T.filterIndex(S.ds, S.filters) : null; }

  /* ========================================================= render loop */

  let raf = 0;
  const dirty = new Set();
  function invalidate(...parts) {
    (parts.length ? parts : ['all']).forEach((p) => dirty.add(p));
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function flush() {
    raf = 0;
    const all = dirty.has('all');
    const d = (k) => all || dirty.has(k);
    const doViz = d('viz');
    const parts = { fields: d('fields'), shelves: d('shelves'), filters: d('filters'), theme: d('theme'), sheets: d('sheets') };
    dirty.clear();
    renderTabs();
    if (parts.fields) renderFields();
    if (parts.shelves) { renderShelves(); renderMarks(); }
    if (parts.filters) renderFilters();
    if (parts.theme) renderTheme();
    if (parts.sheets) renderSheets();
    renderStatus();
    if (doViz) renderViz();
    autosave();
  }

  /* ============================================================ left tabs */

  function renderTabs() {
    $$('.sidebar .tab').forEach((b) => {
      const on = b.dataset.tab === S.leftTab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on);
    });
    $$('.sidebar .panel').forEach((p) => (p.hidden = p.id !== 'panel-' + S.leftTab));
    const n = S.filters.filter(T.isActive).length;
    $('#filterCount').textContent = n ? String(n) : '';
  }

  /* =============================================================== fields */

  const TYPE_TAG = { string: 'ABC', number: '#', date: 'DATE', records: '#' };

  function renderFields() {
    const card = $('#datasetCard');
    if (!S.ds) {
      card.innerHTML = '<div class="ds-empty">NO CARTRIDGE<br><span>LOAD A CSV TO PLAY</span></div>';
      $('#dimList').innerHTML = ''; $('#meaList').innerHTML = '';
      return;
    }
    card.innerHTML = `<div class="ds-name" title="${esc(S.ds.name)}">${esc(S.ds.name)}</div>
      <div class="ds-meta">${S.ds.n.toLocaleString()} ROWS · ${S.ds.fields.length - 1} FIELDS</div>`;
    const q = S.fieldSearch.trim().toLowerCase();
    const item = (f) => `<li class="field ${isMeasureField(f) ? 'mea' : 'dim'}" data-drag="field" data-field="${esc(f.name)}" tabindex="0"
        title="${esc(f.name)} · ${f.type.toUpperCase()} · drag to a shelf, double-click to add, right-click for options">
        <span class="ftype t-${f.type}">${TYPE_TAG[f.type]}</span><span class="fname">${esc(f.name)}</span></li>`;
    const match = (f) => !q || f.name.toLowerCase().includes(q);
    const dims = S.ds.fields.filter((f) => !isMeasureField(f) && match(f));
    const meas = S.ds.fields.filter((f) => isMeasureField(f) && match(f));
    $('#dimList').innerHTML = dims.map(item).join('') || '<li class="field-none">NONE</li>';
    $('#meaList').innerHTML = meas.map(item).join('') || '<li class="field-none">NONE</li>';
  }

  /* ============================================================== shelves */

  function pillLabel(p, shelf) {
    const f = S.ds.byName[p.field];
    if (shelf === 'values' || (shelf === 'color' && isMeasureField(f))) return T.measureSpec(S.ds, p).label;
    if (f.type === 'date') return T.dimSpec(S.ds, p).label;
    return f.name;
  }
  function pillHTML(p, shelf) {
    const f = S.ds.byName[p.field];
    const asMeasure = shelf === 'values' || (shelf === 'color' && isMeasureField(f));
    const menu = asMeasure || f.type === 'date';
    return `<div class="pill ${asMeasure ? 'mea' : 'dim'}${p.id === justDropped ? ' just-dropped' : ''}" data-drag="pill" data-shelf="${shelf}" data-pill="${p.id}" tabindex="0"
      title="${menu ? 'Click for options · ' : ''}Drag to move · drag off to remove">
      <span class="pill-text">${esc(pillLabel(p, shelf))}</span>${menu ? '<span class="pill-caret">▾</span>' : ''}<button class="pill-x" data-remove title="Remove" aria-label="Remove">×</button></div>`;
  }
  let justDropped = null;

  function filterSummary(flt) {
    const f = S.ds.byName[flt.field];
    if (flt.kind === 'set') {
      const total = T.domain(S.ds, f).length;
      return (total - flt.excluded.length) + '/' + total;
    }
    const fmt = flt.kind === 'daterange' ? T.fmtDay : T.fmtNum;
    if (flt.min != null && flt.max != null) return fmt(flt.min) + '…' + fmt(flt.max);
    if (flt.min != null) return '≥ ' + fmt(flt.min);
    if (flt.max != null) return '≤ ' + fmt(flt.max);
    return 'ALL';
  }

  function renderShelves() {
    const ws = $('.workspace');
    ws.classList.toggle('no-data', !S.ds);
    for (const shelf of SHELVES) {
      const zone = $(`.shelf-drop[data-drop="${shelf}"]`);
      const pills = S.ds ? sheet().shelves[shelf] : [];
      zone.innerHTML = pills.map((p) => pillHTML(p, shelf)).join('') ||
        `<span class="shelf-hint">${{ columns: 'DROP FIELDS HERE', rows: 'DROP FIELDS HERE', values: 'DROP MEASURES', color: 'SPLIT BY' }[shelf]}</span>`;
    }
    const fz = $('.shelf-drop[data-drop="filters"]');
    fz.innerHTML = S.ds && S.filters.length
      ? S.filters.map((flt) => `<button class="pill flt${T.isActive(flt) ? ' on' : ''}" data-goto-filter="${flt.id}" title="Open in the FILTERS tab">
          <span class="pill-text">${esc(flt.field)} <em>${esc(filterSummary(flt))}</em></span></button>`).join('')
      : '<span class="shelf-hint">DROP TO FILTER</span>';
    justDropped = null;
  }

  /* ================================================================ marks */

  const ICONS = {
    auto: ['...#....', '...#....', '.#.#.#..', '..###...', '#######.', '..###...', '.#.#.#..', '...#....'],
    table: ['########', '#..#...#', '########', '#..#...#', '#..#...#', '########', '#..#...#', '########'],
    bar: ['........', '......##', '......##', '...##.##', '...##.##', '##.##.##', '##.##.##', '########'],
    stacked: ['......##', '......##', '...##...', '...##.##', '##....##', '...##.##', '##.##.##', '########'],
    line: ['........', '......#.', '.....#.#', '#...#...', '.#.#....', '..#.....', '........', '########'],
    area: ['........', '......#.', '.....###', '#...####', '##.#####', '########', '########', '########'],
    scatter: ['......#.', '..#.....', '.....#..', '.#..#...', '...#..#.', '#.......', '..#.#...', '........'],
    pie: ['..####..', '.######.', '###..###', '##....##', '##....##', '###..###', '.######.', '..####..'],
    heatmap: ['##.#.##.', '##.#.##.', '........', '#.##.#.#', '#.##.#.#', '........', '###.#.##', '###.#.##'],
    treemap: ['####.###', '####.###', '####....', '####.#.#', '.......#', '###.##.#', '###.##.#', '###.##.#'],
    box: ['..#..#..', '.###.#..', '.#.####.', '.###.#.#', '.#.#.###', '.###..#.', '..#...#.', '........'],
    histogram: ['........', '...##...', '..####..', '..####..', '.######.', '.######.', '########', '########'],
    kpi: ['########', '#.####.#', '#.####.#', '.######.', '..####..', '...##...', '..####..', '.######.'],
  };
  function pixelIcon(name) {
    const rows = ICONS[name] || ICONS.auto;
    let r = '';
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '#') r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; });
    return `<svg class="px-icon" viewBox="0 0 8 8" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor">${r}</svg>`;
  }

  function renderMarks() {
    const bar = $('#markBar');
    if (!S.ds) { bar.innerHTML = ''; $('#vizOptions').innerHTML = ''; return; }
    const sh = sheet();
    const resolved = T.Charts.resolveMark(S.ds, sh);
    bar.innerHTML = T.Charts.MARKS.map((m) => {
      const cls = ['mark-btn'];
      if (sh.mark === m.id) cls.push('is-active');
      if (sh.mark === 'auto' && m.id === resolved) cls.push('is-auto');
      return `<button class="${cls.join(' ')}" data-mark="${m.id}" title="${esc(m.tip)}">${pixelIcon(m.id)}<span>${m.label}</span></button>`;
    }).join('');
    renderOptions(resolved);
  }

  function renderOptions(mark) {
    const sh = sheet(), o = sh.opts;
    const tog = (k, label, tip) => `<button class="opt${o[k] ? ' on' : ''}" data-opt="${k}" title="${tip}">${label}</button>`;
    let h = '';
    if (mark === 'table') {
      h += tog('totals', 'TOTALS', 'Grand totals') + tog('subtotals', 'SUBTOTALS', 'Subtotals for each outer row group') + tog('heat', 'HEAT', 'Shade cells by value');
    }
    if (['bar', 'stacked', 'line', 'area', 'heatmap'].includes(mark)) h += tog('labels', 'LABELS', 'Show values on the marks');
    if (['bar', 'stacked'].includes(mark)) {
      const lab = { label: 'A→Z', desc: 'HI→LO', asc: 'LO→HI' }[o.sort || 'label'];
      h += `<button class="opt on" data-opt-sort title="Sort categories (dates always stay in time order)">SORT ${lab}</button>`;
    }
    $('#vizOptions').innerHTML = h;
  }

  /* ============================================================== filters */

  function addFilter(field) {
    const f = S.ds.byName[field];
    if (!f || f.type === 'records') return;
    let flt = S.filters.find((x) => x.field === field);
    if (!flt) {
      flt = { id: uid('f'), field, kind: T.filterKind(f), excluded: [], min: null, max: null, keepNull: true, search: '' };
      S.filters.push(flt);
    }
    S.leftTab = 'filters';
    invalidate('filters', 'shelves');
    requestAnimationFrame(() => {
      const card = $(`.filter-card[data-fid="${flt.id}"]`);
      if (card) { card.scrollIntoView({ block: 'nearest' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 900); }
    });
  }

  const MAX_LIST = 300;
  function setListHTML(flt) {
    const f = S.ds.byName[flt.field];
    const dom = T.domain(S.ds, f);
    const ex = new Set(flt.excluded);
    const q = (flt.search || '').toLowerCase();
    const spec = T.dimSpec(S.ds, { field: f.name, grain: 'exact' });
    let shown = 0, h = '';
    for (let j = 0; j < dom.length && shown < MAX_LIST; j++) {
      const d = dom[j], label = spec.fmt(d.value);
      if (q && !label.toLowerCase().includes(q)) continue;
      shown++;
      h += `<label class="chk"><input type="checkbox" data-vi="${j}"${ex.has(d.value) ? '' : ' checked'}><span class="chk-box"></span><span class="chk-label" title="${esc(label)}">${esc(label)}</span><span class="chk-count">${d.count.toLocaleString()}</span></label>`;
    }
    if (!shown) h = '<div class="filter-empty">NO MATCH</div>';
    else if (shown >= MAX_LIST) h += `<div class="filter-empty">SHOWING ${MAX_LIST} - SEARCH TO NARROW</div>`;
    return h;
  }

  function filterCardHTML(flt) {
    const f = S.ds.byName[flt.field];
    let body = '';
    if (flt.kind === 'set') {
      const total = T.domain(S.ds, f).length;
      body = `<div class="filter-tools">
          <input class="search small" data-fsearch placeholder="SEARCH…" title="${total.toLocaleString()} distinct values" value="${esc(flt.search || '')}">
          <button class="mini" data-fall title="Select all (matching search)">ALL</button><button class="mini" data-fnone title="Clear all (matching search)">NONE</button><button class="mini" data-finv title="Invert">INV</button>
        </div><div class="chk-list">${setListHTML(flt)}</div>`;
    } else {
      const [lo, hi] = T.extent(S.ds, f);
      const isDate = flt.kind === 'daterange';
      const type = isDate ? 'date' : 'number';
      const show = (v) => (v == null ? '' : isDate ? T.fmtDay(v) : v);
      const ph = (v) => (v == null ? '' : isDate ? T.fmtDay(v) : T.fmtNum(v));
      body = `<div class="range-row"><label>FROM<input class="num" type="${type}" data-fmin value="${show(flt.min)}" placeholder="${ph(lo)}" ${isDate ? `min="${ph(lo)}" max="${ph(hi)}"` : 'step="any"'}></label>
        <label>TO<input class="num" type="${type}" data-fmax value="${show(flt.max)}" placeholder="${ph(hi)}" ${isDate ? `min="${ph(lo)}" max="${ph(hi)}"` : 'step="any"'}></label></div>
        <div class="range-foot"><span>RANGE ${esc(ph(lo))} → ${esc(ph(hi))}</span>
        <label class="chk inline"><input type="checkbox" data-fnull${flt.keepNull !== false ? ' checked' : ''}><span class="chk-box"></span><span class="chk-label">KEEP EMPTY</span></label>
        <button class="mini" data-freset>RESET</button></div>`;
    }
    return `<div class="filter-card${T.isActive(flt) ? ' on' : ''}" data-fid="${flt.id}">
      <div class="filter-head"><span class="ftype t-${f.type}">${TYPE_TAG[f.type]}</span><span class="filter-name">${esc(f.name)}</span>
      <span class="filter-sum">${esc(filterSummary(flt))}</span><button class="pill-x" data-fremove title="Remove filter">×</button></div>
      <div class="filter-body">${body}</div></div>`;
  }

  function renderFilters() {
    const panel = $('#panel-filters');
    if (!S.ds) { panel.innerHTML = '<div class="panel-empty">LOAD A CSV FIRST</div>'; return; }
    const opts = S.ds.fields.filter((f) => f.type !== 'records' && !S.filters.some((x) => x.field === f.name))
      .map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');
    panel.innerHTML = `<div class="filter-top">
        <select class="select" id="addFilter"><option value="">+ ADD FILTER…</option>${opts}</select>
        ${S.filters.length ? '<button class="mini" data-fclear title="Remove all filters">CLEAR</button>' : ''}
      </div>
      <div class="filter-hint">FILTERS APPLY TO EVERY LEVEL (SHEET). DROP ANY FIELD HERE OR ON THE FILTERS SHELF.</div>
      ${S.filters.map(filterCardHTML).join('') || '<div class="panel-empty drop-me">DROP A FIELD HERE<br>TO START FILTERING</div>'}`;
  }

  function updateFilterChrome(flt) {
    const card = $(`.filter-card[data-fid="${flt.id}"]`);
    if (card) {
      card.classList.toggle('on', T.isActive(flt));
      $('.filter-sum', card).textContent = filterSummary(flt);
    }
  }

  let filterTimer = 0;
  function filtersChanged(flt) {
    if (flt) updateFilterChrome(flt);
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { refilter(); invalidate('viz', 'shelves'); }, 60);
  }

  function bindFilterPanel() {
    const panel = $('#panel-filters');
    const fltOf = (el) => { const c = el.closest('.filter-card'); return c && S.filters.find((x) => x.id === c.dataset.fid); };
    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'addFilter') { if (t.value) { addFilter(t.value); SFX.play('filter'); } return; }
      const flt = fltOf(t);
      if (!flt) return;
      if (t.dataset.vi !== undefined) {
        const v = T.domain(S.ds, S.ds.byName[flt.field])[+t.dataset.vi].value;
        const ex = new Set(flt.excluded);
        if (t.checked) ex.delete(v); else ex.add(v);
        flt.excluded = Array.from(ex);
        SFX.play('click');
      } else if (t.matches('[data-fmin],[data-fmax]')) {
        const raw = t.value;
        const v = raw === '' ? null : flt.kind === 'daterange' ? T.parseDate(raw) : parseFloat(raw);
        flt[t.matches('[data-fmin]') ? 'min' : 'max'] = Number.isFinite(v) ? v : null;
      } else if (t.matches('[data-fnull]')) {
        flt.keepNull = t.checked;
      } else return;
      filtersChanged(flt);
    });
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.matches('[data-fsearch]')) return;
      const flt = fltOf(t);
      flt.search = t.value;
      $('.chk-list', t.closest('.filter-card')).innerHTML = setListHTML(flt);
    });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.matches('[data-fclear]')) { S.filters = []; SFX.play('remove'); refilter(); invalidate('filters', 'shelves', 'viz'); return; }
      const flt = fltOf(b);
      if (!flt) return;
      if (b.matches('[data-fremove]')) {
        S.filters = S.filters.filter((x) => x !== flt);
        SFX.play('remove'); refilter(); invalidate('filters', 'shelves', 'viz'); return;
      }
      if (b.matches('[data-freset]')) { flt.min = flt.max = null; flt.keepNull = true; invalidate('filters'); filtersChanged(flt); return; }
      if (b.matches('[data-fall],[data-fnone],[data-finv]')) {
        const f = S.ds.byName[flt.field];
        const spec = T.dimSpec(S.ds, { field: f.name, grain: 'exact' });
        const q = (flt.search || '').toLowerCase();
        const dom = T.domain(S.ds, f).filter((d) => !q || spec.fmt(d.value).toLowerCase().includes(q)).map((d) => d.value);
        const ex = new Set(flt.excluded);
        if (b.matches('[data-fall]')) dom.forEach((v) => ex.delete(v));
        else if (b.matches('[data-fnone]')) dom.forEach((v) => ex.add(v));
        else dom.forEach((v) => (ex.has(v) ? ex.delete(v) : ex.add(v)));
        flt.excluded = Array.from(ex);
        $('.chk-list', b.closest('.filter-card')).innerHTML = setListHTML(flt);
        SFX.play('click');
        filtersChanged(flt);
      }
    });
  }

  /* ================================================================ theme */

  function setTheme(css, opts = {}) {
    let parsed;
    try { parsed = T.Theme.parse(css); } catch (e) { toast(e.message, 'error'); SFX.play('error'); return false; }
    S.theme = parsed.theme; S.themeCss = css; S.themeWarnings = parsed.warnings;
    store.set('themeCss', css);
    T.Theme.apply(parsed, $('#viz')).then(() => invalidate('viz'));
    invalidate('theme', 'viz', 'status');
    if (!opts.silent) {
      toast('THEME LOADED: ' + S.theme.name.toUpperCase() + (parsed.warnings.length ? ' (' + parsed.warnings.length + ' WARNINGS)' : ''));
      SFX.play('drop');
    }
    return true;
  }

  function renderTheme() {
    const t = S.theme;
    if (!t) return;
    const sw = t.palette.map((c, j) => `<span class="swatch" style="background:${esc(c)}" title="${j + 1}: ${esc(c)}"><b>${j + 1}</b></span>`).join('');
    $('#panel-theme').innerHTML = `
      <div class="theme-card">
        <div class="theme-name">${esc(t.name.toUpperCase())}</div>
        <div class="theme-preview" style="background:${esc(t.background)};color:${esc(t.text)};font-family:${esc(t.fontFamily)};font-size:${t.fontSize}px">
          <div style="font-family:${esc(t.titleFontFamily)};font-size:${t.titleFontSize}px">Title font</div>
          <div>Body font 0123456789</div>
          <div class="swatches">${sw}</div>
          <div class="ramp" style="background:linear-gradient(90deg, ${t.sequential.map(esc).join(',')})"></div>
        </div>
      </div>
      ${S.themeWarnings.length ? `<ul class="theme-warn">${S.themeWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <button class="btn block" data-action="open-theme">LOAD THEME CSS…</button>
      <div class="preset-row">${Object.keys(T.Theme.PRESETS).map((k) => `<button class="mini" data-preset="${k}">${k.toUpperCase()}</button>`).join('')}</div>
      <button class="btn block ghost" data-action="theme-template">DOWNLOAD AS CSS TEMPLATE</button>
      <details class="theme-doc"><summary>THEME CSS VARIABLES</summary>
<pre>:root {
  --tatko-font-family: "Inter", sans-serif;
  --tatko-title-font-family: ...;
  --tatko-font-size: 13px;
  --tatko-title-font-size: 15px;
  --tatko-text-color: #111;
  --tatko-muted-color: #555;
  --tatko-background: #fff;
  --tatko-plot-background: #fff;
  --tatko-grid-color: #eee;
  --tatko-palette: #2a78d6, #eb6834, ...;
  --tatko-sequential: #cde2fb, #104281;
  --tatko-table-header-background: #f0f0f0;
  --tatko-table-header-color: #111;
  --tatko-table-border-color: #e5e5e5;
  --tatko-table-total-background: #f7f7f7;
}</pre>
<p>All optional. Plain <code>font-family</code>, <code>color</code> and <code>background</code> on <code>:root</code> or <code>body</code> also work. Use <code>@import</code> (web fonts) or <code>@font-face</code> with a data: URL for custom fonts.</p>
      </details>`;
  }

  /* =============================================================== sheets */

  function renderSheets() {
    const el = $('#sheetTabs');
    if (!S.ds) { el.innerHTML = ''; return; }
    el.innerHTML = S.sheets.map((s, j) => `<div class="sheet-tab${j === S.active ? ' is-active' : ''}" data-sheet="${j}" title="Double-click to rename">
        <span class="sheet-name">${esc(s.name)}</span>${S.sheets.length > 1 ? '<button class="sheet-x" data-close title="Delete level">×</button>' : ''}</div>`).join('') +
      '<button class="sheet-add" data-add-sheet title="New sheet">+ LEVEL</button><button class="sheet-add" data-dup-sheet title="Duplicate this sheet">DUPLICATE</button>';
  }

  function bindSheets() {
    const el = $('#sheetTabs');
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-add-sheet]')) {
        S.sheets.push(newSheet('LEVEL ' + (S.sheets.length + 1))); S.active = S.sheets.length - 1;
        SFX.play('start'); invalidate(); return;
      }
      if (e.target.closest('[data-dup-sheet]')) {
        const copy = JSON.parse(JSON.stringify(sheet()));
        copy.id = uid('s'); copy.name = sheet().name + ' COPY';
        SHELVES.forEach((k) => copy.shelves[k].forEach((p) => (p.id = uid('p'))));
        S.sheets.splice(S.active + 1, 0, copy); S.active++;
        SFX.play('drop'); invalidate(); return;
      }
      const tab = e.target.closest('.sheet-tab');
      if (!tab) return;
      const j = +tab.dataset.sheet;
      if (e.target.closest('[data-close]')) {
        S.sheets.splice(j, 1);
        if (S.active >= S.sheets.length) S.active = S.sheets.length - 1;
        else if (j < S.active) S.active--;
        SFX.play('remove'); invalidate(); return;
      }
      if (j !== S.active) { S.active = j; SFX.play('click'); invalidate(); }
    });
    el.addEventListener('dblclick', (e) => {
      const name = e.target.closest('.sheet-name');
      if (!name) return;
      const j = +name.closest('.sheet-tab').dataset.sheet;
      const input = document.createElement('input');
      input.className = 'sheet-rename'; input.value = S.sheets[j].name; input.maxLength = 32;
      name.replaceWith(input); input.focus(); input.select();
      const done = (ok) => { if (ok && input.value.trim()) S.sheets[j].name = input.value.trim().toUpperCase(); invalidate('sheets'); };
      input.addEventListener('keydown', (k) => { if (k.key === 'Enter') input.blur(); if (k.key === 'Escape') { input.value = ''; input.blur(); } });
      input.addEventListener('blur', () => done(true), { once: true });
    });
  }

  /* =============================================================== status */

  function renderStatus() {
    const el = $('#status');
    if (!S.ds) { el.innerHTML = '<span class="blink">INSERT CSV</span><span>CREDIT 0</span><span class="right">TATKO v' + VERSION + ' · YOUR DATA NEVER LEAVES THIS COMPUTER</span>'; return; }
    const pct = S.ds.n ? Math.round((S.idx.length / S.ds.n) * 100) : 0;
    el.innerHTML = `<span>P1 ▸ ${esc(S.ds.name)}</span><span>${S.ds.n.toLocaleString()} ROWS</span>
      <span class="${S.idx.length < S.ds.n ? 'hot' : ''}">${S.idx.length.toLocaleString()} IN PLAY (${pct}%)</span>
      <span>THEME ${esc(S.theme ? S.theme.name.toUpperCase() : '')}</span><span class="right">TATKO v${VERSION}</span>`;
  }

  /* ================================================================== viz */

  const PLOT_CONFIG = {
    responsive: true, displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines'],
    toImageButtonOptions: { filename: 'tatko-chart', scale: 2 },
  };

  function purgePlot() {
    const p = $('#viz .plot');
    if (p && window.Plotly) Plotly.purge(p);
  }

  function setVizHTML(html) { purgePlot(); $('#viz').innerHTML = html; }

  function renderViz() {
    const el = $('#viz');
    el.classList.toggle('is-splash', !S.ds);
    if (!S.ds) return setVizHTML(splashHTML());
    const sh = sheet();
    const mark = T.Charts.resolveMark(S.ds, sh);
    S.lastView = mark;
    if (mark === 'empty') return setVizHTML(readyHTML());
    try {
      if (mark === 'table') {
        const out = T.Pivot.render(T.Pivot.compute(S.ds, S.idx, sh), sh, S.theme);
        S.lastPivot = out;
        return setVizHTML(`<div class="pivot-wrap">${out.html}</div>`);
      }
      const res = T.Charts.build({ ds: S.ds, idx: S.idx, sheet: sh, theme: S.theme }, mark);
      const notes = (res.notes || []).map((n) => `<span>${esc(n)}</span>`).join('');
      if (res.kind === 'message') return setVizHTML(messageHTML(res.text, res.sub));
      if (res.kind === 'html') return setVizHTML(res.html + (notes ? `<div class="viz-notes">${notes}</div>` : ''));
      let plot = $('.plot', el);
      if (!plot) { setVizHTML('<div class="plot-scroll"><div class="plot"></div></div><div class="viz-notes"></div>'); plot = $('.plot', el); }
      plot.style.height = res.minHeight ? res.minHeight + 'px' : '100%';
      $('.viz-notes', el).innerHTML = notes;
      $('.viz-notes', el).hidden = !notes;
      Plotly.react(plot, res.data, res.layout, PLOT_CONFIG);
    } catch (err) {
      console.error(err);
      setVizHTML(messageHTML('GAME OVER', 'SOMETHING BROKE WHILE DRAWING: ' + err.message));
    }
  }

  function splashHTML() {
    return `<div class="splash">
      <div class="splash-grid"></div>
      <img class="splash-sprite" src="assets/icon-256.png" alt="Tatko">
      <h1 class="logo">TATKO</h1>
      <div class="splash-sub">BUSINESS INTELLIGENCE · 8-BIT EDITION</div>
      <div class="press-start blink">PRESS START</div>
      <div class="splash-actions">
        <button class="btn btn-primary big" data-action="open-csv">LOAD CSV</button>
        <button class="btn big" data-action="demo">PLAY DEMO</button>
      </div>
      <div class="splash-hint">…OR DROP A .CSV FILE ANYWHERE ON THIS SCREEN</div>
      <div class="splash-foot">ТАТКО · "DADDY" IN UKRAINIAN · © ${new Date().getFullYear()}</div>
    </div>`;
  }
  function readyHTML() {
    return `<div class="message ready">
      <div class="msg-title">PLAYER 1 READY</div>
      <div class="msg-sub">DRAG FIELDS FROM THE LEFT ONTO <b>COLUMNS</b>, <b>ROWS</b> AND <b>VALUES</b></div>
      <div class="ready-arrow">◀ ◀ ◀</div>
      <div class="msg-sub small">TIP: DOUBLE-CLICK A FIELD TO ADD IT · CLICK A PILL TO CHANGE IT</div>
    </div>`;
  }
  function messageHTML(title, sub) {
    return `<div class="message"><div class="msg-title">${esc(title)}</div><div class="msg-sub">${esc(sub || '')}</div></div>`;
  }

  function bindViz() {
    const el = $('#viz');
    el.addEventListener('click', (e) => {
      const th = e.target.closest('th.sortable');
      if (!th || !S.ds) return;
      const sh = sheet();
      const ps = sh.pivotSort;
      if (th.dataset.sortLabel !== undefined) {
        const level = +th.dataset.sortLabel;
        const same = ps && ps.by === 'label' && ps.level === level;
        sh.pivotSort = same && ps.dir === -1 ? null : { by: 'label', level, dir: same ? -1 : 1 };
      } else {
        const lf = S.lastPivot.leaves[+th.dataset.sortLeaf];
        const same = ps && ps.by === 'value' && ps.col === lf.ck && ps.m === lf.m;
        sh.pivotSort = same && ps.dir === 1 ? null : { by: 'value', col: lf.ck, m: lf.m, dir: same ? 1 : -1 };
      }
      SFX.play('click');
      invalidate('viz');
    });
    let rt = 0;
    new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => { const p = $('#viz .plot'); if (p && p.data) Plotly.Plots.resize(p); }, 80);
    }).observe(el);
  }

  /* ========================================================== drag & drop */

  const D = { s: null, justDragged: false };

  function payloadField(p) {
    if (p.kind === 'field') return S.ds.byName[p.field];
    const pill = sheet().shelves[p.shelf].find((x) => x.id === p.id);
    return pill && S.ds.byName[pill.field];
  }

  function canDrop(p, zone) {
    const f = payloadField(p);
    if (!f) return false;
    if (zone === 'trash') return p.kind === 'pill';
    if (zone === 'filters') return f.type !== 'records';
    if (f.type === 'records') return zone === 'values';
    return true;
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !S.ds) return;
    const src = e.target.closest('[data-drag]');
    if (!src || e.target.closest('[data-remove]')) return;
    const payload = src.dataset.drag === 'field'
      ? { kind: 'field', field: src.dataset.field }
      : { kind: 'pill', shelf: src.dataset.shelf, id: src.dataset.pill };
    D.s = { src, payload, x0: e.clientX, y0: e.clientY, started: false };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', endDrag, { once: true });
  }

  function startDrag(d) {
    d.started = true;
    closeMenu();
    const f = payloadField(d.payload);
    const asMeasure = d.payload.kind === 'pill' ? d.src.classList.contains('mea') : isMeasureField(f);
    const ghost = document.createElement('div');
    ghost.className = 'pill drag-ghost ' + (asMeasure ? 'mea' : 'dim');
    ghost.innerHTML = `<span class="pill-text">${esc(d.payload.kind === 'pill' ? d.src.querySelector('.pill-text').textContent : f.name)}</span>`;
    document.body.appendChild(ghost);
    d.ghost = ghost;
    if (d.payload.kind === 'pill') d.src.classList.add('drag-src');
    document.body.classList.add('is-dragging');
    $$('[data-drop]').forEach((z) => z.classList.toggle('can-drop', canDrop(d.payload, z.dataset.drop)));
    SFX.play('pick');
  }

  function onPointerMove(e) {
    const d = D.s;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      startDrag(d);
    }
    e.preventDefault();
    d.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    let tgt = under && under.closest('[data-drop]');
    if (tgt && !tgt.classList.contains('can-drop')) tgt = null;
    if (tgt !== d.target) {
      if (d.target) d.target.classList.remove('drop-hover');
      if (tgt) tgt.classList.add('drop-hover');
      d.target = tgt;
    }
    d.ghost.classList.toggle('will-remove', !tgt && d.payload.kind === 'pill');
    // insertion caret for shelves
    let caret = $('.drop-caret');
    if (tgt && tgt.classList.contains('shelf-drop') && SHELVES.includes(tgt.dataset.drop)) {
      const pills = $$(':scope > .pill:not(.drag-src)', tgt);
      let j = pills.length;
      for (let k = 0; k < pills.length; k++) {
        const r = pills[k].getBoundingClientRect();
        if (e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2)) { j = k; break; }
      }
      d.index = j;
      if (!caret) { caret = document.createElement('span'); caret.className = 'drop-caret'; }
      if (tgt.dataset.drop === 'color') caret.remove();
      else if (pills[j]) tgt.insertBefore(caret, pills[j]);
      else tgt.appendChild(caret);
    } else if (caret) caret.remove();
  }

  function onPointerUp(e) {
    const d = D.s;
    window.removeEventListener('pointermove', onPointerMove);
    if (!d || !d.started) { D.s = null; return; }
    D.justDragged = true;
    setTimeout(() => (D.justDragged = false), 0);
    try { performDrop(d, e); } finally { endDrag(); }
  }

  function endDrag() {
    const d = D.s;
    window.removeEventListener('pointermove', onPointerMove);
    if (d) {
      if (d.ghost) d.ghost.remove();
      if (d.src) d.src.classList.remove('drag-src');
    }
    const caret = $('.drop-caret');
    if (caret) caret.remove();
    $$('.can-drop, .drop-hover').forEach((z) => z.classList.remove('can-drop', 'drop-hover'));
    document.body.classList.remove('is-dragging');
    D.s = null;
  }

  function poof(x, y) {
    const p = document.createElement('div');
    p.className = 'poof';
    p.style.left = x + 'px'; p.style.top = y + 'px';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 500);
  }

  function removePill(shelf, id) {
    const arr = sheet().shelves[shelf];
    const k = arr.findIndex((x) => x.id === id);
    if (k >= 0) arr.splice(k, 1);
  }

  function performDrop(d, e) {
    const p = d.payload, t = d.target, sh = sheet();
    if (!t || t.dataset.drop === 'trash') {
      if (p.kind === 'pill') { removePill(p.shelf, p.id); poof(e.clientX, e.clientY); SFX.play('remove'); invalidate('shelves', 'viz'); }
      return;
    }
    const zone = t.dataset.drop;
    if (zone === 'filters') { addFilter(payloadField(p).name); SFX.play('filter'); return; }
    let pill;
    if (p.kind === 'pill') {
      const arr = sh.shelves[p.shelf];
      const k = arr.findIndex((x) => x.id === p.id);
      pill = arr.splice(k, 1)[0];
      if (zone !== p.shelf) {
        const f = S.ds.byName[pill.field];
        if (zone === 'values' || p.shelf === 'values') pill.agg = aggFor(f, zone);
      }
    } else pill = newPill(p.field, zone);
    if (zone === 'color') sh.shelves.color = [pill];
    else sh.shelves[zone].splice(d.index == null ? sh.shelves[zone].length : d.index, 0, pill);
    justDropped = pill.id;
    SFX.play('drop');
    invalidate('shelves', 'viz');
  }

  /* ======================================================== quick actions */

  function quickAdd(fieldName, shelf) {
    const f = S.ds.byName[fieldName];
    const sh = sheet();
    if (!shelf) {
      if (isMeasureField(f)) shelf = 'values';
      else if (f.type === 'date') shelf = 'columns';
      else shelf = sh.shelves.rows.length && !sh.shelves.columns.length ? 'columns' : 'rows';
    }
    if (shelf === 'filters') { addFilter(fieldName); SFX.play('filter'); return; }
    const pill = newPill(fieldName, shelf);
    if (shelf === 'color') sh.shelves.color = [pill]; else sh.shelves[shelf].push(pill);
    justDropped = pill.id;
    SFX.play('drop');
    invalidate('shelves', 'viz');
  }

  function swapAxes() {
    const sh = sheet();
    [sh.shelves.rows, sh.shelves.columns] = [sh.shelves.columns, sh.shelves.rows];
    sh.pivotSort = null;
    SFX.play('drop');
    invalidate('shelves', 'viz');
  }

  /* ================================================================ menus */

  function showMenu(anchor, items) {
    const m = $('#menu');
    m.innerHTML = items.map((it, j) => it.sep ? '<div class="menu-sep"></div>'
      : it.head ? `<div class="menu-head">${esc(it.head)}</div>`
      : `<button class="menu-item${it.checked ? ' checked' : ''}" data-mi="${j}"${it.disabled ? ' disabled' : ''}>${it.checked ? '▶ ' : ''}${esc(it.label)}</button>`).join('');
    m.hidden = false;
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = Math.min(r.left, window.innerWidth - mw - 8), y = r.bottom + 4;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    m.style.left = Math.max(8, x) + 'px'; m.style.top = y + 'px';
    m.onclick = (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = items[+b.dataset.mi];
      closeMenu();
      SFX.play('click');
      it.action && it.action();
    };
    const first = m.querySelector('.menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() { const m = $('#menu'); if (!m.hidden) { m.hidden = true; m.innerHTML = ''; } }

  function pillMenu(el) {
    const shelf = el.dataset.shelf, sh = sheet();
    const pill = sh.shelves[shelf].find((x) => x.id === el.dataset.pill);
    if (!pill) return;
    const f = S.ds.byName[pill.field];
    const items = [];
    const asMeasure = shelf === 'values' || (shelf === 'color' && isMeasureField(f));
    if (asMeasure) {
      items.push({ head: 'AGGREGATION' });
      T.AGGS.filter(([k]) => T.allowedAggs(f).includes(k)).forEach(([k, label]) =>
        items.push({ label, checked: T.measureSpec(S.ds, pill).agg === k, action: () => { pill.agg = k; invalidate('shelves', 'viz'); } }));
    } else if (f.type === 'date') {
      items.push({ head: 'DATE LEVEL' });
      T.GRAINS.forEach(([k, label]) => items.push({ label, checked: pill.grain === k, action: () => { pill.grain = k; invalidate('shelves', 'viz'); } }));
    }
    if (items.length) items.push({ sep: true });
    SHELVES.filter((s) => s !== shelf && canDrop({ kind: 'pill', shelf, id: pill.id }, s)).forEach((s) =>
      items.push({ label: 'MOVE TO ' + s.toUpperCase(), action: () => { removePill(shelf, pill.id); if (s === 'values' || shelf === 'values') pill.agg = aggFor(f, s); if (s === 'color') sh.shelves.color = [pill]; else sh.shelves[s].push(pill); invalidate('shelves', 'viz'); } }));
    if (f.type !== 'records') items.push({ label: 'FILTER ON ' + f.name.toUpperCase(), action: () => addFilter(f.name) });
    items.push({ label: 'REMOVE', action: () => { removePill(shelf, pill.id); SFX.play('remove'); invalidate('shelves', 'viz'); } });
    showMenu(el, items);
  }

  function fieldMenu(el, at) {
    const f = S.ds.byName[el.dataset.field];
    const items = [{ head: f.name.toUpperCase() }];
    ['columns', 'rows', 'values', 'color'].forEach((s) => {
      if (canDrop({ kind: 'field', field: f.name }, s)) items.push({ label: 'ADD TO ' + s.toUpperCase(), action: () => quickAdd(f.name, s) });
    });
    if (f.type !== 'records') items.push({ label: 'ADD AS FILTER', action: () => { addFilter(f.name); SFX.play('filter'); } });
    if (f.type !== 'records') {
      items.push({ sep: true });
      items.push(isMeasureField(f)
        ? { label: 'CONVERT TO DIMENSION', action: () => { f.role = 'dimension'; invalidate(); } }
        : { label: 'CONVERT TO MEASURE', disabled: f.type !== 'number', action: () => { f.role = 'measure'; invalidate(); } });
    }
    showMenu(at || el, items);
  }

  /* ================================================================ files */

  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const baseName = () => (S.ds ? S.ds.name.replace(/\.[^.]+$/, '') : 'tatko');

  function showLoading(text) {
    const o = $('#loading');
    $('.loading-text', o).textContent = text;
    o.hidden = false;
  }
  function hideLoading() { $('#loading').hidden = true; }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

  async function loadCSVFile(file) {
    showLoading('LOADING ' + file.name.toUpperCase());
    await nextFrame();
    try {
      const text = T.decode(await file.arrayBuffer());
      await nextFrame();
      setDataset(T.fromCSV(text, file.name));
    } catch (e) {
      console.error(e);
      toast('GAME OVER: ' + e.message, 'error'); SFX.play('error');
    } finally { hideLoading(); }
  }

  async function loadDemo(preset, instant) {
    if (instant) return setDataset(T.fromCSV(window.TATKO_DEMO_CSV, 'pixel-mart-sales.csv'), preset); // deep link: no overlay
    showLoading('LOADING DEMO CARTRIDGE');
    await nextFrame();
    try {
      setDataset(T.fromCSV(window.TATKO_DEMO_CSV, 'pixel-mart-sales.csv'), preset);
    } finally { hideLoading(); }
  }

  const signature = (ds) => ds.fields.map((f) => f.name + ':' + f.type).join('|');

  function sanitizeSheets(sheets) {
    const ok = (p) => p && S.ds.byName[p.field];
    return (sheets || []).map((s) => {
      const sh = Object.assign(newSheet(s.name || 'LEVEL'), s);
      sh.opts = Object.assign(newSheet('').opts, s.opts || {});
      sh.shelves = {};
      SHELVES.forEach((k) => (sh.shelves[k] = ((s.shelves || {})[k] || []).filter(ok).map((p) => Object.assign({}, p, { id: uid('p') }))));
      if (!T.Charts.MARKS.some((m) => m.id === sh.mark)) sh.mark = 'auto';
      return sh;
    });
  }
  function sanitizeFilters(filters) {
    return (filters || []).filter((f) => f && S.ds.byName[f.field] && S.ds.byName[f.field].values).map((f) => Object.assign({ excluded: [], search: '' }, f));
  }
  function applyRoles(roles) {
    if (!roles) return;
    Object.entries(roles).forEach(([name, role]) => { const f = S.ds.byName[name]; if (f && f.type !== 'records') f.role = role; });
  }

  function setDataset(ds, preset) {
    S.ds = ds;
    S.filters = [];
    S.sheets = [newSheet('LEVEL 1')];
    S.active = 0;
    const saved = store.get('session.' + signature(ds), null);
    if (preset) applyPreset(preset);
    else if (S.pendingGame) { applyGame(S.pendingGame); S.pendingGame = null; toast('SAVED GAME RESUMED'); }
    else if (saved && saved.sheets) {
      applyRoles(saved.roles);
      const sheets = sanitizeSheets(saved.sheets);
      if (sheets.length) { S.sheets = sheets; S.active = Math.min(saved.active || 0, sheets.length - 1); }
      S.filters = sanitizeFilters(saved.filters);
      toast('WELCOME BACK! LAST LAYOUT FOR THIS FILE RESTORED');
    } else toast(ds.n.toLocaleString() + ' ROWS LOADED · ' + (ds.fields.length - 1) + ' FIELDS');
    refilter();
    S.leftTab = 'fields';
    SFX.play('start');
    invalidate();
  }

  let saveTimer = 0;
  function autosave() {
    if (!S.ds) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('session.' + signature(S.ds), gameState()), 400);
  }

  function gameState() {
    const roles = {};
    S.ds.fields.forEach((f) => { if (f.type !== 'records') roles[f.name] = f.role; });
    return { sheets: S.sheets, active: S.active, filters: S.filters, roles };
  }

  function saveGame() {
    if (!S.ds) { toast('LOAD A CSV FIRST', 'error'); SFX.play('error'); return; }
    const game = Object.assign({ tatko: VERSION, savedAt: new Date().toISOString(), dataset: { name: S.ds.name, fields: S.ds.fields.filter((f) => f.type !== 'records').map((f) => ({ name: f.name, type: f.type })) }, themeCss: S.themeCss }, gameState());
    download(baseName() + '.tatko.json', JSON.stringify(game, null, 2), 'application/json');
    toast('GAME SAVED (LAYOUT, FILTERS & THEME - NOT THE DATA)');
    SFX.play('drop');
  }

  function applyGame(game) {
    if (game.themeCss) setTheme(game.themeCss, { silent: true });
    if (!S.ds) return;
    applyRoles(game.roles);
    const sheets = sanitizeSheets(game.sheets);
    S.sheets = sheets.length ? sheets : [newSheet('LEVEL 1')];
    S.active = Math.min(game.active || 0, S.sheets.length - 1);
    S.filters = sanitizeFilters(game.filters);
  }

  async function loadGameFile(file) {
    try {
      const game = JSON.parse(await file.text());
      if (!game || !game.sheets) throw new Error('NOT A TATKO SAVE FILE');
      if (!S.ds) {
        S.pendingGame = game;
        if (game.themeCss) setTheme(game.themeCss, { silent: true });
        toast('SAVE LOADED · NOW INSERT ' + ((game.dataset && game.dataset.name) || 'THE MATCHING CSV').toUpperCase());
        SFX.play('drop');
        return;
      }
      const before = JSON.stringify(game.sheets).length;
      applyGame(game);
      refilter();
      toast(JSON.stringify(S.sheets).length < before * 0.7 ? 'GAME LOADED · SOME FIELDS WERE MISSING FROM THIS CSV' : 'GAME LOADED');
      SFX.play('start');
      invalidate();
    } catch (e) { toast('GAME OVER: ' + e.message, 'error'); SFX.play('error'); }
  }

  async function loadThemeFile(file) { setTheme(await file.text()); }

  function exportMenu(anchor) {
    if (!S.ds) { toast('LOAD A CSV FIRST', 'error'); SFX.play('error'); return; }
    const plot = $('#viz .plot');
    const view = S.lastView;
    showMenu(anchor, [
      { head: 'EXPORT' },
      { label: 'CHART AS PNG', disabled: !(plot && plot.data), action: () => Plotly.downloadImage(plot, { format: 'png', filename: baseName() + '-' + sheet().name.toLowerCase().replace(/\s+/g, '-'), scale: 2, width: plot.clientWidth, height: plot.clientHeight }) },
      { label: 'CHART AS SVG', disabled: !(plot && plot.data), action: () => Plotly.downloadImage(plot, { format: 'svg', filename: baseName(), width: plot.clientWidth, height: plot.clientHeight }) },
      { label: view === 'table' ? 'PIVOT TABLE AS CSV' : 'VIEW DATA AS CSV', disabled: view === 'empty', action: () => {
        const csv = view === 'table' && S.lastPivot ? S.lastPivot.csv() : T.toCSV(T.Charts.exportRows(S.ds, S.idx, sheet()));
        download(baseName() + '-view.csv', csv, 'text/csv');
      } },
      { label: 'FILTERED ROWS AS CSV', action: () => {
        const fs = S.ds.fields.filter((f) => f.values);
        const rows = [fs.map((f) => f.name)];
        for (const i of S.idx) rows.push(fs.map((f) => { const v = f.values[i]; return v === null ? '' : f.type === 'date' ? T.fmtExact(v) : v; }));
        download(baseName() + '-filtered.csv', T.toCSV(rows), 'text/csv');
      } },
    ]);
  }

  /* ================================================================ toast */

  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 5000 : 2800);
  }

  /* ================================================================= help */

  function showHelp() {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="How to play">
      <h2>HOW TO PLAY</h2>
      <ol class="howto">
        <li><b>INSERT A CSV</b> - LOAD CSV, or drop a file anywhere. Comma, semicolon, tab and pipe files are detected automatically.</li>
        <li><b>DRAG FIELDS</b> from the left onto <b>COLUMNS</b>, <b>ROWS</b>, <b>VALUES</b> and <b>COLOR</b>. Blue pills are dimensions, green pills are measures.</li>
        <li><b>PICK A MARK</b> - or leave AUTO and Tatko chooses.</li>
        <li><b>PIVOT</b> - drag pills between shelves, reorder them, or hit ⇄ to swap rows and columns. Click table headers to sort.</li>
        <li><b>TUNE</b> - click a pill to change its aggregation (SUM, AVG…) or date level (YEAR, MONTH…).</li>
        <li><b>FILTER</b> - drop a field on FILTERS (shelf or tab). Filters apply to every level.</li>
        <li><b>REMOVE</b> - drag a pill off its shelf, or hit its ×.</li>
        <li><b>THEME CSS</b> - load a .css file with your colors and fonts; charts and tables follow it.</li>
        <li><b>SAVE / LOAD</b> - store your layout, filters and theme in a .tatko.json file. Data stays in the CSV.</li>
      </ol>
      <div class="keys"><span><kbd>DBL-CLICK</kbd> add field</span><span><kbd>RIGHT-CLICK</kbd> field options</span><span><kbd>DEL</kbd> remove focused pill</span><span><kbd>ESC</kbd> close</span></div>
      <p class="privacy">YOUR DATA NEVER LEAVES THIS COMPUTER. TATKO RUNS ENTIRELY IN YOUR BROWSER.</p>
      <button class="btn btn-primary" data-close-modal>CONTINUE ▶</button>
    </div>`;
    m.hidden = false;
    $('[data-close-modal]', m).focus();
  }
  function closeModal() { $('#modal').hidden = true; }

  /* ============================================================== presets */

  function applyPreset(name) {
    const P = (field, extra) => Object.assign(newPill(field, extra && extra.shelf), extra || {});
    const sh = sheet();
    const set = (cfg) => { Object.assign(sh.shelves, cfg.shelves); if (cfg.mark) sh.mark = cfg.mark; if (cfg.opts) Object.assign(sh.opts, cfg.opts); };
    const presets = {
      table: () => set({ shelves: { rows: [P('Region'), P('Category')], columns: [P('Order Date', { grain: 'year' })], values: [P('Revenue', { shelf: 'values' })] }, mark: 'table', opts: { heat: true } }),
      bar: () => set({ shelves: { columns: [P('Category')], values: [P('Revenue', { shelf: 'values' })], color: [P('Region')] }, mark: 'stacked', opts: { sort: 'desc' } }),
      line: () => set({ shelves: { columns: [P('Order Date', { grain: 'month' })], values: [P('Revenue', { shelf: 'values' })], color: [P('Channel')] }, mark: 'line' }),
      scatter: () => set({ shelves: { rows: [P('Product')], values: [P('Revenue', { shelf: 'values' }), P('Profit', { shelf: 'values' }), P('Units', { shelf: 'values' })], color: [P('Category')] }, mark: 'scatter' }),
      treemap: () => set({ shelves: { rows: [P('Category'), P('Product')], values: [P('Revenue', { shelf: 'values' })] }, mark: 'treemap' }),
      kpi: () => set({ shelves: { values: [P('Revenue', { shelf: 'values' }), P('Profit', { shelf: 'values' }), P('Units', { shelf: 'values' }), P(T.RECORDS, { shelf: 'values' })] }, mark: 'kpi' }),
    };
    try { (presets[name] || presets.table)(); } catch (e) { console.warn('preset failed', e); }
  }

  /* ============================================================= bindings */

  function bindGlobal() {
    document.addEventListener('pointerdown', onPointerDown);

    document.addEventListener('click', (e) => {
      if (D.justDragged) return;
      if (!e.target.closest('#menu') && !e.target.closest('.pill:not(.flt)') && !e.target.closest('[data-action="export"]')) closeMenu();
      const act = e.target.closest('[data-action]');
      if (act) return doAction(act.dataset.action, act);
      if (e.target.closest('[data-close-modal]') || e.target.id === 'modal') return closeModal();
      const tab = e.target.closest('.sidebar .tab');
      if (tab) { S.leftTab = tab.dataset.tab; SFX.play('click'); return invalidate('filters', 'theme'); }
      const preset = e.target.closest('[data-preset]');
      if (preset) return setTheme(T.Theme.PRESETS[preset.dataset.preset]);
      if (!S.ds) return;
      const x = e.target.closest('[data-remove]');
      if (x) { const pe = x.closest('.pill'); removePill(pe.dataset.shelf, pe.dataset.pill); SFX.play('remove'); return invalidate('shelves', 'viz'); }
      const gf = e.target.closest('[data-goto-filter]');
      if (gf) {
        S.leftTab = 'filters'; invalidate('filters');
        requestAnimationFrame(() => { const c = $(`.filter-card[data-fid="${gf.dataset.gotoFilter}"]`); if (c) { c.scrollIntoView({ block: 'nearest' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 900); } });
        return;
      }
      const pill = e.target.closest('.pill[data-pill]');
      if (pill) return pillMenu(pill);
      const mark = e.target.closest('[data-mark]');
      if (mark) { sheet().mark = mark.dataset.mark; SFX.play('click'); return invalidate('shelves', 'viz'); }
      const opt = e.target.closest('[data-opt]');
      if (opt) { const o = sheet().opts; o[opt.dataset.opt] = !o[opt.dataset.opt]; SFX.play('click'); return invalidate('shelves', 'viz'); }
      if (e.target.closest('[data-opt-sort]')) {
        const o = sheet().opts; o.sort = { label: 'desc', desc: 'asc', asc: 'label' }[o.sort || 'label'];
        SFX.play('click'); return invalidate('shelves', 'viz');
      }
      if (e.target.closest('[data-swap]')) return swapAxes();
    });

    document.addEventListener('dblclick', (e) => {
      const f = e.target.closest('.field[data-field]');
      if (f && S.ds) quickAdd(f.dataset.field);
    });
    document.addEventListener('contextmenu', (e) => {
      const f = e.target.closest('.field[data-field]');
      if (f && S.ds) { e.preventDefault(); fieldMenu(f, { x: e.clientX, y: e.clientY }); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenu(); closeModal(); if (D.s) endDrag(); return; }
      const a = document.activeElement;
      if (!a || !S.ds) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && a.matches('.pill[data-pill]')) {
        removePill(a.dataset.shelf, a.dataset.pill); SFX.play('remove'); invalidate('shelves', 'viz'); e.preventDefault();
      } else if (e.key === 'Enter' && a.matches('.field[data-field]')) { quickAdd(a.dataset.field); e.preventDefault(); }
      else if (e.key === 'Enter' && a.matches('.pill[data-pill]')) { pillMenu(a); e.preventDefault(); }
    });

    $('#fieldSearch').addEventListener('input', (e) => { S.fieldSearch = e.target.value; renderFields(); });

    // Native file drop anywhere: .csv -> data, .css -> theme, .json -> saved game
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; document.body.classList.add('file-over'); } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; document.body.classList.remove('file-over'); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; document.body.classList.remove('file-over');
      const file = e.dataTransfer.files[0];
      if (file) routeFile(file);
    });

    $('#csvInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadCSVFile(f); });
    $('#themeInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadThemeFile(f); });
    $('#gameInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadGameFile(f); });
  }

  function routeFile(file) {
    const n = file.name.toLowerCase();
    if (n.endsWith('.css')) return loadThemeFile(file);
    if (n.endsWith('.json')) return loadGameFile(file);
    return loadCSVFile(file);
  }

  function doAction(action, el) {
    SFX.play('click');
    switch (action) {
      case 'open-csv': return $('#csvInput').click();
      case 'demo': return loadDemo();
      case 'open-theme': return $('#themeInput').click();
      case 'save-game': return saveGame();
      case 'load-game': return $('#gameInput').click();
      case 'export': return exportMenu(el);
      case 'help': return showHelp();
      case 'theme-template': return download('tatko-theme.css', T.Theme.toCSS(S.theme), 'text/css');
      case 'toggle-sfx':
        SFX.on = !SFX.on; store.set('sfx', SFX.on); syncToggles(); if (SFX.on) SFX.play('drop'); return;
      case 'toggle-crt':
        document.body.classList.toggle('crt'); store.set('crt', document.body.classList.contains('crt')); return syncToggles();
    }
  }

  function syncToggles() {
    const sfx = $('[data-action="toggle-sfx"]'), crt = $('[data-action="toggle-crt"]');
    sfx.setAttribute('aria-pressed', SFX.on); sfx.textContent = SFX.on ? 'SFX ON' : 'SFX OFF';
    const c = document.body.classList.contains('crt');
    crt.setAttribute('aria-pressed', c); crt.textContent = c ? 'CRT ON' : 'CRT OFF';
  }

  /* ================================================================= boot */

  function boot() {
    if (!window.Plotly) console.warn('Plotly failed to load - charts disabled');
    if (!store.get('crt', true)) document.body.classList.remove('crt');
    syncToggles();
    bindGlobal(); bindFilterPanel(); bindSheets(); bindViz();
    setTheme(store.get('themeCss', null) || T.Theme.ARCADE, { silent: true });
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('theme') && T.Theme.PRESETS[cap(params.get('theme'))]) setTheme(T.Theme.PRESETS[cap(params.get('theme'))], { silent: true });
    if (params.has('nocrt')) { document.body.classList.remove('crt'); syncToggles(); }
    if (params.has('mute')) { SFX.on = false; syncToggles(); }
    invalidate();
    if (params.has('demo')) loadDemo(params.get('preset') || null, true);
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  // refresh(): re-apply filters and redraw everything (used by tests and the console).
  T.App = { state: S, setTheme, loadDemo, setDataset, refresh: () => { refilter(); invalidate(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
