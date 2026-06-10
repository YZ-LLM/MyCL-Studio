// history-loader — UI event persistence + lazy-load reader.
//
// `<project>/.mycl/history.log` NDJSON dosyasını yönetir. Her satır
// `{ ts, kind, data }` formatında; uygulama kapanıp açıldığında 3 panel
// (chat / translator / claude_stream) geçmişle yüklenebilir.
//
// Append: atomic POSIX append (O_APPEND), audit.ts pattern reuse. Fire-and-
// forget caller (emit fonksiyonları) açısından — caller hatayı log.warn'a
// düşürür ama akışı kesmez.
//
// Load: tüm dosyayı oku, satırlara böl, ters çevir (en yenisi başta), ts
// filtresi + limit. Bozuk satır skip (geriye dönük safety). v14 scope'unda
// tail-chunk read optimizasyonu YOK; log büyürse açık-item olarak v15.
//
// Tam-fidelity karar (Ümit 2026-05-20): skip-persist guard yok. Her event
// (text deltaları, relevance_call, token_usage dahil) yazılır → kapatıp
// açtığında "her şey olduğu gibi" görünür.

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { join, dirname } from "node:path";
import { enrichRecord } from "./record-context.js";

const MYCL_DIR = ".mycl";
const HISTORY_FILE = "history.log";

export interface HistoryEntry {
  ts: number;
  kind: string;
  data: unknown;
}

export interface LoadOptions {
  since_ts: number;
  /** Optional üst sınır (exclusive). Lazy load chunk için: `until_ts = oldestLoadedTs`. */
  until_ts?: number;
  limit: number;
}

export interface LoadResult {
  /** Kronolojik sıralı (eskiden yeniye). */
  events: HistoryEntry[];
  /** Filter sonrası limit dolduysa ve daha eski satır kaldıysa true. */
  older_available: boolean;
  /** events[0].ts veya 0 (events boşsa). Lazy load için referans. */
  oldest_returned_ts: number;
}

function historyPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, HISTORY_FILE);
}

/**
 * Tek event append eder. Atomic POSIX O_APPEND (PIPE_BUF altında race-free).
 * Caller fire-and-forget; hata yutulmaz, propagate edilir — caller log.warn'a
 * düşürmeli.
 */
export async function appendHistory(
  projectRoot: string,
  entry: HistoryEntry,
): Promise<void> {
  // v15.6: metadata enrichment — dataset/replay için sabit anchor alanları
  // (_session, _iter, _phase, _schema_v, _record_ts).
  const enriched = enrichRecord(entry, 1);
  const line = JSON.stringify(enriched) + "\n";
  const p = historyPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

/**
 * Belirli zaman aralığındaki event'leri yükler. `since_ts` ve opsiyonel
 * `until_ts` arasında, en fazla `limit` adet.
 *
 * Dönen `events` kronolojik (eskiden yeniye) sıralı; UI doğrudan state'e
 * prepend/replace edebilir. `older_available` lazy-load button visibility için.
 *
 * Bozuk satır (JSON parse hata, eksik `ts`/`kind`) skip edilir + log silent.
 * Dosya yoksa boş sonuç.
 */
/**
 * UI'da gösterilmeyen claude_stream sub-event'leri (App.tsx:240 zaten skipler).
 * Bunlar history.log'un çoğunluğunu kaplar (yoğun proje: 8000+ satırın 85%'i).
 * Backend skip → limit gerçek anlamlı event'lere uygulanır, chat_message
 * cutoff'a uğramaz.
 */
function isNoiseEvent(entry: HistoryEntry): boolean {
  if (entry.kind !== "claude_stream") return false;
  const sub = (entry.data as { sub?: string } | null)?.sub;
  return sub === "token_usage" || sub === "init" || sub === "relevance_call";
}

export async function loadMessages(
  projectRoot: string,
  opts: LoadOptions,
): Promise<LoadResult> {
  const p = historyPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { events: [], older_available: false, oldest_returned_ts: 0 };
    }
    throw err;
  }

  const lines = raw.split("\n");
  // En yeniden başlayarak topla; limit dolunca olası daha eski satır var mı diye flag.
  const reversed: HistoryEntry[] = [];
  let olderAvailable = false;
  // ADİL KOTA (2026-06-10, Ümit: "chat ekranı bile aynı kalmalı" — boot'ta chat boş geldi):
  // yoğun codegen oturumunda en yeni `limit` event'in ~hepsi claude_stream delta'sıdır →
  // chat_message pencereye hiç giremezdi. Chat'e AYRI kota → stream seli chat'i boğamaz.
  const chatCap = Math.min(400, opts.limit);
  let chatCount = 0;
  let otherCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: HistoryEntry;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.ts !== "number" ||
        typeof parsed.kind !== "string"
      ) {
        continue;
      }
      entry = parsed as HistoryEntry;
    } catch {
      continue;
    }
    // Üst sınır (exclusive)
    if (opts.until_ts !== undefined && entry.ts >= opts.until_ts) continue;
    // Alt sınır (inclusive)
    if (entry.ts < opts.since_ts) {
      // Bu satır filter dışı kaldı; demek ki since_ts'ten önce de event var.
      // (limit'a dahil değil, ama bilgi olarak kayda al.)
      olderAvailable = true;
      continue;
    }
    // UI'da gösterilmeyen noise event'leri (token_usage / init / relevance_call)
    // limit hesabına alma — yoğun projelerde chat_message'ları gizler.
    if (isNoiseEvent(entry)) continue;
    if (entry.kind === "chat_message") {
      if (chatCount >= chatCap) {
        olderAvailable = true;
        continue;
      }
      chatCount++;
    } else {
      if (otherCount >= opts.limit) {
        olderAvailable = true;
        continue;
      }
      otherCount++;
    }
    reversed.push(entry);
    if (chatCount >= chatCap && otherCount >= opts.limit) {
      // İki kota da doldu; daha eski satırlar lazy chunk'a kalır.
      olderAvailable = true;
      break;
    }
  }

  // Kronolojik sıraya çevir (eskiden yeniye)
  const events = reversed.reverse();
  return {
    events,
    older_available: olderAvailable,
    oldest_returned_ts: events.length > 0 ? events[0].ts : 0,
  };
}
