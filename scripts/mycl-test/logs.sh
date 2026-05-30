#!/usr/bin/env bash
# logs.sh — adminpanel .mycl/ log dosyalarının son N satırını dump et.
# Args: [N=30]

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

N="${1:-30}"

echo "=== trace.log (last $N) ==="
trace_tail "$N"
echo ""
echo "=== audit.log (last $N) ==="
audit_tail "$N"
echo ""
echo "=== history.log (last $N) ==="
history_tail "$N"
