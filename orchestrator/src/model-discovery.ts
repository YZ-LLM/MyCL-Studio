// model-discovery — güncel Claude modellerini WEB ARAMASIYLA bulur (Ümit: "keşfin API ile alakası yok; LLM
// internette Anthropic/Claude dökümanlarından bulsun").
//
// BACKEND-AWARE (Ümit: "API yok diye yapmadığın bişey olmasın"): abonelik/cli → claude CLI'nin WebSearch/WebFetch
// araçları; api → Anthropic SDK + server-side web_search tool (web_search_20250305). İkisi de Anthropic'in RESMİ
// dökümanlarını arar → güncel model id/ad. Sonra deterministik aile-tier'lama (setLiveTiersFromModels).
// Hatasızlık: yalnız resmi kaynak + EXACT id + doğrulama (claude-* deseni); şüphe/başarısızlık → statik katalog.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { PURE_REASONING_DISALLOWED_TOOLS } from "./tool-policy.js";
import { makeAnthropicClient } from "./claude-api.js";
import { extractKindBlock } from "./cli-json.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { log } from "./logger.js";

// GÜNLÜK CACHE (Ümit: "her açılışta web-arama token yakmasın"). Modeller global (proje-bağımsız) → ~/.mycl'de.
const CACHE_PATH = join(homedir(), ".mycl", "model-discovery-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 saat: günde bir kez ara

async function readDiscoveryCache(): Promise<DiscoveredModel[] | null> {
  try {
    const c = JSON.parse(await readFile(CACHE_PATH, "utf-8")) as { ts: number; models: DiscoveredModel[] };
    if (Date.now() - c.ts < CACHE_TTL_MS && Array.isArray(c.models) && c.models.length > 0) {
      return c.models;
    }
  } catch {
    // yok/bozuk/eski → null (yeniden ara)
  }
  return null;
}
async function writeDiscoveryCache(models: DiscoveredModel[]): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), models }, null, 2));
  } catch (e) {
    log.warn("model-discovery", "cache yazılamadı (non-fatal)", e);
  }
}

const DISCOVERY_SYSTEM = [
  "You find the CURRENT, OFFICIAL Claude (Anthropic) model lineup. Use WebSearch + WebFetch on Anthropic's",
  "OFFICIAL sources ONLY (docs.anthropic.com, anthropic.com, official model/pricing pages).",
  "Extract each currently-available model's EXACT API id (e.g. \"claude-opus-4-8\") and display name.",
  "For EACH model assign a tier from the docs' OWN positioning:",
  '  - "strong" = the MOST CAPABLE / flagship model (best reasoning/coding),',
  '  - "balanced" = mid (fast + capable, general use),',
  '  - "cheap" = the FASTEST / cheapest / lightest model.',
  "So even a BRAND-NEW family (not opus/sonnet/haiku) gets the right tier from how the docs describe it.",
  "Do NOT guess or invent ids — only models you CONFIRM in official Anthropic sources. If unsure, omit it.",
  'Output ONLY one JSON block: {"kind":"models","models":[{"id":"claude-...","display_name":"...","tier":"strong|balanced|cheap"}]}',
  "Order MOST CAPABLE first. If you cannot confirm from official sources, return an empty models array.",
].join("\n");

export interface DiscoveredModel {
  id: string;
  display_name: string;
  /** LLM'in dökümandan attığı tier (yeni aileler için kritik). cheap/balanced/strong. */
  tier?: "cheap" | "balanced" | "strong";
}

/** Web-arama yanıtından modelleri ayıklar (SAF) + doğrular (id claude-* benzeri, boş değil; tier geçerliyse alınır). */
export function parseDiscoveredModels(text: string): DiscoveredModel[] {
  const block = extractKindBlock(text, ["models"]);
  const raw = block?.models;
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    // Doğrulama: Anthropic model id deseni (uydurma/bozuk id'leri ele).
    if (!/^claude-[a-z0-9.-]+$/i.test(id)) continue;
    const dn = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
    const tier =
      m.tier === "cheap" || m.tier === "balanced" || m.tier === "strong" ? m.tier : undefined;
    out.push({ id, display_name: dn, tier });
  }
  return out;
}

/**
 * Güncel modelleri web aramasıyla keşfeder. claude CLI (WebSearch/WebFetch) gerekir; yoksa/başarısızsa [] döner
 * (caller statik kataloğa düşer). API key GEREKMEZ. Tek-atış, non-blocking caller.
 */
export async function discoverModelsViaWeb(
  config: MyclConfig,
  projectRoot: string,
): Promise<DiscoveredModel[]> {
  // Günlük cache: 24 saat içinde keşif yapıldıysa web-aramayı ATLA (token tasarrufu).
  const cached = await readDiscoveryCache();
  if (cached) {
    log.info("model-discovery", "cache hit (günlük) — web-arama atlandı", { count: cached.length });
    return cached;
  }
  const modelId = config.selected_models.orchestrator ?? config.selected_models.main;
  try {
    // BACKEND-AWARE (Ümit: "API yok diye yapma"): cli → claude CLI WebSearch; api → SDK web_search server-tool.
    const text =
      backendForRole(config, "main") === "cli"
        ? await discoverViaCli(modelId, projectRoot)
        : await discoverViaApi(config, modelId);
    const models = parseDiscoveredModels(text);
    if (models.length > 0) await writeDiscoveryCache(models); // günlük cache'e yaz
    return models;
  } catch (e) {
    log.warn("model-discovery", "web keşif başarısız (statik katalog geçerli)", e);
    return [];
  }
}

/**
 * Önerilen modeli persist etmeden ÖNCE GERÇEKTEN çağrılabilir mi doğrula (Ümit 2026-06-13).
 * Keşif web-aramayla model ADI bulur ama uydurma/yanlış-okunmuş id (örn. var-olmayan
 * "claude-mythos-5") yalnız `claude-*` regex'ini geçip ANA MODEL olarak yazılabilirdi →
 * sonra TÜM codegen kırılır. Minimal ping (tek-token) ile dener; başarısız/timeout → false
 * (güvenli taraf: doğrulanamayan modele GEÇME — kullanıcı Ayarlar'dan elle seçebilir).
 * Backend-aware (cli → claude CLI; api → SDK). API key gerektiren yol API; cli yolu abonelik.
 */
export async function verifyModelCallable(
  config: MyclConfig,
  model: string,
  projectRoot: string,
): Promise<boolean> {
  if (!/^claude-[a-z0-9.-]+$/i.test(model)) return false; // biçim bile bozuksa deneme
  try {
    if (backendForRole(config, "main") === "cli") {
      const res = await runClaudeCli({
        systemPrompt: "Reply with exactly: ok",
        userMessage: "ping",
        modelId: model,
        cwd: projectRoot,
        timeoutMs: 30_000,
        disallowedTools: PURE_REASONING_DISALLOWED_TOOLS, // ping→"ok": araç gerekmez; yazma/Bash/alt-ajan yasak
      });
      return res.ok;
    }
    const client = makeAnthropicClient(config.api_keys.main, { timeoutMs: 30_000 });
    await client.messages.create({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    });
    return true;
  } catch (e) {
    log.warn("model-discovery", "model doğrulanamadı (geçilmeyecek)", { model, err: String(e) });
    return false;
  }
}

const DISCOVERY_USER =
  "Find the current official Claude model lineup from Anthropic's official documentation. Exact ids only.";

/** Abonelik/CLI yolu: claude CLI'nin WebSearch/WebFetch araçları. */
async function discoverViaCli(modelId: string, projectRoot: string): Promise<string> {
  const res = await runClaudeCli({
    systemPrompt: DISCOVERY_SYSTEM,
    userMessage: DISCOVERY_USER,
    modelId,
    cwd: projectRoot,
    allowedTools: ["WebSearch", "WebFetch"],
    disallowedTools: PURE_REASONING_DISALLOWED_TOOLS, // WebSearch/WebFetch açık; yazma/Bash/alt-ajan yasak
    // Ümit 2026-06-11: folder-guard AÇIK — WebSearch/WebFetch'te Bash YOK → nesting yok; sandbox-exec claude'un
    // startup Desktop/klasör taramasını + tccd'yi keser → "Masaüstü'ne erişmek istiyor" TCC penceresi çıkmaz.
    // (Profil default-allow + yalnız korunan-klasör/tccd deny → ağ/web-arama serbest çalışır.)
    folderGuard: true,
  });
  if (!res.ok) throw new Error(res.error ?? "cli web keşif başarısız");
  return res.text;
}

/** API yolu: Anthropic SDK + server-side web_search tool (web_search_20250305; beta header gerekmez). */
async function discoverViaApi(config: MyclConfig, modelId: string): Promise<string> {
  const client = makeAnthropicClient(config.api_keys.main, { timeoutMs: 90_000 });
  const response = await client.messages.create({
    model: modelId,
    max_tokens: 2048,
    system: DISCOVERY_SYSTEM,
    messages: [{ role: "user", content: DISCOVERY_USER }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  });
  // Claude'un (web_search sonrası) final cevabı text block'larında — JSON oradadır.
  return response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
