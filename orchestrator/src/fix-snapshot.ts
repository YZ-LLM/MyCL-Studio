// fix-snapshot — otomatik düzeltmeden ÖNCE geri-alınabilir yedek (Ümit 2026-06-10: "oto-cevap açıkken durmasın,
// darboğazda devam etsin" → otonom düzeltme GÜVENLİ olmalı). Git deposunda checkpoint (ucuz); git YOKSA kaynak
// ağacını `.mycl/backups/<ts>/`'a kopyalar (node_modules vb. hariç). Yanlış oto-düzeltme geri alınabilir.

import { cp, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createCheckpoint } from "./git.js";
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
    emitChatMessage("system", "📌 Snapshot alındı (git) — bu otomatik düzeltme gerekirse geri alınabilir.");
    return { method: "git", ref: cp1.ref };
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
      "📌 Snapshot alındı (`~/.mycl/backups`) — git yok ama kaynak yedeklendi; yanlış düzeltmede oradan geri alınır.",
    );
    return { method: "copy", dir };
  } catch (e) {
    log.warn("fix-snapshot", "snapshot failed (non-fatal)", e);
    emitChatMessage(
      "system",
      "⚠️ Snapshot alınamadı — otomatik düzeltme yine de uygulanacak ama GERİ ALMA yok. Dikkatli ol.",
    );
    return { method: "none" };
  }
}
