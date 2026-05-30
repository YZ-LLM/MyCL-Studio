#!/usr/bin/env bash
# lib-qa.sh — QA senaryo helper'ları (Batch B).
# v15.7 (2026-05-27) — production readiness madde 19: 9 senaryo QA rejimi.

# Mevcut mycl-test lib'i import — open_mycl, send_to_composer, screenshot
QA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$QA_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/mycl-test/lib.sh"

# QA report dosyası — qa-all.sh tarafından append edilir
QA_REPORT="${QA_REPORT:-/tmp/qa-report-$(date +%Y%m%d-%H%M%S).md}"

# ─── Senaryo lifecycle ─────────────────────────────────────────────────────

qa_start() {
  QA_NAME="$1"
  QA_START_TS=$(date +%s)
  QA_PASS_COUNT=0
  QA_FAIL_COUNT=0
  QA_FAIL_REASONS=()
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "▶ $QA_NAME"
  echo "════════════════════════════════════════════════════"
}

qa_end() {
  local elapsed=$(( $(date +%s) - QA_START_TS ))
  local status
  if [[ $QA_FAIL_COUNT -eq 0 ]]; then
    status="✅ PASS"
  else
    status="❌ FAIL"
  fi
  echo ""
  echo "─── $QA_NAME — $status (${elapsed}s, ${QA_PASS_COUNT} pass, ${QA_FAIL_COUNT} fail)"
  if [[ ${#QA_FAIL_REASONS[@]} -gt 0 ]]; then
    for r in "${QA_FAIL_REASONS[@]}"; do
      echo "   • $r"
    done
  fi
  # Report append
  {
    echo "## $QA_NAME — $status"
    echo "- Süre: ${elapsed}s | Pass: ${QA_PASS_COUNT} | Fail: ${QA_FAIL_COUNT}"
    if [[ ${#QA_FAIL_REASONS[@]} -gt 0 ]]; then
      for r in "${QA_FAIL_REASONS[@]}"; do echo "  - ❌ $r"; done
    fi
    echo ""
  } >> "$QA_REPORT"
  [[ $QA_FAIL_COUNT -eq 0 ]] && return 0 || return 1
}

qa_pass() {
  local msg="$1"
  QA_PASS_COUNT=$((QA_PASS_COUNT + 1))
  echo "  ✅ $msg"
}

qa_fail() {
  local msg="$1"
  QA_FAIL_COUNT=$((QA_FAIL_COUNT + 1))
  QA_FAIL_REASONS+=("$msg")
  echo "  ❌ $msg"
}

# ─── Assertion helpers ─────────────────────────────────────────────────────

# audit.log'da `*-fail` veya `policy-violation` event YOK mu?
# Args: <project_root> [since_ts=0]
assert_no_audit_errors() {
  local project="$1"
  local since="${2:-0}"
  local audit="$project/.mycl/audit.log"
  if [[ ! -f "$audit" ]]; then
    qa_fail "audit.log yok: $audit"
    return 1
  fi
  # JSON events scan — `*-fail`, `policy-violation`, `error` pattern
  local fails
  fails=$(awk -v s="$since" 'BEGIN{c=0}
    /^\{/ {
      if (match($0, /"ts":[0-9]+/)) {
        ts = substr($0, RSTART+5, RLENGTH-5)+0
        if (ts < s) next
      }
      if ($0 ~ /"event":"[a-z0-9-]+-fail"/ || $0 ~ /"event":"policy-violation"/) c++
    }
    END { print c }' "$audit")
  if [[ "$fails" -gt 0 ]]; then
    qa_fail "audit'te $fails fail/policy-violation event"
    return 1
  fi
  qa_pass "audit clean (0 fail)"
}

# Belirli phase'in -complete event'i var mı?
assert_phase_complete() {
  local project="$1"
  local phase="$2"
  if grep -q "\"event\":\"phase-${phase}-complete\"" "$project/.mycl/audit.log" 2>/dev/null; then
    qa_pass "Phase $phase complete"
    return 0
  fi
  qa_fail "Phase $phase complete event yok"
  return 1
}

# state.json check — field değer eşleşmesi
# Args: <project> <jq_path> <expected>
assert_state_field() {
  local project="$1" path="$2" expected="$3"
  local val
  val=$(grep -oE "\"$path\":[^,}]+" "$project/.mycl/state.json" 2>/dev/null | head -1 | cut -d: -f2- | tr -d ' "')
  if [[ "$val" == "$expected" ]]; then
    qa_pass "state.$path = $expected"
  else
    qa_fail "state.$path = $val (beklenen: $expected)"
  fi
}

# Dosya var mı + boyutu > 0?
assert_file_nonempty() {
  local path="$1" label="${2:-$path}"
  if [[ -s "$path" ]]; then
    qa_pass "$label var ($(stat -f%z "$path") byte)"
  else
    qa_fail "$label yok veya boş: $path"
  fi
}

# Migration dosyaları üretildi mi?
assert_migrations_written() {
  local project="$1"
  local dir="$project/.mycl/migrations"
  if [[ ! -d "$dir" ]]; then
    qa_fail "migrations dizini yok: $dir"
    return 1
  fi
  local count
  count=$(find "$dir" -name "*.sql" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    qa_pass "$count migration SQL dosyası"
  else
    qa_fail "migration SQL yok"
  fi
}

# Bir askq'ya orkestratör'ün önerdiği seçenekle cevap ver
# Args: <project_root> [timeout=20]
# Trace'ten en son askq event'inin suggested_option veya ilk option'unu okur
answer_with_suggestion() {
  local project="$1"
  local timeout="${2:-20}"
  local trace="$project/.mycl/trace.log"
  # Son askq event
  local last_askq
  last_askq=$(grep '"msg":"askq"' "$trace" 2>/dev/null | tail -1)
  if [[ -z "$last_askq" ]]; then
    qa_fail "Son askq event bulunamadı"
    return 1
  fi
  # suggested_option veya ilk option al
  local answer
  answer=$(echo "$last_askq" | grep -oE '"suggested_option":"[^"]+"' | head -1 | sed 's/.*":"//;s/"$//')
  if [[ -z "$answer" ]]; then
    answer=$(echo "$last_askq" | grep -oE '"options":\[[^]]+\]' | grep -oE '"[^"]+"' | head -1 | sed 's/^"//;s/"$//')
  fi
  if [[ -z "$answer" ]]; then
    qa_fail "Askq cevap çıkarılamadı"
    return 1
  fi
  echo "  → answering askq: $answer"
  send_to_composer "$answer" >/dev/null
  sleep "$timeout"
}

# Pipeline complete event'ini bekle (timeout: dakika)
# Args: <project> <timeout_min>
wait_pipeline_complete() {
  local project="$1"
  local timeout_min="${2:-30}"
  local end=$((SECONDS + timeout_min * 60))
  echo "  ⏳ Pipeline complete bekleniyor (max ${timeout_min}m)..."
  while [[ $SECONDS -lt $end ]]; do
    if grep -q '"event":"phase-17-complete"' "$project/.mycl/audit.log" 2>/dev/null; then
      qa_pass "pipeline complete (Phase 17)"
      return 0
    fi
    # Fail durumu — herhangi bir Phase N fail
    if grep -qE '"event":"phase-[0-9]+-fail"' "$project/.mycl/audit.log" 2>/dev/null; then
      qa_fail "pipeline fail event"
      return 1
    fi
    sleep 10
  done
  qa_fail "pipeline complete timeout (${timeout_min}m)"
  return 1
}

# Screenshot al + path döndür
qa_screenshot() {
  local label="$1"
  local out
  out=$(bash "$ROOT_DIR/scripts/mycl-test/screenshot.sh" 2>/dev/null)
  echo "  📷 $label: $out"
  echo "$out"
}
