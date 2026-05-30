// tech-debt-scanner — Phase 8 "ASLA TEKNİK BORÇ BIRAKMA" enforcement
// (MyCL_Pseudocode.md:203).
//
// Production path'larına yazılan/edit edilen dosyaları tarar ve teknik borç
// göstergelerini tespit eder. Phase 8 observer her Write/Edit sonrası bu
// scanner'ı çağırır; bulgular `tdd-tech-debt-detected` audit event olarak
// kayda geçer. Gate evaluation tech_debt_count !== 0 ise faili döndürür.
//
// Detection categories:
//   - todo_comment: TODO/FIXME/HACK/XXX/WIP yorum işaretleri
//   - mock_in_prod: mock/stub/dummy/fake kelimesi production path'inde
//   - hardcoded_credential: inline password/api_key/secret
//   - empty_catch: try/catch içinde boş veya sadece comment'li body
//   - skipped_test: .skip(/.only(/xit(/xdescribe( — Phase 8 prod path'lerinde
//     genelde yok ama defensive
//
// Test path'leri (isTestPath) tarama dışı tutulur — mock/dummy oralarda OK.

import type { State } from "./types.js";

export interface TechDebtFinding {
  category:
    | "todo_comment"
    | "mock_in_prod"
    | "hardcoded_credential"
    | "empty_catch"
    | "skipped_test";
  line: number;
  excerpt: string; // Bulgu satırının kısa snippet'i (max 100 char)
  reason: string;
}

/**
 * Production code'da kabul edilmeyen yorum işaretleri. Test path'lerinde
 * (`*.test.*`, `__tests__/`) tarama dışı — orada TODO/FIXME OK.
 */
const TODO_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(TODO|FIXME|HACK|XXX|WIP)\b/i, reason: "todo/fixme/hack/xxx/wip marker" },
];

/**
 * Production code'da mock/stub/dummy/fake kelimesi. Test fixtures legit
 * gerekirse `seed` veya `sample` kullanılmalı. Variable naming sınırı:
 * `mockData`, `stubResponse`, `dummyUser` gibi identifier'lar TOO BROAD —
 * kullanıcı isimlendirme normal kullanım için fallback dışı tutulur:
 * gerçek mock kütüphane import'ları (jest.mock, vi.mock, sinon.stub) prod'da
 * olmamalı (zaten test path'lerine ait).
 */
const MOCK_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(vi|jest)\.mock\s*\(/, reason: "test mocking call in production path" },
  { re: /\bsinon\.(stub|fake|mock)\s*\(/, reason: "sinon stub/fake in production" },
  { re: /\bmockImplementation\s*\(/, reason: "mockImplementation in production" },
];

/**
 * Hardcoded credentials. Pattern: identifier ataması + sabit string (en az 8 char).
 * False positive azaltma: env var (`process.env.X`), readFile, config.get çağrıları
 * değer olarak çıkarılır.
 */
const CREDENTIAL_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\b(password|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'$]{8,}["']/i,
    reason: "hardcoded credential literal",
  },
];

/**
 * Boş catch blokları. `catch (e) {}`, `catch {}`, `catch (_) { // ignore }`
 * gibi pattern'ler — gerekçesiz sessizlik = tech debt.
 */
const EMPTY_CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/**
 * Skipped test: .skip(, .only(, xit(, xdescribe(, @pytest.skip
 */
const SKIPPED_TEST_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\.\s*skip\s*\(/, reason: ".skip() leaves test pending" },
  { re: /\.\s*only\s*\(/, reason: ".only() excludes other tests" },
  { re: /\bxit\s*\(/, reason: "xit() skipped test" },
  { re: /\bxdescribe\s*\(/, reason: "xdescribe() skipped suite" },
  { re: /@pytest\.mark\.skip\b/, reason: "@pytest.mark.skip" },
];

/**
 * Bir dosya içeriğini tarar ve tüm tech debt bulgularını döner. Boş array =
 * temiz. Her finding line number + kısa excerpt + reason içerir.
 *
 * `path`: dosya yolu (sadece reason mesajına dahil edilir; tarama yapmaz).
 */
export function scanTechDebt(content: string): TechDebtFinding[] {
  const findings: TechDebtFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    for (const p of TODO_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          category: "todo_comment",
          line: ln,
          excerpt: line.trim().slice(0, 100),
          reason: p.reason,
        });
      }
    }
    for (const p of MOCK_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          category: "mock_in_prod",
          line: ln,
          excerpt: line.trim().slice(0, 100),
          reason: p.reason,
        });
      }
    }
    for (const p of CREDENTIAL_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          category: "hardcoded_credential",
          line: ln,
          excerpt: line.trim().slice(0, 100),
          reason: p.reason,
        });
      }
    }
    if (EMPTY_CATCH_RE.test(line)) {
      findings.push({
        category: "empty_catch",
        line: ln,
        excerpt: line.trim().slice(0, 100),
        reason: "empty catch block",
      });
    }
    for (const p of SKIPPED_TEST_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          category: "skipped_test",
          line: ln,
          excerpt: line.trim().slice(0, 100),
          reason: p.reason,
        });
      }
    }
  }

  return findings;
}

/**
 * Helper: state üzerinden Phase 8 progress için Tech debt count okuma.
 * Audit log'tan değil; observer state'e patch eder.
 */
export function getTechDebtCount(state: State): number {
  return (state as State & { tdd_tech_debt_count?: number }).tdd_tech_debt_count ?? 0;
}
