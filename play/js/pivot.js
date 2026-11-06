/* Tatko - pivot table: multi-level rows x columns, subtotals, totals, sorting, heat. */
(function () {
  'use strict';
  const T = (window.Tatko = window.Tatko || {});

  const MAX_ROWS = 3000;
  const MAX_LEAF_COLS = 400;
  const LVL = '\u001e';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * Aggregate every bucket the table can show: each row path prefix
   * (level 0 = grand total ... level R = leaf row) crossed with each full
   * column key and the column grand total. Totals are aggregated from the
   * raw rows, never summed from cells, so AVG/MEDIAN/COUNT DISTINCT stay right.
   */
  function compute(ds, idx, sheet) {
    const rows = sheet.shelves.rows.map((p) => T.dimSpec(ds, p));
    const cols = sheet.shelves.columns.map((p) => T.dimSpec(ds, p));
    let meas = sheet.shelves.values.map((p) => T.measureSpec(ds, p));
    if (!meas.length) meas = [T.measureSpec(ds, { field: T.RECORDS })];
    const R = rows.length, C = cols.length, M = meas.length;

    const buckets = new Map();
    const rowNodes = new Map(); // path -> node
    const root = { level: 0, path: '0' + LVL, keys: [], children: [] };
    rowNodes.set('0' + LVL, root);
    const colKeys = new Map(); // ck -> keys

    const rk = new Array(R), ck = new Array(C);
    const prefixes = new Array(R + 1);
    for (let r = 0; r < idx.length; r++) {
      const i = idx[r];
      let path = '';
      prefixes[0] = '0' + LVL;
      for (let l = 0; l < R; l++) {
        rk[l] = rows[l].key(i);
        path += T.keyStr(rk[l]) + T.SEP;
        prefixes[l + 1] = (l + 1) + LVL + path;
        if (!rowNodes.has(prefixes[l + 1])) {
          const node = { level: l + 1, path: prefixes[l + 1], keys: rk.slice(0, l + 1), children: [] };
          rowNodes.set(prefixes[l + 1], node);
          rowNodes.get(prefixes[l]).children.push(node);
        }
      }
      let c = '';
      for (let l = 0; l < C; l++) { ck[l] = cols[l].key(i); c += T.keyStr(ck[l]) + T.SEP; }
      if (C && !colKeys.has(c)) colKeys.set(c, ck.slice());
      const colTargets = C ? [c, '*'] : ['*'];
      for (let l = 0; l <= R; l++) {
        for (const ct of colTargets) {
          const bk = prefixes[l] + '|' + ct;
          let accs = buckets.get(bk);
          if (!accs) { accs = meas.map((m) => new T.Acc(m.agg)); buckets.set(bk, accs); }
          for (let j = 0; j < M; j++) accs[j].add(meas[j].get(i));
        }
      }
    }

    const colList = Array.from(colKeys, ([k, keys]) => ({ k, keys })).sort((a, b) => T.cmpKeys(a.keys, b.keys));
    const value = (rowPath, colK, m) => {
      const accs = buckets.get(rowPath + '|' + colK);
      return accs ? accs[m].value() : null;
    };

    // Sort row tree: by label (default) or by a column's value.
    const ps = sheet.pivotSort || { by: 'label', dir: 1 };
    const sortChildren = (node) => {
      if (!node.children.length) return;
      const lvl = node.level;
      if (ps.by === 'value') {
        node.children.sort((a, b) => {
          const va = value(a.path, ps.col, ps.m), vb = value(b.path, ps.col, ps.m);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * ps.dir;
        });
      } else {
        const dir = ps.by === 'label' && (ps.level == null || ps.level === lvl) ? ps.dir : 1;
        node.children.sort((a, b) => T.cmp(a.keys[lvl], b.keys[lvl]) * dir);
      }
      node.children.forEach(sortChildren);
    };
    sortChildren(root);

    return { rows, cols, meas, R, C, M, root, colList, value, empty: idx.length === 0 };
  }

  /** Render the pivot into HTML. Returns {html, csv()} */
  function render(model, sheet, theme) {
    const { rows, cols, meas, R, C, M, root, value } = model;
    const opts = sheet.opts;
    const showTotals = opts.totals !== false;
    const showSub = opts.subtotals !== false;
    let colList = model.colList;
    let truncatedCols = false;
    if (colList.length * M > MAX_LEAF_COLS) { colList = colList.slice(0, Math.floor(MAX_LEAF_COLS / M)); truncatedCols = true; }

    // Leaf columns: (col key, measure)
    const leaves = [];
    if (C) colList.forEach((c) => meas.forEach((m, j) => leaves.push({ ck: c.k, keys: c.keys, m: j })));
    if (!C || showTotals) meas.forEach((m, j) => leaves.push({ ck: '*', keys: null, m: j, total: !!C }));

    const showMeasureRow = M > 1 || C === 0;
    const H = C + (showMeasureRow ? 1 : 0);
    const RH = Math.max(1, R);

    // Heat ranges per measure (leaf cells only).
    const heat = opts.heat ? meas.map(() => [Infinity, -Infinity]) : null;
    const rowsOut = []; // {node, kind:'leaf'|'sub'|'grand'}
    let truncatedRows = false;
    const walk = (node) => {
      if (rowsOut.length >= MAX_ROWS) { truncatedRows = true; return; }
      if (node.level === R) { rowsOut.push({ node, kind: R ? 'leaf' : 'grand-only' }); return; }
      node.children.forEach(walk);
      if (node.level > 0 && showSub && node.children.length > 1) rowsOut.push({ node, kind: 'sub' });
    };
    walk(root);
    if (R && showTotals) rowsOut.push({ node: root, kind: 'grand' });

    if (heat) {
      for (const r of rowsOut) {
        if (r.kind !== 'leaf' && r.kind !== 'grand-only') continue;
        for (const lf of leaves) {
          if (lf.total) continue;
          const v = value(r.node.path, lf.ck, lf.m);
          if (v === null) continue;
          const h = heat[lf.m];
          if (v < h[0]) h[0] = v;
          if (v > h[1]) h[1] = v;
        }
      }
    }
    const heatStyle = (v, m) => {
      if (!heat || v === null) return '';
      const [lo, hi] = heat[m];
      const t = hi > lo ? (v - lo) / (hi - lo) : 1;
      const bg = T.Theme.mix(theme.sequential[0], theme.sequential[theme.sequential.length - 1], t);
      return ` style="background:${bg};color:${T.Theme.inkOn(bg, '#0b0b0b', '#f8f8f8')}"`;
    };

    const sortMark = (by, extra) => {
      const ps = sheet.pivotSort;
      if (!ps || ps.by !== by) return '';
      if (by === 'label' && ps.level !== extra) return '';
      if (by === 'value' && (ps.col !== extra.col || ps.m !== extra.m)) return '';
      return ps.dir > 0 ? ' <span class="sort-ind">▲</span>' : ' <span class="sort-ind">▼</span>';
    };

    let h = '<table class="pivot"><thead>';
    // Column-dimension header rows
    for (let lv = 0; lv < C; lv++) {
      h += '<tr>';
      h += `<th class="corner" colspan="${RH}"><span class="corner-dim">${esc(cols[lv].label)} ▸</span></th>`;
      let i = 0;
      while (i < leaves.length) {
        const lf = leaves[i];
        if (lf.total) {
          if (lv === 0) h += `<th class="col-head total" colspan="${M}" rowspan="${C}">GRAND TOTAL</th>`;
          i += M; continue;
        }
        const pre = lf.keys.slice(0, lv + 1);
        let span = 0;
        while (i + span < leaves.length && !leaves[i + span].total && T.cmpKeys(leaves[i + span].keys.slice(0, lv + 1), pre) === 0) span++;
        h += `<th class="col-head" colspan="${span}">${esc(cols[lv].fmt(lf.keys[lv]))}</th>`;
        i += span;
      }
      h += '</tr>';
    }
    // Last header row: row-dimension names + measure names
    h += '<tr>';
    if (R) rows.forEach((d, l) => (h += `<th class="row-dim sortable" data-sort-label="${l}">${esc(d.label)}${sortMark('label', l)}</th>`));
    else h += '<th class="row-dim"></th>';
    if (showMeasureRow) {
      leaves.forEach((lf, li) => {
        h += `<th class="measure-head sortable${lf.total ? ' total' : ''}" data-sort-leaf="${li}">${esc(meas[lf.m].label)}${sortMark('value', { col: lf.ck, m: lf.m })}</th>`;
      });
    } else {
      // single measure + column dims: the measure label lives in the caption; still allow value sort
      leaves.forEach((lf, li) => {
        h += `<th class="measure-head sortable slim${lf.total ? ' total' : ''}" data-sort-leaf="${li}" title="Sort by this column">${sortMark('value', { col: lf.ck, m: lf.m }) || '<span class="sort-ind dim">⇅</span>'}</th>`;
      });
    }
    h += '</tr></thead><tbody>';

    // Body
    let prev = [];
    const csv = [];
    // Header label per leaf column. With no column dimensions, leaves have no keys
    // (keys === null) and are labelled by their measure alone.
    const leafLabel = (lf) => {
      if (!lf.keys) return lf.total ? 'Grand Total | ' + meas[lf.m].label : meas[lf.m].label;
      const col = lf.keys.map((k, l) => cols[l].fmt(k)).join(' / ');
      return M > 1 ? col + ' | ' + meas[lf.m].label : col;
    };
    csv.push([...(R ? rows.map((d) => d.label) : ['']), ...leaves.map(leafLabel)]);
    for (const r of rowsOut) {
      const node = r.node;
      let cls = r.kind;
      let labels = '';
      const csvRow = [];
      if (r.kind === 'leaf') {
        for (let l = 0; l < R; l++) {
          const same = prev.length > l && T.cmpKeys(prev.slice(0, l + 1), node.keys.slice(0, l + 1)) === 0;
          const txt = rows[l].fmt(node.keys[l]);
          labels += `<th class="row-head${same ? ' repeat' : ''}" title="${esc(txt)}">${same ? '' : esc(txt)}</th>`;
          csvRow.push(txt);
        }
        prev = node.keys;
      } else if (r.kind === 'sub') {
        for (let l = 0; l < node.level - 1; l++) { labels += '<th class="row-head repeat"></th>'; csvRow.push(rows[l].fmt(node.keys[l])); }
        labels += `<th class="row-head sub-label" colspan="${R - node.level + 1}">TOTAL ${esc(rows[node.level - 1].fmt(node.keys[node.level - 1]))}</th>`;
        csvRow.push('Total ' + rows[node.level - 1].fmt(node.keys[node.level - 1]));
        for (let l = node.level; l < R; l++) csvRow.push('');
      } else if (r.kind === 'grand') {
        labels += `<th class="row-head grand-label" colspan="${R}">GRAND TOTAL</th>`;
        csvRow.push('Grand Total'); for (let l = 1; l < R; l++) csvRow.push('');
        prev = [];
      } else {
        labels += '<th class="row-head grand-label">ALL</th>'; csvRow.push('All');
        cls = 'leaf';
      }
      h += `<tr class="${cls}">${labels}`;
      for (const lf of leaves) {
        const v = value(node.path, lf.ck, lf.m);
        const style = (r.kind === 'leaf' || r.kind === 'grand-only') && !lf.total ? heatStyle(v, lf.m) : '';
        h += `<td class="${lf.total ? 'total' : ''}"${style}>${esc(meas[lf.m].fmt(v))}</td>`;
        csvRow.push(v);
      }
      h += '</tr>';
      csv.push(csvRow);
    }
    h += '</tbody></table>';

    const notes = [];
    if (truncatedRows) notes.push('SHOWING FIRST ' + MAX_ROWS + ' ROWS - ADD A FILTER TO SEE THE REST');
    if (truncatedCols) notes.push('SHOWING FIRST ' + colList.length + ' COLUMNS - TOO MANY TO DRAW');
    if (model.empty) notes.push('NO ROWS MATCH THE CURRENT FILTERS');
    const caption = meas.length === 1 && C ? `<div class="pivot-caption">${esc(meas[0].label)}</div>` : '';
    return {
      html: caption + h + notes.map((n) => `<div class="pivot-note">${esc(n)}</div>`).join(''),
      csv: () => T.toCSV(csv),
      leaves,
    };
  }

  T.Pivot = { compute, render };
})();
