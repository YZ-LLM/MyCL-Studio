// regression-diff — fix-modu için REGRESYON farkı. Ümit 2026-06-12: gate, fix'i TÜM `npm test`'le yargılayıp
// ÖNCEDEN-VAR/alakasız kırmızılarda doğru fix'i "başarısız" sayıp geri alıyor + boş eskalasyon yapıyordu
// (adminpanel: 18 fail YouTube/Navigation + 2 boş suite, fix users-me GEÇMİŞTİ). Çözüm: fix ÖNCESİ baseline al,
// fix SONRASI yalnız YENİ düşen testte (gerçek regresyon) fail et. Önceden-kırık + bozuk-dosya fix'in suçu değil.
//
// KRİTİK İÇGÖRÜ: parser mükemmel olmak ZORUNDA DEĞİL — yalnız iki koşu arasında TUTARLI olması yeter. Fark
// (sonra ∖ önce) yeni kırılmaları verir; tutarlı gürültü iki tarafta da olur → farkta iptal olur. Çapraz-runner
// (vitest/jest/pytest/cargo/go) için yaygın fail-satır desenleri; runner anlaşılamazsa (kırmızı ama 0 fail
// ayrıştırıldı) ÇAĞIRAN mutlak davranışa düşer (sahte-yeşil önleme).

import { stripAnsi } from "./strip-ansi.js";

/** Yaygın test-runner fail-satır desenleri. Yakalanan grup = testin (koşular arası sabit) kimliği. */
const FAIL_PATTERNS: RegExp[] = [
  // vitest/jest/mocha: "× Suite > test ... 5ms" / "✕ test" / "✗ test" — sondaki süre (12ms) soyulur.
  /^\s*[×✕✗✖]\s+(.+?)(?:\s+\d+\s*m?s)?\s*$/,
  // vitest/jest dosya: "FAIL path/to/file"
  /^\s*FAIL\s+(.+?)\s*$/,
  // pytest: "FAILED tests/x.py::test_y"
  /^\s*FAILED\s+(.+?)\s*$/,
  // go: "--- FAIL: TestName (0.00s)"
  /^\s*---\s*FAIL:\s*(.+?)(?:\s*\(.*\))?\s*$/,
];

/** Çıktıdan fail-eden test kimliklerini çıkar (ANSI soy → normalize: trim + boşluk daralt). */
export function parseFailures(output: string): Set<string> {
  const out = new Set<string>();
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    for (const re of FAIL_PATTERNS) {
      const m = line.match(re);
      if (m && m[1]) {
        const id = m[1].trim().replace(/\s+/g, " ");
        // Saf sayı (örn. "5") veya boş → gürültü, atla.
        if (id && !/^\d+$/.test(id)) out.add(id);
        break; // bir satır tek desene sayılır
      }
    }
  }
  return out;
}

export interface RegressionResult {
  /** Önce YOK (geçiyordu) ama şimdi VAR (düşüyor) = gerçek regresyon. */
  regressed: string[];
  /** İki koşuda da fail = önceden-var (fix'in suçu değil). */
  preExistingCount: number;
  baselineCount: number;
  afterCount: number;
}

/** after ∖ baseline = fix'in YENİ kırdığı testler. */
export function computeRegression(baseline: Set<string>, after: Set<string>): RegressionResult {
  const regressed: string[] = [];
  let preExistingCount = 0;
  for (const id of after) {
    if (baseline.has(id)) preExistingCount++;
    else regressed.push(id);
  }
  return {
    regressed,
    preExistingCount,
    baselineCount: baseline.size,
    afterCount: after.size,
  };
}
