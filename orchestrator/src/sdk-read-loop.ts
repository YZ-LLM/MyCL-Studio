// sdk-read-loop — SALT OKUNUR araç döngüsü (API/SDK yolu): runTurn ↔ executeTool.
//
// NEDEN ORTAK MODÜL (2026-08-03): iki rol aynı şeye ihtiyaç duyuyor —
//  1) MÜFETTİŞ: API modunda `claude` binary'si login değil → araç kullanan kanıt toplama SDK ile yapılır.
//  2) YAŞAYAN DÖKÜMANTASYON / KULLANIM KILAVUZU: bugüne kadar API modunda HİÇ üretilmiyordu
//     (living-docs "yalnız CLI/abonelik" deyip dönüyordu) → kullanıcı API modundaysa kılavuz asla oluşmuyor,
//     "her zaman güncel" sözü tutulmuyordu. Kılavuz üretimi kodu OKUMAYI zorunlu kılar (araçsız tek atış
//     modeli uydurmaya iter — `isNoAccessDoc` guard'ı tam da bu yüzden var), o yüzden araç döngüsü şart.
//
// Kopyala-yapıştır yerine tek çekirdek: müfettiş bunu delege eder, davranışı birebir korunur.
// SALT OKUNUR sözleşmesi: çağıran araç adlarını verir; yazma araçları (Write/Edit) BURADAN geçmez —
// dosyaya yazmayı çağıranın kendi Node kodu yapar.

import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ApiMessage } from "./claude-api.js";
import { executeTool, TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import type { MyclConfig } from "./config.js";
import { log } from "./logger.js";

/** assistant content'ten düz metni çıkar. SAF. */
export function extractSdkText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("")
    .trim();
}

type CatalogTool = (typeof TOOLS_CODEGEN)[number];

/** SAF: istenen araç adlarını codegen araç kataloğundan süz (bilinmeyen ad sessizce düşmesin diye döndürülür). */
export function selectTools(names: readonly string[]): {
  tools: CatalogTool[];
  unknown: string[];
} {
  const catalog = new Map(TOOLS_CODEGEN.map((t) => [(t as { name: string }).name, t]));
  const tools = names.map((n) => catalog.get(n)).filter((t): t is CatalogTool => Boolean(t));
  const unknown = names.filter((n) => !catalog.has(n));
  return { tools, unknown };
}

export interface SdkReadLoopOpts {
  systemPrompt: string;
  userMessage: string;
  projectRoot: string;
  modelId: string;
  effort?: string;
  /** İzinli araçlar — yalnız salt okunur olanlar verilmeli (örn. ["Read","Grep","Glob"]). */
  toolNames: readonly string[];
  maxTurns: number;
  toolResultCap: number;
  maxTokens?: number;
  /** Telemetri: her tur metni (bekleme göstergesi/canlılık). */
  onText?: (text: string) => void;
  /** Telemetri: her araç çağrısı. */
  observer?: (toolUse: { name: string; input: Record<string, unknown> }) => void;
  /** Log etiketi (hangi rol koşuyor). */
  tag: string;
}

/**
 * Araç döngüsü: model araç isterse çalıştır, sonucu geri ver; model durunca son metni dön.
 * Fail-closed: hata/tavan aşımı → `ok:false` (çağıran görünür şekilde ele alır, sessiz "başarılı" yok).
 */
export async function runReadOnlySdkLoop(
  config: MyclConfig,
  apiKey: string,
  opts: SdkReadLoopOpts,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const { tools, unknown } = selectTools(opts.toolNames);
  if (unknown.length > 0) {
    // Sessiz düşme yok: istenen araç katalogda yoksa görünür log (yanlış araç adı = sessizce yeteneksiz ajan).
    log.warn(opts.tag, "SDK döngüsünde bilinmeyen araç adı yok sayıldı", { unknown });
  }
  const ctx: ToolContext = { project_root: opts.projectRoot };
  const messages: ApiMessage[] = [{ role: "user", content: opts.userMessage }];
  let lastText = "";
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    let r;
    try {
      r = await runTurn(
        config,
        apiKey,
        {
          messages,
          system: opts.systemPrompt,
          model: opts.modelId,
          tools: tools as unknown as Parameters<typeof runTurn>[2]["tools"],
          max_tokens: opts.maxTokens ?? 8192,
          // CLI tarafında --effort iletilir; API tarafında efor yalnız adaptive-thinking destekleyen
          // modelde output_config'e yansır (desteklemeyen modelde efektif no-op — dürüst not).
          effortOverride: opts.effort,
        },
        () => {},
      );
    } catch (e) {
      return { ok: false, text: lastText, error: String(e) };
    }
    messages.push({ role: "assistant", content: r.assistantContent });
    const turnText = extractSdkText(r.assistantContent);
    if (turnText) {
      lastText = turnText;
      opts.onText?.(turnText);
    }
    if (r.toolUses.length === 0) {
      if (r.stop_reason === "max_tokens") {
        log.warn(opts.tag, "SDK turu max_tokens'da kesildi — çıktı truncate olabilir (kısmi metin)", { turn });
      }
      return { ok: true, text: lastText }; // model durdu → çıktı hazır
    }
    const toolResults: Anthropic.MessageParam["content"] = [];
    for (const tu of r.toolUses) {
      opts.observer?.({ name: tu.name, input: tu.input as Record<string, unknown> });
      const result = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx).catch((e) => ({
        content: `tool error: ${String(e)}`,
        is_error: true,
      }));
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: String(result.content).slice(0, opts.toolResultCap),
        is_error: result.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  log.warn(opts.tag, "SDK araç-döngüsü tavanı aştı", { turns: opts.maxTurns });
  return {
    ok: Boolean(lastText.trim()),
    text: lastText,
    error: lastText.trim() ? undefined : "SDK araç döngüsü tavanı aştı (çıktı yok)",
  };
}
