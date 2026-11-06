/* Tatko - chart builder: maps shelves to Plotly figures (or KPI tiles). */
(function () {
  'use strict';
  const T = (window.Tatko = window.Tatko || {});

  const MAX_SUBPLOTS = 24;
  const MAX_SERIES = 8;
  const MAX_RAW_POINTS = 30000;
  const OTHER = '\u0002Other';

  const MARKS = [
    { id: 'auto', label: 'AUTO', tip: 'Let Tatko pick the best view for the fields on the shelves' },
    { id: 'table', label: 'TABLE', tip: 'Pivot table: ROWS x COLUMNS, aggregated VALUES' },
    { id: 'bar', label: 'BAR', tip: 'Bars per category (COLUMNS = vertical, ROWS only = horizontal). Extra ROWS = small multiples' },
    { id: 'stacked', label: 'STACK', tip: 'Stacked bars, split by the COLOR field' },
    { id: 'line', label: 'LINE', tip: 'Lines over a date or ordered field on COLUMNS' },
    { id: 'area', label: 'AREA', tip: 'Stacked areas over a date on COLUMNS' },
    { id: 'scatter', label: 'SCATTER', tip: 'Needs 2 VALUES (x, y), optional 3rd = size. Dimensions = one dot per group' },
    { id: 'pie', label: 'DONUT', tip: 'Share of one VALUE across a dimension' },
    { id: 'heatmap', label: 'HEAT', tip: 'COLUMNS x ROWS grid shaded by the first VALUE' },
    { id: 'treemap', label: 'TREE', tip: 'Nested rectangles: ROWS then COLUMNS dimensions, sized by the first VALUE' },
    { id: 'box', label: 'BOX', tip: 'Distribution of the first VALUE field per category' },
    { id: 'histogram', label: 'HISTO', tip: 'Distribution of the first VALUE field' },
    { id: 'kpi', label: 'SCORE', tip: 'Big-number score tiles for each VALUE' },
  ];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* --------------------------------------------------------------- helpers */

  function isMeasurePill(ds, p) {
    const f = ds.byName[p.field];
    return f && (f.type === 'records' || f.role === 'measure');
  }

  function autoMark(ds, sheet) {
    const S = sheet.shelves;
    const dims = S.columns.length + S.rows.length;
    if (!dims && !S.values.length && !S.color.length) return 'empty';
    if (!dims) return S.values.length ? 'kpi' : 'table';
    if (S.columns.length && S.rows.length) return 'table';
    if (!S.values.length) return 'table';
    const first = (S.columns[0] || S.rows[0]);
    const f = ds.byName[first.field];
    if (S.columns.length && f.type === 'date' && first.grain !== 'moy' && first.grain !== 'dow') return 'line';
    return 'bar';
  }
  function resolveMark(ds, sheet) { return sheet.mark === 'auto' ? autoMark(ds, sheet) : sheet.mark; }

  /** Colours follow the entity, never its rank: assigned over the FULL dataset. */
  const colorCache = new Map();
  function colorFolder(ds, spec, theme) {
    const ck = ds.name + '|' + ds.n + '|' + spec.label + '|' + theme.palette.join();
    if (colorCache.has(ck)) return colorCache.get(ck);
    const counts = new Map();
    for (let i = 0; i < ds.n; i++) { const k = spec.key(i); counts.set(k, (counts.get(k) || 0) + 1); }
    let keep = Array.from(counts.keys());
    const folds = keep.length > MAX_SERIES;
    if (folds) keep = keep.sort((a, b) => counts.get(b) - counts.get(a)).slice(0, MAX_SERIES - 1);
    keep.sort(T.cmp);
    const slot = new Map(keep.map((k, j) => [k, j]));
    const order = folds ? keep.concat([OTHER]) : keep;
    const res = {
      folds,
      fold: (k) => (slot.has(k) ? k : OTHER),
      color: (k) => (slot.has(k) ? theme.palette[slot.get(k) % theme.palette.length] : theme.other),
      rank: (k) => (slot.has(k) ? slot.get(k) : 1e9),
      label: (k) => (k === OTHER ? 'Other' : spec.fmt(k)),
      order,
    };
    colorCache.set(ck, res);
    return res;
  }

  function foldedSpec(spec, cf) {
    return Object.assign({}, spec, { key: (i) => cf.fold(spec.key(i)), fmt: cf.label });
  }

  function measures(ds, sheet) {
    const m = sheet.shelves.values.map((p) => T.measureSpec(ds, p));
    return m.length ? m : [T.measureSpec(ds, { field: T.RECORDS })];
  }

  function colorEncoding(ds, sheet, theme) {
    const p = sheet.shelves.color[0];
    if (!p) return {};
    if (isMeasurePill(ds, p)) return { measure: T.measureSpec(ds, p) };
    const spec = T.dimSpec(ds, p);
    const cf = colorFolder(ds, spec, theme);
    return { dim: foldedSpec(spec, cf), cf };
  }

  function axisBase(theme) {
    return {
      gridcolor: theme.grid, linecolor: theme.grid, zerolinecolor: theme.grid, zerolinewidth: 1,
      tickfont: { color: theme.muted }, automargin: true,
      title: { font: { color: theme.muted, size: theme.fontSize } },
    };
  }

  function baseLayout(theme, title) {
    return {
      paper_bgcolor: theme.background,
      plot_bgcolor: theme.plotBackground,
      font: { family: theme.fontFamily, size: theme.fontSize, color: theme.text },
      colorway: theme.palette,
      title: title ? { text: esc(title), x: 0.01, xanchor: 'left', y: 0.98, yanchor: 'top', font: { family: theme.titleFontFamily, size: theme.titleFontSize, color: theme.text } } : undefined,
      margin: { l: 70, r: 30, t: title ? 70 : 30, b: 60, pad: 4 },
      hoverlabel: { bgcolor: theme.background, bordercolor: theme.grid, font: { family: theme.fontFamily, size: theme.fontSize, color: theme.text } },
      legend: { font: { color: theme.text }, bgcolor: 'rgba(0,0,0,0)', itemsizing: 'constant' },
      barcornerradius: 4,
      bargap: 0.28,
      bargroupgap: 0.06,
      showlegend: false,
    };
  }

  function titleFor(meas, dims, color) {
    const m = meas.map((x) => x.label).join(', ');
    const parts = dims.map((d) => d.label);
    if (color) parts.push(color.label);
    return parts.length ? m + ' by ' + parts.join(', ') : m;
  }

  const message = (text, sub) => ({ kind: 'message', text, sub });

  /* -------------------------------------------- bar / stacked / line / area */

  function seriesChart(ctx, mark) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    let catPills = S.columns, facetPills = S.rows, horizontal = false;
    if (!catPills.length) { catPills = S.rows; facetPills = []; horizontal = mark === 'bar' || mark === 'stacked'; }
    const cats = catPills.map((p) => T.dimSpec(ds, p));
    const facets = facetPills.map((p) => T.dimSpec(ds, p));
    const meas = measures(ds, sheet);
    const enc = colorEncoding(ds, sheet, theme);
    const series = enc.dim || null;
    const allMeas = enc.measure && (mark === 'bar') ? meas.concat([enc.measure]) : meas;

    const dims = facets.concat(cats, series ? [series] : []);
    const groups = T.groupBy(idx, dims, allMeas);
    if (!groups.length) return message('NO DATA', 'NO ROWS MATCH THE CURRENT FILTERS');

    const F = facets.length, K = cats.length;
    const facetMap = new Map(), catMap = new Map(), serMap = new Map(), cell = new Map();
    for (const g of groups) {
      const fk = g.keys.slice(0, F), kk = g.keys.slice(F, F + K), sk = series ? g.keys[F + K] : null;
      const fs = T.joinKeys(fk), ks = T.joinKeys(kk), ss = T.keyStr(sk);
      if (!facetMap.has(fs)) facetMap.set(fs, { keys: fk });
      let c = catMap.get(ks);
      if (!c) { c = { keys: kk, total: 0 }; catMap.set(ks, c); }
      if (g.vals[0] !== null) c.total += g.vals[0];
      if (series && !serMap.has(ss)) serMap.set(ss, { key: sk });
      cell.set(fs + '|' + ks + '|' + ss, g.vals);
    }

    const timeAxis = K === 1 && cats[0].isTime && (mark === 'line' || mark === 'area');
    let catList = Array.from(catMap, ([s, c]) => Object.assign(c, { s }));
    const sortable = !(K && cats[0].isTime) && sheet.opts.sort && sheet.opts.sort !== 'label';
    if (sortable) catList.sort((a, b) => (sheet.opts.sort === 'desc' ? b.total - a.total : a.total - b.total));
    else catList.sort((a, b) => T.cmpKeys(a.keys, b.keys));
    catList.forEach((c) => {
      c.label = K ? c.keys.map((k, j) => cats[j].fmt(k)).join(' · ') : 'All';
      c.x = timeAxis ? (c.keys[0] === null ? null : new Date(c.keys[0]).toISOString().slice(0, 19)) : c.label;
    });
    if (timeAxis) catList = catList.filter((c) => c.x !== null);

    const M = meas.length;
    let facetList = Array.from(facetMap, ([s, f]) => Object.assign(f, { s })).sort((a, b) => T.cmpKeys(a.keys, b.keys));
    const maxFacets = Math.max(1, Math.floor(MAX_SUBPLOTS / M));
    const facetsTruncated = facetList.length > maxFacets;
    facetList = facetList.slice(0, maxFacets);
    const nF = facetList.length;

    let serList = series ? Array.from(serMap.values()) : [{ key: null }];
    if (series) serList.sort((a, b) => enc.cf.rank(a.key) - enc.cf.rank(b.key));

    const data = [];
    const layout = baseLayout(theme, titleFor(meas, facets.concat(cats), series));
    const multi = nF * M > 1;
    const annotations = [];
    const fmtV = (mi, v) => (v === null ? '' : allMeas[mi].fmt(v));

    facetList.forEach((f, fi) => {
      meas.forEach((m, mi) => {
        const a = fi * M + mi + 1;
        const ax = a === 1 ? '' : String(a);
        serList.forEach((s) => {
          const ss = T.keyStr(s.key);
          const vals = catList.map((c) => { const v = cell.get(f.s + '|' + c.s + '|' + ss); return v ? v[mi] : null; });
          const xs = catList.map((c) => c.x);
          const name = series ? series.fmt(s.key) : m.label;
          const color = series ? enc.cf.color(s.key) : theme.palette[0];
          const custom = vals.map((v) => fmtV(mi, v));
          const t = {
            name, legendgroup: name, showlegend: a === 1 && !!series,
            xaxis: 'x' + ax, yaxis: 'y' + ax,
            customdata: catList.map((c, j) => [c.label, custom[j]]),
            hovertemplate: `<b>%{customdata[0]}</b><br>${esc(m.label)}: %{customdata[1]}<extra>${series ? esc(name) : ''}</extra>`,
          };
          if (mark === 'bar' || mark === 'stacked') {
            Object.assign(t, {
              type: 'bar', orientation: horizontal ? 'h' : 'v',
              x: horizontal ? vals : xs, y: horizontal ? xs : vals,
              marker: { color, line: { width: mark === 'stacked' ? 2 : 0, color: theme.plotBackground } },
            });
            if (enc.measure && mark === 'bar') {
              const cv = catList.map((c) => { const v = cell.get(f.s + '|' + c.s + '|' + ss); return v ? v[M] : null; });
              t.marker = { color: cv, colorscale: [[0, theme.sequential[0]], [1, theme.sequential[theme.sequential.length - 1]]], showscale: a === 1, colorbar: { title: { text: esc(enc.measure.label), side: 'right' }, outlinewidth: 0, tickfont: { color: theme.muted } } };
            }
            if (sheet.opts.labels) {
              t.text = custom; t.textposition = mark === 'stacked' ? 'inside' : 'outside';
              t.texttemplate = '%{text}'; t.cliponaxis = false;
              t.textfont = { color: mark === 'stacked' ? '#ffffff' : theme.text };
            }
          } else {
            Object.assign(t, {
              type: 'scatter', x: xs, y: vals,
              mode: xs.length <= 60 ? 'lines+markers' : 'lines',
              line: { width: 2, color, shape: 'linear' },
              marker: { size: 8, color, line: { width: 2, color: theme.plotBackground } },
              connectgaps: false,
            });
            if (mark === 'area') { t.stackgroup = 'g' + a; t.fillcolor = T.Theme.mix(color, theme.plotBackground, 0.25); t.mode = 'lines'; }
            if (sheet.opts.labels) { t.mode = 'lines+markers+text'; t.text = custom; t.textposition = 'top center'; t.textfont = { color: theme.text }; }
          }
          data.push(t);
        });

        const catAxis = Object.assign(axisBase(theme), { showgrid: false });
        const valAxis = Object.assign(axisBase(theme), { rangemode: 'tozero', separatethousands: true });
        if (timeAxis) catAxis.type = 'date';
        else Object.assign(catAxis, { type: 'category', categoryorder: 'array', categoryarray: catList.map((c) => c.x) });
        if (horizontal) catAxis.autorange = 'reversed';
        if (!multi) {
          valAxis.title.text = esc(m.label);
          catAxis.title.text = esc(K ? cats.map((c) => c.label).join(' · ') : '');
        } else {
          const t = [F ? facets.map((d, j) => d.fmt(f.keys[j])).join(' · ') : '', M > 1 ? m.label : ''].filter(Boolean).join('  ·  ');
          annotations.push({ xref: `x${ax} domain`, yref: `y${ax} domain`, x: 0, y: 1.02, xanchor: 'left', yanchor: 'bottom', text: esc(t), showarrow: false, font: { color: theme.text, size: theme.fontSize } });
          if (fi < nF - 1 && !horizontal) catAxis.showticklabels = false;
        }
        layout['xaxis' + ax] = horizontal ? valAxis : catAxis;
        layout['yaxis' + ax] = horizontal ? catAxis : valAxis;
      });
    });

    if (multi) {
      layout.grid = { rows: nF, columns: M, pattern: 'independent', roworder: 'top to bottom', xgap: 0.12, ygap: nF > 1 ? 0.35 : 0.2 };
      layout.annotations = annotations;
    }
    layout.barmode = mark === 'stacked' ? 'stack' : 'group';
    if (series) layout.showlegend = true;
    const notes = [];
    if (facetsTruncated) notes.push('SHOWING ' + nF + ' OF ' + facetMap.size + ' PANELS');
    if (series && enc.cf.folds) notes.push('COLOR: TOP 7 VALUES + OTHER');
    if (enc.measure && mark !== 'bar') notes.push('A MEASURE ON COLOR IS ONLY USED BY BAR CHARTS');
    return { kind: 'plot', data, layout, minHeight: nF > 1 ? nF * 230 + 120 : 0, notes };
  }

  /* --------------------------------------------------------------- scatter */

  function scatter(ctx) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    const meas = S.values.map((p) => T.measureSpec(ds, p));
    if (meas.length < 2) return message('SCATTER NEEDS 2 VALUES', 'DROP TWO MEASURES ON VALUES: THE FIRST IS X, THE SECOND IS Y, A THIRD SETS DOT SIZE');
    const detail = S.columns.concat(S.rows).map((p) => T.dimSpec(ds, p));
    const enc = colorEncoding(ds, sheet, theme);
    const series = enc.dim || null;
    const m3 = meas.slice(0, 3);
    const points = []; // {x,y,size,ser,label}
    const rawOK = !detail.length && m3.every((m) => m.field.type === 'number');
    let sampled = false;
    if (rawOK) {
      const step = Math.max(1, Math.ceil(idx.length / MAX_RAW_POINTS));
      sampled = step > 1;
      for (let r = 0; r < idx.length; r += step) {
        const i = idx[r];
        const x = m3[0].get(i), y = m3[1].get(i);
        if (x === null || y === null) continue;
        points.push({ x, y, size: m3[2] ? m3[2].get(i) : null, ser: series ? series.key(i) : null, label: '' });
      }
    } else {
      const dims = detail.concat(series ? [series] : []);
      for (const g of T.groupBy(idx, dims, m3)) {
        if (g.vals[0] === null || g.vals[1] === null) continue;
        points.push({
          x: g.vals[0], y: g.vals[1], size: g.vals[2] ?? null,
          ser: series ? g.keys[detail.length] : null,
          label: detail.map((d, j) => d.fmt(g.keys[j])).join(' · '),
        });
      }
    }
    if (!points.length) return message('NO DATA', 'NO ROWS MATCH THE CURRENT FILTERS');
    let smin = Infinity, smax = -Infinity;
    if (m3[2]) points.forEach((p) => { if (p.size !== null) { smin = Math.min(smin, p.size); smax = Math.max(smax, p.size); } });
    const sizeOf = (v) => (v === null || !(smax > smin) ? 12 : 8 + 28 * Math.sqrt((v - smin) / (smax - smin)));

    const bySer = new Map();
    points.forEach((p) => { const k = T.keyStr(p.ser); if (!bySer.has(k)) bySer.set(k, { key: p.ser, pts: [] }); bySer.get(k).pts.push(p); });
    const serList = Array.from(bySer.values());
    if (series) serList.sort((a, b) => enc.cf.rank(a.key) - enc.cf.rank(b.key));

    const data = serList.map((s) => {
      const color = series ? enc.cf.color(s.key) : theme.palette[0];
      const t = {
        type: rawOK && s.pts.length > 5000 ? 'scattergl' : 'scatter', mode: 'markers',
        name: series ? series.fmt(s.key) : 'points', showlegend: !!series,
        x: s.pts.map((p) => p.x), y: s.pts.map((p) => p.y),
        text: s.pts.map((p) => p.label),
        customdata: s.pts.map((p) => [m3[0].fmt(p.x), m3[1].fmt(p.y), m3[2] ? m3[2].fmt(p.size) : '']),
        marker: { color, size: s.pts.map((p) => sizeOf(p.size)), opacity: 0.85, line: { width: 2, color: theme.plotBackground } },
        hovertemplate: (detail.length ? '<b>%{text}</b><br>' : '') + `${esc(m3[0].label)}: %{customdata[0]}<br>${esc(m3[1].label)}: %{customdata[1]}` + (m3[2] ? `<br>${esc(m3[2].label)}: %{customdata[2]}` : '') + `<extra>${series ? esc(series.fmt(s.key)) : ''}</extra>`,
      };
      return t;
    });
    const layout = baseLayout(theme, m3[1].label + ' vs ' + m3[0].label + (detail.length ? ' per ' + detail.map((d) => d.label).join(' · ') : ''));
    layout.xaxis = Object.assign(axisBase(theme), { title: { text: esc(m3[0].label), font: { color: theme.muted } } });
    layout.yaxis = Object.assign(axisBase(theme), { title: { text: esc(m3[1].label), font: { color: theme.muted } } });
    layout.showlegend = !!series;
    layout.hovermode = 'closest';
    const notes = [];
    if (sampled) notes.push('SHOWING A SAMPLE OF ' + points.length.toLocaleString() + ' ROWS');
    if (!rawOK && !detail.length) notes.push('ONE DOT PER COLOR VALUE - ADD DIMENSIONS TO SPLIT');
    if (enc.measure) notes.push('A MEASURE ON COLOR IS NOT USED BY SCATTER - USE A DIMENSION');
    return { kind: 'plot', data, layout, notes };
  }

  /* ------------------------------------------------------------------- pie */

  function pie(ctx) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    let pills = S.columns.concat(S.rows);
    if (!pills.length && S.color[0] && !isMeasurePill(ds, S.color[0])) pills = [S.color[0]];
    if (!pills.length) return message('DONUT NEEDS A DIMENSION', 'DROP A DIMENSION ON COLUMNS, ROWS OR COLOR');
    const cats = pills.map((p) => T.dimSpec(ds, p));
    const m = measures(ds, sheet)[0];
    let groups = T.groupBy(idx, cats, [m]).filter((g) => g.vals[0] !== null && g.vals[0] > 0);
    if (!groups.length) return message('NO DATA', 'A DONUT NEEDS POSITIVE VALUES');
    groups.sort((a, b) => b.vals[0] - a.vals[0]);
    let other = null;
    if (groups.length > MAX_SERIES) {
      other = groups.slice(MAX_SERIES - 1).reduce((s, g) => s + g.vals[0], 0);
      groups = groups.slice(0, MAX_SERIES - 1);
    }
    const labels = groups.map((g) => g.keys.map((k, j) => cats[j].fmt(k)).join(' · '));
    const values = groups.map((g) => g.vals[0]);
    let colors;
    if (cats.length === 1) {
      const cf = colorFolder(ds, cats[0], theme);
      colors = !cf.folds ? groups.map((g) => cf.color(g.keys[0])) : null;
    }
    if (!colors) colors = groups.map((_, j) => theme.palette[j % theme.palette.length]);
    if (other !== null) { labels.push('Other'); values.push(other); colors.push(theme.other); }
    const data = [{
      type: 'pie', hole: 0.55, sort: false, direction: 'clockwise', labels, values,
      marker: { colors, line: { color: theme.background, width: 2 } },
      textinfo: 'percent', textfont: { color: '#ffffff' }, insidetextorientation: 'horizontal',
      customdata: values.map((v) => m.fmt(v)),
      hovertemplate: '<b>%{label}</b><br>' + esc(m.label) + ': %{customdata}<br>%{percent}<extra></extra>',
    }];
    const layout = baseLayout(theme, titleFor([m], cats));
    layout.showlegend = true;
    return { kind: 'plot', data, layout, notes: other !== null ? ['TOP 7 SLICES + OTHER'] : [] };
  }

  /* --------------------------------------------------------------- heatmap */

  function heatmap(ctx) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    const xs = S.columns.map((p) => T.dimSpec(ds, p));
    const ys = S.rows.map((p) => T.dimSpec(ds, p));
    if (!xs.length && !ys.length) return message('HEATMAP NEEDS DIMENSIONS', 'DROP DIMENSIONS ON COLUMNS AND ROWS');
    const m = measures(ds, sheet)[0];
    const groups = T.groupBy(idx, xs.concat(ys), [m]);
    if (!groups.length) return message('NO DATA', 'NO ROWS MATCH THE CURRENT FILTERS');
    const X = new Map(), Y = new Map();
    groups.forEach((g) => {
      const xk = g.keys.slice(0, xs.length), yk = g.keys.slice(xs.length);
      X.set(T.joinKeys(xk), xk); Y.set(T.joinKeys(yk), yk);
    });
    const xl = Array.from(X).sort((a, b) => T.cmpKeys(a[1], b[1]));
    const yl = Array.from(Y).sort((a, b) => T.cmpKeys(a[1], b[1]));
    const xi = new Map(xl.map(([s], j) => [s, j])), yi = new Map(yl.map(([s], j) => [s, j]));
    const z = yl.map(() => xl.map(() => null));
    const zt = yl.map(() => xl.map(() => ''));
    groups.forEach((g) => {
      const r = yi.get(T.joinKeys(g.keys.slice(xs.length))), c = xi.get(T.joinKeys(g.keys.slice(0, xs.length)));
      z[r][c] = g.vals[0]; zt[r][c] = m.fmt(g.vals[0]);
    });
    const lab = (specs) => ([, keys]) => (specs.length ? keys.map((k, j) => specs[j].fmt(k)).join(' · ') : 'All');
    const data = [{
      type: 'heatmap', z, x: xl.map(lab(xs)), y: yl.map(lab(ys)),
      colorscale: [[0, theme.sequential[0]], [1, theme.sequential[theme.sequential.length - 1]]],
      xgap: 2, ygap: 2, customdata: zt, hoverongaps: false,
      hovertemplate: '<b>%{y} · %{x}</b><br>' + esc(m.label) + ': %{customdata}<extra></extra>',
      colorbar: { outlinewidth: 0, tickfont: { color: theme.muted }, title: { text: esc(m.label), side: 'right' } },
      texttemplate: sheet.opts.labels ? '%{customdata}' : undefined,
    }];
    const layout = baseLayout(theme, titleFor([m], xs.concat(ys)));
    layout.xaxis = Object.assign(axisBase(theme), { type: 'category', showgrid: false, title: { text: esc(xs.map((d) => d.label).join(' · ')), font: { color: theme.muted } } });
    layout.yaxis = Object.assign(axisBase(theme), { type: 'category', showgrid: false, autorange: 'reversed', title: { text: esc(ys.map((d) => d.label).join(' · ')), font: { color: theme.muted } } });
    layout.plot_bgcolor = theme.background;
    return { kind: 'plot', data, layout, notes: [] };
  }

  /* --------------------------------------------------------------- treemap */

  function treemap(ctx) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    const dims = S.rows.concat(S.columns).map((p) => T.dimSpec(ds, p));
    if (!dims.length) return message('TREEMAP NEEDS DIMENSIONS', 'DROP ONE OR MORE DIMENSIONS ON ROWS OR COLUMNS');
    const m = measures(ds, sheet)[0];
    const groups = T.groupBy(idx, dims, [m]);
    const cf = colorFolder(ds, dims[0], theme);
    const ids = [], labels = [], parents = [], values = [], colors = [], custom = [];
    const seen = new Set();
    let dropped = 0;
    for (const g of groups) {
      const v = g.vals[0];
      if (v === null || v <= 0) { dropped++; continue; }
      let pid = '';
      g.keys.forEach((k, l) => {
        const id = pid + '/' + T.keyStr(k);
        if (!seen.has(id)) {
          seen.add(id);
          const leaf = l === dims.length - 1;
          ids.push(id); labels.push(dims[l].fmt(k)); parents.push(pid);
          values.push(leaf ? v : 0);
          const base = cf.color(g.keys[0]);
          colors.push(l === 0 ? base : T.Theme.mix(base, theme.background, Math.min(0.15 * l, 0.45)));
          custom.push(leaf ? m.fmt(v) : '');
        }
        pid = id;
      });
    }
    if (!ids.length) return message('NO DATA', 'A TREEMAP NEEDS POSITIVE VALUES');
    const data = [{
      type: 'treemap', ids, labels, parents, values, branchvalues: 'remainder',
      marker: { colors, line: { color: theme.background, width: 2 } },
      customdata: custom, textinfo: 'label+value',
      texttemplate: '<b>%{label}</b><br>%{customdata}',
      hovertemplate: '<b>%{label}</b><br>' + esc(m.label) + ': %{value:,.4~g}<extra></extra>',
      textfont: { color: '#ffffff' }, pathbar: { visible: true, textfont: { color: theme.text } },
    }];
    const layout = baseLayout(theme, titleFor([m], dims));
    layout.margin = { l: 10, r: 10, t: 60, b: 10 };
    return { kind: 'plot', data, layout, notes: dropped ? [dropped + ' GROUPS WITH ZERO OR NEGATIVE VALUES HIDDEN'] : [] };
  }

  /* ------------------------------------------------------- box / histogram */

  function distribution(ctx, mark) {
    const { ds, idx, sheet, theme } = ctx;
    const S = sheet.shelves;
    const vp = S.values[0];
    const f = vp && ds.byName[vp.field];
    if (!f || f.type !== 'number') return message(mark === 'box' ? 'BOX NEEDS A NUMBER' : 'HISTOGRAM NEEDS A NUMBER', 'DROP A NUMERIC FIELD ON VALUES (RAW VALUES ARE USED, NOT THE AGGREGATE)');
    const cats = (S.columns.length ? S.columns : S.rows).map((p) => T.dimSpec(ds, p));
    const enc = colorEncoding(ds, sheet, theme);
    const series = enc.dim || null;
    const bySer = new Map();
    for (let r = 0; r < idx.length; r++) {
      const i = idx[r], v = f.values[i];
      if (v === null) continue;
      const sk = series ? series.key(i) : null, ks = T.keyStr(sk);
      let s = bySer.get(ks);
      if (!s) { s = { key: sk, x: [], y: [] }; bySer.set(ks, s); }
      s.y.push(v);
      if (cats.length) s.x.push(cats.map((c) => c.fmt(c.key(i))).join(' · '));
    }
    if (!bySer.size) return message('NO DATA', 'NO ROWS MATCH THE CURRENT FILTERS');
    const serList = Array.from(bySer.values());
    if (series) serList.sort((a, b) => enc.cf.rank(a.key) - enc.cf.rank(b.key));
    const layout = baseLayout(theme, (mark === 'box' ? 'Distribution of ' : 'Histogram of ') + f.name + (cats.length ? ' by ' + cats.map((c) => c.label).join(' · ') : ''));
    layout.showlegend = !!series;
    const data = serList.map((s) => {
      const color = series ? enc.cf.color(s.key) : theme.palette[0];
      const name = series ? series.fmt(s.key) : f.name;
      if (mark === 'box') {
        return {
          type: 'box', name, y: s.y, x: cats.length ? s.x : undefined, boxpoints: false,
          marker: { color }, line: { color, width: 2 }, fillcolor: T.Theme.mix(color, theme.plotBackground, 0.6),
          showlegend: !!series,
        };
      }
      return { type: 'histogram', name, x: s.y, nbinsx: 30, marker: { color, line: { color: theme.plotBackground, width: 2 } }, opacity: serList.length > 1 ? 0.7 : 1, showlegend: !!series };
    });
    if (mark === 'box') {
      layout.boxmode = series ? 'group' : 'overlay';
      if (cats.length) {
        const order = Array.from(new Set(serList.flatMap((s) => s.x))).sort((a, b) => T.cmp(a, b));
        layout.xaxis = Object.assign(axisBase(theme), { type: 'category', categoryorder: 'array', categoryarray: order, showgrid: false });
      } else layout.xaxis = Object.assign(axisBase(theme), { showticklabels: !!series, showgrid: false });
      layout.yaxis = Object.assign(axisBase(theme), { title: { text: esc(f.name), font: { color: theme.muted } } });
    } else {
      layout.barmode = 'overlay';
      layout.bargap = 0.04;
      layout.xaxis = Object.assign(axisBase(theme), { title: { text: esc(f.name), font: { color: theme.muted } } });
      layout.yaxis = Object.assign(axisBase(theme), { title: { text: 'Rows', font: { color: theme.muted } } });
    }
    return { kind: 'plot', data, layout, notes: cats.length && mark === 'histogram' ? ['HISTOGRAM IGNORES COLUMNS/ROWS - USE COLOR TO SPLIT'] : [] };
  }

  /* ------------------------------------------------------------------- KPI */

  function kpi(ctx) {
    const { ds, idx, sheet } = ctx;
    const meas = measures(ds, sheet);
    const g = T.groupBy(idx, [], meas)[0];
    const tiles = meas.map((m, j) => {
      const v = g ? g.vals[j] : null;
      return `<div class="kpi-tile"><div class="kpi-label">${esc(m.label)}</div><div class="kpi-value">${esc(v === null ? '--' : m.fmt(v))}</div></div>`;
    });
    const html = `<div class="kpi-grid"><div class="kpi-head">HI-SCORE</div>${tiles.join('')}<div class="kpi-foot">${idx.length.toLocaleString()} ROWS IN PLAY</div></div>`;
    const notes = sheet.shelves.columns.length + sheet.shelves.rows.length ? ['SCORE TILES IGNORE COLUMNS/ROWS'] : [];
    return { kind: 'html', html, notes };
  }

  /* --------------------------------------------------------------- dispatch */

  function build(ctx, mark) {
    switch (mark) {
      case 'bar': case 'stacked': case 'line': case 'area': return seriesChart(ctx, mark);
      case 'scatter': return scatter(ctx);
      case 'pie': return pie(ctx);
      case 'heatmap': return heatmap(ctx);
      case 'treemap': return treemap(ctx);
      case 'box': case 'histogram': return distribution(ctx, mark);
      case 'kpi': return kpi(ctx);
    }
    return message('UNKNOWN MARK', mark);
  }

  /** Data behind the current chart, for CSV export: grouped by every dim on the shelves. */
  function exportRows(ds, idx, sheet) {
    const S = sheet.shelves;
    const dimPills = S.columns.concat(S.rows, S.color.filter((p) => !isMeasurePill(ds, p)));
    const dims = dimPills.map((p) => T.dimSpec(ds, p));
    const meas = measures(ds, sheet);
    const groups = T.groupBy(idx, dims, meas).sort((a, b) => T.cmpKeys(a.keys, b.keys));
    return [dims.map((d) => d.label).concat(meas.map((m) => m.label))].concat(
      groups.map((g) => g.keys.map((k, j) => dims[j].fmt(k)).concat(g.vals))
    );
  }

  T.Charts = { MARKS, build, resolveMark, autoMark, isMeasurePill, exportRows };
})();
