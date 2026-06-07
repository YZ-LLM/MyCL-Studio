// models — Anthropic API model listesi + 24h memory cache.
//
// Kullanıcı Settings ekranında dropdown'lara model seçer. Hardcoded liste
// yerine Anthropic API'den canlı çekilir (yeni modeller otomatik gelir).
//
// Cache stratejisi:
//   - In-memory (orchestrator yaşadığı sürece)
//   - 24h TTL
//   - "Modelleri Yenile" butonu force refresh tetikler

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.js";

export interface ModelEntry {
  id: string;            // örn. "claude-sonnet-4-6"
  display_name: string;  // örn. "Claude Sonnet 4.6"
  created_at: string;    // ISO 8601
}

interface CacheEntry {
  models: ModelEntry[];
  fetched_at: number;    // epoch ms
}

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(apiKey: string): string {
  // SHA256 hash'in ilk 16 hex karakteri — slice(0, 12) collision riskini
  // sıfıra indirir; tam API key hiç memory'de log'lanmaz.
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export class ModelsError extends Error {
  override readonly name = "ModelsError";
}

/**
 * Tüm modelleri listeler (pagination'ı toplar). cache hit'se cache döner.
 * `force=true` ile force refresh.
 */
export async function listModels(
  apiKey: string,
  force = false,
): Promise<{ models: ModelEntry[]; fetched_at: number; cached: boolean }> {
  const key = cacheKey(apiKey);
  const now = Date.now();
  const cached = cache.get(key);

  if (!force && cached && now - cached.fetched_at < TTL_MS) {
    log.debug("models", "cache hit", { count: cached.models.length });
    return { models: cached.models, fetched_at: cached.fetched_at, cached: true };
  }

  log.info("models", "fetching from API", { force });
  const startTs = Date.now();
  // v15.14: AÇIK timeout + retry — SDK varsayılan timeout'u (0.102) geçici ağ/API
  // yavaşlığında models.list'i "Request timed out" ile patlatabiliyordu (transient).
  // SDK timeout/429/5xx'te otomatik retry yapar → geçici hata sessizce atlatılır.
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 3 });

  const all: ModelEntry[] = [];
  try {
    // SDK auto-paginate: for-await tüm sayfaları gezer.
    for await (const m of client.models.list({ limit: 1000 })) {
      all.push({
        id: m.id,
        display_name: m.display_name,
        created_at: m.created_at,
      });
    }
  } catch (err) {
    log.error("models", "fetch failed", err);
    throw new ModelsError(`models.list failed: ${String(err)}`);
  }

  // created_at desc (en yeni başta).
  all.sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );

  const entry: CacheEntry = { models: all, fetched_at: now };
  cache.set(key, entry);

  log.info("models", "fetched", {
    count: all.length,
    elapsed_ms: Date.now() - startTs,
  });
  return { models: all, fetched_at: now, cached: false };
}
