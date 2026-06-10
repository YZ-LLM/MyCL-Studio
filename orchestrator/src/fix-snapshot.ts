// fix-snapshot — otomatik düzeltmeden ÖNCE geri-alınabilir yedek (Ümit 2026-06-10: "oto-cevap açıkken durmasın,
// darboğazda devam etsin" → otonom düzeltme GÜVENLİ olmalı). Git deposunda checkpoint (ucuz); git YOKSA kaynak
// ağacını `.mycl/backups/<ts>/`'a kopyalar (node_modules vb. hariç). Yanlış oto-düzeltme geri alınabilir.

import { cp, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createCheckpoint, restoreCheckpoint } from "./git.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";

const EXCLUDE_TOP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".mycl",
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
 * Bir snapshot'tan projeyi GERİ YÜKLE. git → restoreCheckpoint (checkout+clean, fix'in eklediği dosyalar da gider);
 * copy → yedek dizini proje üstüne kopyalanır (silinen/değişen dosyalar döner; fix'in eklediği fazlalık kalabilir).
 */
export async function restoreSnapshot(snap: FixSnapshot, projectRoot: string): Promise<boolean> {
  try {
    if (snap.method === "git" && snap.ref) {
      const ok = await restoreCheckpoint(projectRoot, snap.ref);
      return ok;
    }
    if (snap.method === "copy" && snap.dir) {
      await cp(snap.dir, projectRoot, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (e) {
    log.warn("fix-snapshot", "restore failed", e);
    return false;
  }
}

// ───────── Rollback noktası (Ümit 2026-06-10: "oto-cevap açıksa ve geri almaktan başka çare yoksa MyCL kendi geri
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
/** Dizi çözüldü/yeni tur → rollback noktasını at (bayat restore olmasın). */
export function disarmRollback(): void {
  _rollback = null;
}
