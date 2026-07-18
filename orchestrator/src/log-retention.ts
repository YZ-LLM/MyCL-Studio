// log-retention — YZLLM 2026-06-20: GLOBAL loglar (~/.mycl) 6 aydan eski satırlardan budanır;
// PROJE logları (<proje>/.mycl) ASLA silinmez (bu modül yalnız globalDir dosyalarına dokunur).
//
// Strateji: satır-bazlı ts-budama (JSON `ts` number/ISO veya pipe-ISO prefix) — datable + eski
// satır atılır; tarihlenemeyen satır KORUNUR (veri kaybetme). Sonra güvenlik tavanı (son N satır).
// Boot'ta bir kez, fail-soft, non-blocking. trace.log boot-logudur (proje açılınca proje'ye rotate).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_LINES = 100_000; // ts-budamadan sonra güvenlik tavanı (devasa dosyayı kesin sınırla)
// HIZLI OTURUMLAR (YZLLM 2026-07-18, Claude Code 2.1.208 esinli "shrinking transcripts"): satır tavanı
// uzun satırlarda onlarca MB'a izin veriyordu (canlı: trace.log 49 MB) → ek BAYT bütçesi. En yeni
// satırlar korunur (kuyruktan biriktir); proje logları yine DOKUNULMAZ (2026-06-20 kuralı).
export const MAX_BYTES_PER_LOG = 8 * 1024 * 1024;

/** ~/.mycl altındaki budanacak GLOBAL loglar. Proje logları (<proje>/.mycl) burada YOK. */
const GLOBAL_LOGS = ["trace.log", "session-transcripts.jsonl", "audit.log", "tauri-stderr.log"];

/** SAF: bir satırdan ms-epoch zaman damgası çıkar (JSON ts number/ISO, veya pipe-ISO prefix). Yoksa null. */
export function lineTimestamp(line: string): number | null {
  const t = line.trim();
  if (t === "") return null;
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as { ts?: unknown };
      if (typeof o.ts === "number") return o.ts;
      if (typeof o.ts === "string") {
        const p = Date.parse(o.ts);
        return Number.isNaN(p) ? null : p;
      }
    } catch {
      /* geçerli JSON değil → pipe denemesine düş */
    }
  }
  // Pipe/plain format: "2026-05-12T07:20:47Z | session_start | ..." → baştaki ISO
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/.exec(t);
  if (m) {
    const p = Date.parse(m[1]);
    return Number.isNaN(p) ? null : p;
  }
  return null;
}

/**
 * SAF: içeriği cutoff'tan eski (datable) satırlardan arındır + son MAX_LINES ile sınırla.
 * Tarihlenemeyen satır KORUNUR (kör veri kaybı yok). Test edilebilir.
 */
export function filterRecentLines(
  content: string,
  cutoffMs: number,
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES_PER_LOG,
): string {
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const ts = lineTimestamp(line);
    if (ts === null || ts >= cutoffMs) kept.push(line); // datable-eski → at; diğer → tut
  }
  let capped = kept.length > maxLines ? kept.slice(-maxLines) : kept;
  // Bayt bütçesi: EN YENİ satırlardan geriye doğru biriktir — bütçeyi aşan eski kuyruk atılır.
  let total = 0;
  let start = capped.length;
  while (start > 0 && total + capped[start - 1]!.length + 1 <= maxBytes) {
    total += capped[start - 1]!.length + 1;
    start--;
  }
  if (start > 0) capped = capped.slice(start);
  return capped.length ? capped.join("\n") + "\n" : "";
}

/**
 * GLOBAL logları (yalnız globalDir) 6 aydan eski satırlardan buda. ASLA throw etmez (fail-soft).
 * Proje loglarına DOKUNMAZ. Boot'ta bir kez çağrılır (non-blocking).
 */
export async function pruneOldLogs(globalDir: string): Promise<void> {
  const cutoff = Date.now() - SIX_MONTHS_MS;
  for (const name of GLOBAL_LOGS) {
    const path = join(globalDir, name);
    try {
      const content = await fs.readFile(path, "utf8");
      const filtered = filterRecentLines(content, cutoff);
      if (filtered.length < content.length) {
        await fs.writeFile(path, filtered, "utf8");
        log.info("log-retention", "budandı", {
          file: name,
          before: content.length,
          after: filtered.length,
        });
      }
    } catch {
      /* dosya yok / okunamadı → atla (fail-soft) */
    }
  }
}
