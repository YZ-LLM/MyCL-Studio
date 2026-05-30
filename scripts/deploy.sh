#!/usr/bin/env bash
# scripts/deploy.sh — Tauri bundle build + safe deploy to /Applications.
#
# v15.7 (2026-05-26): Production readiness madde 17 (rollback). Eski
# "MyCL Studio.app" varsa "MyCL Studio.app.prev" olarak yedeklenir; deploy
# fail ederse manuel restore mümkün: `mv .app.prev .app`.
#
# Akış:
#   1. orchestrator + frontend build (tsc)
#   2. Test (varsa --skip-tests ile atlanır)
#   3. Tauri bundle
#   4. Backup mevcut /Applications/MyCL Studio.app → .app.prev (varsa)
#   5. Yeni bundle'ı /Applications/ altına kopyala
#   6. Başarılıysa .app.prev korunur (bir sonraki deploy'da rotate)
#
# Usage:
#   scripts/deploy.sh           # full: build + test + deploy
#   scripts/deploy.sh --skip-tests
#   scripts/deploy.sh --restore # rollback: .app.prev → .app

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="MyCL Studio.app"
APPS_DIR="/Applications"
CUR="$APPS_DIR/$APP_NAME"
PREV="$APPS_DIR/$APP_NAME.prev"
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"

cd "$ROOT"

# --restore flag — quick rollback path
if [[ "${1:-}" == "--restore" ]]; then
  if [[ ! -d "$PREV" ]]; then
    echo "❌ Backup yok: $PREV" >&2
    exit 1
  fi
  echo "🔄 Rollback: $PREV → $CUR"
  rm -rf "$CUR"
  mv "$PREV" "$CUR"
  echo "✅ Eski sürüm geri yüklendi. $PREV silindi."
  exit 0
fi

SKIP_TESTS=false
if [[ "${1:-}" == "--skip-tests" ]]; then
  SKIP_TESTS=true
fi

echo "📦 Orchestrator build…"
npm --prefix orchestrator run build

if [[ "$SKIP_TESTS" != "true" ]]; then
  echo "🧪 Orchestrator tests…"
  npm --prefix orchestrator test
fi

echo "🏗  Tauri bundle build…"
npm run tauri build

if [[ ! -d "$BUNDLE" ]]; then
  echo "❌ Bundle bulunamadı: $BUNDLE" >&2
  exit 1
fi

# Backup mevcut sürüm
if [[ -d "$CUR" ]]; then
  echo "💾 Backup: $CUR → $PREV"
  rm -rf "$PREV"
  mv "$CUR" "$PREV"
fi

echo "🚀 Deploy: $BUNDLE → $CUR"
cp -R "$BUNDLE" "$APPS_DIR/"

echo "✅ Deploy OK."
echo "   Yeni: $CUR"
if [[ -d "$PREV" ]]; then
  echo "   Önceki: $PREV (rollback: scripts/deploy.sh --restore)"
fi
