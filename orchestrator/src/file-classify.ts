// file-classify — dosya yolu sınıflandırma TEK kaynağı (kaynak/test/kozmetik/config).
//
// Neden (YZLLM 2026-07-16, "çözümler her zaman generic olsun"): aynı bilgi üç yerde
// TUTARSIZ kopyaydı — phase-8 `PROD_EXT` (dar), fix/evidence `SOURCE_EXTS` (farklı küme),
// tech-debt-scanner `isTestPath` (üst küme desenler). Tek modül + BİRLEŞİM tabloları;
// üç eski dosya buradan import/re-export eder.
//
// Yerleşim kararı: bu tablolar profillere DEĞİL koda ait — dosya-uzantısı bilgisi
// stack'ten BAĞIMSIZDIR (bir `.py` her repoda kaynaktır; karışık dilli repolar var;
// stack bilinmezken de gerekir). KATI #1 yalnız stack'e BAĞIMLI bilgiyi profile koyar.
//
// Tümü SAF fonksiyon — FS erişimi yok, birim testlenebilir.

/**
 * Kaynak kod uzantıları — üç eski listenin BİRLEŞİMİ + `.dart` `.cs` (ikisi de
 * desteklenen stack'ti ama hiçbir listede yoktu → Faz 8'de prod sayılmıyordu;
 * eklemek gate'i GÜÇLENDİRİR, zayıflatmaz).
 */
const SOURCE_EXTS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".ex", ".exs",
  ".rb", ".php", ".vue", ".svelte", ".cpp", ".c", ".dart", ".cs",
];

/** Yol kaynak kod uzantısıyla mı bitiyor (test/prod ayrımı YAPMAZ — ham uzantı kontrolü). */
export function hasSourceExt(p: string): boolean {
  for (const e of SOURCE_EXTS) if (p.endsWith(e)) return true;
  return false;
}

// Test/spec dosya desenleri — tech-debt-scanner'daki üst kümenin taşınmış hâli
// (phase-8'in eski listesi bunun alt kümesiydi; birleşim = bu liste).
// Dizin desenleri (^|/) ile çapalı: git-göreli yollarda baştaki eğik çizgi yok —
// eski /\/tests\// deseni kök seviyedeki `tests/foo.py`yu sessiz kaçırıyordu.
const TEST_PATH_PATTERNS: RegExp[] = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /_test\.(py|go|rs)$/,
  /test_.*\.py$/,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
];

/** Yol test/spec dosyası mı. node_modules → false (zaten elenir). */
export function isTestPath(path: string): boolean {
  if (path.includes("node_modules")) return false;
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

/** Yol PROD kaynak dosyası mı (kaynak uzantılı + test değil + node_modules değil). */
export function isProdPath(path: string): boolean {
  if (path.includes("node_modules") || isTestPath(path)) return false;
  return hasSourceExt(path);
}

// v15.10: repro-gate kapsamı için "kozmetik" dosya (stil/markup/doküman/görsel)
// ayrımı — yalnız bunlar değiştiyse mantık değişikliği yok → repro-gate muaf.
// Diğer her şey (kod, config) mantık sayılır (güvenli taraf). Regex yerine uzantı
// kümesi (minimal).
const COSMETIC_EXTS = new Set([
  ".css", ".scss", ".sass", ".less", ".html", ".htm",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".md", ".markdown", ".txt",
]);
export function isCosmeticFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && COSMETIC_EXTS.has(path.slice(dot).toLowerCase());
}

// BDD dış döngü (YZLLM 2026-07-03): görünür yaşayan dokümantasyon — `features/*.feature`.
// Gherkin biçimli düz metin; parser/runner YOK (stack-bağımsız, KATI#1). SAF.
// NOT: `.feature` bilerek isTestPath/isProdPath/isCosmeticFile'ın HİÇBİRİNE uymaz → tech-debt
// taramasına girmez, tdd-*-write saymaz, repro-gate'i tetiklemez (çift sayım YOK). Bu bir GATE
// DEĞİL: yalnız görünürlük/telemetri (bdd-scenario-write audit + Faz 9 yumuşak inceleme).
export function isFeatureFile(path: string): boolean {
  if (path.includes("node_modules")) return false;
  return /\.feature$/i.test(path);
}

// GÖREV-SINIFI #3 (YZLLM 2026-06-21, Vestel canlı + mahkeme tasarımı): build/test-tooling CONFIG
// dosyası mı. Bu dosyalar test-toplama/derleme/lint AYARIDIR — çalışan PROD kod-yolu DEĞİL → runtime
// kırmızı→yeşil repro İMKANSIZ/anlamsız (playwright.config.ts'e testMatch eklemek gibi). STACK-BAĞIMSIZ
// generic isim kalıbı (tek framework hardcode YOK: ".config." eki tüm JS araçlarında ortak + tsconfig/
// jsconfig + rc + yaygın test/lint config'leri). PAKET-MANİFESTİ (package.json/Cargo.toml/go.mod) HARİÇ —
// onlar bağımlılık taşır, prod'u etkiler. Kuşkuda FALSE (güvenli taraf: prod kabul et, repro iste).
const CONFIG_EXTS = new Set([".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json"]);
const OTHER_CONFIG_BASENAMES = new Set([
  "pytest.ini", "tox.ini", "mypy.ini", ".flake8", // Python test/lint tooling (deps taşımaz)
]);
export function isBuildConfigFile(path: string): boolean {
  if (path.includes("node_modules")) return false;
  // Build/test-tooling config repo KÖKÜNDE bulunur (playwright.config.ts, vitest.config.ts, tsconfig.json).
  // İç içe '*.config.ts' (ör. Angular src/app/app.config.ts) RUNTIME app-config olabilir → kök şartı bu
  // yanlış-muafiyeti keser (kuşkuda prod kabul et, repro iste). Monorepo alt-config'i de güvenli tarafta kalır.
  const norm = path.startsWith("./") ? path.slice(2) : path;
  if (norm.includes("/")) return false;
  const base = norm.toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  // <ad>.config.<js-ext> — playwright/vitest/jest/vite/next/tailwind/postcss/eslint/rollup/webpack/cypress…
  if (base.includes(".config.") && CONFIG_EXTS.has(ext)) return true;
  // tsconfig*.json / jsconfig*.json (tsconfig.build.json dahil)
  if (/^(ts|js)config(\.[\w-]+)*\.json$/.test(base)) return true;
  // .<tool>rc / .<tool>rc.<ext> — eslintrc, prettierrc, babelrc, stylelintrc, swcrc…
  if (/^\.[a-z]+rc(\.[\w-]+)?$/.test(base)) return true;
  // diğer stack'lerin yaygın test/lint-tooling config'leri
  return OTHER_CONFIG_BASENAMES.has(base);
}

/**
 * Yol RUNTIME PROD dosyası mı — Faz 8 repro-gate'in tek sorusu: "çalışan üretim
 * kod yolu değişti mi?". Kaynak uzantılı + test değil + kök build/test-config değil.
 * (Kozmetik dosyalar kaynak uzantısı taşımadığı için zaten dışarıda kalır.)
 */
export function isRuntimeProdFile(path: string): boolean {
  return isProdPath(path) && !isBuildConfigFile(path);
}
