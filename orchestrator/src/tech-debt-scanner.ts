// tech-debt-scanner — Phase 8 "ASLA TEKNİK BORÇ BIRAKMA" enforcement
// (sıfır-teknik-borç ilkesi).
//
// Production path'larına yazılan/edit edilen dosyaları tarar ve teknik borç
// göstergelerini tespit eder. Faz 8 kapısı bu iterasyonda yazılan/düzenlenen dosyaları
// KAPI ANINDA, o anki içerikleriyle tarar (2026-11-28; eskiden her Write/Edit anında —
// CLI kipinde araç henüz koşmadan — taranıyordu); bulgular `tdd-tech-debt-detected`
// audit event olarak kayda geçer. Kapı bulgu varsa düşer.
//
// Detection categories:
//   - todo_comment: TODO/FIXME/HACK/XXX/WIP yorum işaretleri (büyük harf + önünde yorum başlatıcısı; isTodoCommentLine)
//   - mock_in_prod: mock/stub/dummy/fake kelimesi production path'inde
//   - hardcoded_credential: inline password/api_key/secret
//   - empty_catch: try/catch içinde boş veya sadece comment'li body
//   - skipped_test: .skip(/.only(/xit(/xdescribe( — Phase 8 prod path'lerinde
//     genelde yok ama defensive
//
// Test path'leri (isTestPath) tarama dışı tutulur — mock/dummy oralarda OK.


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
const TODO_MARKER_RE = /\b(TODO|FIXME|HACK|XXX|WIP)\b/g;
const TODO_REASON = "todo/fixme/hack/xxx/wip marker";

/**
 * SAF (2026-11-28, ekransız deneme koşusu 31): satır gerçek bir borç YORUMU mu taşıyor?
 *
 * KANIT: işaret satırın her yerinde ve harf ayrımı olmadan aranıyordu; yapılacaklar uygulamasında
 * `… ?? "todo.sqlite3";` ve `` `todo server listening …` `` satırları `todo_comment` sayıldı, Faz 8 kapısı 13 kez düştü.
 *
 * KURAL (stack'e bağlı değil): işaret BÜYÜK harfle yazılmış olmalı VE aynı satırda ondan önce bir yorum başlatıcısı
 * bulunmalı: `//` (önünde `:` yokken), `/*`, `<!--` satırın herhangi bir yerinde; `#` ve `--` satır başında ya da boşluktan
 * sonra; `*`, `;`, `%` satır başında. Satır ortasındaki
 * `;` ve `%` yalnız işaretten HEMEN önce gelirse (aradaki boşluk hariç) sayılır: JS'te `a(); s = "TODO"` gibi satırlarda
 * `;` deyim sonudur, yorum değil (temkinli seçim).
 * BİLEREK: küçük harfli `// todo: …` artık yakalanmaz.
 */
export function isTodoCommentLine(line: string): boolean {
  if (/^\s*[*;%]/.test(line) && new RegExp(TODO_MARKER_RE.source).test(line.replace(/^\s*[*;%]+/, ""))) return true;
  for (const m of line.matchAll(TODO_MARKER_RE)) {
    const prefix = line.slice(0, m.index);
    // `#` ve `--` yalnız satır başında ya da boşluktan sonra (`this.#alan`, `"#fff"`, `i--` yorum değil); `//` önünde `:`
    // olmamalı (`http://…` adres) — inceleme bulgusu, temkinli seçim.
    if (/(^|[^:])\/\/|\/\*|<!--|(^|\s)#|(^|\s)--/.test(prefix)) return true;
    if (/[;%]\s*$/.test(prefix)) return true;
  }
  return false;
}

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
 * FIX D (YZLLM 2026-07-01): kabul-anahtarı — (dosya + kategori + normalize snippet). Kullanıcı bir bulguyu
 * KALICI kabul edince bu anahtar `.mycl/accepted-findings.jsonl`'e yazılır; scanTechDebt eşleşen anahtarı ATLAR.
 * NORMALİZASYON: path ayraçları `/`, snippet lower-case + boşluk sadeleştirme → ufak biçim farkları eşleşmeyi
 * bozmaz. İdempotent (tekrar normalize güvenli). FARKLI snippet → farklı anahtar → güvenlik korunur (yeni parola işaretlenir).
 */
export function acceptedFindingKey(file: string, category: string, excerpt: string): string {
  const f = file.replace(/\\/g, "/");
  const snip = excerpt.trim().toLowerCase().replace(/\s+/g, " ");
  return `${f}::${category}::${snip}`;
}

/**
 * Bir dosya içeriğini tarar ve tüm tech debt bulgularını döner. Boş array =
 * temiz. Her finding line number + kısa excerpt + reason içerir.
 *
 * `path`: dosya yolu (reason mesajına dahil + i18n muafiyeti + kabul-anahtarı için).
 * `acceptedKeys`: KALICI kabul edilmiş bulguların anahtar kümesi (FIX D) — eşleşen bulgular atlanır
 * (aynı-soru döngüsü kalıcı kırılır). Verilmezse tüm bulgular döner (geriye uyumlu).
 */
export function scanTechDebt(
  content: string,
  path?: string,
  acceptedKeys?: ReadonlySet<string>,
): TechDebtFinding[] {
  const findings: TechDebtFinding[] = [];
  const lines = content.split("\n");
  // YZLLM canlı-test 0620: i18n/çeviri dosyaları credential taramasından MUAF — UI etiketleri
  // (ör. `password: "Password"`, `password: "Şifre"`) sır DEĞİL ama key adı credential-benzeri +
  // değer ≥8 char olunca hardcoded_credential SANILIYORDU → Faz 8 SAHTE gate → error-analysis
  // çözülecek-sorun-yok döngüsünde 344K token boğulup blok üretemedi → 8 saatlik iş DÜŞTÜ.
  // (TODO/mock/skip gibi gerçek borçlar i18n'de de YAKALANIR; yalnız credential atlanır.)
  const skipCredential = !!path && isI18nLabelFile(path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    if (isTodoCommentLine(line)) {
      findings.push({
        category: "todo_comment",
        line: ln,
        excerpt: line.trim().slice(0, 100),
        reason: TODO_REASON,
      });
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
    if (!skipCredential) {
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

  // FIX D: KALICI kabul edilmiş bulguları ele (aynı-soru döngüsü kalıcı kırılır). path yoksa anahtar üretilemez
  // → filtre atlanır (geriye uyumlu). Güvenlik: yalnız TAM anahtar (dosya+kategori+snippet) eşleşince atlanır.
  if (acceptedKeys && acceptedKeys.size > 0) {
    return findings.filter(
      (f) => !acceptedKeys.has(acceptedFindingKey(path ?? "", f.category, f.excerpt)),
    );
  }

  return findings;
}

/**
 * FIX D: son (kabul-edilebilir) tech-debt bulguları — projeRoot → dosya bazlı mevcut bulgular. `tdd-tech-debt-detected`
 * audit event'i kısaltılmış satır metni taşıdığından KALICI kabul yazarken tam snippet'e buradan erişilir. Faz 8 kapısı
 * her değerlendirmede depoyu sıfırlayıp kendi taramasıyla doldurur (2026-11-28; tek kaynak kapı anındaki tarama).
 * Bellek-içi (döngü tek-oturum) — kalıcılık `.mycl/accepted-findings.jsonl`'de.
 */
const _lastTechDebtFindings = new Map<string, { file: string; category: string; excerpt: string }[]>();

/** Bir dosyanın mevcut bulgularını depoya yaz (o dosyanın eski girdilerini değiştirir). Boş findings → dosya temizlenir. */
export function updateLastTechDebtFindings(projectRoot: string, file: string, findings: TechDebtFinding[]): void {
  const kept = (_lastTechDebtFindings.get(projectRoot) ?? []).filter((x) => x.file !== file);
  for (const f of findings) kept.push({ file, category: f.category, excerpt: f.excerpt });
  _lastTechDebtFindings.set(projectRoot, kept);
}

/** Depodaki tüm mevcut bulguları döner (accept yazımı için). */
export function getLastTechDebtFindings(projectRoot: string): { file: string; category: string; excerpt: string }[] {
  return _lastTechDebtFindings.get(projectRoot) ?? [];
}

/**
 * FIX D (mahkeme 2026-07-01): iterasyon başında depoyu temizle → çapraz-iterasyon BAYATLIĞI önlenir.
 * Aksi halde önceki iterasyonda taranıp bu iterasyonda dokunulmayan bir dosyanın bulgusu depoda kalır →
 * kullanıcı FARKLI bir bulgu için "kalıcı kabul" derken istemeden o bayat bulguyu da yazardı (kapsam sızıntısı).
 */
export function resetLastTechDebtFindings(projectRoot: string): void {
  _lastTechDebtFindings.delete(projectRoot);
}

// Test/spec dosyaları — tech-debt taraması dışı (mock/dummy/skip oralarda meşru).
// Desenler 2026-07-16'da file-classify.ts'e taşındı (üç tutarsız kopyanın birleşimi
// — buradaki liste üst kümeydi, birleşim ona eşit). Re-export: import yolları korunur.
export { isTestPath } from "./file-classify.js";

// i18n / çeviri / locale dosyaları — UI etiket string'leri credential DEĞİL (yalnız
// hardcoded_credential kontrolünden muaf; TODO/mock/skip yine taranır). Yaygın yapılar:
// `i18n/`, `locale(s)/`, `lang/`, `translation(s)/` dizinleri + `messages.{ts,js}` / `*.messages.*`.
const I18N_PATH_PATTERNS: RegExp[] = [
  /(^|[/\\])(i18n|locales?|lang|translations?)([/\\]|$)/i,
  /(^|[/\\])messages\.[tj]sx?$/i,
  /\.messages\.[tj]sx?$/i,
];

/** Bir yol i18n/çeviri etiket dosyası mı (credential taramasından muaf). */
export function isI18nLabelFile(path: string): boolean {
  return I18N_PATH_PATTERNS.some((re) => re.test(path));
}
