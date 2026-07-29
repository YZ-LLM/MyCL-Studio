// llm-reasoning — BACKEND-AWARE (api/cli) tek-atış akıl yürütme (tool YOK, saf reasoning).
//
// YZLLM: "yaptığımız her şey API'yi de desteklemeli." decompose/review gibi saf-reasoning çağrıları doğrudan
// runClaudeCli (CLI-only) kullanıyordu → API modunda çalışmazdı. Bu helper backendForRole'a göre CLI ya da
// Anthropic SDK kullanır (design-fanout.runReasoningTurn deseni, ama modelId dışarıdan = canlı-tier uyumlu).

import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { PURE_REASONING_DISALLOWED_TOOLS } from "./tool-policy.js";
import { resolveLlmClient, modelSupportsAdaptive } from "./claude-api.js";
import { backendForRole, type MyclConfig } from "./config.js";

export interface ReasoningResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Tek-atış saf akıl yürütme (tool yok). backend="cli" → runClaudeCli (sandbox, write/bash engelli);
 * backend="api"/"auto"(limitliyse api) → Anthropic SDK. modelId dışarıdan verilir (selectModelForTask /
 * canlı-tier uyumu). Başarısız → {ok:false} (caller fallback yapar).
 */
export async function runReasoning(
  config: MyclConfig,
  opts: {
    systemPrompt: string;
    userMessage: string;
    modelId: string;
    projectRoot: string;
    maxTokens?: number;
    /** Verify-up (YZLLM 2026-06-11): kontrolcü eforu — CLI'da --effort; API'da yalnız destekleyen modelde output_config. */
    effort?: string;
  },
): Promise<ReasoningResult> {
  const backend = backendForRole(config, "main");
  if (backend === "cli") {
    // KALICI OTURUM KALDIRILDI (OE denetimi 2026-07-29, canlı cave kanıtı): reasoning çağrıları seyrek →
    // oturum 20 dk idle-kill'e hep yakalanıyordu; 36 "kalıcı oturum başarısız → cold-start" + 27 turn-timeout =
    // her çağrı önce ölü oturumu deneyip timeout bekliyor, SONRA cold-start yapıyordu (çift maliyet, net negatif).
    // Doğrudan cold-start: aynı prompt/araç-politikası, tek deneme.
    const res = await runClaudeCli({
      systemPrompt: opts.systemPrompt,
      userMessage: opts.userMessage,
      modelId: opts.modelId,
      cwd: opts.projectRoot,
      effort: opts.effort,
      allowedTools: [], // saf reasoning
      disallowedTools: PURE_REASONING_DISALLOWED_TOOLS, // saf reasoning: yazma + Bash + alt-ajan yasak (cold-start = kalıcı yolla parite)
    });
    return { ok: res.ok, text: res.text, error: res.error };
  }
  // API (api / auto-limited→api)
  try {
    const { client, model } = resolveLlmClient(config, "main", config.api_keys.main, opts.modelId, {
      timeoutMs: 60_000,
    });
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userMessage }],
      // Efor yalnız destekleyen modelde (aksi 400) — efektif modele bak.
      ...(opts.effort && modelSupportsAdaptive(model)
        ? { output_config: { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" } }
        : {}),
    });
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: "", error: String(e) };
  }
}
