#!/usr/bin/env bash
# uc-all — Üç UC'yi sıralı çalıştır (UC3 → UC2 → UC1).
# UC3/UC2 adminpanel'i kullanır (önce mevcut state), UC1 fresh folder oluşturur.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "════════════════════════════════════════"
echo "UC3 — Debug"
echo "════════════════════════════════════════"
bash "$DIR/uc3-debug.sh" "anket çalışmıyor" || echo "⚠ UC3 fail (devam)"
echo ""

echo "════════════════════════════════════════"
echo "UC2 — Geliştirme"
echo "════════════════════════════════════════"
bash "$DIR/uc2-develop.sh" "Yeni özellik: kullanıcı profil sayfası" || echo "⚠ UC2 fail (devam)"
echo ""

echo "════════════════════════════════════════"
echo "UC1 — Yeni Proje"
echo "════════════════════════════════════════"
bash "$DIR/uc1-new-project.sh" || echo "⚠ UC1 fail (devam)"
echo ""

echo "✅ UC-all tamamlandı. Screenshot'ları /tmp/mycl-screenshot-*.png içinde gör."
