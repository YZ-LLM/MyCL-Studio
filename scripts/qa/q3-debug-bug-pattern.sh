#!/usr/bin/env bash
# Q3 — Debug bug-pattern testi (kombinasyon: UC3 happy path doğrulama).
# Adminpanel projesi üzerinde, bug pattern → Faz 0 D1 askq doğrula.
#
# Bu Q3a/b/c/d için ortak smoke test. Detaylı varyantlar Phase 0 sonrası
# Faz 5+ pipeline'a girer (LLM cost yüksek) — bu script SADECE Faz 0 D1
# askq emit'i doğrular. Tam pipeline testi qa-all.sh'ta opt-in.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib-qa.sh"

qa_start "Q3 — Debug bug pattern → Phase 0 D1"

# Adminpanel açık olmalı (önce manuel veya UC2'den)
PROJECT="$PROJECT_ROOT"
TRACE="$PROJECT/.mycl/trace.log"
BASELINE=$(wc -l < "$TRACE" 2>/dev/null || echo "0")

# Önceki askq açıksa Vazgeç (test'i temiz başlat)
send_to_composer "Vazgeç" >/dev/null 2>&1 || true
sleep 4

# Bug pattern fast-path tetikle (askq YOK iken)
echo "  → bug trigger: 'profil sayfası çalışmıyor'"
BASELINE=$(wc -l < "$TRACE")
send_to_composer "profil sayfası çalışmıyor" >/dev/null
sleep 8

# Doğrulama
if awk -v n="$BASELINE" 'NR>n' "$TRACE" | grep -q "bug pattern detected"; then
  qa_pass "bug fast-path tetiklendi"
elif awk -v n="$BASELINE" 'NR>n' "$TRACE" | grep -q "debug_triage"; then
  qa_pass "orkestratör debug_triage seçti (fallback)"
else
  qa_fail "Ne bug fast-path ne debug_triage tetiklendi"
fi

# Phase 0 D1 askq açıldı mı? (max 60s)
echo "  ⏳ Phase 0 D1 askq bekleniyor (max 90s — LLM araştırma)..."
end=$((SECONDS + 90))
found=false
while [[ $SECONDS -lt $end ]]; do
  if awk -v n="$BASELINE" 'NR>n' "$TRACE" | grep -q "debug-d1-complete\|D2_WAITING\|report_root_cause"; then
    found=true
    break
  fi
  sleep 3
done
if $found; then
  qa_pass "Phase 0 D1 askq emit edildi"
else
  qa_fail "Phase 0 D1 askq emit edilmedi (90s timeout)"
fi

# audit clean — sadece bu run'da error YOK
assert_no_audit_errors "$PROJECT" "$(date -r "$(($(date +%s) - 120))" +%s 2>/dev/null || echo 0)"

qa_screenshot "Q3 final"
qa_end
