#!/usr/bin/env bash
# Q2 — Develop smoke: adminpanel'da yeni özellik talebi → develop_new_or_iter.
# Tam pipeline yerine smoke: iteration_count++ ve Phase 1 başlangıcı doğrulanır.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib-qa.sh"

qa_start "Q2 — Develop smoke (UC2a-d kombinasyonu)"

PROJECT="$PROJECT_ROOT"
TRACE="$PROJECT/.mycl/trace.log"
STATE="$PROJECT/.mycl/state.json"

# Önceki iteration sayısı
PREV_ITER=$(grep -oE '"iteration_count":[ ]*[0-9]+' "$STATE" | head -1 | grep -oE '[0-9]+')
echo "  Önceki iteration: $PREV_ITER"

# Önceki askq açıksa Vazgeç
send_to_composer "Vazgeç" >/dev/null 2>&1 || true
sleep 4

BASELINE=$(wc -l < "$TRACE")
echo "  → develop trigger: 'Yeni özellik: dashboard widget'"
send_to_composer "Yeni özellik: dashboard widget — istatistik kartları" >/dev/null
sleep 15

# develop_new_or_iter event'i
if awk -v n="$BASELINE" 'NR>n' "$TRACE" | grep -q "develop_new_or_iter\|iteration-.*-start"; then
  qa_pass "develop_new_or_iter tetiklendi"
else
  qa_fail "develop_new_or_iter tetiklenmedi"
fi

# iteration_count ++
sleep 2
NEW_ITER=$(grep -oE '"iteration_count":[ ]*[0-9]+' "$STATE" | head -1 | grep -oE '[0-9]+')
if [[ "$NEW_ITER" -gt "$PREV_ITER" ]]; then
  qa_pass "iteration_count ${PREV_ITER} → ${NEW_ITER}"
else
  qa_fail "iteration_count artmadı ($PREV_ITER)"
fi

# Phase 1 başladı mı?
if awk -v n="$BASELINE" 'NR>n' "$TRACE" | grep -q "phase-1.*run start\|module.*phase-1"; then
  qa_pass "Phase 1 başladı"
else
  qa_fail "Phase 1 başlamadı"
fi

qa_screenshot "Q2 final"
qa_end
