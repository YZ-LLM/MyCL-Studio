// experience-layer — çapraz-koşu DERS deposu (kendi-yeterlilik mekanizması AŞAMA 3 TEMELİ).
//
// Vizyon (project_self_sufficiency_roadmap): MyCL geçmiş sorunlardan tecrübe biriktirsin —
// problem → KANITLI çözüm → ilke. Benzer sorunda recall + uygula. KRİTİK ilkeler (kullanıcı):
//   - Ders = İDDİA (kanıtla çürütülebilir), HAKİKAT değil → recall'da YİNE DOĞRULA, auto-uygula YOK.
//   - Geri-alınabilir/zırhlı: yanlış ders yakalanınca retract (tecrübe-katmanı zehirlenmesin).
//   - verified: yalnız düşman-doğrulanmış ders güçlü; doğrulanmamış = zayıf öneri.
// Bu AŞAMA 3 TEMELİ: depo + recall (SAF, test-edilebilir). İnspector'a bağlama + populate = sonraki.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir } from "./paths.js";
import { log } from "./logger.js";

export interface Lesson {
  /** Problem imzası — recall anahtarı (ör. "ts-prune Next framework-export false-positive"). */
  signature: string;
  /** Problemin kısa tanımı. */
  problem: string;
  /** KANITLI çözüm (ne yapıldı + neden işe yaradı). */
  resolution: string;
  /** Çıkarılan yeniden-kullanılır ilke. */
  principle: string;
  /** Düşman-doğrulanmış mı (güçlü) yoksa zayıf-öneri mi. */
  verified: boolean;
  /** Bulgu false-positive mi (suppress) yoksa gerçek mi (proceed). RETRACT-çelişki mantığı bunu kullanır —
   *  principle metnine bağlı kırılgan regex YERİNE açık alan (Sonnet müfettiş 2026-06-23 düzeltmesi). */
  isFalsePositive?: boolean;
  /** Geri-alındı mı (yanlış ders → zehirlenme önleme). */
  retracted?: boolean;
  ts: number;
}

function lessonsPath(): string {
  return join(globalConfigDir(), "lessons.jsonl");
}

/** İmza normalize (recall eşleşmesi): küçük harf, noktalama→boşluk, fazla boşluk sadeleştir. */
export function normalizeSignature(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** İki imza arası kelime-örtüşme skoru (0..1). Basit, ağır-bağımlılık yok (3+ harfli kelimeler). */
export function signatureOverlap(a: string, b: string): number {
  const wa = new Set(normalizeSignature(a).split(" ").filter((w) => w.length > 2));
  const wb = new Set(normalizeSignature(b).split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

async function readAllLessons(): Promise<Lesson[]> {
  try {
    const raw = await readFile(lessonsPath(), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Lesson;
        } catch {
          return null;
        }
      })
      .filter((x): x is Lesson => Boolean(x && x.signature));
  } catch {
    return []; // dosya yok → boş
  }
}

async function writeAll(all: Lesson[]): Promise<void> {
  await writeFile(lessonsPath(), all.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf-8");
}

/** Ders kaydet — aynı imza varsa GÜNCELLE (yeni kanıt/durum), yoksa append. */
export async function recordLesson(lesson: Lesson): Promise<void> {
  const all = await readAllLessons();
  const idx = all.findIndex(
    (x) => normalizeSignature(x.signature) === normalizeSignature(lesson.signature),
  );
  try {
    if (idx >= 0) {
      all[idx] = lesson;
      await writeAll(all);
    } else {
      await appendFile(lessonsPath(), JSON.stringify(lesson) + "\n", "utf-8");
    }
  } catch (e) {
    log.warn("experience", "lesson kaydı başarısız (non-fatal)", { error: String(e) });
  }
}

/**
 * İmzaya benzer dersleri getir — ÖNERİ (auto-uygula DEĞİL, caller yine doğrular). retracted HARİÇ;
 * eşik üstü örtüşme; verified önce, sonra skor. Ders=iddia: çağıran bunu kanıtla teyit etmeli.
 */
export async function recallLessons(
  signature: string,
  opts?: { minOverlap?: number; limit?: number },
): Promise<Lesson[]> {
  const min = opts?.minOverlap ?? 0.4;
  const limit = opts?.limit ?? 3;
  const all = await readAllLessons();
  return all
    .filter((l) => !l.retracted)
    .map((l) => ({ l, score: signatureOverlap(signature, l.signature) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => Number(b.l.verified) - Number(a.l.verified) || b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}

/** Dersi geri-al (yanlış çıktı → zehirlenme önleme). Ders=iddia, hakikat değil → revize edilebilir. */
export async function retractLesson(signature: string): Promise<boolean> {
  const all = await readAllLessons();
  const idx = all.findIndex(
    (x) => normalizeSignature(x.signature) === normalizeSignature(signature),
  );
  if (idx < 0) return false;
  all[idx] = { ...all[idx], retracted: true };
  try {
    await writeAll(all);
    return true;
  } catch (e) {
    log.warn("experience", "retract başarısız", { error: String(e) });
    return false;
  }
}
