#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_PATH="${1:-$ROOT/.chrome-extension-dev-key.pem}"
DIST_DIR="$ROOT/dist"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Extension key not found: $KEY_PATH" >&2
  exit 1
fi

if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
  chrome_bin="${CHROME_BIN}"
else
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [[ -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    fi
  done
fi

if [[ -z "${chrome_bin:-}" ]]; then
  echo "Chrome binary not found. Set CHROME_BIN to a Chrome/Chromium executable." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rsync -a \
  --exclude ".git/" \
  --exclude "dist/" \
  --exclude ".chrome-extension-dev-key.pem" \
  --exclude "*.crx" \
  --exclude "*.pem" \
  "$ROOT/" "$TMP_DIR/extension/"

"$chrome_bin" \
  --pack-extension="$TMP_DIR/extension" \
  --pack-extension-key="$KEY_PATH"

if [[ -f "$TMP_DIR/extension.crx" ]]; then
  mv "$TMP_DIR/extension.crx" "$DIST_DIR/ordinator.crx"
fi

echo "Packaged extension at $DIST_DIR/ordinator.crx"
