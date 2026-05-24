#!/usr/bin/env bash
set -euo pipefail

root="$(pwd)"
runtime="$root/tools/klevar-yolo-runtime"
dist_cli="$runtime/dist/cli.js"

if [[ ! -d "$runtime" ]]; then
  echo "Klevar YOLO runtime not found at tools/klevar-yolo-runtime. Sync this project with the latest template first." >&2
  exit 1
fi

pushd "$runtime" >/dev/null
if [[ ! -d node_modules ]]; then
  echo "Installing Klevar YOLO runtime dependencies..."
  npm ci
fi

if [[ ! -f "$dist_cli" ]]; then
  echo "Building Klevar YOLO runtime..."
  npm run build
fi
popd >/dev/null

node "$dist_cli" "$@"
