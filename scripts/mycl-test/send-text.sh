#!/usr/bin/env bash
# send-text.sh — Composer'a metin yaz + Enter gönder.
# Args: <text>
# Önkoşul: macOS Settings → Privacy & Security → Accessibility'de Terminal/iTerm izin.

set -e
TEXT="${1:?Usage: send-text.sh <text>}"

# MyCL Studio'yu öne getir, composer'a focus.
# Composer placeholder "MyCL'e yaz..." — focus için Tab dolaşmak yerine
# pencerenin ortasına click veya direkt keystroke. App genelde composer'a
# auto-focus. Tab atmayacağım — text gönder + Enter.
osascript <<APPLESCRIPT
tell application "MyCL Studio" to activate
delay 0.4
tell application "System Events"
  -- Composer'a focus garanti et: bazı durumlarda askq button veya
  -- başka element odakta. Cmd+L gibi standart shortcut yok — basit
  -- Tab/keystroke kombinasyonu. Tauri webview odağı korumalı.
  keystroke "$TEXT"
  delay 0.3
  key code 36
end tell
APPLESCRIPT
