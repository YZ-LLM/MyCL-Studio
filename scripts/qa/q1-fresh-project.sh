#!/usr/bin/env bash
# Q1 — Fresh proje smoke: tmp folder oluştur, splash'tan aç, state.json
# default değerlerle init oldu mu doğrula. Tam pipeline (Phase 1-17) ayrı
# (cost yüksek): qa-all.sh içinde opt-in flag.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib-qa.sh"

qa_start "Q1 — Fresh proje smoke (UC1)"

TS=$(date +%s)
FOLDER="/tmp/qa-q1-${TS}"
mkdir -p "$FOLDER"
export PROJECT_ROOT="$FOLDER"

# Mevcut MyCL kapat + tekrar aç (splash'a ulaş)
kill_mycl
sleep 2
open -a "$APP_NAME"
sleep 4
activate_mycl

# Splash'tan "Yeni Klasör Seç" butonu
echo "  → Yeni Klasör Seç click"
osascript <<APPLESCRIPT 2>&1 | head -2
tell application "System Events"
  tell process "$PROCESS_NAME"
    set els to entire contents of window 1
    repeat with e in els
      try
        if (class of e is button) and (name of e contains "Yeni Klasör") then
          click e
          return "clicked"
        end if
      end try
    end repeat
    return "not_found"
  end tell
end tell
APPLESCRIPT
sleep 1.5

# Folder picker'a path
echo "  → folder picker path: $FOLDER"
osascript <<APPLESCRIPT 2>&1 | head -1
tell application "System Events"
  keystroke "g" using {command down, shift down}
  delay 0.5
  keystroke "$FOLDER"
  delay 0.3
  key code 36
  delay 0.8
  key code 36
end tell
APPLESCRIPT
sleep 4

# Doğrulama
assert_file_nonempty "$FOLDER/.mycl/state.json" "state.json"
assert_file_nonempty "$FOLDER/.mycl/trace.log" "trace.log"
assert_state_field "$FOLDER" "current_phase" "1"
assert_state_field "$FOLDER" "spec_approved" "false"

# project loaded event
if grep -q "project loaded" "$FOLDER/.mycl/trace.log" 2>/dev/null; then
  qa_pass "project loaded event"
else
  qa_fail "project loaded event yok"
fi

qa_screenshot "Q1 final"
qa_end
