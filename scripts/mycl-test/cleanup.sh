#!/usr/bin/env bash
# cleanup.sh — MyCL Studio'yu kapat + /tmp screenshot temizliği.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/lib.sh"

kill_mycl
# Eski screenshot'ları topla (son 50 hariç sil)
ls -1t /tmp/mycl-screenshot-*.png 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null || true
echo "✅ Cleanup OK"
