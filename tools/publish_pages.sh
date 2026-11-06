#!/bin/zsh
# Build Tatko and publish website/ to the gh-pages branch, which GitHub Pages serves.
# The gh-pages branch only ever holds the latest built site (it is force-pushed).
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
/usr/bin/python3 tools/build.py
TMP=$(mktemp -d)
rsync -a --exclude .DS_Store website/ "$TMP"/
touch "$TMP/.nojekyll"   # serve files as-is (no Jekyll processing)
cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -qm "Publish Tatko site ($(date +%Y-%m-%d))"
git push -f "$REMOTE" gh-pages
cd - >/dev/null
rm -rf "$TMP"
echo "Published. GitHub Pages updates within a minute or two."
