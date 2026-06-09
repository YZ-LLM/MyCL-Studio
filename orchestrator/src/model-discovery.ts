// model-discovery — güncel Claude modellerini WEB ARAMASIYLA bulur (Ümit: "keşfin API ile alakası yok; LLM
// internette Anthropic/Claude dökümanlarından bulsun"). API key GEREKMEZ → abonelik (CLI) modunda da çalışır.
//
// LLM (claude CLI, WebSearch/WebFetch) Anthropic'in RESMİ dökümanlarını arar → güncel model id'leri + adları.
// Sonra deterministik aile-tier'lama (model-catalog.setLiveTiersFromModels) uygular (LLM tier YANLIŞI olmasın).
// Hatasızlık: yalnız resmi kaynak + EXACT id + doğrulama (claude-* deseni); şüphe/başarısızlık → statik katalog.

import { runClaudeCli } from "./cli-run.js";
import { extractKindBlock } from "./cli-json.js";
import { type MyclConfig } from "./config.js";
import { log } from "./logger.js";

const DISCOVERY_SYSTEM = [
  "You find the CURRENT, OFFICIAL Claude (Anthropic) model lineup. Use WebSearch + WebFetch on Anthropic's",
  "OFFICIAL sources ONLY (docs.anthropic.com, anthropic.com, official model/pricing pages).",
  "Extract each currently-available model's EXACT API id (e.g. \"claude-opus-4-8\") and display name.",
  "Do NOT guess or invent ids — only models you CONFIRM in official Anthropic sources. If unsure, omit it.",
  'Output ONLY one JSON block, nothing else: {"kind":"models","models":[{"id":"claude-...","display_name":"..."}]}',
  "Order newest/current first. If you cannot confirm from official sources, return an empty models array.",
].join("\n");

export interface DiscoveredModel {
  id: string;
  display_name: string;
}

/** Web-arama yanıtından modelleri ayıklar (SAF) + doğrular (id claude-* benzeri, boş değil). */
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
    out.push({ id, display_name: dn });
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
  try {
    const res = await runClaudeCli({
      systemPrompt: DISCOVERY_SYSTEM,
      userMessage:
        "Find the current official Claude model lineup from Anthropic's official documentation. Exact ids only.",
      modelId: config.selected_models.orchestrator ?? config.selected_models.main,
      cwd: projectRoot,
      allowedTools: ["WebSearch", "WebFetch"],
      folderGuard: false, // web-arama; dosya yazmaz, sandbox-exec sarmaya gerek yok (nesting önle)
    });
    if (!res.ok) {
      log.warn("model-discovery", "web keşif başarısız (statik katalog geçerli)", { error: res.error });
      return [];
    }
    return parseDiscoveredModels(res.text);
  } catch (e) {
    log.warn("model-discovery", "web keşif exception (statik katalog geçerli)", e);
    return [];
  }
}
