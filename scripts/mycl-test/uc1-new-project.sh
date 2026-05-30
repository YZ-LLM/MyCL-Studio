#!/usr/bin/env bash
# UC1 — Yeni proje başlatma.
# /tmp/mycl-uc1-test-<ts> fresh folder oluştur, MyCL splash'tan aç,
# Phase 1 askq açılır mı doğrula.
#
# Folder picker AppleScript automation: Cmd+Shift+G ile "Go to folder"
# dialog'u, path yapıştır, Enter. Bazı macOS sürümlerinde fail edebilir;
# o durumda kullanıcı manuel olarak picker'dan path seçer.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

TS=$(date +%s)
TEST_FOLDER="/tmp/mycl-uc1-test-${TS}"
mkdir -p "$TEST_FOLDER"

echo "📁 UC1 — Yeni proje senaryosu"
echo "Test folder: $TEST_FOLDER"
echo ""

# MyCL'yi yeniden başlat (splash'a ulaşmak için)
kill_mycl
sleep 1
open -a "$APP_NAME"
sleep 3
activate_mycl

# Splash'taki "Yeni Klasör Seç" butonunu tıkla
echo "🖱  Splash'tan 'Yeni Klasör Seç' tıklanıyor..."
osascript <<APPLESCRIPT 2>&1 | head -3
tell application "System Events"
  tell process "$PROCESS_NAME"
    set els to entire contents of window 1
    repeat with e in els
      try
        if (class of e is button) and (name of e contains "Yeni Klasör") then
          click e
          return "clicked: " & (name of e)
        end if
      end try
    end repeat
    return "button not found"
  end tell
end tell
APPLESCRIPT

sleep 1.5

# Folder picker açılmış olmalı — Cmd+Shift+G ile path dialog'u
echo "📂 Folder picker'a path yazılıyor: $TEST_FOLDER"
osascript <<APPLESCRIPT 2>&1 | head -3
tell application "System Events"
  keystroke "g" using {command down, shift down}
  delay 0.5
  keystroke "$TEST_FOLDER"
  delay 0.3
  key code 36
  delay 0.8
  -- Aç butonu (Enter or default action)
  key code 36
end tell
APPLESCRIPT

# Boot bekle
sleep 3
TRACE_FILE="$TEST_FOLDER/.mycl/trace.log"

if [[ -f "$TRACE_FILE" ]]; then
  echo "✅ trace.log oluştu — proje boot edildi"
else
  echo "❌ trace.log oluşmadı: $TRACE_FILE"
  echo "Folder picker fail etmiş olabilir. Manuel kontrol gerekli."
  bash "$DIR/screenshot.sh"
  exit 1
fi

STATE_FILE="$TEST_FOLDER/.mycl/state.json"
if [[ -f "$STATE_FILE" ]]; then
  echo "✅ state.json oluştu"
  echo "=== state.json (head) ==="
  head -10 "$STATE_FILE"
else
  echo "⚠ state.json henüz oluşmadı"
fi

echo ""
echo "=== Trace (last 15) ==="
tail -15 "$TRACE_FILE" | grep -E "(project loaded|boot|phase-1)" || tail -10 "$TRACE_FILE"

echo ""
SCREENSHOT=$("$DIR/screenshot.sh")
echo "📷 Screenshot: $SCREENSHOT"
echo ""
echo "🧹 Test folder: $TEST_FOLDER (silmiyorum, manuel cleanup için)"
