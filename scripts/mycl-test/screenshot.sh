#!/usr/bin/env bash
# screenshot.sh — Aktif MyCL Studio penceresinin screenshot'unu /tmp altına yazar.
# Çıktı: dosya yolu (Claude bunu Read tool ile görür).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

TS=$(date +%Y%m%d-%H%M%S)
OUT="/tmp/mycl-screenshot-${TS}.png"

# Tauri 2 webview pencerelerinin accessibility ID'si yok; -l <id> çalışmaz.
# Bunun yerine position + size al, screencapture -R ile dikdörtgen yakala.
# Format: "x, y, w, h" → "x,y,w,h"
RECT=$(osascript -e "tell application \"System Events\" to tell process \"$PROCESS_NAME\" to get {position, size} of window 1" 2>/dev/null | tr -d ' ')

if [[ -n "$RECT" && "$RECT" =~ ^[0-9]+,[0-9]+,[0-9]+,[0-9]+$ ]]; then
  # screencapture -R x,y,w,h
  screencapture -R "$RECT" -x "$OUT"
else
  echo "⚠ Window region alınamadı, tam ekran screenshot alınıyor" >&2
  screencapture -x "$OUT"
fi

echo "$OUT"
