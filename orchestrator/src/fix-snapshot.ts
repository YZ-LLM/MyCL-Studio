// fix-snapshot — otomatik düzeltmeden ÖNCE geri-alınabilir yedek (YZLLM 2026-06-10: "oto-cevap açıkken durmasın,
// darboğazda devam etsin" → otonom düzeltme GÜVENLİ olmalı). Git deposunda checkpoint (ucuz); git YOKSA kaynak
// ağacını `.mycl/backups/<ts>/`'a kopyalar (node_modules vb. hariç). Yanlış oto-düzeltme geri alınabilir.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createCheckpoint, restoreCheckpoint } from "./git.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";

// Yedeklenmeyen + restore'da SİLİNMEYEN top-level dizinler. node_modules/.git/dist vb. ağır/türetilmiş;
// .mycl (MyCL state) + error_folder (hata kataloğu) BİLEREK korunur — rollback "MyCL state ve hata kataloğu
// korundu" sözünü tutar (YZLLM 2026-06-12: error_folder eklendi — yoksa ayna-restore onu da geri alırdı).
const EXCLUDE_TOP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".mycl",
  "error_folder",
  ".turbo",
  ".cache",
  ".vite",
]);

export interface FixSnapshot {
  method: "git" | "copy" | "none";
  ref?: string;
  dir?: string;
}

/**
 * Oto-düzeltme öncesi snapshot. Git temizse git-checkpoint (ref). Değilse kaynak kopyası (.mycl/backups).
 * İkisi de olmazsa görünür uyarı + {none} (düzeltme yine uygulanır ama geri-alma yok — dürüstçe söylenir).
 * `nowTs` dışarıdan verilir (test determinizmi; runtime Date.now()).
 */
export async function snapshotBeforeAutofix(projectRoot: string, nowTs: number): Promise<FixSnapshot> {
  // 1. Git tercih edilir (ucuz, temiz ağaçta).
  const cp1 = await createCheckpoint(projectRoot).catch(() => ({ ok: false as const, ref: undefined }));
  if (cp1.ok && "ref" in cp1 && cp1.ref) {
    emitChatMessage("system", "📌 Snapshot alındı (git) — bu adımda silinen/değişen dosyalar gerekirse geri alınabilir.");
    const snap: FixSnapshot = { method: "git", ref: cp1.ref };
    armRollback(snap);
    return snap;
  }
  // 2. Git yok/kirli → kaynak ağacını yedekle. Hedef proje DIŞINDA (~/.mycl/backups) — `fs.cp` bir dizini kendi
  // alt-dizinine kopyalayamaz; ayrıca yedek projeyi kirletmez + proje işlemlerinden etkilenmez.
  try {
    const dir = join(globalConfigDir(), "backups", `${basename(projectRoot)}-autofix-${nowTs}`);
    await mkdir(dir, { recursive: true });
    await cp(projectRoot, dir, {
      recursive: true,
      filter: (src: string) => {
        const rel = src.slice(projectRoot.length).replace(/^[/\\]+/, "");
        if (rel === "") return true;
        const top = rel.split(/[/\\]/)[0];
        return !EXCLUDE_TOP.has(top);
      },
    });
    emitChatMessage(
      "system",
      "📌 Snapshot alındı (`~/.mycl/backups`) — git yok ama kaynak yedeklendi; silinen/yanlış değişen dosya oradan geri alınır.",
    );
    const snap: FixSnapshot = { method: "copy", dir };
    armRollback(snap);
    return snap;
  } catch (e) {
    log.warn("fix-snapshot", "snapshot failed (non-fatal)", e);
    emitChatMessage(
      "system",
      "⚠️ Snapshot alınamadı — otomatik düzeltme yine de uygulanacak ama GERİ ALMA yok. Dikkatli ol.",
    );
    disarmRollback();
    return { method: "none" };
  }
}

/**
 * YZLLM 2026-06-12 KRİTİK FİX: copy-restore artık GERÇEK AYNA. Eski hali yalnız `cp(backup→proje)` ile üzerine
 * yazıyordu → fix'in EKLEDİĞİ dosyalar (yeni util/test dosyaları) SİLİNMİYORDU → her başarısız fix'in artığı
 * birikiyor, fix-öncesi baseline kırık-sayısı tur tur şişiyordu (gözlemlendi: 20→21→24) + "geri aldım" YALAN
 * oluyordu + regresyon baseline'ı zehirleniyordu. Ayna-restore: (1) backup'ı projeye yaz, (2) projede olup
 * backup'ta OLMAYAN dosyaları SİL (hariç-tutulan top-level dizinler hariç). Sonuç: proje TAM olarak snapshot anı.
 */
async function mirrorRestore(backupDir: string, projectRoot: string): Promise<void> {
  // 1. Backup içeriğini projeye yaz — değişen/silinen dosyalar geri gelir.
  await cp(backupDir, projectRoot, { recursive: true, force: true });
  // 2. Projede olup backup'ta OLMAYAN dosyaları sil = fix'in EKLEDİĞİ fazlalık. Hariç-tutulan top-level
  //    dizinlere (node_modules/.git/.mycl/error_folder/dist...) DOKUNMA — bilerek yedeklenmedi/korunuyor.
  await removeAddedFiles(projectRoot, backupDir, projectRoot);
}

/** projeRoot altını gez; backup'ta karşılığı OLMAYAN dosya/dizini sil. Top-level EXCLUDE_TOP atlanır (korunur). */
async function removeAddedFiles(dir: string, backupRoot: string, projectRoot: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && code !== "ENOENT" && code !== "ENOTDIR") {
      // Dizin VAR ama okunamadı (EACCES/EIO) → bu alt-ağaçtaki fix-eklediği dosyalar SİLİNEMEDİ →
      // restore EKSİK (sessiz-fallback denetimi). Görünür kıl.
      log.error("fix-snapshot", "removeAddedFiles: dizin okunamadı — restore eksik (eklenen dosyalar kaldı)", { dir, code });
    }
    return; // dizin yok/okunamadı → atla
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relative(projectRoot, full);
    const top = rel.split(/[/\\]/)[0];
    if (EXCLUDE_TOP.has(top)) continue; // yedeklenmemiş/korunan dizin → dokunma
    const inBackup = join(backupRoot, rel);
    // VERİ-KAYBI önleme (sessiz-fallback denetimi): stat'ı errno'ya göre ayır. ENOENT = backup'ta gerçekten
    // yok → fix ekledi → silinebilir. BAŞKA hata (EACCES/EIO) = belirsiz → "yok" sanıp SİLMEK veri-kaybı →
    // güvenli taraf: KORU (dokunma), görünür kıl.
    let existsInBackup: boolean;
    try {
      await stat(inBackup);
      existsInBackup = true;
    } catch (statErr) {
      if ((statErr as { code?: string }).code === "ENOENT") {
        existsInBackup = false;
      } else {
        log.error("fix-snapshot", "stat belirsiz hata — dosya KORUNDU (silinmedi, veri-kaybı önleme)", {
          inBackup,
          code: (statErr as { code?: string }).code,
        });
        continue;
      }
    }
    if (!existsInBackup) {
      // backup'ta yok → fix ekledi → sil (dosya VEYA tüm alt-ağaç).
      await rm(full, { recursive: true, force: true }).catch((err) =>
        log.warn("fix-snapshot", "mirror: added-file silinemedi (non-fatal)", { full, err }),
      );
      continue;
    }
    if (e.isDirectory()) await removeAddedFiles(full, backupRoot, projectRoot);
  }
}

/**
 * Bir snapshot'tan projeyi GERİ YÜKLE. git → restoreCheckpoint (checkout+clean, fix'in eklediği dosyalar da gider);
 * copy → AYNA-restore (mirrorRestore): proje tam olarak snapshot anına döner (fix'in eklediği dosyalar dahil temizlenir).
 */
export async function restoreSnapshot(snap: FixSnapshot, projectRoot: string): Promise<boolean> {
  try {
    if (snap.method === "git" && snap.ref) {
      const ok = await restoreCheckpoint(projectRoot, snap.ref);
      return ok;
    }
    if (snap.method === "copy" && snap.dir) {
      await mirrorRestore(snap.dir, projectRoot);
      return true;
    }
    return false;
  } catch (e) {
    log.warn("fix-snapshot", "restore failed", e);
    return false;
  }
}

// ───────── Rollback noktası (YZLLM 2026-06-10: "oto-cevap açıksa ve geri almaktan başka çare yoksa MyCL kendi geri
// alsın"). Bir düzeltme-dizisinin EN TEMİZ hali = ilk fix denemesinden ÖNCEki snapshot (FIRST-wins). Diziyi
// çözen başarı veya yeni kullanıcı turu disarm eder; tükenmede failPhase bunu restore eder. ─────────
let _rollback: FixSnapshot | null = null;

/** İlk-kazanır: dizinin ilk (en temiz) snapshot'ını rollback noktası yap (sonrakiler ezmez — junk birikmesin). */
export function armRollback(snap: FixSnapshot): void {
  if (_rollback === null && (snap.method === "git" || snap.method === "copy")) {
    _rollback = snap;
  }
}
/** Rollback noktasını al + temizle (restore edildikten sonra). */
export function takeRollback(): FixSnapshot | null {
  const r = _rollback;
  _rollback = null;
  return r;
}
/** Rollback noktasını GÖZ AT (temizlemeden) — aynı turda armed bir snapshot başka mekanizmaca (Faz 8 fix
 * rollback'i) ÇİFT yedek almadan yeniden kullanılsın. Yeni kullanıcı turu zaten disarm eder → bayat dönmez. */
export function peekRollback(): FixSnapshot | null {
  return _rollback;
}
/** Dizi çözüldü/yeni tur → rollback noktasını at (bayat restore olmasın). */
export function disarmRollback(): void {
  _rollback = null;
}
