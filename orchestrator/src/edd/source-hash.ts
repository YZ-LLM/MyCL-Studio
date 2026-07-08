// edd/source-hash — kaynak birim hash'i + boyut/silinme GÜVENLİ okuma. YZLLM 2026-07-08 (EDD Faz 4 mahkeme fix).
//
// KAYNAK GÜVENLİĞİ (feedback_resource_careful — "büyük binary ×N çökertti"): dosyayı OKUMADAN önce STAT ile boyut
// kontrol → analiz SONRASI aynı yola dev bir dosya (git pull / build artefaktı / log dump / DB dökümü) konursa tümünü
// belleğe okuma YOK. Eşik enumerate MAX_UNIT_BYTES ile ORTAK (tek doğruluk kaynağı). Hata GÖRÜNÜR loglanır (KATI#4).
//
// Hash algoritması engine markDone / codegen-note / reconcile ile BİREBİR aynı (sha256 ilk-16 hex) → karşılaştırmalar tutarlı.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { log } from "../logger.js";
import { MAX_UNIT_BYTES } from "./enumerate.js";

export interface SourceHashResult {
  /** sha256 ilk-16 hex — yalnız dosya var + boyut sınırı altında + okunabildiyse. */
  hash?: string;
  /** dosya silinmiş (ENOENT). */
  gone: boolean;
  /** boyut MAX_UNIT_BYTES üstü — OKUNMADAN "değişmiş/analiz-dışı" say (bellek koruması). */
  tooLarge: boolean;
}

/**
 * Kaynak birimi GÜVENLİ hash'le: aç → fstat (boyut) → sınırlı oku → hash. Dev dosyayı belleğe ALMAZ. ENOENT-dışı
 * hatalar görünür loglanır (sessiz yutma yok); hash undefined döner → çağıran "doğrulanamadı" olarak ele alır.
 *
 * TOCTOU-güvenli (mahkeme minor): boyut AÇIK fd'nin fstat'ından okunur; okuma da yalnız o boyut kadar SINIRLI yapılır
 * (Buffer.alloc(size), fstat sonrası dosya büyüse bile yalnız `size` bayt okunur → bellek ≤ MAX). Ayrı stat+readFile'ın
 * "stat sonrası büyüme → sınırsız readFile" penceresi kapalı.
 */
export async function safeSourceHash(abs: string): Promise<SourceHashResult> {
  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await fs.open(abs, "r");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn("edd/source-hash", "açılamadı (doğrulanamadı)", { abs, error: String(e) });
    return { gone: code === "ENOENT", tooLarge: false };
  }
  try {
    const size = (await fh.stat()).size;
    if (size > MAX_UNIT_BYTES) return { gone: false, tooLarge: true };
    const buf = Buffer.alloc(size);
    let n = 0;
    if (size > 0) n = (await fh.read(buf, 0, size, 0)).bytesRead;
    const bytes = n < size ? buf.subarray(0, n) : buf; // shrink yarışı → yalnız okunan baytları hash'le
    return { hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16), gone: false, tooLarge: false };
  } catch (e) {
    log.warn("edd/source-hash", "okuma başarısız (doğrulanamadı)", { abs, error: String(e) });
    return { gone: false, tooLarge: false };
  } finally {
    await fh.close();
  }
}
