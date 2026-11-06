#!/bin/bash
# Build the distributable zip: dist/cinema-brightness@zeropaulsy.shell-extension.zip
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
gnome-extensions pack cinema-brightness@zeropaulsy \
    --extra-source=helper --extra-source=setup --extra-source=COPYING \
    --out-dir=dist --force
echo "Built dist/cinema-brightness@zeropaulsy.shell-extension.zip"
echo "Install with: gnome-extensions install --force dist/cinema-brightness@zeropaulsy.shell-extension.zip"
