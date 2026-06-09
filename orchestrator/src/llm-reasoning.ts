// llm-reasoning — BACKEND-AWARE (api/cli) tek-atış akıl yürütme (tool YOK, saf reasoning).
//
// Ümit: "yaptığımız her şey API'yi de desteklemeli." decompose/review gibi saf-reasoning çağrıları doğrudan
// runClaudeCli (CLI-only) kullanıyordu → API modunda çalışmazdı. Bu helper backendForRole'a göre CLI ya da
// Anthropic SDK kullanır (design-fanout.runReasoningTurn deseni, ama modelId dışarıdan = canlı-tier uyumlu).

import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { makeAnthropicClient } from "./claude-api.js";
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
  },
): Promise<ReasoningResult> {
  const backend = backendForRole(config, "main");
  if (backend === "cli") {
    const res = await runClaudeCli({
      systemPrompt: opts.systemPrompt,
      userMessage: opts.userMessage,
      modelId: opts.modelId,
      cwd: opts.projectRoot,
      allowedTools: [], // saf reasoning
      disallowedTools: ["Write", "Edit", "Bash"],
    });
    return { ok: res.ok, text: res.text, error: res.error };
  }
  // API (api / auto-limited→api)
  try {
    const client = makeAnthropicClient(config.api_keys.main, { timeoutMs: 60_000 });
    const response = await client.messages.create({
      model: opts.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userMessage }],
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
