#!/usr/bin/env bash
# scripts/mycl-test/lib.sh — Ortak helper'lar.
# v15.7 (2026-05-26): macOS native automation, sıfır npm dep.

PROJECT_ROOT="${PROJECT_ROOT:-$HOME/adminpanel}"
APP_NAME="MyCL Studio"
PROCESS_NAME="mycl-v14"  # macOS binary adı (System Events processName)
TRACE_LOG="$PROJECT_ROOT/.mycl/trace.log"
AUDIT_LOG="$PROJECT_ROOT/.mycl/audit.log"
HISTORY_LOG="$PROJECT_ROOT/.mycl/history.log"

# App aç + boot tamamlanmasını bekle.
# Trace.log boot sırasında rotate edilir (boot mesajı: "rotated to project
# trace.log") — bu nedenle ts baseline yerine "rotated to project trace.log"
# event'ini bekle. Bu, log dosyasının yeni session'la yeniden açıldığını
# garanti eder; sonra "project loaded" event'i normal akış.
open_mycl() {
  local boot_marker_ts
  boot_marker_ts=$(date +%s)
  open -a "$APP_NAME"
  for i in {1..40}; do
    # trace.log var mı?
    if [[ -f "$TRACE_LOG" ]]; then
      local last_mtime
      last_mtime=$(stat -f %m "$TRACE_LOG" 2>/dev/null || echo "0")
      # Trace.log boot_marker'dan sonra modifiye olduysa + "project loaded" varsa
      if [[ "$last_mtime" -ge "$boot_marker_ts" ]]; then
        if tail -50 "$TRACE_LOG" 2>/dev/null | grep -q "project loaded"; then
          return 0
        fi
      fi
    fi
    sleep 0.5
  done
  echo "❌ Boot timeout (20s) — trace.log'da yeni 'project loaded' event'i bulunamadı" >&2
  return 1
}

# AppleScript quit + fallback pkill — graceful, sonra force.
# Process adı binary'den: "mycl-v14" (display: "MyCL Studio"). osascript "tell
# application" display adıyla çalışır ama process kill için pgrep binary adıyla.
kill_mycl() {
  osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
  sleep 1.5
  # Hala yaşıyorsa zorla — binary adıyla
  if pgrep -fl "$PROCESS_NAME" >/dev/null 2>&1; then
    pkill -f "$APP_NAME.app/Contents/MacOS" 2>/dev/null || true
    sleep 1
  fi
}

trace_tail() {
  tail -"${1:-30}" "$TRACE_LOG" 2>/dev/null
}

audit_tail() {
  tail -"${1:-30}" "$AUDIT_LOG" 2>/dev/null
}

history_tail() {
  tail -"${1:-30}" "$HISTORY_LOG" 2>/dev/null
}

# MyCL Studio'yu öne getir — keystroke/click öncesi tetiklenmeli.
activate_mycl() {
  osascript -e "tell application \"$APP_NAME\" to activate" 2>/dev/null
  sleep 0.4
}

# Tauri webview AX tree'sinde static text içeren parent group'a click.
# Args: <text_substring>
# Splash'taki "Son Projeler" listesindeki bir projeyi tıklamak için kullanılır.
# Tree pattern: group N of group 3 of group 2 of UI element 1 of scroll area 1
# of group 1 of group 1 of window 1 — her recent project ayrı group.
click_recent_project() {
  local match="$1"
  activate_mycl
  osascript <<APPLESCRIPT 2>&1
tell application "System Events"
  tell process "$PROCESS_NAME"
    set tgts to entire contents of window 1
    repeat with elem in tgts
      try
        if (class of elem is static text) and (value of elem contains "$match") then
          -- static text'in parent'i clickable group
          click (group 1 of (container of elem))
          return "clicked: " & (value of elem)
        end if
      end try
    end repeat
    return "not_found"
  end tell
end tell
APPLESCRIPT
}

# Composer'a text gönder + Enter.
# v15.7 (2026-05-27): Türkçe karakter desteği için clipboard + Cmd+V paste.
# AppleScript `keystroke` Mac klavye layout simulasyonu yapıyor → "→" "a"
# olur, ı/ç/ş bazen kaybolur. pbcopy + Cmd+V Unicode tüm karakterleri korur.
#
# Composer textarea'ya odaklanmak için window altına position-based click;
# Tauri AX focus property unreliable.
send_to_composer() {
  local text="$1"
  activate_mycl
  # Window pos al → composer area click coordinate
  local rect
  rect=$(osascript -e "tell application \"System Events\" to tell process \"$PROCESS_NAME\" to get {position, size} of window 1" 2>/dev/null | tr -d ' ')
  if [[ "$rect" =~ ^([0-9]+),([0-9]+),([0-9]+),([0-9]+)$ ]]; then
    local wx="${BASH_REMATCH[1]}" wy="${BASH_REMATCH[2]}"
    local ww="${BASH_REMATCH[3]}" wh="${BASH_REMATCH[4]}"
    # Composer textarea ekranın alt-orta bölgesinde (window_h - 165 ≈ orta nokta)
    local cx=$((wx + ww / 2)) cy=$((wy + wh - 165))
    osascript -e "tell application \"System Events\" to click at {$cx, $cy}" 2>/dev/null || true
    sleep 0.3
  fi
  # Clipboard'a koy + Cmd+V paste + Enter
  printf '%s' "$text" | pbcopy
  osascript <<APPLESCRIPT 2>&1
tell application "System Events"
  keystroke "v" using {command down}
  delay 0.4
  key code 36
end tell
APPLESCRIPT
}

# Belirli bir pattern trace.log tail'inde görünene kadar bekle.
# Args: <pattern> <timeout_sec>
wait_event() {
  local pattern="$1"
  local timeout="${2:-10}"
  local end=$((SECONDS + timeout))
  while [[ $SECONDS -lt $end ]]; do
    if tail -300 "$TRACE_LOG" 2>/dev/null | grep -q "$pattern"; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}
