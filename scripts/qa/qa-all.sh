#!/usr/bin/env bash
# qa-all.sh — 3 smoke senaryo sıralı + rapor.
# v15.7 (2026-05-27): Q1 (fresh) + Q2 (develop) + Q3 (debug) smoke testleri.
# Tam pipeline testi (Phase 1-17 uçtan uca) ayrı tour — bu script HIZLI
# regression check için (~5-10 dakika).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export QA_REPORT="/tmp/qa-report-$(date +%Y%m%d-%H%M%S).md"
{
  echo "# MyCL Studio QA Report"
  echo "Date: $(date)"
  echo ""
} > "$QA_REPORT"

PASS=0
FAIL=0

run_qa() {
  local script="$1"
  if bash "$script"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

echo "════════════════════════════════════════"
echo "QA Suite başlıyor — rapor: $QA_REPORT"
echo "════════════════════════════════════════"

# Q3 ilk (mevcut adminpanel state'ini kullanır, en hızlı)
run_qa "$DIR/q3-debug-bug-pattern.sh"

# Q2 (adminpanel devam — develop trigger)
run_qa "$DIR/q2-develop-smoke.sh"

# Q1 son (fresh folder, MyCL restart)
run_qa "$DIR/q1-fresh-project.sh"

# Özet
echo ""
echo "════════════════════════════════════════"
echo "QA Suite tamamlandı: $PASS pass / $FAIL fail"
echo "Rapor: $QA_REPORT"
echo "════════════════════════════════════════"
{
  echo ""
  echo "## ÖZET"
  echo "- Total: $((PASS + FAIL))"
  echo "- Pass: $PASS"
  echo "- Fail: $FAIL"
} >> "$QA_REPORT"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
