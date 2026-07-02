// semgrep-excludes — TEK KAYNAK: tüm semgrep taramalarının paylaştığı `--exclude` bayrakları.
//
// Neden tek kaynak: bu bayraklar 15 çağrı yerine (phase-registry Faz 10/13 tarama + scoped şablonları +
// sast-scan) elle kopyalanmıştı → drift riski. Tek sabit → hepsi tutarlı, ekleme tek yerden.
//
// Kapsam:
//   - Build çıktısı: .next/dist/build/out/coverage/.turbo/.svelte-kit/.nuxt/target (üretilen kod = proje-borcu DEĞİL).
//   - Paket/vendor dizini: node_modules, vendor.
//   - Kendi audit'imiz: mycl-audit* (MyCL'in enjekte ettiği dosyalar).
//   - MINIFIED/BUNDLE vendor (YZLLM 2026-07-01): `*.min.js/css`, `*.bundle.js`, `*.chunk.js`, `*.vendor.js`.
//     Canlı-bug (cave5): `public/assets/js/bundles/ckeditor/*` + TinyMCE gibi üçüncü-taraf bundle'lar KAYNAK
//     ağacındaydı (build-dir değil) → hiçbir exclude eşleşmiyor → 65 false-positive → Faz 10/13 sahte-sarı.
//     Bu globlar DOSYA-desenli (dizin adı değil) → kendi kaynağını yanlışlıkla elemez (false-green güvenli).
//     Not: minified-OLMAYAN vendor (ör. CKEditor samples) için `.semgrepignore` path-anchored `**/bundles/**` ekler.
//     `*.min*.js` (yalnız `*.min.js` değil): canlı-bug (cave5) `table.min - Copy.js` gibi minified KOPYALARI da yakalar
//     (`.min` ekten sonra ` - Copy`/`(1)` gibi ekler alıyor). Nadir yan etki: `minimal.js`/`minimap.js` kaynak dosyası
//     da eleniyor — .semgrepignore görünür + kullanıcı satırı silebilir (kabul edilebilir denge, YZLLM onayı).
export const SEMGREP_EXCLUDE_FLAGS =
  "--exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' " +
  "--exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' " +
  "--exclude='vendor' --exclude='target' --exclude='*.min*.js' --exclude='*.min*.css' --exclude='*.bundle.js' " +
  "--exclude='*.chunk.js' --exclude='*.vendor.js'";
