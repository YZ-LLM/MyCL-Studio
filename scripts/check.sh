#!/usr/bin/env bash
# scripts/check.sh — Tek doğruluk kaynağı: yayın/geliştirme gate'i.
#
# Hem yerel (`npm run check`) hem CI (.github/workflows/check.yml) BUNU çağırır.
# Herhangi bir kontrol başarısızsa exit 1 → push/CI kırmızı, gürültüyle patlar.
# Yeni kontrol eklemek = buraya bir blok; tek artefakt, çürüyen state tablosu yok.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n── %s ──\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }

step "1/7 Orchestrator build (tsc)"
if npm --prefix orchestrator run build; then ok "build temiz"; else bad "orchestrator build"; fi

step "2/7 Orchestrator testleri (vitest)"
if npm --prefix orchestrator test; then ok "testler yeşil"; else bad "orchestrator test"; fi

step "3/7 Frontend tip kontrolü (tsc --noEmit)"
if npx tsc --noEmit; then ok "frontend typecheck temiz"; else bad "frontend typecheck"; fi

# Pattern'ler bu dosyada da geçtiği için taramadan check.sh + lockfile hariç tutulur.
EXCL=(':(exclude)scripts/check.sh' ':(exclude)package-lock.json')

step "4/7 Sızıntı taraması (secret dosya / gerçek anahtar)"
secrets=$(git ls-files | grep -iE 'secrets\.json|auth\.json|(^|/)\.env$|\.key$|\.pem$' || true)
skant=$(git grep -nE "sk-ant-[A-Za-z0-9]{6}" -- . "${EXCL[@]}" 2>/dev/null \
        | grep -viE "test|placeholder|redact|SECRET_KEY_RE" || true)
if [ -z "$secrets" ] && [ -z "$skant" ]; then
  ok "sızıntı yok"
else
  bad "sızıntı bulundu"
  [ -n "$secrets" ] && { echo "    secret dosya:"; echo "$secrets" | sed 's/^/      /'; }
  [ -n "$skant" ]   && { echo "    olası anahtar:"; echo "$skant" | sed 's/^/      /'; }
fi

# Not: "Opus 4.7" gibi model isimleri DESEN DEĞİL — "ultracode yalnızca Opus
# 4.7/4.8'de geçerli" gibi meşru/doğru kullanımlar var (false positive olur).
# Yalnızca tartışmasız eskimiş sürüm/mimari banner'ları taranır.
step "5/7 Eski-iddia taraması (aktif/tracked dosyalar)"
stale=$(git grep -lE "20 Faz|20-phase|MIMARI YASAKLARI|126 test|v1[34] —" -- . "${EXCL[@]}" 2>/dev/null || true)
if [ -z "$stale" ]; then ok "eski iddia yok"; else bad "eski iddia bulundu"; echo "$stale" | sed 's/^/      /'; fi

# Custom semgrep kuralları (güvenlik=Faz 13, kod-kalite=Faz 10) bozuksa runner
# tool_error_codes ile SESSİZCE skip eder → gate sessizce düşer. O yüzden YAML'ları
# validate et. semgrep yoksa (CI'da kurulu olmayabilir) ATLA — eksik araç CI'yı KIRMASIN
# (bu bir geliştirme-zamanı drift guard'ı; gerçek tarama runtime'da Faz 10/13'te).
step "6/7 Custom semgrep kuralları (güvenlik + kod-kalite; --validate, varsa)"
if command -v semgrep >/dev/null 2>&1; then
  if semgrep --validate --config assets/security-rules/ >/dev/null 2>&1; then
    ok "custom güvenlik kuralları geçerli (Faz 13)"
  else
    bad "assets/security-rules/ — geçersiz semgrep kuralı (Faz 13 güvenlik gate'i sessizce düşer)"
  fi
  if semgrep --validate --config assets/quality-rules/ >/dev/null 2>&1; then
    ok "custom kod-kalite kuralları geçerli (Faz 10)"
  else
    bad "assets/quality-rules/ — geçersiz semgrep kuralı (Faz 10 kod-kalite gate'i sessizce düşer)"
  fi
else
  ok "semgrep yok — kural validate atlandı (runtime Faz 10/13'te taranır)"
fi

# setup.sh "kopyala/clone → çalışır" sözleşmesini taşır. Kod yeni bir dış araç eklerse
# (toolInstalled("X")) setup.sh onu kurmuyorsa burada PATLAR → "eksik kalmasın" otomasyonu.
step "7/7 setup.sh dış-araç kapsamı (eksik kalmasın)"
req=$(grep -rhoE 'toolInstalled\("[a-z0-9_-]+"\)' orchestrator/src 2>/dev/null \
      | sed -E 's/.*"([a-z0-9_-]+)".*/\1/' | sort -u)
req="$req semgrep gitleaks playwright cargo node osv-scanner"  # toolInstalled kullanmayan sabit baz araçlar
miss=""
for t in $req; do grep -qw "$t" setup.sh 2>/dev/null || miss="$miss $t"; done
if [ -z "$miss" ]; then
  ok "setup.sh tüm dış araçları kapsıyor ($(echo $req | tr ' ' ',' ))"
else
  bad "setup.sh eksik araç(lar):$miss — setup.sh'e kurulum ekle (yeni makine bunlarsız çalışmaz)"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  echo "✅ check: HEPSİ GEÇTİ"
else
  echo "❌ check: BAŞARISIZ — yukarıdaki ✗ satırlarını düzelt"
fi
exit "$fail"
