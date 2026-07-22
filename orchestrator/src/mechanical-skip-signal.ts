// mechanical-skip-signal — koşullu mekanik fazların (Faz 5 UI / DAST / perf / db) SPEC-SİNYALİ. SAF + test-edilebilir.
//
// Neden ayrı modül (YZLLM 2026-07-14 test-kapsamı denetimi): bu regex mantığı `shouldRunMechanical` (index.ts, 8000+
// satır, export edilmemiş) içinde gömülüydü → BİRİM TESTİ YAPILAMIYORDU. Var olan test (skip-ui-phases-flow) kararın
// bir KOPYASINI test ediyordu (gölge-test = sahte güven: gerçek regex sapsa test yine yeşil kalır). Bu SAHTE-YEŞİL
// kaynağı (bkz project_faz5_skip_false_green): regex bir mekanik gate'i yanlış atlatırsa boş-build sahte-geçer.
// Buraya çıkarıldı → shouldRunMechanical bunu ÇAĞIRIR (tek kaynak) + gerçek regex birim-testli.
//
// KULLANIM: yalnız POZİTİF sinyal (koşul VAR → gate KOŞ). Faz 5'te tek başına SKIP kararı VERMEZ (yapısal
// skip_ui_phases + bu pozitif-override birlikte; index.ts:5106). Belirsizlikte gate KOŞAR (fail-open, kuşkuda full).

export type SkipUnless = "has_ui" | "has_web_target" | "has_nfr" | "has_database" | "always";

/** has_ui: UI-spesifik terimler. 'web' BİLEREK yok (mahkeme: library/API spec'te "web browsers" → yanlış UI tetiği;
 *  'web' has_web_target'a ait).
 *  CANLI KÖK (YZLLM 2026-07-21, cave iter26 /wellcome): spec İngilizce ("the /wellcome page renders empty, the
 *  ejs view has no visible dom content") ama regex İngilizce markup terimlerini İÇERMİYORDU → has_ui=false → Faz 16
 *  (E2E) yanlış atlandı. Eklenen terimler UI-markup (ejs/html/css/dom/jsx/tsx/stylesheet/navbar/markup/viewport/
 *  tailwind); /wellcome bunlardan ejs/dom/html ile eşleşir. MAHKEME MEDIUM: "render"/"modal" ÇIKARILDI — "render a
 *  PDF report" / "modal value" gibi UI-DIŞI meşru anlamları var + has_ui Faz 5 (UI build) tüketicisinde FP pahalı.
 *  page/view/route/form/table BİLEREK yok (route=backend, table=DB). Kaçan nadir UI vakaları tam-develop gerçek-app
 *  kapısıyla (proje UI-dosyası var mı → sentez) yakalanır — o kapı regex FP'sinden bağımsız. */
const RE_HAS_UI =
  /\b(ui|frontend|görsel|ekran|sayfa|button|react|vue|svelte|angular|dashboard|panel|portal|widget|layout|component|screen|chart|ejs|html|css|dom|jsx|tsx|stylesheet|navbar|markup|viewport|tailwind)\b/;
/** has_web_target: HTTP sunan her proje (web VEYA api). UI + api/sunucu terimleri; yalnız CLI/library/ml (HTTP yok) → false. */
const RE_HAS_WEB_TARGET =
  /\b(ui|frontend|görsel|ekran|sayfa|button|web|react|vue|svelte|angular|next|api|rest|endpoint|http|server|sunucu|backend|express|fastapi|flask|django|rails|graphql|swagger|openapi)\b/;
/** has_nfr: performans/yük terimleri. */
const RE_HAS_NFR = /\b(load|performance|throughput|latency|nfr|tps|rps|p95|p99)\b/;
/** has_database: SQL/NoSQL/ORM/kalıcılık terimleri.
 *  NOT (YZLLM 2026-07-14, gerçek-regex testi yakaladı): `veritaban` (`veritabanı` DEĞİL) — trailing `\b` sonundaki
 *  Türkçe `ı` ASCII \w olmadığı için `veritabanı\b` HİÇ eşleşmiyordu (ölü terim; gölge-test kaçırmıştı). `veritaban`
 *  n→ı sınırında geçerli `\b` yakalar → "veritabanı", "veritabanında" eşleşir. */
const RE_HAS_DATABASE =
  /\b(database|veritaban|db|prisma|sql|postgres|mysql|sqlite|mongo|mongodb|redis|nosql|orm|persist|persistence|supabase|firestore|dynamodb)\b/;

/**
 * Spec (küçük-harfe çevrilmiş) verilen koşulu (skip_unless) taşıyor mu → mekanik gate koşulmalı mı.
 * SAF: yalnız string→boolean (spec-okuma/fs YOK; onu shouldRunMechanical yapar). `always`/undefined → her zaman true.
 * Bilinmeyen koşul → true (fail-open, kuşkuda gate'i koş). Tek doğruluk kaynağı — index.ts BUNU çağırır.
 */
export function specSignalMatches(specLower: string, skip_unless: SkipUnless | undefined): boolean {
  if (!skip_unless || skip_unless === "always") return true;
  if (skip_unless === "has_ui") return RE_HAS_UI.test(specLower);
  if (skip_unless === "has_web_target") return RE_HAS_WEB_TARGET.test(specLower);
  if (skip_unless === "has_nfr") return RE_HAS_NFR.test(specLower);
  if (skip_unless === "has_database") return RE_HAS_DATABASE.test(specLower);
  return true; // bilinmeyen → fail-open
}
