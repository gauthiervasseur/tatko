#!/bin/zsh
# Regenerate the website screenshots with headless Chrome.
# Needs a local server on port 8765 serving the Tatko folder:
#   python3 -m http.server 8765 --bind 127.0.0.1   (run from the Tatko folder)
set -e
cd "$(dirname "$0")/.."
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT=website/assets/screens
PROFILE=$(mktemp -d)
mkdir -p "$OUT"

shot() { # name hash
  "$CH" --headless=new --hide-scrollbars --user-data-dir="$PROFILE" --window-size=1440,860 \
    --force-device-scale-factor=2 --timeout=6000 --screenshot="$OUT/$1.png" \
    "http://127.0.0.1:8765/app/index.html#mute&nocrt&$2" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions 82 --resampleWidth 1600 "$OUT/$1.png" --out "$OUT/$1.jpg" >/dev/null
  rm "$OUT/$1.png"
  echo "  $OUT/$1.jpg"
}

shot splash  "theme=arcade"
shot table   "demo&preset=table&theme=arcade"
shot bar     "demo&preset=bar&theme=arcade"
shot line    "demo&preset=line&theme=arcade"
shot scatter "demo&preset=scatter&theme=arcade"
shot treemap "demo&preset=treemap&theme=arcade"
shot kpi     "demo&preset=kpi&theme=arcade"
shot corporate "demo&preset=bar&theme=corporate"
shot corporate-table "demo&preset=table&theme=corporate"
rm -rf "$PROFILE"
