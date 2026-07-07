// edd/progress — EDD birim-analiz ilerleme logu (.mycl/edd-progress.jsonl). YZLLM 2026-07-07 (EDD Faz 1).
//
// Append-only + fsync + patch (task-queue/store.ts deseni). Her kaynak birim (dosya) için durum:
//   pending → analiz bekliyor · done → analiz edildi (+ kaynak-hash) · unanalyzable → analiz edilemez (+ sebep).
// Çökme/kapanma → resume: done OLMAYAN birimlerden devam (idempotent). "Hiçbir şey kaçmasın" garantisi:
// enumeration TÜM birimleri üretir, bu log her birimin durumunu tutar → done+unanalyzable = kapsam kanıtı,
// pending = kalan iş. unanalyzable SESSİZCE atlanmaz, sebebiyle kaydedilir (KATI#4).

import { promises as fs } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MYCL_DIR = ".mycl";
const PROGRESS_FILE = "edd-progress.jsonl";

export type EddUnitStatus = "pending" | "done" | "unanalyzable";

/**
 * Birimin davranış-sözleşmesi (analyzer çıktısı). TEK doğruluk kaynağı burada (progress kaydında) tutulur;
 * tech-doc.md bundan TÜRETİLİR (bağımsız ikinci kaynak yok → drift yok, mahkeme bulgusu). Faz 2/3 enjeksiyonu bunu okur.
 */
export interface EddBehavior {
  what_it_does: string;
  invariants: string[];
  side_effects: string[];
  dependents_note?: string;
}

export interface EddUnitRecord {
  /** projectRoot'a göre relative dosya yolu (birim kimliği). */
  unit: string;
  status: EddUnitStatus;
  /** unanalyzable için görünür sebep (binary / too-large / read-error / analiz-hatası). */
  reason?: string;
  /** analiz anındaki kaynak-hash (bayatlama tespiti — Faz 4). */
  hash?: string;
  /** done ise davranış-sözleşmesi (yapılandırılmış kaynak; tech-doc buradan türer). */
  behavior?: EddBehavior;
  ts: number;
}

interface EddPatch {
  _patch: string; // unit kimliği
  status?: EddUnitStatus;
  reason?: string;
  hash?: string;
  behavior?: EddBehavior;
  ts: number;
}

function progressPath(root: string): string {
  return join(root, MYCL_DIR, PROGRESS_FILE);
}

async function appendLine(path: string, entry: object): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const fh = await openFile(path, "a");
  try {
    await fh.write(JSON.stringify(entry) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Birimi ilk kez kaydet (taban kayıt — genelde pending). */
export async function appendEddUnit(root: string, rec: EddUnitRecord): Promise<void> {
  await appendLine(progressPath(root), rec);
}

/** Var olan birimin durumunu güncelle (append-only patch — read tarafı taban kayda merge eder). */
export async function patchEddUnit(
  root: string,
  unit: string,
  patch: Pick<EddPatch, "status" | "reason" | "hash" | "behavior">,
): Promise<void> {
  await appendLine(progressPath(root), { _patch: unit, ts: Date.now(), ...patch } satisfies EddPatch);
}

/**
 * Tüm birimlerin GÜNCEL durumunu (patch'ler taban kayda merge) döner (unit → record). SAF okuma.
 * Bozuk/kısmi satır (append-only yarım-yazım) atlanır — çökme-dayanıklı.
 */
export async function readEddProgress(root: string): Promise<Map<string, EddUnitRecord>> {
  let raw: string;
  try {
    raw = await fs.readFile(progressPath(root), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const byUnit = new Map<string, EddUnitRecord>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // bozuk/kısmi satır → atla (idempotent resume)
    }
    if (typeof obj._patch === "string") {
      const cur = byUnit.get(obj._patch);
      if (cur) {
        if (obj.status === "pending" || obj.status === "done" || obj.status === "unanalyzable") cur.status = obj.status;
        if (typeof obj.reason === "string") cur.reason = obj.reason;
        if (typeof obj.hash === "string") cur.hash = obj.hash;
        if (obj.behavior && typeof obj.behavior === "object") cur.behavior = obj.behavior as EddBehavior;
        if (typeof obj.ts === "number") cur.ts = obj.ts;
      }
      continue;
    }
    if (typeof obj.unit === "string" && (obj.status === "pending" || obj.status === "done" || obj.status === "unanalyzable")) {
      byUnit.set(obj.unit, {
        unit: obj.unit,
        status: obj.status,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
        hash: typeof obj.hash === "string" ? obj.hash : undefined,
        behavior: obj.behavior && typeof obj.behavior === "object" ? (obj.behavior as EddBehavior) : undefined,
        ts: typeof obj.ts === "number" ? obj.ts : 0,
      });
    }
  }
  return byUnit;
}

/** Özet ("N/N done, K unanalyzable, M pending" raporu + tamamlanma kontrolü için). SAF. */
export function summarizeProgress(byUnit: Map<string, EddUnitRecord>): {
  total: number;
  done: number;
  unanalyzable: number;
  pending: number;
} {
  let done = 0;
  let unanalyzable = 0;
  let pending = 0;
  for (const r of byUnit.values()) {
    if (r.status === "done") done++;
    else if (r.status === "unanalyzable") unanalyzable++;
    else pending++;
  }
  return { total: byUnit.size, done, unanalyzable, pending };
}
