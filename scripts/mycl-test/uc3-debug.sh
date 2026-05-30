#!/usr/bin/env bash
# UC3 — Var olan projede debug.
# Composer'a bug pattern içeren mesaj → bug fast-path → Phase 0 D1 askq.
#
# Args: [bug_text="anket çalışmıyor"]
# Önkoşul: adminpanel projesi MyCL'de açık olmalı (UC2/manuel boot sonrası).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

BUG_TEXT="${1:-anket çalışmıyor}"
BASELINE=$(wc -l < "$TRACE_LOG" 2>/dev/null || echo "0")

echo "🐞 UC3 — Debug senaryosu"
echo "Bug text: \"$BUG_TEXT\""
echo "Trace baseline: $BASELINE"
echo ""

# Composer'a yaz
send_to_composer "$BUG_TEXT" >/dev/null

# Bug fast-path veya debug_triage tetiklenmesini bekle
echo "⏳ Waiting for bug pattern fast-path or debug_triage..."
if wait_event "bug pattern detected" 8 || wait_event "debug_triage" 8 || wait_event "debug-d1-start" 8; then
  echo "✅ Bug fast-path tetiklendi"
else
  echo "❌ Bug fast-path tetiklenmedi"
  echo "=== Trace tail (since baseline) ==="
  awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | head -30
  exit 1
fi

# D1 araştırma + askq emit'i bekle (max 45s, LLM araştırma süresi)
echo "⏳ Waiting for Phase 0 D2 askq (max 45s, LLM investigation)..."
if wait_event "D2_WAITING\|debug-d1-complete\|report_root_cause" 45; then
  echo "✅ Phase 0 D1 tamamlandı, askq emit edildi"
else
  echo "⚠ D1 tamamlanmadı / askq açılmadı (timeout)"
  echo "=== Trace last 40 ==="
  trace_tail 40
fi

echo ""
echo "=== Relevant events (since baseline) ==="
awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | grep -E "(bug pattern|debug_triage|debug-d1|report_root_cause|D2_WAITING|pending_diagnostic|askq)" | head -20 || echo "(no matches)"

echo ""
SCREENSHOT=$("$DIR/screenshot.sh")
echo "📷 Screenshot: $SCREENSHOT"
