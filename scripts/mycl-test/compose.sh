#!/usr/bin/env bash
# compose.sh — Composer'a metin yaz, expected pattern trace.log'a düşmeyi bekle.
# Args: <text> [expected_pattern=user_message]
# Önkoşul: MyCL Studio zaten boot edilmiş olmalı (önce smoke.sh çalıştır veya manuel aç).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

TEXT="${1:?Usage: compose.sh <text> [expected_pattern]}"
EXPECTED="${2:-user_message}"

# trace.log baseline — yeni eklenecek satırları izlemek için
BASELINE=$(wc -l < "$TRACE_LOG" 2>/dev/null || echo "0")

echo "✍ Sending: '$TEXT'"
"$DIR/send-text.sh" "$TEXT"

echo "⏳ Waiting for pattern: '$EXPECTED' (max 12s)"
if wait_event "$EXPECTED" 12; then
  echo "✅ Pattern bulundu"
else
  echo "❌ Pattern bulunamadı: '$EXPECTED'"
  echo "=== Trace tail (last 30 since baseline) ==="
  awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | head -50
  exit 1
fi

echo ""
echo "=== Relevant trace events ==="
awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | grep -E "(orchestrator-agent|user_message|policy-violation|bug pattern|chat_message|agent decision|tool_use)" | head -15 || echo "(no matches)"

echo ""
SCREENSHOT=$("$DIR/screenshot.sh")
echo "📷 Screenshot: $SCREENSHOT"
