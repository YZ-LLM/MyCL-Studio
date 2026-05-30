#!/usr/bin/env bash
# smoke.sh — Boot + screenshot + temel log doğrulama.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

kill_mycl
echo "🚀 Booting MyCL Studio..."
if ! open_mycl; then
  echo "❌ Boot fail"
  trace_tail 20
  exit 1
fi
echo "✅ Boot OK"

sleep 1.5
SCREENSHOT=$("$DIR/screenshot.sh")
echo "📷 Screenshot: $SCREENSHOT"
echo ""

echo "=== Audit (last 5) ==="
audit_tail 5
echo ""
echo "=== Trace (key events, last 10) ==="
trace_tail 30 | grep -E "(project loaded|risk-check|phase_changed|orchestrator)" | tail -10 || echo "(no key events in tail)"
