/* Tatko - visualization themes loaded from a plain CSS file.
 *
 * A theme is ordinary CSS. Tatko reads custom properties named --tatko-*
 * (from any rule), plus plain font-family / color / background on :root,
 * html, body or .tatko as fallbacks. @import and @font-face rules are
 * injected into the page so web fonts load.
 */
(function () {
  'use strict';
  const T = (window.Tatko = window.Tatko || {});

  // Default: the "Arcade" theme. Categorical order is the validated
  // colour-blind-safe dark-surface palette from the dataviz method.
  const ARCADE = `/* Tatko theme: ARCADE (default) */
:root {
  --tatko-theme-name: "Arcade";
  --tatko-font-family: "VT323", "Courier New", monospace;
  --tatko-title-font-family: "Press Start 2P", "VT323", monospace;
  --tatko-font-size: 19px;
  --tatko-title-font-size: 12px;
  --tatko-text-color: #f0efec;
  --tatko-muted-color: #b9b2dd;
  --tatko-background: #120b2e;
  --tatko-plot-background: #120b2e;
  --tatko-grid-color: #2f2660;
  --tatko-palette: #3987e5, #d95926, #199e70, #c98500, #d55181, #008300, #9085e9, #e66767;
  --tatko-sequential: #1d3a6e, #b7d3f6;
  --tatko-table-header-background: #1f1550;
  --tatko-table-header-color: #ffd400;
  --tatko-table-border-color: #33296b;
  --tatko-table-total-background: #1a1145;
}
`;

  const CORPORATE = `/* Tatko theme: CORPORATE (light) */
:root {
  --tatko-theme-name: "Corporate";
  --tatko-font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --tatko-title-font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --tatko-font-size: 13px;
  --tatko-text-color: #0b0b0b;
  --tatko-muted-color: #52514e;
  --tatko-background: #fcfcfb;
  --tatko-plot-background: #fcfcfb;
  --tatko-grid-color: #e6e5e0;
  --tatko-palette: #2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #6250d6, #e34948;
  --tatko-sequential: #cde2fb, #104281;
  --tatko-table-header-background: #f0efec;
  --tatko-table-header-color: #0b0b0b;
  --tatko-table-border-color: #e6e5e0;
  --tatko-table-total-background: #f5f4f1;
}
`;

  const PRESETS = { Arcade: ARCADE, Corporate: CORPORATE };

  /* ----------------------------------------------------------- color utils */

  const probe = document.createElement('canvas').getContext('2d');
  function toRGB(c) {
    if (!c || !CSS.supports('color', c)) return null;
    probe.fillStyle = '#000';
    probe.fillStyle = c;
    const s = probe.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
    if (s[0] === '#') return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const m = s.match(/[\d.]+/g);
    return m ? [+m[0], +m[1], +m[2]] : null;
  }
  const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  function mix(a, b, t) {
    const A = toRGB(a), B = toRGB(b);
    if (!A || !B) return a;
    return hex(A.map((v, i) => v + (B[i] - v) * t));
  }
  function luminance(c) {
    const rgb = toRGB(c);
    if (!rgb) return 0;
    const l = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }
  /** Readable ink for text drawn on `bg` (used for heat-shaded table cells). */
  function inkOn(bg, dark, light) { return luminance(bg) > 0.38 ? dark : light; }

  /** Split "a, rgb(1,2,3), b" on top-level commas only. */
  function splitList(v) {
    const out = []; let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  const unquote = (s) => (s || '').trim().replace(/^["']|["']$/g, '');

  /* --------------------------------------------------------------- parsing */

  const BASE_SELECTORS = /^(:root|html|body|\.tatko|\.tatko-theme|\*)$/;

  function parse(cssText) {
    const warnings = [];
    const imports = [];
    // Strip comments first, then pull out @import rules. URLs may contain ';'
    // (Google Fonts: "wght@400;600"), so match the quoted/url() part as a unit.
    const body = cssText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])(.*?)\3)[^;]*;/gi, (m, q1, u1, q2, u2) => {
        imports.push(u1 || u2); return '';
      });
    const vars = {};
    const fontFaces = [];
    let sheet;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(body);
    } catch (e) {
      throw new Error('THIS CSS COULD NOT BE READ: ' + e.message);
    }
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSFontFaceRule) { fontFaces.push(rule.cssText); continue; }
      if (!(rule instanceof CSSStyleRule)) continue;
      const base = rule.selectorText.split(',').some((s) => BASE_SELECTORS.test(s.trim()));
      for (let k = 0; k < rule.style.length; k++) {
        const p = rule.style[k];
        if (p.startsWith('--tatko-') || base) vars[p] = rule.style.getPropertyValue(p).trim();
      }
    }
    const d = resolve({}); // defaults (from ARCADE) for anything not given
    const get = (...names) => { for (const n of names) if (vars[n]) return vars[n]; return null; };
    const color = (v, fallback, label) => {
      if (!v) return fallback;
      if (toRGB(v)) return v;
      warnings.push('IGNORED ' + label + ': "' + v + '" IS NOT A COLOR');
      return fallback;
    };

    const t = {};
    t.name = unquote(get('--tatko-theme-name')) || 'Custom';
    t.fontFamily = get('--tatko-font-family', 'font-family') || d.fontFamily;
    t.titleFontFamily = get('--tatko-title-font-family') || t.fontFamily;
    t.fontSize = parseFloat(get('--tatko-font-size', 'font-size')) || (vars['--tatko-font-family'] || vars['font-family'] ? 13 : d.fontSize);
    t.titleFontSize = parseFloat(get('--tatko-title-font-size')) || Math.round(t.fontSize * 1.15);
    t.background = color(get('--tatko-background', 'background-color', 'background'), d.background, 'BACKGROUND');
    t.text = color(get('--tatko-text-color', 'color'), luminance(t.background) > 0.4 ? '#0b0b0b' : '#f0efec', 'TEXT COLOR');
    t.muted = color(get('--tatko-muted-color'), mix(t.text, t.background, 0.35), 'MUTED COLOR');
    t.plotBackground = color(get('--tatko-plot-background'), t.background, 'PLOT BACKGROUND');
    t.grid = color(get('--tatko-grid-color'), mix(t.background, t.text, 0.14), 'GRID COLOR');

    let palette = [];
    const list = get('--tatko-palette');
    if (list) palette = splitList(list);
    for (let k = 1; k <= 12; k++) { const c = vars['--tatko-color-' + k]; if (c) palette[k - 1] = c; }
    palette = palette.filter((c) => {
      if (toRGB(c)) return true;
      warnings.push('IGNORED PALETTE COLOR "' + c + '"'); return false;
    });
    if (!palette.length) palette = d.palette;
    if (palette.length > 8) warnings.push('PALETTE HAS ' + palette.length + ' COLORS: ONLY THE FIRST 8 ARE USED, THE REST FOLD INTO "OTHER"');
    t.palette = palette.slice(0, 8);
    t.other = mix(t.background, t.text, 0.45);

    const seq = get('--tatko-sequential');
    const seqList = seq ? splitList(seq).filter((c) => toRGB(c)) : [];
    t.sequential = seqList.length >= 2 ? seqList : [mix(t.background, t.palette[0], 0.15), t.palette[0]];

    t.tableHeaderBackground = color(get('--tatko-table-header-background'), mix(t.background, t.text, 0.07), 'TABLE HEADER BACKGROUND');
    t.tableHeaderText = color(get('--tatko-table-header-color'), t.text, 'TABLE HEADER COLOR');
    t.tableBorder = color(get('--tatko-table-border-color'), t.grid, 'TABLE BORDER COLOR');
    t.tableTotalBackground = color(get('--tatko-table-total-background'), mix(t.background, t.text, 0.04), 'TABLE TOTAL BACKGROUND');

    const fontCss = imports.map((u) => '@import url("' + u + '");').join('\n') + '\n' + fontFaces.join('\n');
    return { theme: t, fontCss, warnings };
  }

  // Defaults come from the arcade CSS itself so there is one source of truth.
  let ARCADE_RESOLVED = null;
  function resolve() {
    if (ARCADE_RESOLVED) return ARCADE_RESOLVED;
    ARCADE_RESOLVED = {
      fontFamily: '"VT323", monospace', fontSize: 19, background: '#120b2e',
      palette: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    };
    return ARCADE_RESOLVED;
  }

  /** Inject the theme's web fonts and expose its values as CSS variables on `el`. */
  function apply(parsed, el) {
    let style = document.getElementById('tatko-theme-fonts');
    if (!style) { style = document.createElement('style'); style.id = 'tatko-theme-fonts'; document.head.appendChild(style); }
    style.textContent = parsed.fontCss;
    const t = parsed.theme;
    const s = el.style;
    s.setProperty('--viz-font', t.fontFamily);
    s.setProperty('--viz-title-font', t.titleFontFamily);
    s.setProperty('--viz-font-size', t.fontSize + 'px');
    s.setProperty('--viz-title-size', t.titleFontSize + 'px');
    s.setProperty('--viz-bg', t.background);
    s.setProperty('--viz-text', t.text);
    s.setProperty('--viz-muted', t.muted);
    s.setProperty('--viz-grid', t.grid);
    s.setProperty('--viz-accent', t.palette[0]);
    s.setProperty('--viz-th-bg', t.tableHeaderBackground);
    s.setProperty('--viz-th-text', t.tableHeaderText);
    s.setProperty('--viz-border', t.tableBorder);
    s.setProperty('--viz-total-bg', t.tableTotalBackground);
    // Resolve once fonts are actually usable, so charts measure text correctly.
    const fams = [t.fontFamily, t.titleFontFamily].map((f) => splitList(f)[0]).filter(Boolean);
    return Promise.all(fams.map((f) => document.fonts.load(t.fontSize + 'px ' + f).catch(() => null))).then(() => document.fonts.ready);
  }

  /** Serialize a resolved theme back to a CSS file (used for "download template"). */
  function toCSS(t) {
    return `/* Tatko visualization theme.
 * Load it with THEME CSS in Tatko. Every variable is optional.
 * Web fonts: add @import url("https://fonts.googleapis.com/...") or @font-face rules at the top.
 */
:root {
  --tatko-theme-name: "${t.name}";
  --tatko-font-family: ${t.fontFamily};
  --tatko-title-font-family: ${t.titleFontFamily};
  --tatko-font-size: ${t.fontSize}px;
  --tatko-title-font-size: ${t.titleFontSize}px;
  --tatko-text-color: ${t.text};
  --tatko-muted-color: ${t.muted};
  --tatko-background: ${t.background};
  --tatko-plot-background: ${t.plotBackground};
  --tatko-grid-color: ${t.grid};
  /* Categorical colors, in order. Up to 8; more series fold into "Other". */
  --tatko-palette: ${t.palette.join(', ')};
  /* Low and high ends of the single-hue ramp used by heatmaps and heat cells. */
  --tatko-sequential: ${t.sequential.join(', ')};
  --tatko-table-header-background: ${t.tableHeaderBackground};
  --tatko-table-header-color: ${t.tableHeaderText};
  --tatko-table-border-color: ${t.tableBorder};
  --tatko-table-total-background: ${t.tableTotalBackground};
}
`;
  }

  T.Theme = { ARCADE, CORPORATE, PRESETS, parse, apply, toCSS, mix, toRGB, luminance, inkOn };
})();
