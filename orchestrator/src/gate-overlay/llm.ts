// gate-overlay/llm — gate seçicinin ÇİFT arka uçlu (abonelik CLI + API) çalıştırıcısı.
//
// NEDEN forced tool yok: abonelik (CLI) native tool tanımını desteklemiyor; parite bilinçli
// olarak text-JSON'a taşındı (subscription-mode). Her iki arka uç da AYNI ham metni döndürür,
// aynı saf derleyiciye (compile.ts) düşer — yani "API'de başka, abonelikte başka davranır"
// diye bir yol yok (API DESTEĞİ ŞART kuralı).
//
// NEDEN ayrı dosya: compile.ts saf çekirdek + ince dosya IO'su; SDK/ipc/config bağımlılıkları
// oraya girseydi saf birim testleri koca bir bağımlılık ağacını ayağa kaldırmak zorunda kalırdı.
//
// Emsal: plan-mode.generatePlan (CLI dalı runClaudeCli + salt-okunur deny listesi, API dalı
// resolveLlmClient + messages.create; ikisi de aynı parse'a düşer).

import Anthropic from "@anthropic-ai/sdk";
import { resolveLlmClient } from "../claude-api.js";
import { runClaudeCli } from "../cli-run.js";
import { resolveProvider, type MyclConfig } from "../config.js";
import { emitClaudeStream, withClaudeStreamBanner } from "../ipc.js";
import { log } from "../logger.js";
import { selectEffortForTask, selectModelForTask } from "../model-catalog.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "../tool-policy.js";
import { buildOverlayPrompt } from "./compile.js";
import type { GatePool } from "./pool.js";

/** Seçim turu üst sınırı — tek soruluk, salt akıl yürütme işi; uzarsa asılmıştır. */
const OVERLAY_TIMEOUT_MS = 120_000;

/**
 * Gate seçiciyi çalıştırır, ham metni döndürür (parse ETMEZ — o compile.ts'in işi).
 * Hata YUTULMAZ: `ok:false` + neden döner, çağıran görünür hataya çevirir (KATI #4).
 */
export async function runOverlaySelection(
  config: MyclConfig,
  projectRoot: string,
  pool: GatePool,
  taskText: string,
  fileInventorySummary: string,
  /** İkinci deneme: ilk turun NEDEN okunamadığı. Aynı promptu aynen tekrarlamak aynı hatayı davet eder. */
  retryNote?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const prompt = buildOverlayPrompt(pool, taskText, fileInventorySummary);
  const { system } = prompt;
  const user = retryNote
    ? `${prompt.user}\n\nYour previous answer could not be read: ${retryNote}\nAnswer again with exactly one \`\`\`json block that satisfies the output contract. No other text.`
    : prompt.user;
  // Risk incelemesi işi → güçlü katman (kaçırılan kısıt da yanlış kısıt da pahalı).
  const model = selectModelForTask("review", config.selected_models.model_tiers).modelId;
  const effort = selectEffortForTask("review", config.claude_code_flags.effort);
  const provider = resolveProvider(config, "orchestrator");
  log.info("gate-overlay", "gate secimi basliyor", {
    backend: provider.backend,
    model,
    files: fileInventorySummary.length,
  });
  try {
    if (provider.backend === "cli") {
      const res = await withClaudeStreamBanner(
        { text: "cli-gate-overlay", model, cwd: projectRoot },
        () =>
          runClaudeCli({
            systemPrompt: system,
            userMessage: user,
            modelId: model,
            // Proje kökü: ajan gerektiğinde dosyaya bakıp kısıtın anlamlı olduğunu doğrulasın.
            cwd: projectRoot,
            // Salt akıl yürütme — yazma/alt-ajan yasak (Read/Grep açık).
            disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
            effort,
            onText: (t) => emitClaudeStream({ sub: "text", text: t }),
            timeoutMs: OVERLAY_TIMEOUT_MS,
          }),
      );
      if (!res.ok) return { ok: false, error: res.error ?? "CLI gate secimi basarisiz" };
      return { ok: true, text: res.text };
    }
    const { client, model: apiModel } = resolveLlmClient(
      config,
      "orchestrator",
      provider.apiKey,
      model,
      { timeoutMs: OVERLAY_TIMEOUT_MS },
    );
    const response = await client.messages.create({
      model: apiModel,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
