# Tatko

8-bit business intelligence for a single CSV file. Drag fields onto shelves to get charts and
pivot tables, filter with tabs, and style the visualizations with your own CSS file. Runs fully
offline in the browser: double-click `index.html`, nothing to install.

*Татко* (Tatko) is Ukrainian for "Daddy".

## Folder layout

```
Tatko/
├── app/                  the application (this is what gets zipped)
│   ├── index.html        entry point, works from file://
│   ├── css/tatko.css     arcade UI
│   ├── css/fonts.css     generated: pixel fonts as data: URLs
│   ├── js/data.js        CSV parsing, type inference, filters, aggregation
│   ├── js/theme.js       reads a theme CSS file into chart/table styling
│   ├── js/pivot.js       pivot table engine and renderer
│   ├── js/charts.js      shelves → Plotly figures (12 chart types)
│   ├── js/app.js         UI: drag & drop, shelves, filters, sheets, save/load
│   ├── vendor/           plotly.js 2.35.2 (MIT)
│   ├── fonts/            Press Start 2P, VT323 (SIL OFL) + licences
│   ├── assets/           icons generated from the portrait
│   ├── samples/          generated demo dataset (fictional)
│   └── themes/           example theme CSS files
├── desktop/macos/        native Mac wrapper (Swift + WKWebView)
├── website/              static site, ready to upload as-is
│   ├── index.html        landing page
│   ├── play/             live copy of the app
│   └── download/         .dmg, .zip, example themes, demo CSV
├── dist/                 Tatko-<version>.zip, Tatko-<version>.dmg, Tatko.app
└── tools/                build scripts
```

## Build

Uses the macOS system Python 3 (needs Pillow only for the icon script).

```sh
/usr/bin/python3 tools/build.py          # fonts.css, demo data, themes, zip, dmg, website/
```

On a Mac with the Xcode Command Line Tools, the build also compiles the native Mac app
(`tools/build_mac.py`): a universal Apple silicon + Intel binary, macOS 13+, wrapped in a .dmg.
The app is ad-hoc signed but **not notarized**, so first launch needs System Settings ›
Privacy & Security › Open Anyway. Notarizing requires an Apple Developer ID ($99/year):
sign with `codesign --options runtime -s "Developer ID Application: …"`, then
`xcrun notarytool submit … --wait` and `xcrun stapler staple` on the .dmg.

Self-test of the Mac app: loads the demo, exports a chart and a table PNG through the real
EXPORT menu (saved without a dialog), writes `checks.json` and `snapshot.png`, then quits:
`TATKO_SELFTEST=/some/dir dist/Tatko.app/Contents/MacOS/Tatko`
Add `TATKO_SELFTEST_EVAL=file.js` to run an async JS body in the app instead and save its
string result to `eval.txt` (handy for debugging WebKit-only behaviour).

There is no Windows .exe yet; Windows users use the zip. Building one from a Mac needs a
cross-compiler (e.g. Zig), which isn't installed.

Optional:

```sh
/usr/bin/python3 tools/make_icon.py <portrait.png> app/assets   # regenerate the pixel-art icons
python3 -m http.server 8765 --bind 127.0.0.1 &                  # then:
tools/screenshots.sh                                            # regenerate website screenshots
```

To publish, upload the contents of `website/` to any static host.

## Shelf semantics

| Shelf   | Table                    | Charts                                                        |
|---------|--------------------------|---------------------------------------------------------------|
| COLUMNS | column headers (nested)  | categories on the x axis                                      |
| ROWS    | row headers (nested)     | small multiples (or the y axis when COLUMNS is empty)         |
| VALUES  | aggregated measures      | one panel per measure (Tatko never draws two y axes)          |
| COLOR   | not used                 | one series per value (8 colours max, the rest fold into Other) |
| FILTERS | applies to every sheet   | applies to every sheet                                         |

Scatter uses VALUES as x, y and size. Box and histogram use the raw values of the first VALUES field.

## Theme CSS

All variables are optional; see `app/themes/arcade.css` for the full list, or the THEME tab in the app.
Plain `font-family`, `color` and `background` on `:root`/`body` also work, as do `@import` and `@font-face`.
The default palettes are the colour-blind-checked categorical sets from the data-viz method (dark and
light variants).

## Shortcuts & deep links

`index.html#demo&preset=table|bar|line|scatter|treemap|kpi&theme=arcade|corporate&nocrt&mute`
loads the demo directly (used by the screenshot script).
