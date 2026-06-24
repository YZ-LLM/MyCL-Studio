// İkili Soru Bankası — cross-family üretici (Dilim 4).
//
// Bankayı ÜRETEN müfettiş işi YAPANDAN bağımsız aile olmalı (orkestratör Opus →
// üretici Sonnet); aynı-aile korelasyonlu kör-nokta soru SETİNİ daraltır. Bu
// adaptör runReasoning(INSPECTOR_MODEL_DEFAULT) ile aday üretir; çıktı GÜVENİLMEZ
// → generate.coerceQuestions eler. Kilitleme generate.generateBank'ta (meta-test).

import { runReasoning } from "../llm-reasoning.js";
import { INSPECTOR_MODEL_DEFAULT } from "../inspector.js";
import { VERIFY_BEFORE_CLAIM } from "../agent-language.js";
import { log } from "../logger.js";
import type { MyclConfig } from "../config.js";
import { coerceQuestions, type QuestionProposer } from "./generate.js";
import type { BankKey, BankQuestion } from "./types.js";

const GEN_SYSTEM = [
  "You generate DETERMINISTIC, CODE-DECIDABLE binary tripwire questions for a software pipeline checkpoint.",
  "Each question must be answerable by RUNNING A COMMAND — no human judgment, no LLM. Emit ONLY questions a",
  "deterministic check can decide; SKIP anything needing taste/architecture/UX judgment.",
  "",
  "POLARITY: phrase every question so 'Yes' = PASS/green (e.g. 'X geçerli JSON mü?' NOT 'X bozuk mu?').",
  "",
  "Each question object needs:",
  "  - id: short kebab-case slug",
  "  - text: the binary, Yes=green question, in Turkish",
  "  - check.cmd: a shell command that exits 0 when the invariant HOLDS, nonzero when VIOLATED. It MUST run",
  "      STANDALONE inside a throwaway dir containing ONLY the fixture files — no project deps, no network, no",
  "      installed tools beyond the language runtime. Prefer runtime one-liners (node -e, python -c, ...).",
  "  - check.inconclusive_codes (optional): exit codes meaning 'could not evaluate' (tool crash) → INCONCLUSIVE.",
  "  - blocking_class: 'blocking' (correctness/security) or 'advisory' (cosmetic).",
  "  - real_to_proxy: one line — the REAL property vs the PROXY the check measures (so a reviewer can challenge it).",
  "  - fixtures: array with AT LEAST one known-good (expect 'PASS') AND one known-bad (expect 'FAIL'). Each:",
  "      { name, files: { '<relpath>': '<content>' }, expect: 'PASS'|'FAIL' }. Run inside a dir populated with these",
  "      files, the check MUST exit 0 for PASS fixtures and nonzero for FAIL fixtures — DETERMINISTICALLY.",
  "",
  "If you cannot build a check that reliably distinguishes good from bad with the fixtures, DO NOT emit it",
  "(unprovable checks are rejected anyway). Output EXACTLY one JSON array. No prose, no markdown fences.",
  "",
  VERIFY_BEFORE_CLAIM,
].join("\n");

/** LLM metninden ilk JSON dizisini ayıkla (prose/fence sarmalına dayanıklı). */
function parseJsonArray(text: string): unknown {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Cross-family (Sonnet) üretici. Gerçek LLM çağrısı; başarısız → boş aday. */
export function createSonnetProposer(config: MyclConfig, projectRoot: string): QuestionProposer {
  return async (key: BankKey): Promise<BankQuestion[]> => {
    const r = await runReasoning(config, {
      systemPrompt: GEN_SYSTEM,
      userMessage:
        "Generate code-decidable binary tripwire questions for this checkpoint.\n" +
        `checkpoint=${key.checkpoint}\nstack=${key.stack}\nartifact-type=${key.artifact}\n\n` +
        "Return a JSON array (may be empty if nothing is reliably code-decidable here).",
      modelId: INSPECTOR_MODEL_DEFAULT,
      projectRoot,
      effort: "high",
      maxTokens: 4000,
    });
    if (!r.ok) {
      log.warn("question-bank", "üretici (Sonnet) başarısız → boş aday", { key, error: r.error });
      return [];
    }
    return coerceQuestions(parseJsonArray(r.text));
  };
}
