/* Tatko - image export that keeps the theme's fonts and colours.
 *
 * Charts: Plotly's SVG is rasterised as an <img>, which cannot see the page's
 * web fonts. We embed the theme's @font-face rules (as data: URLs) inside the
 * SVG first, so the PNG uses the same fonts as the screen.
 *
 * Tables and score tiles: painted onto a canvas from the live layout
 * (backgrounds, borders, text), so heat colours, headers and fonts match.
 */
(function () {
  'use strict';
  const T = (window.Tatko = window.Tatko || {});

  const MAX_AREA = 16e6; // Safari's canvas limit (px); also keeps files reasonable
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
  const familiesOf = (stack) => stack.split(',').map(unquote).map((f) => f.toLowerCase());

  /* ------------------------------------------------------------ font embedding */

  const blobToDataURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  const inlined = new Map(); // css text -> css with data: URLs
  async function inlineUrls(css, base) {
    if (inlined.has(css)) return inlined.get(css);
    let out = css;
    for (const m of css.matchAll(/url\((['"]?)(?!data:)([^'")]+)\1\)/g)) {
      try {
        const abs = new URL(m[2], base).href;
        const data = await blobToDataURL(await (await fetch(abs)).blob());
        out = out.split(m[0]).join('url("' + data + '")');
      } catch (e) { /* unreachable font file: keep the URL, the fallback font is used */ }
    }
    inlined.set(css, out);
    return out;
  }

  /** @font-face rules (with fonts inlined) for the given CSS font stacks. */
  async function fontFaceCSS(stacks) {
    const wanted = new Set(stacks.flatMap(familiesOf));
    const rules = [];
    const visit = async (sheet) => {
      let list;
      try { list = sheet.cssRules; } catch (e) {
        // Cross-origin stylesheet (e.g. a Google Fonts @import): read it ourselves.
        if (!sheet.href) return;
        try {
          const txt = await (await fetch(sheet.href)).text();
          for (const m of txt.matchAll(/@font-face\s*{[^}]*}/g)) rules.push({ css: m[0], base: sheet.href });
        } catch (e2) { /* offline: nothing to embed */ }
        return;
      }
      for (const r of list) {
        if (r instanceof CSSImportRule && r.styleSheet) await visit(r.styleSheet);
        else if (r instanceof CSSFontFaceRule) rules.push({ css: r.cssText, base: sheet.href || location.href });
      }
    };
    for (const s of Array.from(document.styleSheets)) await visit(s);
    const out = [];
    for (const { css, base } of rules) {
      const fam = (css.match(/font-family:\s*([^;]+);/) || [])[1];
      if (fam && wanted.has(unquote(fam).toLowerCase())) out.push(await inlineUrls(css, base));
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ charts */

  // Plotly writes some font names with raw double quotes inside style="…"
  // (e.g. font-family: "Press Start 2P", …), which makes the SVG invalid XML.
  const cleanFontAttrs = (svg) => svg.replace(/font-family:([^;>]*?);/g, (m, v) => 'font-family:' + v.replace(/"/g, "'") + ';');

  async function chartSVG(plot, theme) {
    const w = plot.clientWidth, h = plot.clientHeight;
    let svg = await Plotly.toImage(plot, { format: 'svg', width: w, height: h, imageDataOnly: true });
    if (svg.startsWith('data:')) svg = decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
    svg = cleanFontAttrs(svg);
    const css = await fontFaceCSS([theme.fontFamily, theme.titleFontFamily]);
    if (css) svg = svg.replace(/<svg\b[^>]*>/, (open) => open + '<defs><style type="text/css"><![CDATA[\n' + css + '\n]]></style></defs>');
    return { svg, w, h };
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('COULD NOT RENDER THE CHART IMAGE'));
      img.src = src;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG ENCODING FAILED'))), 'image/png'));
  }

  /**
   * Paint the live chart's text onto the canvas with the page's own fonts.
   * Each <text> keeps its exact on-screen transform (position, rotation, scale).
   */
  function paintChartText(ctx, plot, scale) {
    const origin = plot.getBoundingClientRect();
    for (const t of plot.querySelectorAll('svg text')) {
      if (t.closest('.hoverlayer')) continue;
      const lines = t.querySelectorAll('tspan.line');
      for (const el of lines.length ? Array.from(lines) : [t]) {
        const text = el.textContent;
        if (!text || !text.trim()) continue;
        let p0;  // baseline start of the line, in the text's own coordinates
        try { p0 = el.getStartPositionOfChar(0); } catch (e) { continue; }
        const cs = getComputedStyle(el.querySelector('tspan') || el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const m = el.getScreenCTM();
        if (!m) continue;
        ctx.save();
        ctx.setTransform(scale * m.a, scale * m.b, scale * m.c, scale * m.d,
          scale * (m.e - origin.left), scale * (m.f - origin.top));
        ctx.globalAlpha = (parseFloat(cs.opacity) || 1) * (cs.fillOpacity === '' ? 1 : parseFloat(cs.fillOpacity));
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        ctx.fillStyle = cs.fill && cs.fill !== 'none' ? cs.fill : cs.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, p0.x, p0.y);
        ctx.restore();
      }
    }
  }

  /**
   * PNG of a chart. Fonts inside an SVG drawn as an image are unreliable
   * (WebKit ignores embedded web fonts there), so the chart is rasterised
   * without its text, then the text is painted with the page's fonts.
   */
  async function chartPNG(plot, theme, scale = 2) {
    await document.fonts.ready;
    const w = plot.clientWidth, h = plot.clientHeight;
    let svg = await Plotly.toImage(plot, { format: 'svg', width: w, height: h, imageDataOnly: true });
    if (svg.startsWith('data:')) svg = decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
    svg = cleanFontAttrs(svg).replace(/<svg\b[^>]*>/, (open) => open + '<style>text, tspan { fill: transparent !important; stroke: none !important; }</style>');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      paintChartText(ctx, plot, scale);
      return await canvasBlob(c);
    } finally { URL.revokeObjectURL(url); }
  }

  /* ------------------------------------------------------- tables & tiles */

  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

  /** Paint the full scrollable content of `scroller` (table or score tiles). */
  async function domPNG(scroller, theme, scale = 2) {
    const keep = [scroller.scrollLeft, scroller.scrollTop];
    scroller.scrollTo(0, 0); // sticky headers back in place before measuring
    try {
      await document.fonts.ready;
      const full = scroller.getBoundingClientRect();
      // Crop to the content (plus a margin) rather than the whole viz area.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const el of scroller.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
      if (x0 === Infinity) throw new Error('NOTHING TO EXPORT IN THIS VIEW');
      const pad = 16;
      const box = { left: Math.max(full.left, x0 - pad), top: Math.max(full.top, y0 - pad) };
      const W = Math.ceil(Math.min(full.left + scroller.scrollWidth, x1 + pad) - box.left);
      let H = Math.ceil(Math.min(full.top + scroller.scrollHeight, y1 + pad) - box.top);
      scale = Math.min(scale, Math.sqrt(MAX_AREA / (W * H)));
      let truncated = false;
      if (scale < 0.75) { scale = 0.75; H = Math.floor(MAX_AREA / (W * scale * scale)); truncated = true; }
      const c = document.createElement('canvas');
      c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, W, H);
      const ox = box.left, oy = box.top;

      const els = scroller.querySelectorAll('*');
      // 1. backgrounds and borders
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.top - oy > H) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;
        const x = r.left - ox, y = r.top - oy;
        if (!transparent(cs.backgroundColor)) { ctx.fillStyle = cs.backgroundColor; ctx.fillRect(x, y, r.width, r.height); }
        const side = (w, col, rect) => { const n = parseFloat(w); if (n > 0 && !transparent(col)) { ctx.fillStyle = col; ctx.fillRect(...rect(n)); } };
        side(cs.borderTopWidth, cs.borderTopColor, (n) => [x, y, r.width, n]);
        side(cs.borderBottomWidth, cs.borderBottomColor, (n) => [x, y + r.height - n, r.width, n]);
        side(cs.borderLeftWidth, cs.borderLeftColor, (n) => [x, y, n, r.height]);
        side(cs.borderRightWidth, cs.borderRightColor, (n) => [x + r.width - n, y, n, r.height]);
      }
      // 2. text, clipped to its element (honours ellipsis-width cells)
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = node.parentElement;
        if (el.closest('.sort-ind')) continue; // on-screen sort hints, not content
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        range.selectNodeContents(node);
        const rr = range.getBoundingClientRect();
        if (!rr.width || rr.top - oy > H) continue;
        const clip = el.getBoundingClientRect();
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.left - ox, clip.top - oy, clip.width, clip.height);
        ctx.clip();
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        ctx.fillStyle = cs.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, rr.left - ox, rr.top - oy + rr.height / 2);
        ctx.restore();
      }
      const blob = await canvasBlob(c);
      return { blob, truncated };
    } finally { scroller.scrollTo(keep[0], keep[1]); }
  }

  T.Export = { chartSVG, chartPNG, domPNG, fontFaceCSS };
})();
