#!/usr/bin/env bash
# UC2 — Var olan projede geliştirme (2a: pipeline complete → yeni iş).
# Composer'a yeni özellik talebi → orkestratör develop_new_or_iter → Phase 1.
#
# Args: [feature_text="Yeni özellik: kullanıcı profil sayfası ekle"]
# Önkoşul: adminpanel projesi MyCL'de açık ve pipeline tamamlanmış olmalı.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

FEATURE_TEXT="${1:-Yeni özellik: kullanıcı profil sayfası ekle}"
BASELINE=$(wc -l < "$TRACE_LOG" 2>/dev/null || echo "0")
STATE_FILE="$PROJECT_ROOT/.mycl/state.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "❌ state.json yok: $STATE_FILE" >&2
  exit 1
fi

PREV_ITER=$(grep -o '"iteration_count":[[:space:]]*[0-9]*' "$STATE_FILE" | head -1 | grep -o '[0-9]*' || echo "0")
echo "🛠 UC2 — Geliştirme senaryosu (2a)"
echo "Feature text: \"$FEATURE_TEXT\""
echo "Önceki iteration_count: $PREV_ITER"
echo ""

send_to_composer "$FEATURE_TEXT" >/dev/null

echo "⏳ Waiting for develop_new_or_iter action (max 30s)..."
if wait_event "develop_new_or_iter\|iteration-.*-start" 30; then
  echo "✅ develop_new_or_iter tetiklendi"
else
  echo "❌ develop_new_or_iter tetiklenmedi"
  echo "=== Trace tail ==="
  awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | head -30
  exit 1
fi

# State.json'da iteration_count artmış mı?
sleep 2
NEW_ITER=$(grep -o '"iteration_count":[[:space:]]*[0-9]*' "$STATE_FILE" | head -1 | grep -o '[0-9]*' || echo "0")
echo "Yeni iteration_count: $NEW_ITER"
if [[ "$NEW_ITER" -gt "$PREV_ITER" ]]; then
  echo "✅ iteration_count arttı ($PREV_ITER → $NEW_ITER)"
else
  echo "⚠ iteration_count artmadı (state save henüz tamamlanmamış olabilir)"
fi

echo ""
echo "=== Relevant events ==="
awk -v n="$BASELINE" 'NR>n' "$TRACE_LOG" | grep -E "(develop_new_or_iter|iteration-.*-start|phase-1|orchestrator-agent)" | head -15 || echo "(no matches)"

echo ""
SCREENSHOT=$("$DIR/screenshot.sh")
echo "📷 Screenshot: $SCREENSHOT"
