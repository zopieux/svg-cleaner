#!/usr/bin/env bash

set -euo pipefail

nix build .#web

mkdir -p dist
cp -RL result/* dist/
chmod -R +w dist/

# Cache busting: rename assets and update references
REV=$(git rev-parse --short HEAD)
echo "Applying cache busting with revision: ${REV}"

for f in main.js svg_cleaner.js; do
    if [ -f "dist/$f" ]; then
        ext="${f##*.}"
        base="${f%.*}"
        new_name="${base}.${REV}.${ext}"
        mv -v "dist/$f" "dist/${new_name}"
        # Update references
        find dist -type f \( -name "*.html" -o -name "*.js" \) -exec sed -i "s/$f/${new_name}/g" {} +
    fi
done
