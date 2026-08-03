#!/usr/bin/env bash
# setup.sh — MyCL Studio TEK-KOMUT kurulum (macOS + Linux).
#
# Hedef: indir → `bash setup.sh` → BİLGİSAYARDA OLMAYAN HER ŞEY kurulur (Homebrew, Node ≥22,
# Rust, Tauri sistem bağımlılıkları, güvenlik araçları, Chromium) → `npm run tauri dev` → çalışır.
# Idempotent: kurulu olanı atlar. Secrets ASLA repo'da değildir — anahtarlar uygulama açılışında
# girilir (~/.mycl/secrets.json). Bazı adımlar sudo/şifre isteyebilir.
#
# DEĞİŞMEZ KURAL: her yeni dış-araç bağımlılığı buraya EKLENMELİDİR — scripts/check.sh "7/7"
# bunu otomatik zorlar (eksikse `npm run check` kırmızı).

set -uo pipefail
cd "$(dirname "$0")"

OS="$(uname -s)"
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠ %s\033[0m\n' "$1"; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# ── 0. Paket yöneticisi (mac: Homebrew — yoksa kur) ──
say "0. Paket yöneticisi"
if [ "$OS" = "Darwin" ]; then
  if have brew; then ok "Homebrew"
  else
    warn "Homebrew yok — kuruluyor (şifre isteyebilir)…"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || warn "Homebrew kurulamadı"
    [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
    have brew && ok "Homebrew kuruldu" || warn "Homebrew yok — bazı araçlar elle gerekebilir"
  fi
else
  ok "Linux (apt/dnf + rustup)"
fi

# ── 1. Node ≥22 (yoksa kur) ──
say "1. Node ≥22"
if ! have node || [ "$(node_major)" -lt 22 ]; then
  warn "Node ≥22 yok — kuruluyor…"
  if [ "$OS" = "Darwin" ] && have brew; then brew install node || true
  elif have apt-get; then curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  elif have dnf; then sudo dnf install -y nodejs
  else warn "Node otomatik kurulamadı — elle ≥22 kur: https://nodejs.org"; fi
fi
if have node && [ "$(node_major)" -ge 22 ]; then ok "$(node -v)"; else echo "✗ Node ≥22 yok — elle kurup tekrar dene"; exit 1; fi

# ── 2. Rust / cargo (Tauri host — yoksa rustup ile kur) ──
say "2. Rust / cargo"
if ! have cargo; then
  warn "Rust yok — rustup ile kuruluyor…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || warn "rustup kurulamadı"
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if have cargo; then ok "$(cargo --version)"; else echo "✗ cargo yok — https://rustup.rs"; exit 1; fi

# ── 3. Tauri sistem bağımlılıkları ──
say "3. Tauri sistem bağımlılıkları"
if [ "$OS" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools"
  else warn "Xcode CLT kuruluyor (pencere açılabilir)…"; xcode-select --install 2>/dev/null || true; fi
elif have apt-get; then
  sudo apt-get update -y && sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
    build-essential curl wget file libssl-dev pkg-config && ok "Linux Tauri deps" \
    || warn "Linux Tauri deps elle gerekebilir (webkit2gtk-4.1/libgtk-3/librsvg2/appindicator3)"
else
  warn "Tauri deps elle kur: webkit2gtk-4.1 / libgtk-3 / librsvg2 / libayatana-appindicator3"
fi

# ── 4. Node bağımlılıkları ──
say "4. Bağımlılıklar (npm install)"
npm install || { echo "✗ npm install (kök) başarısız"; exit 1; }
npm --prefix orchestrator install || { echo "✗ npm install (orchestrator) başarısız"; exit 1; }
ok "node bağımlılıkları kuruldu (kök + orchestrator)"

# ── 5. Güvenlik araçları (nuclei, katana, semgrep, gitleaks, osv-scanner) ──
say "5. Güvenlik araçları"
install_tool() {  # bin brew_pkg [go_pkg]
  local bin="$1" brew_pkg="$2" go_pkg="${3:-}"
  if have "$bin"; then ok "$bin (zaten kurulu)"; return 0; fi
  if [ "$OS" = "Darwin" ] && have brew && brew install "$brew_pkg"; then ok "$bin (brew)"; return 0; fi
  if [ -n "$go_pkg" ] && have go && GOBIN="$HOME/go/bin" go install "$go_pkg"; then ok "$bin (go)"; return 0; fi
  warn "$bin kurulamadı — elle: brew install $brew_pkg${go_pkg:+  /  go install $go_pkg}"
  return 0
}
install_tool nuclei   nuclei   "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
install_tool katana   katana   "github.com/projectdiscovery/katana/cmd/katana@latest"
install_tool gitleaks gitleaks "github.com/gitleaks/gitleaks/v8@latest"
# osv-scanner: STACK BAĞIMSIZ bağımlılık zafiyeti taraması (dart/deno/flutter/swift gibi kendi denetim
# aracı olmayan stack'lerin tek kapsamı — 2026-08-03).
install_tool osv-scanner osv-scanner "github.com/google/osv-scanner/v2/cmd/osv-scanner@latest"
# semgrep: go paketi yok → brew (mac) / pipx|pip (linux)
if have semgrep; then ok "semgrep (zaten kurulu)"
elif [ "$OS" = "Darwin" ] && have brew && brew install semgrep; then ok "semgrep (brew)"
elif have pipx && pipx install semgrep; then ok "semgrep (pipx)"
elif have pip3 && pip3 install --user semgrep; then ok "semgrep (pip)"
else warn "semgrep kurulamadı — elle: brew install semgrep / pipx install semgrep"; fi

# ── 6. Playwright Chromium (proje kılavuzu ekran görüntüleri) ──
say "6. Playwright Chromium"
if (cd orchestrator && npx playwright install chromium); then ok "chromium kuruldu"
else warn "chromium kurulamadı — gerektiğinde MyCL kendi kurmayı dener"; fi

# ── 7. nuclei güncel CVE template'leri ──
say "7. nuclei template'leri (güncel CVE)"
if have nuclei && nuclei -update-templates -silent; then ok "template'ler güncel"
else warn "nuclei template güncellenemedi (nuclei yoksa atlanır)"; fi

say "BİTTİ ✅  Her şey hazır."
echo "Başlat:  npm run tauri dev"
echo "İlk açılışta API anahtarlarını gir (~/.mycl/secrets.json'a yazılır; repo'ya ASLA girmez)."
