#!/bin/bash
# MyCL Studio — full-update helper. Tauri-spawned, detached.
# Args: $1 = current .app bundle path
#       $2 = parent (Tauri) PID
#       $3 = source root (Rust env!("CARGO_MANIFEST_DIR")/.. ile geçirilir)
# 1) Source'da Tauri release build (~2 dk)
# 2) Bundle doğrulaması (dir + executable binary)
# 3) Parent process'in ölmesini bekle (max 30 sn)
# 4) Eski .app'i sil, yenisini source'tan kopyala
# 5) Open .app — kullanıcı yeniden açılmış sürümü görür
# Hata → /tmp/mycl-update.log + Console.app'te göster, exit 1
set -e

# .app Finder'dan launched ise PATH minimal (`/usr/bin:/bin:/usr/sbin:/sbin`).
# npm/cargo/tauri-cli bulunsun diye common bin locations + cargo bin ekle.
# Varsa user'ın PATH'ini de koru (PATH varyasyonlarını yakala).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:${PATH:-}"

APP_PATH="$1"
PARENT_PID="$2"
SRC="$3"
LOG=/tmp/mycl-update.log

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: SRC argümanı eksik veya geçersiz dizin: '$SRC'" >>"$LOG"
  open -a Console "$LOG" || true
  exit 1
fi

NEW_APP="$SRC/src-tauri/target/release/bundle/macos/MyCL Studio.app"
NEW_BIN="$NEW_APP/Contents/MacOS/mycl-v14"

echo "=== mycl update $(date) ===" >"$LOG"
echo "APP_PATH=$APP_PATH" >>"$LOG"
echo "PARENT_PID=$PARENT_PID" >>"$LOG"
echo "SRC=$SRC" >>"$LOG"

# Build (set -e if-bloğu içinde tetiklenmez → açık fail dalı)
if ! ( cd "$SRC" && npm run tauri -- build ) >>"$LOG" 2>&1; then
  rc=$?
  echo "ERROR: tauri build başarısız (exit $rc)" >>"$LOG"
  open -a Console "$LOG" || true
  exit 1
fi

# Bundle yapısı doğrulaması: dir + executable binary var mı?
if [ ! -d "$NEW_APP" ] || [ ! -x "$NEW_BIN" ]; then
  echo "ERROR: yeni .app bundle eksik veya bozuk ($NEW_APP)" >>"$LOG"
  open -a Console "$LOG" || true
  exit 1
fi

# Parent app'in çıkmasını bekle (max 30 sn). Tauri tarafı app.exit(0) çağırır.
WAITED=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  sleep 0.5
  WAITED=$((WAITED + 1))
  if [ "$WAITED" -gt 60 ]; then
    echo "WARN: parent $PARENT_PID 30sn'de çıkmadı, force kill" >>"$LOG"
    kill -9 "$PARENT_PID" 2>/dev/null || true
    break
  fi
done

rm -rf "$APP_PATH"
cp -R "$SRC/src-tauri/target/release/bundle/macos/MyCL Studio.app" "$APP_PATH"
open "$APP_PATH"
echo "=== update OK $(date) ===" >>"$LOG"
