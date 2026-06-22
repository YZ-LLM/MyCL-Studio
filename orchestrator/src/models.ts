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
import { makeAnthropicClient } from "./claude-api.js";
import { GLM_CATALOG } from "./model-catalog.js";
import { log } from "./logger.js";

const ZAI_MODELS_URL = process.env.MYCL_ZAI_MODELS_URL ?? "https://api.z.ai/api/paas/v4/models";

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
 * z.ai (GLM) CANLI model keşfi (②b, YZLLM 2026-06-22): OpenAI-uyumlu /v4/models endpoint'inden glm-*
 * modellerini çeker (Bearer auth) → z.ai yeni model eklerse otomatik yakalanır. Hata/boş/key-yok →
 * statik GLM_CATALOG fallback (CANLI doğrulandı: 8 model statik listeyle birebir). ASLA throw etmez.
 * NOT: UI dropdown'ı statik GLM optgroup kullanır (doğrulanmış-doğru); bu capability gelecekte katalog-
 * tazeleme / model-resolution için + statik liste bayatlarsa canlı doğrulama sağlar.
 */
export async function discoverZaiModels(apiKey: string): Promise<ModelEntry[]> {
  const fallback = (): ModelEntry[] =>
    GLM_CATALOG.map((m) => ({ id: m.id, display_name: m.label, created_at: new Date(0).toISOString() }));
  if (!apiKey || apiKey.trim().length === 0) return fallback();
  try {
    const r = await fetch(ZAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: Array<{ id?: string; created?: number }> };
    const out: ModelEntry[] = [];
    for (const m of j.data ?? []) {
      if (typeof m.id === "string" && m.id.startsWith("glm-")) {
        out.push({
          id: m.id,
          display_name: m.id,
          created_at:
            typeof m.created === "number" ? new Date(m.created * 1000).toISOString() : new Date(0).toISOString(),
        });
      }
    }
    return out.length > 0 ? out : fallback();
  } catch (err) {
    log.warn("models", "z.ai /v4/models keşfi başarısız → statik GLM fallback", err);
    return fallback();
  }
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
  const client = makeAnthropicClient(apiKey, { timeoutMs: 20_000, maxRetries: 3 });

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
