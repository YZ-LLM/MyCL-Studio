// llm-reasoning — BACKEND-AWARE (api/cli) tek-atış akıl yürütme (tool YOK, saf reasoning).
//
// Ümit: "yaptığımız her şey API'yi de desteklemeli." decompose/review gibi saf-reasoning çağrıları doğrudan
// runClaudeCli (CLI-only) kullanıyordu → API modunda çalışmazdı. Bu helper backendForRole'a göre CLI ya da
// Anthropic SDK kullanır (design-fanout.runReasoningTurn deseni, ama modelId dışarıdan = canlı-tier uyumlu).

import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { getPersistentSession, shortHash } from "./persistent-cli-session.js";
import { makeAnthropicClient, modelSupportsAdaptive } from "./claude-api.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { log } from "./logger.js";

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
    /** Verify-up (Ümit 2026-06-11): kontrolcü eforu — CLI'da --effort; API'da yalnız destekleyen modelde output_config. */
    effort?: string;
  },
): Promise<ReasoningResult> {
  const backend = backendForRole(config, "main");
  if (backend === "cli") {
    // Ümit 2026-06-11: KALICI oturum (read-only reasoning — verify-up/audit/vb.). Süreç-tipi (systemPrompt+model)
    // başına tek canlı süreç → respawn yok → ısı↓; biriken bağlam tutarlılık. Başarısızsa cold-start'a düş.
    try {
      // Oturum systemPrompt'a göre anahtarlanır (model DEĞİL) → model/efor oturum-İÇİNDE değişir (respawn yok).
      const session = getPersistentSession({
        id: `reasoning-${shortHash(opts.systemPrompt)}`,
        modelId: opts.modelId,
        systemPrompt: opts.systemPrompt,
        effort: opts.effort,
        cwd: opts.projectRoot,
        disallowedTools: ["Write", "Edit", "Bash"],
      });
      const r = await session.send(opts.userMessage, { model: opts.modelId, effort: opts.effort, timeoutMs: 180_000 });
      if (r.ok && r.text.trim()) return { ok: true, text: r.text };
      log.warn("llm-reasoning", "kalıcı oturum başarısız → cold-start", { error: r.error });
    } catch (e) {
      log.warn("llm-reasoning", "kalıcı oturum hata → cold-start", { error: String(e) });
    }
    const res = await runClaudeCli({
      systemPrompt: opts.systemPrompt,
      userMessage: opts.userMessage,
      modelId: opts.modelId,
      cwd: opts.projectRoot,
      effort: opts.effort,
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
      // Efor yalnız destekleyen modelde (aksi 400) — haiku'da atlanır, model seviyesi asıl kaldıraç.
      ...(opts.effort && modelSupportsAdaptive(opts.modelId)
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
