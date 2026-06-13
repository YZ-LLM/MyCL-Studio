// hypothesis-investigation — Faz 0 D1 ÖNCESİ Bash'li çok-perspektifli kök-neden İNCELEMESİ.
//
// runHypothesisFanout (design-fanout.ts) ile KARDEŞ ama farkı: o saf-akıl-yürütme (Bash YOK,
// yalnız toplanan kanıt üzerine reason); BU ise her merceği GERÇEKTEN araştırır — Read/Grep/
// Glob/Bash ile kodu okur/arar/çalıştırır → kanıta-dayalı hipotez. MyCL-native fan-out
// (Promise.allSettled × N runClaudeCli) — claude'un kendi Agent Teams'i DEĞİL; bağımsız,
// doğrulanabilir, abonelik/CLI yolu. Çıktılar D1 user message'ına enjekte edilir; D1 yine
// NORMAL koşar (regresyon-güvenli; report_root_cause/D2 akışı değişmez).
//
// Maliyet guardrail: caller agent_teams_optin + CLI ile GATE'ler; küçük N (3 mercek) +
// per-inceleme idle-timeout. runClaudeCli'de turn-budget yok → N küçük + gate ile sınırlı.

import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { subagentModelId, type MyclConfig } from "./config.js";
import { HYPOTHESIS_ANGLES } from "./design-fanout.js";
import { log } from "./logger.js";

/** Per-inceleme idle-timeout (D1 ile aynı mertebe; Bash'li araştırma yoğun olabilir). */
const INVESTIGATION_TIMEOUT_MS = 150_000;

function investigationSystemPrompt(angle: string): string {
  return (
    "You are a debugging INVESTIGATION agent with READ-ONLY tools: Read, Grep, Glob, Bash.\n" +
    `Your lens: ${angle}.\n` +
    "Investigate the codebase to CONFIRM or REFUTE a root-cause hypothesis FROM YOUR LENS for the bug below.\n" +
    "- Use Grep/Glob to locate relevant code, Read to inspect it, Bash ONLY for read-only checks " +
    "(grep, cat, ls, git log/blame, a quick non-mutating command). DO NOT modify files or run " +
    "destructive/long-running commands.\n" +
    "- Ground EVERY claim in concrete evidence you actually observed (file paths, line numbers, " +
    "function names, values). Do not speculate beyond what you found.\n" +
    "- If your lens clearly does NOT fit this bug, say so in one line.\n" +
    "Conclude with your SINGLE most likely root-cause hypothesis from your lens (2-4 sentences, " +
    "concrete to THIS bug). Your hypothesis feeds the D1 investigation that follows.\n\n" +
    "## OUTPUT — CLI mode (no custom tool)\n" +
    "Your ENTIRE final reply must be exactly one JSON block and nothing else:\n" +
    '{"kind":"hypothesis","text":"<your concise root-cause hypothesis citing the evidence you found>"}'
  );
}

/**
 * Faz 0 D1 ÖNCESİ Bash'li hipotez İNCELEMESİ (CLI/abonelik). 3 mercek paralel → her biri
 * kodu araştırarak kanıta-dayalı kök-neden hipotezi (etiketli metin dizisi). Başarısız/boş
 * mercek atlanır; caller <2 ise enjekte etmez (D1 normal koşar). Bash gerektirir → caller
 * yalnız backend "cli" iken çağırmalı.
 */
export async function runHypothesisInvestigations(
  config: MyclConfig,
  projectRoot: string,
  bugReport: string,
  evidence: string,
): Promise<string[]> {
  const model = subagentModelId(config.selected_models, "hypothesis");
  const userMsg =
    `Bug report:\n${bugReport}\n\n---\nDeterministic evidence already gathered (error catalog, git ` +
    `blame, dependency graph, UI probe):\n` +
    (evidence && evidence.trim() ? evidence : "(none gathered)") +
    "\n\nInvestigate from your lens, then emit the hypothesis JSON block.";

  const settled = await Promise.allSettled(
    HYPOTHESIS_ANGLES.map((h) =>
      runClaudeCli({
        systemPrompt: investigationSystemPrompt(h.angle),
        userMessage: userMsg,
        modelId: model,
        cwd: projectRoot,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // salt-okunur hipotez araştırması: yazma + alt-ajan yasak, Bash açık
        effort: config.claude_code_flags.effort,
        timeoutMs: INVESTIGATION_TIMEOUT_MS,
      }),
    ),
  );

  const out: string[] = [];
  settled.forEach((r, i) => {
    const key = HYPOTHESIS_ANGLES[i].key;
    if (r.status !== "fulfilled") {
      log.warn("hypothesis-investigation", "inceleme reddedildi", { angle: key, reason: String(r.reason) });
      return;
    }
    if (!r.value.ok) {
      log.warn("hypothesis-investigation", "inceleme başarısız", { angle: key, error: r.value.error });
      return;
    }
    const block = extractKindBlock(r.value.text, ["hypothesis"]);
    const text = block && typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      out.push(`[${key}] ${text}`);
    } else {
      log.warn("hypothesis-investigation", "hypothesis bloğu yok/boş (atlandı)", { angle: key });
    }
  });
  return out;
}
