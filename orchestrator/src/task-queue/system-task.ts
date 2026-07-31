// system-task — SİSTEM kaynaklı iş açmanın TEK kapısı: kanonik anahtar + tekrar önleme + kanıtlı metin.
//
// KÖK NEDEN (canlı cave kanıtı 2026-07-30, 17 gün): kuyruk işlerinin ~%68'i MyCL'in kendi arızasından
// doğuyordu ve HİÇBİRİNDE tekrar kontrolü yoktu → aynı iş defalarca açıldı ("Faz 8 hatası (çözülmeden
// ertelendi): —" 4 kez, "Faz 16 hatası" 3 kez, aynı Full Test bölümleri ve aynı semgrep etiketleri her
// turda yeniden). Kullanıcı 37 iş görüyor ama bunların çoğu aynı üç sorunun kopyası; hiçbiri bitmiyor.
//
// Tasarım: karar SAF (bu dosya, test edilebilir), yazma çağıranda. Anahtar METİNDEN BAĞIMSIZ üretilir
// (kaynak + tür + konu) → şablon metni değişince tekrar kontrolü kaymaz (eski substring yönteminin zaafı).

import type { TaskQueueItem, TaskSource } from "./types.js";
import { textSimilarity } from "./intake.js";

/** Sistem işinin türü — anahtar bileşeni. Yeni tür eklerken buraya ekle (anahtar çakışmasın). */
export type SystemTaskKind =
  | "security-finding" // tekil DAST/pentest bulgusu (konu: şablon kimliği)
  | "security-class" // toplu güvenlik sınıfı (konu: audit/sast etiketi)
  | "full-test-section" // Full Test bölümü düştü (konu: bölüm kimliği)
  | "maintenance-audit" // bakım turu bağımlılık taraması
  | "maintenance-sast" // bakım turu statik güvenlik bulgusu (konu: etiket)
  | "verify-gap" // atlanan doğrulama boyutu (konu: faz numarası)
  | "deferred-phase-error"; // çözülmeden ertelenen faz hatası (konu: faz + imza)

/**
 * SAF: konuyu kanonik hale getir — küçük harf, boşluk sıkıştırma, rakam maskeleme (sayı değişse de aynı
 * bulgu aynı anahtarı alsın), ilk 12 kelime. Regex yok (deterministik karakter döngüsü).
 */
export function normalizeSubject(s: string): string {
  const out: string[] = [];
  let word = "";
  const flush = (): void => {
    if (word) {
      out.push(word);
      word = "";
    }
  };
  for (const chRaw of String(s ?? "").toLowerCase()) {
    const ch = chRaw;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flush();
      continue;
    }
    // Rakamlar maskelenir: "14 bulgu" ile "22 bulgu" AYNI bulgu sınıfıdır.
    word += ch >= "0" && ch <= "9" ? "#" : ch;
  }
  flush();
  return out.slice(0, 12).join(" ");
}

/** SAF: kanonik anahtar. Metinden bağımsız → şablon değişse de aynı iş aynı anahtarı alır. */
export function systemTaskKey(p: {
  source: TaskSource;
  kind: SystemTaskKind;
  subject: string;
}): string {
  return `${p.source}:${p.kind}:${normalizeSubject(p.subject)}`;
}

export type DedupAction =
  /** Kuyrukta eşi yok → yeni iş aç. */
  | { action: "create"; key: string }
  /** Açık iş var → YENİ iş açma; mevcut işi taze kanıtla güncelle (gerekirse deneme hakkını canlandır). */
  | { action: "refresh"; key: string; taskId: string; revive: boolean }
  /** Yeni iş açılmaz: iş zaten bitmiş (yalnız includeDone) ya da kullanıcı iptal etmiş. */
  | { action: "skip"; key: string; taskId: string; why: "done" | "cancelled" };

/**
 * SAF: aynı sistem işi zaten kuyrukta mı, ne yapılmalı?
 *
 * Kurallar (gerekçeleriyle):
 *  - Açık iş (pending/running) → REFRESH: aynı bulgu için ikinci iş açmak kuyruğu şişirir, kullanıcı
 *    "37 iş" görür ama üçü aynıdır. Taze kanıt mevcut işe yazılır (ajan yeniden denemede görür).
 *  - Açık AMA deneme hakkı dolmuş iş → REFRESH + CANLANDIR: bulgu hâlâ gerçek ve yeni kanıt geldi →
 *    donuk iş yeniden denenebilir olur (intake.reviveIfCapped sözleşmesinin aynası).
 *  - Bitmiş iş (done) → normalde YENİ İŞ: aynı bulgu düzeltildikten sonra yeniden çıktıysa bu gerçek bir
 *    regresyondur, yutulamaz (KATI #4). İstisna includeDone=true (verify-gap'in bugünkü davranışı korunur).
 *  - Kullanıcının iptal ettiği iş (dropped) → SKIP: kullanıcı bilerek kapattı; sessizce diriltmek
 *    "beni dinlemedi" olur. Çağıran tek seferlik görünür not basar.
 *  - dedup_key taşımayan ESKİ kayıtlar için metin benzerliği yedeği (intake ile aynı Jaccard eşiği).
 */
export function decideSystemTask(p: {
  key: string;
  text: string;
  existing: readonly TaskQueueItem[];
  /** true → bitmiş işler de tekrar sayılır (yeni iş açılmaz). Varsayılan: false. */
  includeDone?: boolean;
  /** Anahtarsız eski kayıtlar için metin benzerliği eşiği (0-1). Varsayılan 0.7 (intake ile aynı). */
  similarityThreshold?: number;
  /** Deneme tavanı — bunu aşan pending iş "donuk"tur, canlandırılır. */
  maxRetries: number;
}): DedupAction {
  const threshold = p.similarityThreshold ?? 0.7;
  const match = (it: TaskQueueItem): boolean =>
    it.dedup_key ? it.dedup_key === p.key : textSimilarity(it.text, p.text) > threshold;

  const status = (it: TaskQueueItem): string => it.status ?? "pending";
  const hits = p.existing.filter(match);
  // Açık iş önceliklidir (aynı bulgu hem açık hem bitmiş kayıt taşıyabilir → açık olanı tazele).
  const open = hits.find((it) => status(it) === "pending" || status(it) === "running");
  if (open) {
    const capped = status(open) === "pending" && (open.attempts ?? 0) >= p.maxRetries;
    return { action: "refresh", key: p.key, taskId: open.id, revive: capped };
  }
  const cancelled = hits.find((it) => status(it) === "dropped");
  if (cancelled) return { action: "skip", key: p.key, taskId: cancelled.id, why: "cancelled" };
  const done = hits.find((it) => status(it) === "done");
  if (done && p.includeDone) return { action: "skip", key: p.key, taskId: done.id, why: "done" };
  return { action: "create", key: p.key };
}

/**
 * SAF: çözülmeden ertelenen faz hatası için KANIT TAŞIYAN iş metni.
 *
 * Eski metin: `Faz 8 hatası (çözülmeden ertelendi): —` — hata analizi sağlayıcıya ulaşamadığı için çözüm
 * listesi boş kalıyordu ve iş "—" ile kuyruğa giriyordu. Böyle bir iş koşturulduğunda ajanın elinde HİÇBİR
 * bağlam olmuyor → çözemiyor → deneme hakkını yakıyor (canlı cave: 8 donuk işin ikisi tam olarak bu).
 * Yeni metin gerçek hatayı, nereye bakılacağını ve ne yapılacağını taşır.
 */
export function buildDeferredErrorTaskText(p: {
  phase: number;
  /** Fazın gerçek hata çıktısı (kısaltılır). */
  failReason?: string;
  /** Hata analizi çalışabildiyse önerdiği ilk çözüm. */
  solutionTr?: string;
  /** Kanıtın audit'teki olay adı + zamanı (kullanıcı ve ajan oradan bakar). */
  auditEvent?: string;
  auditTs?: number;
}): string {
  const lines: string[] = [];
  lines.push(
    p.solutionTr
      ? `Faz ${p.phase} hatası çözülmeden ertelendi. Önerilen yön: ${p.solutionTr}`
      : `Faz ${p.phase} hatası çözülmeden ertelendi — hata analizi YAPILAMADI (sağlayıcıya ulaşılamadı).`,
  );
  const why = (p.failReason ?? "").trim();
  if (why) lines.push(`Son hata: ${why.slice(0, 300)}`);
  if (p.auditEvent) {
    const when = p.auditTs ? new Date(p.auditTs).toISOString().slice(0, 16).replace("T", " ") : "";
    lines.push(`Kanıt: .mycl/audit.log · ${p.auditEvent}${when ? ` · ${when}` : ""} (faz ${p.phase})`);
  }
  lines.push(
    "Yapılacak: hatayı yeniden üret, kök nedeni bul ve düzelt; düzeltmeyi doğrulayan testi koştur.",
  );
  return lines.join("\n");
}
