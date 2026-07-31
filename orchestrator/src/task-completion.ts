// task-completion — bir kuyruk işi "Tamamlandı" (KİLİTLİ) damgalanabilir mi? SAF karar.
//
// KÖK NEDEN (canlı cave kanıtı 2026-07-30): tek ölçüt `hasDeliverable` idi — "proje klasöründe görünür
// bir dosya var mı". Mevcut bir projede bu HER ZAMAN doğru → süreç Faz 17'ye ulaştığı anda iş "done"
// damgalanıyordu, o iterasyonda hiçbir şey yapılmamış olsa bile. En açık kanıt: 13 Temmuz 15:52-15:58
// arasında altı standart iş (test altyapısı, responsive, güvenlik temeli, parmak izi, hata kataloğu,
// yardım kılavuzu) ortalama 70 saniyede "tamamlandı" işaretlendi; o dakikalarda audit'te tek bir dosya
// yazma olayı yok, bütün fazlar ya atlandı ya da denetim yapılamadan geçildi. Kullanıcı "37 işten hiçbiri
// bitmedi" diyor, kuyruk ise "26 tamamlandı" gösteriyordu.
//
// Yeni ölçüt: BU İTERASYONDA gerçekten iş yapıldığına dair POZİTİF kanıt. İki meşru kanıt türü var:
//   (a) dosya yazıldı/değiştirildi (codegen yazma olayları),
//   (b) "değişiklik gerekmedi" POZİTİF olarak kanıtlandı (inceleme yapıldı, kod zaten karşılıyor /
//       bulgu kanıtla false-positive çıktı / gerçek uygulamada sorun yok).
// Kanıt yoksa iş "done" DAMGALANMAZ; kuyruğa döner (mevcut yeniden deneme merdiveni; üç denemede
// otomatik durur, kaybolmaz). Bu, "atlama yok" ile çelişmez — iş kaybolmuyor, yalnız YALAN söylenmiyor.
//
// harness-verdict.ts'in kardeşi: aynı audit olay girdisi, aynı "yalnız bu iterasyon" pencere sözleşmesi.

/** Audit olayının bu modül için gereken alanları (harness-verdict ile aynı gevşek şekil). */
export interface CompletionAuditEvent {
  event?: string;
  detail?: string;
  ts?: number;
}

/**
 * Dosyaya yazan/değiştiren audit olayları — fix/scope.ts ile AYNI küme (tek doğruluk kaynağı orası;
 * burada kopya tutmak yerine oradan import edilir).
 */
export type CompletionEvidence =
  | { kind: "code-write"; events: string[] }
  | { kind: "no-change-needed"; signal: string }
  | { kind: "window-unknown" }
  | { kind: "none" };

export interface CompletionInput {
  /** BU İTERASYONA süzülmüş audit olayları (iteration_started_at sonrası). */
  events: readonly CompletionAuditEvent[];
  /** Audit gerçekten okunabildi mi (false → kanıt penceresi bilinmiyor). */
  auditReadable: boolean;
  /** state.iteration_started_at biliniyor mu (eski kayıtlarda yok). */
  iterationWindowKnown: boolean;
  /** hasDeliverable(projectRoot) — proje boş mu (bugünkü boş build kilidi). */
  deliverableExists: boolean;
  /** Ajan kaynaklı olduğu doğrulanmış değişen dosyalar (MyCL'in kendi çıktıları elenmiş). */
  agentAuthoredFiles?: readonly string[];
  /** Dosyaya yazan audit olaylarının adları (fix/scope.ts WRITE_EVENTS). */
  writeEvents: ReadonlySet<string>;
}

export type CompletionDecision =
  | { verdict: "done"; evidence: CompletionEvidence; note?: string }
  | { verdict: "requeue"; reason: string; userMessage: string };

/**
 * "Değişiklik gerekmedi" POZİTİF kanıtları. Dikkat: escalate (müfettiş çözemedi) kanıt DEĞİLDİR —
 * o "bilmiyoruz" demektir. Yalnız gerçekten bir inceleme yapılıp "gerek yok" sonucuna varılan olaylar.
 */
const NO_CHANGE_NEEDED_EVENTS: ReadonlySet<string> = new Set([
  "phase-5-no-change-needed", // ajan inceledi: kod spec'i zaten karşılıyor
  "mahkeme-suppress-accept-continue", // iki bağımsız değerlendirme KANITLA false-positive dedi
  "realapp-verify-pass", // bildirilen sorun çalışan uygulamada YOK
]);

/**
 * MAHKEME DÜZELTMESİ (2026-07-30): iki meşru iş `phase-N-complete` olayını DETAY ile ayırt ediyor —
 * olay adı genel olduğu için (her fazda yazılır) yalnız bu detaylar kanıt sayılır:
 *  - `mahkeme_false_positive_suppressed`: gate döngüsündeki mahkeme bulguyu kanıtla false-positive ilan etti
 *    (çalışan koda dokunulmadı — meşru "değişiklik gerekmedi").
 *  - `gate_autofix_resolved`: gate kendi içinde oto-düzeltildi. Bu yolda codegen gözlemcisi bağlı olmadığı
 *    için dosya yazma olayı audit'e düşmüyor; kanıt bu olaydır (yoksa düzeltilmiş güvenlik işi
 *    "kanıtsız" sayılıp kuyruğa geri dönerdi).
 */
const COMPLETE_DETAIL_EVIDENCE: ReadonlySet<string> = new Set([
  "mahkeme_false_positive_suppressed",
  "gate_autofix_resolved",
]);

/**
 * BİLEREK kanıt sayılmayan olaylar: bunlar HER pipeline sonunda koşar (yaşayan dökümantasyon tazeleme,
 * kılavuz ekran görüntüleri, spec yenileme). Kanıt sayılsalardı düzeltme tamamen etkisiz olurdu —
 * hiçbir iş yapılmayan bir koşu bile "dosya yazıldı" görünürdü.
 */
export const NON_EVIDENCE_EVENTS: ReadonlySet<string> = new Set([
  "living-docs-update",
  "guide-shots-generated",
  "devs-spec-refresh",
  "prototype-cache-saved",
  "error-catalog-ensured",
]);

/** SAF: iş "Tamamlandı" damgalanabilir mi? Karar sırası deterministik. */
export function decideTaskCompletion(inp: CompletionInput): CompletionDecision {
  // R0 — BUGÜNKÜ davranış birebir: proje boş → sahte tamamlanma kilidi (mesaj metni de korunur).
  if (!inp.deliverableExists) {
    return {
      verdict: "requeue",
      reason: "boş build — hiç uygulama/kaynak dosyası üretilmedi (sahte tamamlanma kilidi)",
      userMessage:
        "⛔ İş 'Tamamlandı' DAMGALANMADI — boş build (hiç uygulama/kaynak dosyası üretilmedi). İş kuyruğa geri kondu; bir sonraki denemede farklı yaklaşım kullanılacak.",
    };
  }
  // R1 — kanıt penceresi bilinmiyorsa eski davranışı sürdür ama SESSİZ kalma (KATI #4).
  if (!inp.auditReadable || !inp.iterationWindowKnown) {
    return {
      verdict: "done",
      evidence: { kind: "window-unknown" },
      note: "ℹ️ Bu işin çalışma kaydı okunamadı — 'Tamamlandı' damgalandı ama yapılan iş kayıttan doğrulanamadı.",
    };
  }
  // R2 — gerçek dosya kanıtı (codegen yazma olayları veya ajan kaynaklı değişen dosya).
  const writes = inp.events
    .map((e) => e.event ?? "")
    .filter((ev) => inp.writeEvents.has(ev) && !NON_EVIDENCE_EVENTS.has(ev));
  if (writes.length > 0) {
    return { verdict: "done", evidence: { kind: "code-write", events: [...new Set(writes)] } };
  }
  if ((inp.agentAuthoredFiles?.length ?? 0) > 0) {
    return { verdict: "done", evidence: { kind: "code-write", events: [] } };
  }
  // R3 — "değişiklik gerekmedi" POZİTİF kanıtı.
  for (const e of inp.events) {
    const ev = e.event ?? "";
    if (NO_CHANGE_NEEDED_EVENTS.has(ev)) {
      return { verdict: "done", evidence: { kind: "no-change-needed", signal: ev } };
    }
    // Gerçek uygulama kapısı bu işe UYGULANAMADI (nötr) → ayrı bir eksiklik değil.
    if (ev === "realapp-verify-skipped" && String(e.detail ?? "").startsWith("not_applicable")) {
      return { verdict: "done", evidence: { kind: "no-change-needed", signal: `${ev}:not_applicable` } };
    }
    // Faz tamamlanma olayının DETAYI kanıt taşıyor mu (mahkeme false-positive / gate oto-düzeltmesi)?
    if (ev.startsWith("phase-") && ev.endsWith("-complete") && COMPLETE_DETAIL_EVIDENCE.has(String(e.detail ?? ""))) {
      return { verdict: "done", evidence: { kind: "no-change-needed", signal: `${ev}:${e.detail}` } };
    }
  }
  // R4 — hiçbir kanıt yok: iterasyon boşa döndü. "Tamamlandı" demek yalan olur.
  return {
    verdict: "requeue",
    reason: "bu iterasyonda hiçbir dosya değişmedi ve 'değişiklik gerekmedi' kanıtı da yok",
    userMessage:
      "⛔ İş 'Tamamlandı' DAMGALANMADI — bu turda hiçbir dosya değişmedi ve 'değişikliğe gerek yok' diyen bir kanıt da üretilmedi (fazlar atlanmış/denetim yapılamamış olabilir). İş kuyrukta kaldı; farklı yaklaşımla yeniden denenecek.",
  };
}

/**
 * SAF: değişen dosya listesinden MyCL'in KENDİ pipeline sonu çıktılarını ele.
 * Gerekçe: living-docs (.md), kılavuz ekran görüntüleri (.png) ve devs/ kayıtları `onTaskMaybeComplete`
 * ÇAĞRILMADAN ÖNCE yazılıyor → git değişen dosya listesi her koşuda dolu görünür, kanıt değeri sıfırdır.
 */
export function filterAgentAuthored(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const p = f.replace(/\\/g, "/");
    if (p.startsWith(".mycl/") || p.includes("/.mycl/")) continue;
    if (p.startsWith("devs/") || p.includes("/devs/")) continue;
    if (p.includes("public/docs/guide-shots/")) continue;
    const lower = p.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".png") || lower.endsWith(".jpg")) continue;
    out.push(f);
  }
  return out;
}
