/* Tatko - data engine: CSV parsing, type inference, filtering, aggregation.
 * Plain script (no modules) so the app runs straight from file://.
 */
(function () {
  'use strict';
  const T = (window.Tatko = window.Tatko || {});

  const SEP = '\u001f';
  const NULL_LABEL = '(empty)';
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  /* ------------------------------------------------------------------ CSV */

  function countOutsideQuotes(line, d) {
    let n = 0, q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      else if (ch === d && !q) n++;
    }
    return n;
  }

  function detectDelimiter(text) {
    const lines = text.slice(0, 64 * 1024).split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 30);
    let best = ',', bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
      const counts = lines.map((l) => countOutsideQuotes(l, d));
      const first = counts[0] || 0;
      if (!first) continue;
      const consistent = counts.filter((c) => c === first).length / counts.length;
      const score = consistent * 1000 + first;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF/CR line ends. */
  function parseRows(text, delim) {
    const rows = [];
    const d = delim.charCodeAt(0);
    const n = text.length;
    let row = [], field = '', start = 0, i = 0, inQ = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (inQ) {
        if (c === 34) {
          if (text.charCodeAt(i + 1) === 34) { field += text.slice(start, i + 1); i += 2; start = i; continue; }
          field += text.slice(start, i); inQ = false; i++; start = i; continue;
        }
        i++; continue;
      }
      if (c === 34) { field += text.slice(start, i); inQ = true; i++; start = i; continue; }
      if (c === d) { row.push(field + text.slice(start, i)); field = ''; i++; start = i; continue; }
      if (c === 10 || c === 13) {
        row.push(field + text.slice(start, i)); field = '';
        rows.push(row); row = [];
        if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
        i++; start = i; continue;
      }
      i++;
    }
    if (start < n || field !== '' || row.length) { row.push(field + text.slice(start, n)); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  }

  function uniqueHeader(cells) {
    const seen = new Map();
    return cells.map((c, j) => {
      let name = (c || '').trim() || 'Column ' + (j + 1);
      const k = name.toLowerCase();
      if (seen.has(k)) { const m = seen.get(k) + 1; seen.set(k, m); name = name + ' (' + m + ')'; }
      else seen.set(k, 1);
      return name;
    });
  }

  /* --------------------------------------------------------- type inference */

  const EDGE_JUNK = /^[\s$€£¥₴%]+|[\s$€£¥₴%]+$/g;
  const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
  const THOUSANDS_COMMA = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  const THOUSANDS_DOT = /^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/;

  function parseNum(s, decimalComma) {
    let t = s.replace(EDGE_JUNK, '');
    let neg = false;
    if (t.length > 2 && t[0] === '(' && t[t.length - 1] === ')') { neg = true; t = t.slice(1, -1); }
    t = t.replace(/[\s  ']/g, '');
    if (decimalComma) {
      if (t.indexOf('.') >= 0 && !THOUSANDS_DOT.test(t)) return null;
      t = t.replace(/\./g, '').replace(',', '.');
    } else if (t.indexOf(',') >= 0) {
      if (!THOUSANDS_COMMA.test(t)) return null;
      t = t.replace(/,/g, '');
    }
    if (!NUM_RE.test(t)) return null;
    const v = parseFloat(t);
    return neg ? -v : v;
  }

  const ISO_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i;
  const YM_RE = /^(\d{4})-(\d{1,2})$/;
  const DMY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  function mkDate(y, mo, d, h, mi, s) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
    const chk = new Date(ms);
    if (chk.getUTCMonth() !== mo - 1) return null; // e.g. 31 Feb
    return ms;
  }

  function parseDate(s, order) {
    let m = ISO_RE.exec(s);
    if (m) return mkDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    m = YM_RE.exec(s);
    if (m) return mkDate(+m[1], +m[2], 1);
    m = DMY_RE.exec(s);
    if (m) {
      let y = +m[3];
      if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
      const a = +m[1], b = +m[2];
      return order === 'mdy' ? mkDate(y, a, b, +m[4], +m[5], +m[6]) : mkDate(y, b, a, +m[4], +m[5], +m[6]);
    }
    return null;
  }

  function inferColumn(raw, delim) {
    const n = raw.length;
    const ne = [];
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      if (v != null) { const t = v.trim(); if (t !== '') ne.push(t); }
    }
    const strings = () => raw.map((v) => (v == null || v.trim() === '' ? null : v.trim()));
    if (!ne.length) return { type: 'string', values: strings() };

    const sample = ne.length > 5000 ? ne.filter((_, i) => i % Math.ceil(ne.length / 5000) === 0) : ne;

    // Numbers -------------------------------------------------------------
    let commaVotes = 0, dotVotes = 0, leadingZeros = 0;
    for (const s of sample) {
      if (/,\d{1,2}$|,\d{4,}$/.test(s)) commaVotes++;
      if (/\.\d{1,2}$|\.\d{4,}$/.test(s)) dotVotes++;
      if (/^0\d/.test(s)) leadingZeros++;
    }
    let decimalComma = commaVotes > dotVotes;
    if (commaVotes === 0 && dotVotes === 0 && delim === ';') decimalComma = true;
    let ok = 0;
    for (const s of sample) if (parseNum(s, decimalComma) !== null) ok++;
    if (ok / sample.length >= 0.95 && leadingZeros / sample.length < 0.05) {
      const values = raw.map((v) => (v == null || v.trim() === '' ? null : parseNum(v.trim(), decimalComma)));
      return { type: 'number', values };
    }

    // Dates ---------------------------------------------------------------
    let dmy = 0, mdy = 0;
    for (const s of sample) {
      const m = DMY_RE.exec(s);
      if (m) { if (+m[1] > 12) dmy++; if (+m[2] > 12) mdy++; }
    }
    const order = mdy > dmy ? 'mdy' : dmy > mdy ? 'dmy' : delim === ',' ? 'mdy' : 'dmy';
    ok = 0;
    for (const s of sample) if (parseDate(s, order) !== null) ok++;
    if (ok / sample.length >= 0.95) {
      const values = raw.map((v) => (v == null || v.trim() === '' ? null : parseDate(v.trim(), order)));
      return { type: 'date', values };
    }
    return { type: 'string', values: strings() };
  }

  const DIMENSION_NAME = /(^|[^a-z])(id|code|zip|postal|postcode|year|yr|phone|siret|siren|sku|ean)([^a-z]|$)/i;

  function guessRole(name, col) {
    if (col.type !== 'number') return 'dimension';
    if (DIMENSION_NAME.test(name)) {
      const allInt = col.values.every((v) => v === null || Number.isInteger(v));
      if (allInt) return 'dimension';
    }
    return 'measure';
  }

  function decode(buffer) {
    let text = new TextDecoder('utf-8').decode(buffer);
    const bad = (text.slice(0, 200000).match(/�/g) || []).length;
    if (bad > 3) text = new TextDecoder('windows-1252').decode(buffer); // Excel "CSV" from Western locales
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /** Build a dataset (column-oriented) from CSV text. */
  function fromCSV(text, name) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delim = detectDelimiter(text);
    const rows = parseRows(text, delim);
    if (rows.length < 2) throw new Error('NO DATA ROWS FOUND IN THIS FILE');
    const header = uniqueHeader(rows[0]);
    const n = rows.length - 1;
    const fields = header.map((h, j) => {
      const raw = new Array(n);
      for (let i = 0; i < n; i++) { const r = rows[i + 1]; raw[i] = j < r.length ? r[j] : null; }
      const col = inferColumn(raw, delim);
      return { name: h, type: col.type, role: guessRole(h, col), values: col.values };
    });
    fields.push({ name: RECORDS, type: 'records', role: 'measure', values: null });
    const byName = {};
    fields.forEach((f) => (byName[f.name] = f));
    return { name: name || 'data.csv', n, fields, byName, delim };
  }

  const RECORDS = '# Records';

  /* ----------------------------------------------------------- comparisons */

  function cmp(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return collator.compare(String(a), String(b));
  }
  function cmpKeys(a, b) {
    for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return 0;
  }
  const keyStr = (k) => (k === null || k === undefined ? '\u0000' : typeof k === 'number' ? 'n' + k : 's' + k);
  const joinKeys = (keys) => keys.map(keyStr).join(SEP);

  /* ------------------------------------------------------------- formatting */

  const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  function fmtNum(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '';
    return (Math.abs(v) >= 1000 ? nf0 : nf2).format(v);
  }
  const pad = (x) => String(x).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function fmtDay(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function fmtExact(ms) {
    const d = new Date(ms);
    const t = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : '';
    return fmtDay(ms) + t;
  }

  /* ---------------------------------------------------------- date grains */

  const GRAINS = [
    ['year', 'YEAR'], ['quarter', 'QUARTER'], ['month', 'MONTH'], ['week', 'WEEK'],
    ['day', 'DAY'], ['exact', 'EXACT DATE'], ['moy', 'MONTH OF YEAR'], ['dow', 'WEEKDAY'],
  ];
  const GRAIN_LABEL = Object.fromEntries(GRAINS);

  function dateKey(ms, g) {
    const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
    switch (g) {
      case 'year': return Date.UTC(y, 0, 1);
      case 'quarter': return Date.UTC(y, m - (m % 3), 1);
      case 'month': return Date.UTC(y, m, 1);
      case 'week': return Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      case 'day': return Date.UTC(y, m, d.getUTCDate());
      case 'moy': return m;
      case 'dow': return (d.getUTCDay() + 6) % 7;
      default: return ms;
    }
  }
  function dateLabel(k, g) {
    if (k === null) return NULL_LABEL;
    if (g === 'moy') return MONTHS[k];
    if (g === 'dow') return DAYS[k];
    const d = new Date(k), y = d.getUTCFullYear(), m = d.getUTCMonth();
    switch (g) {
      case 'year': return String(y);
      case 'quarter': return y + ' Q' + (Math.floor(m / 3) + 1);
      case 'month': return MONTHS[m] + ' ' + y;
      case 'week': return 'Wk ' + fmtDay(k);
      case 'day': return fmtDay(k);
      default: return fmtExact(k);
    }
  }

  /* ------------------------------------------------- dimension / measure specs */

  function dimSpec(ds, pill) {
    const f = ds.byName[pill.field];
    if (f.type === 'date') {
      const g = pill.grain || 'month';
      const vals = f.values;
      return {
        field: f, grain: g, isTime: g !== 'moy' && g !== 'dow',
        label: GRAIN_LABEL[g] === 'EXACT DATE' ? f.name : cap(g) + '(' + f.name + ')',
        key: (i) => (vals[i] === null ? null : dateKey(vals[i], g)),
        fmt: (k) => dateLabel(k, g),
      };
    }
    const vals = f.values;
    return {
      field: f, label: f.name, isTime: false,
      key: (i) => vals[i],
      fmt: (k) => (k === null || k === undefined ? NULL_LABEL : typeof k === 'number' ? (Number.isInteger(k) ? String(k) : fmtNum(k)) : k),
    };
  }

  const AGGS = [
    ['sum', 'SUM'], ['avg', 'AVERAGE'], ['median', 'MEDIAN'], ['min', 'MIN'], ['max', 'MAX'],
    ['count', 'COUNT'], ['countd', 'COUNT DISTINCT'],
  ];
  const AGG_SHORT = { sum: 'SUM', avg: 'AVG', median: 'MEDIAN', min: 'MIN', max: 'MAX', count: 'CNT', countd: 'CNTD' };
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function allowedAggs(f) {
    if (f.type === 'number') return AGGS.map((a) => a[0]);
    if (f.type === 'date') return ['min', 'max', 'count', 'countd'];
    if (f.type === 'records') return ['count'];
    return ['countd', 'count'];
  }
  function defaultAgg(f) { return allowedAggs(f)[0]; }

  function measureSpec(ds, pill) {
    const f = ds.byName[pill.field];
    if (f.type === 'records') {
      return { field: f, agg: 'count', label: RECORDS, get: () => 1, fmt: fmtNum, raw: () => 1 };
    }
    let agg = pill.agg;
    if (!allowedAggs(f).includes(agg)) agg = defaultAgg(f);
    const vals = f.values;
    const isDateOut = f.type === 'date' && (agg === 'min' || agg === 'max');
    return {
      field: f, agg,
      label: AGG_SHORT[agg] + '(' + f.name + ')',
      get: (i) => vals[i],
      fmt: isDateOut ? (v) => (v === null ? '' : fmtDay(v)) : fmtNum,
    };
  }

  /* ------------------------------------------------------------ aggregation */

  function Acc(agg) {
    this.agg = agg; this.n = 0; this.s = 0; this.mn = Infinity; this.mx = -Infinity;
    this.set = agg === 'countd' ? new Set() : null;
    this.arr = agg === 'median' ? [] : null;
  }
  Acc.prototype.add = function (v) {
    if (v === null || v === undefined || v !== v) return;
    this.n++;
    switch (this.agg) {
      case 'sum': case 'avg': this.s += v; break;
      case 'min': if (v < this.mn) this.mn = v; break;
      case 'max': if (v > this.mx) this.mx = v; break;
      case 'countd': this.set.add(v); break;
      case 'median': this.arr.push(v); break;
    }
  };
  Acc.prototype.value = function () {
    const n = this.n;
    switch (this.agg) {
      case 'sum': return n ? this.s : null;
      case 'avg': return n ? this.s / n : null;
      case 'count': return n;
      case 'countd': return this.set.size;
      case 'min': return n ? this.mn : null;
      case 'max': return n ? this.mx : null;
      case 'median': {
        if (!n) return null;
        const a = this.arr.sort((x, y) => x - y), h = n >> 1;
        return n % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
      }
    }
    return null;
  };

  /** Group filtered rows by dimension specs, aggregating measure specs. */
  function groupBy(idx, dims, meas) {
    const map = new Map();
    const out = [];
    const nd = dims.length, nm = meas.length;
    const keys = new Array(nd);
    for (let r = 0; r < idx.length; r++) {
      const i = idx[r];
      let k = '';
      for (let j = 0; j < nd; j++) { keys[j] = dims[j].key(i); k += keyStr(keys[j]) + SEP; }
      let g = map.get(k);
      if (!g) {
        g = { keys: keys.slice(), accs: meas.map((m) => new Acc(m.agg)) };
        map.set(k, g); out.push(g);
      }
      for (let j = 0; j < nm; j++) g.accs[j].add(meas[j].get(i));
    }
    return out.map((g) => ({ keys: g.keys, vals: g.accs.map((a) => a.value()) }));
  }

  /* --------------------------------------------------------------- domains */

  /** Distinct values of a field over the FULL dataset (not filtered), with counts. */
  function domain(ds, f) {
    if (f._domain) return f._domain;
    const counts = new Map();
    const v = f.values;
    for (let i = 0; i < ds.n; i++) counts.set(v[i], (counts.get(v[i]) || 0) + 1);
    const arr = Array.from(counts, ([value, count]) => ({ value, count }));
    arr.sort((a, b) => cmp(a.value, b.value));
    f._domain = arr;
    return arr;
  }

  function extent(ds, f) {
    if (f._extent) return f._extent;
    let mn = Infinity, mx = -Infinity;
    for (const v of f.values) if (v !== null) { if (v < mn) mn = v; if (v > mx) mx = v; }
    f._extent = mn === Infinity ? [null, null] : [mn, mx];
    return f._extent;
  }

  /* --------------------------------------------------------------- filters */

  function filterKind(f) {
    if (f.type === 'number' && f.role === 'measure') return 'range';
    if (f.type === 'date') return 'daterange';
    return 'set';
  }

  function isActive(flt) {
    if (flt.kind === 'set') return flt.excluded.length > 0;
    return flt.min != null || flt.max != null || flt.keepNull === false;
  }

  const DAY_MS = 86400000;
  function makeTest(ds, flt) {
    const f = ds.byName[flt.field];
    if (!f || !f.values) return null;
    const vals = f.values;
    if (flt.kind === 'set') {
      const ex = new Set(flt.excluded);
      return (i) => !ex.has(vals[i]);
    }
    const lo = flt.min, hi = flt.kind === 'daterange' && flt.max != null ? flt.max + DAY_MS : flt.max;
    const keepNull = flt.keepNull !== false;
    const hiExclusive = flt.kind === 'daterange';
    return (i) => {
      const v = vals[i];
      if (v === null) return keepNull;
      if (lo != null && v < lo) return false;
      if (hi != null && (hiExclusive ? v >= hi : v > hi)) return false;
      return true;
    };
  }

  function filterIndex(ds, filters) {
    const tests = filters.filter(isActive).map((f) => makeTest(ds, f)).filter(Boolean);
    const out = new Int32Array(ds.n);
    let k = 0;
    const nt = tests.length;
    outer: for (let i = 0; i < ds.n; i++) {
      for (let t = 0; t < nt; t++) if (!tests[t](i)) continue outer;
      out[k++] = i;
    }
    return out.subarray(0, k);
  }

  /* ------------------------------------------------------------------ CSV out */

  function toCSV(rows) {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  Object.assign(T, {
    SEP, NULL_LABEL, RECORDS, GRAINS, GRAIN_LABEL, AGGS,
    fromCSV, decode, parseRows, detectDelimiter, parseNum, parseDate,
    cmp, cmpKeys, keyStr, joinKeys, fmtNum, fmtDay, fmtExact, dateKey, dateLabel,
    dimSpec, measureSpec, allowedAggs, defaultAgg, Acc, groupBy,
    domain, extent, filterKind, isActive, filterIndex, toCSV,
  });
})();
