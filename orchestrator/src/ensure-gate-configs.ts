// ensure-gate-configs — Faz 10-17 mekanik gate'leri için ÖNDEN-DOĞRU config üretimi.
//
// YZLLM 2026-06-19 ("sarı kalmasın"): bir gate, config eksikliği yüzünden fail-then-fix
// olunca sidebar SARI kalıyor (gate fail → düzelt → complete). ensureCspMeta deseni gibi
// MyCL config'i BAŞTAN doğru yazarsa gate temiz geçer (sarı kalmaz). Deterministik,
// idempotent, fail-soft (asla throw etmez — gate yine de koşar).

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPkgDeps(projectRoot: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf-8"));
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/** package.json'da `next` var mı (Next.js projesi mi). */
export async function isNextJsProject(projectRoot: string): Promise<boolean> {
  return "next" in (await readPkgDeps(projectRoot));
}

/**
 * Next.js framework-convention + tool-config dosyaları — ts-prune bunları "ölü export" SANIR
 * (import edilmezler; framework/araç dosya-adı convention'ıyla okur). ts-prune `ignore` (path-regex).
 * Bu sürümde `.ts-prunerc.json` config-ignore'u UYGULANMIYOR (CANLI: Vestel) ama CLI `-i <regex>`
 * ÇALIŞIYOR → mechanical-runner ts-prune scanCmd'ine `-i` ile enjekte eder. Tek kaynak burası.
 */
// NOT (YZLLM canlı-test 0621, AMPİRİK Vestel): ts-prune `-i` anchorlu (`(?:^|/)...$`) regex'i UYGULAMIYOR
// (filtrelemedi), ama anchorsuz SUBSTRING formu ÇALIŞIYOR. O yüzden form anchorsuz. Hafif over-match
// riski (ör. "homepage.tsx") nadir + yalnız ölü-kod tespitini etkiler (kod doğruluğunu değil) → kabul.
export const NEXT_TSPRUNE_IGNORE = [
  // app router + Next convention dosyaları (filename substring + uzantı)
  "(page|layout|route|loading|error|not-found|template|default|global-error|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|middleware|instrumentation)\\.[jt]sx?",
  // tool config dosyaları (default export'ları aracın kendisi okur; Vestel'de vitest/playwright.config yakalandı)
  "(next|vite|vitest|playwright|tailwind|postcss|eslint|jest|cypress)\\.config\\.",
  "pages/", // pages router: her dosya framework-kullanır (root + subdir)
  "\\.next/", // Next.js build çıktısı (generated types/d.ts; taranmamalı)
].join("|");

/**
 * Faz 11 (Sadeleştirme / ts-prune) Next.js-AWARE: ts-prune, Next.js framework-convention
 * export'larını (app router `page/layout/route/loading/error/…` default+named export'ları,
 * `pages/` router'ın her dosyası, `middleware`, `next.config`, `getServerSideProps` vb.) hiçbir
 * yere import edilmediği için "ölü kod" SANIYOR → false-positive → Faz 11 fail-then-fix → SARI.
 *
 * Çözüm: Next.js projesinde `.ts-prunerc.json` YOKSA, framework-convention dosyalarını `ignore`
 * eden bir tane yaz (ts-prune cosmiconfig ile okur). Gerçek bileşen dosyalarındaki ölü export'lar
 * yine yakalanır (yalnız convention dosyaları/dizinleri muaf). Kullanıcı/codegen kendi `.ts-prunerc`'ini
 * yazmışsa DOKUNMA. Next.js değilse no-op.
 *
 * @returns "written" (yeni yazıldı) | "present" (zaten var, dokunulmadı) | "not-next" (Next.js değil)
 */
export async function ensureTsPruneConfig(
  projectRoot: string,
): Promise<"written" | "present" | "not-next"> {
  // Mevcut config'e dokunma (ts-prune'un okuduğu her cosmiconfig kaynağı).
  for (const c of [".ts-prunerc", ".ts-prunerc.json", ".ts-prunerc.js", ".ts-prunerc.cjs"]) {
    if (await exists(join(projectRoot, c))) return "present";
  }
  if (!(await isNextJsProject(projectRoot))) return "not-next";

  // ts-prune `ignore` (path-regex). Tek kaynak: NEXT_TSPRUNE_IGNORE (mechanical-runner CLI -i de aynı).
  // NOT: bu config-ignore mevcut ts-prune sürümünde UYGULANMIYOR (CANLI: Vestel) — yine de yazılır
  // (dokümante eder + ileride çalışırsa); ASIL etki mechanical-runner'ın CLI `-i` enjeksiyonu.
  const body = JSON.stringify(
    {
      // MyCL Studio tarafından üretildi (Next.js framework-export'ları ts-prune'da false-positive
      // vermesin — Faz 11 sarı kalmasın). Düzenlemek/iptal için bu dosyayı silin veya kendi
      // .ts-prunerc'inizi yazın; MyCL var olan config'e dokunmaz.
      ignore: NEXT_TSPRUNE_IGNORE,
    },
    null,
    2,
  );
  try {
    await writeFile(join(projectRoot, ".ts-prunerc.json"), body + "\n", "utf-8");
    return "written";
  } catch {
    return "present"; // fail-soft: yazılamadıysa gate yine koşar (false-positive riski sürer ama çökmez)
  }
}

/**
 * `.semgrepignore` — üçüncü-taraf/minified/bundle kodu semgrep taramasından muaf tutar (Faz 10 Lint +
 * Faz 13 Güvenlik sahte-pozitif vermesin). CANLI-BUG (cave5): `public/assets/js/bundles/ckeditor/*` +
 * TinyMCE gibi vendor bundle'lar KAYNAK ağacında (build-dir değil) → CLI `--exclude` build-dir'leri elese
 * de bunlar taranıp 65 false-positive üretti → Faz 10/13 sahte-sarı. Minified globlar CLI'da da var
 * (semgrep-excludes.ts); buradaki EK katman minified-OLMAYAN vendor'ı (path-anchored bundles/ +
 * conventional vendor dizinleri) yakalar; tek dosya tüm config'lere + scoped moda uygulanır.
 *
 * FALSE-GREEN GÜVENLİĞİ: bundles/ gibi dizin desenleri KENDİ kaynağını yanlışlıkla eleyebilir →
 * dosya GÖRÜNÜR + kullanıcı-silebilir + başlıkta uyarı. Var olan `.semgrepignore`'a DOKUNMAZ (idempotent).
 *
 * @returns "written" | "present" (zaten var, dokunulmadı)
 */
export async function ensureSemgrepIgnore(projectRoot: string): Promise<"written" | "present"> {
  const target = join(projectRoot, ".semgrepignore");
  if (await exists(target)) return "present";
  const body = [
    "# MyCL Studio tarafından üretildi — üçüncü-taraf / minified / bundle kodu semgrep taramasından muaf",
    "# (Faz 10 Lint + Faz 13 Güvenlik sahte-pozitif vermesin). KENDİ kodunuz yanlışlıkla eleniyorsa ilgili",
    "# satırı silin; MyCL var olan .semgrepignore'a DOKUNMAZ. Bu bir hariç-tutma listesidir (gitignore söz dizimi).",
    "*.min*.js",
    "*.min*.css",
    "*.bundle.js",
    "*.chunk.js",
    "*.vendor.js",
    "**/bundles/**",
    "**/bower_components/**",
    "**/jspm_packages/**",
    "",
  ].join("\n");
  // MAHKEME (2026-07-01, çapraz-aile): `**/vendor/**` + `**/vendors/**` BİLEREK ÇIKARILDI — `src/vendors/stripe.ts`
  // gibi KENDİ kaynağını eleyip gerçek bulgu gizleyebilirdi (false-green). Kök `vendor` zaten CLI `--exclude='vendor'`
  // ile kapsanıyor (semgrep-excludes.ts). bower_components/jspm_packages gerçek paket dizinleri (kendi-kod riski yok).
  try {
    await writeFile(target, body, "utf-8");
    return "written";
  } catch {
    return "present"; // fail-soft: yazılamadıysa CLI --exclude minified globları yine minified'ı eler
  }
}
