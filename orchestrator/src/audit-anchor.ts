// audit-anchor — denetim defterinin DIŞ ÇAPASI: kaydın sonradan değiştirilmediğinin kanıtı.
//
// KÖK NEDEN (adli öz denetim, 2026-09-10): MyCL'in "TAMAMLANDI / KISMİ" hükmü canlı ölçümlerden
// değil, diskten GERİ OKUNAN `.mycl/audit.log` satırlarından hesaplanıyor. Defter hedef projenin
// içinde duruyor ve orada kod yazan ajanlar çalışıyor. Mahkeme bunu geçici bir dizinde kanıtladı:
// yedi satır değiştirildi (`-fail` → `-complete`), satır sayısı bile aynı kaldı, hüküm KISMİ'den
// GEÇTİ'ye döndü. Yani kapıyı geçmek gerekmiyordu; kapının KAYDINI geçmek yetiyordu.
//
// NEDEN ÇAPA (zincirleme özet DEĞİL): her kaydın bir öncekinin özetini taşıması da düşünüldü, ama
// `appendAudit` her çağrıda dosyayı açıp yazıp kapatıyor ve üç yerde beklemesiz çağrılıyor — iki
// kaydın diske yazılma sırası çağrı sırasından farklı olabildiği için zincir HİÇ kurcalama
// olmadan kırık görünebilirdi. Önek çapası bu sorunu hiç doğurmaz: belirli anlarda "defterin ilk
// N baytı şu özeti veriyordu" denir; sonradan gelen satırlar öneki değiştirmez.
//
// NEDEN EV DİZİNİNDE: çapa, ajanın ERİŞEMEDİĞİ tarafta durmalı — yoksa kaydı değiştiren çapayı da
// değiştirir. Kum havuzu tüm ev dizinini okumaya kapatıyor ve `~/.mycl` geri açılan listede değil.
// Aynı desen Gate Overlay için zaten üretimde: `~/.mycl/overlay-integrity.json` canlı kayıtlarda
// 14 gerçek doğrulama taşıyor. Burada o kanıtlanmış desen genelleştiriliyor.
//
// KAPSAM: `audit.log` (hüküm buradan üretiliyor) ve `accepted-findings.jsonl` (bir bulguyu KALICI
// olarak susturur — denetim defterinden bile kalıcı bir hasar yüzeyi).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir } from "./paths.js";
import { log } from "./logger.js";

/** Çapalanan dosyalar — proje köküne göreli. */
export const ANCHORED_FILES = [
  join(".mycl", "audit.log"),
  join(".mycl", "accepted-findings.jsonl"),
] as const;

const ANCHOR_FILE = "audit-anchors.json";
/** Proje başına saklanan çapa sayısı — dosya sınırsız büyümesin. */
const KEEP_PER_PROJECT = 1;

export interface AnchorRecord {
  /** Çapalanan önek uzunluğu (bayt). Sonraki satırlar bu öneki değiştirmez. */
  bytes: number;
  /** İlk `bytes` baytın sha256'sı. */
  sha256: string;
  /** Çapanın alındığı an (yalnız insan okuması / teşhis). */
  at: number;
}

export type AnchorVerdict =
  | { status: "ok"; checked: number }
  | { status: "no-anchor" }
  | { status: "tampered"; file: string; reason: string }
  | { status: "unreadable"; file: string; reason: string };

function anchorPath(): string {
  return join(globalConfigDir(), ANCHOR_FILE);
}

/** Dosyanın İLK `bytes` baytının sha256'sı. Dosya kısaldıysa null (kesme de kurcalamadır). */
async function prefixHash(path: string, bytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    if (bytesRead < bytes) return null; // dosya çapalandığı andan KISA → satır silinmiş/kesilmiş
    return createHash("sha256").update(buf).digest("hex");
  } finally {
    await fh.close();
  }
}

async function readAnchors(): Promise<Record<string, AnchorRecord[]>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(anchorPath(), "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, AnchorRecord[]>;
    }
  } catch {
    // yok/bozuk → boş (çapa yokluğu "kurcalandı" DEĞİLDİR; aşağıda "no-anchor" olarak ayrılır)
  }
  return {};
}

function keyFor(projectRoot: string, rel: string): string {
  return `${projectRoot}|${rel}`;
}

/**
 * Çapayı tazeler: her çapalanan dosyanın O ANKİ tam uzunluğu + öneğinin özeti kaydedilir.
 * Bundan SONRA eklenen satırlar öneği değiştirmez; geçmişe dokunan her değişiklik yakalanır.
 * Hata fırlatmaz — çapa yazılamazsa doğrulama "çapa yok" der, sessizce "temiz" demez.
 */
export async function refreshAuditAnchor(projectRoot: string): Promise<void> {
  const anchors = await readAnchors();
  let wrote = false;
  for (const rel of ANCHORED_FILES) {
    const abs = join(projectRoot, rel);
    let size: number;
    try {
      size = (await fs.stat(abs)).size;
    } catch {
      continue; // dosya henüz yok → çapalanacak bir şey de yok
    }
    if (size === 0) continue;
    const sha = await prefixHash(abs, size);
    if (sha === null) continue;
    const list = anchors[keyFor(projectRoot, rel)] ?? [];
    list.push({ bytes: size, sha256: sha, at: Date.now() });
    anchors[keyFor(projectRoot, rel)] = list.slice(-KEEP_PER_PROJECT);
    wrote = true;
  }
  if (!wrote) return;
  try {
    const target = anchorPath();
    await fs.mkdir(globalConfigDir(), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(anchors, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (e) {
    log.warn("audit-anchor", "çapa yazılamadı", { error: String(e) });
  }
}

/**
 * Çapayı doğrular. `no-anchor` KURCALAMA DEĞİLDİR — bu özellikten önce başlamış projeler ve ilk
 * çapadan önceki an böyledir; çağıran onu eski davranışla sürdürür (KATI #14: geriye uyum).
 * `tampered` ise kesin bir bulgudur: defterin geçmişi çapalandığı andakinden farklı.
 */
export async function verifyAuditAnchor(projectRoot: string): Promise<AnchorVerdict> {
  const anchors = await readAnchors();
  let checked = 0;
  for (const rel of ANCHORED_FILES) {
    const list = anchors[keyFor(projectRoot, rel)];
    const anchor = list?.[list.length - 1];
    if (!anchor) continue;
    const abs = join(projectRoot, rel);
    const sha = await prefixHash(abs, anchor.bytes);
    if (sha === null) {
      return {
        status: "tampered",
        file: rel,
        reason: `dosya çapalandığı andan KISA (${anchor.bytes} bayt bekleniyordu) — satır silinmiş olabilir`,
      };
    }
    if (sha !== anchor.sha256) {
      return {
        status: "tampered",
        file: rel,
        reason: "geçmiş kayıtların içerik özeti çapayla eşleşmiyor — kayıt sonradan değiştirilmiş",
      };
    }
    checked++;
  }
  return checked > 0 ? { status: "ok", checked } : { status: "no-anchor" };
}
