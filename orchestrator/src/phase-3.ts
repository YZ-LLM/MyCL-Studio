// phase-3 — Engineering Brief (production-schema).
//
// Faz 2'nin enriched intent_summary'sini alır, tag/stakeholder/constraint
// yapısına dökerek `.mycl/brief.md` üretir ve onaylatır.

import { readFile } from "node:fs/promises";
import { appendAudit, appendDecision } from "./audit.js";
import { ProductionSchemaBaseController } from "./base/production-schema-controller.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitError } from "./ipc.js";
import { log } from "./logger.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_WRITE_BRIEF: ToolDef = {
  name: "write_brief",
  description:
    "Persist the structured engineering brief — tags, stakeholders, constraints, and the optional pipeline phases this iteration requires.",
  input_schema: {
    type: "object",
    required: [
      "title",
      "summary",
      "tags",
      "stakeholders",
      "constraints",
      "needed_optional_phases",
      "needed_optional_phases_reason",
    ],
    properties: {
      title: { type: "string" },
      summary: { type: "string", description: "1-2 paragraph engineering summary." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Canonical lowercase kebab-case tags.",
      },
      stakeholders: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      needed_optional_phases: {
        type: "array",
        items: { type: "integer", enum: [5, 6, 7, 8] },
        description:
          "Which OPTIONAL phases this iteration requires. Mandatory phases (4 spec, 9 risk, 10 lint, 11 simplify, 12 perf, 13 sec, 14 unit, 15 integ, 16 e2e, 17 load) always run. Optional: 5 (UI codegen), 6 (UI review), 7 (DB design), 8 (TDD codegen). Pick the minimum set that fulfills the user intent: a tiny UI tweak needs only [5,6]; a DB-only schema change needs [7,8]; a backend logic change needs [8]; a full feature needs all four.",
      },
      needed_optional_phases_reason: {
        type: "string",
        description:
          "1-2 English sentences explaining WHY the chosen optional phases are sufficient (and why others are not needed). Orchestrator translates this to Turkish for UI display.",
      },
    },
  },
};

const TOOL_APPROVAL: ToolDef = {
  name: "request_brief_approval",
  description: "After brief is saved, summarize in 2-3 sentences and ask for approval.",
  input_schema: {
    type: "object",
    required: ["pitch"],
    properties: { pitch: { type: "string" } },
  },
};

interface BriefData {
  title: string;
  summary: string;
  tags: string[];
  stakeholders: string[];
  constraints: string[];
  needed_optional_phases: number[];
  needed_optional_phases_reason: string;
}

const MANDATORY_PHASES = [4, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const OPTIONAL_PHASE_LABELS: Record<number, string> = {
  5: "Faz 5 — UI Yapımı",
  6: "Faz 6 — UI İnceleme",
  7: "Faz 7 — Veritabanı Tasarımı",
  8: "Faz 8 — TDD Uygulama",
};
const MANDATORY_PHASE_LABELS: Record<number, string> = {
  4: "Faz 4 — Spec Yazımı",
  9: "Faz 9 — Risk İncelemesi",
  10: "Faz 10 — Lint",
  11: "Faz 11 — Sadeleştirme",
  12: "Faz 12 — Performans",
  13: "Faz 13 — Güvenlik",
  14: "Faz 14 — Birim Testler",
  15: "Faz 15 — Entegrasyon Testleri",
  16: "Faz 16 — E2E Testler",
  17: "Faz 17 — Yük Testi",
};

/**
 * LLM needed_optional_phases'i invalid (duplicate, out-of-range) dönerse
 * dedupe + filter; tüm zorunlu fazları ekle; sıralı dön.
 */
function computeNeededPhases(optional: number[]): number[] {
  const validOptional = Array.from(
    new Set(optional.filter((p) => p === 5 || p === 6 || p === 7 || p === 8)),
  );
  const all = [...MANDATORY_PHASES, ...validOptional];
  return Array.from(new Set(all)).sort((a, b) => a - b);
}

function briefToMarkdown(b: BriefData): string {
  const needed = computeNeededPhases(b.needed_optional_phases);
  const neededLines = needed.map((p) => {
    const label = MANDATORY_PHASE_LABELS[p] ?? OPTIONAL_PHASE_LABELS[p] ?? `Faz ${p}`;
    const mandatory = MANDATORY_PHASES.includes(p) ? " *(zorunlu)*" : "";
    return `- ${label}${mandatory}`;
  });
  const skipped = [5, 6, 7, 8].filter((p) => !needed.includes(p));
  const skippedLines = skipped.map(
    (p) => `- ~~${OPTIONAL_PHASE_LABELS[p]}~~ (atlanacak)`,
  );

  return `# ${b.title}

## Summary

${b.summary}

## Tags

${b.tags.map((t) => `- \`${t}\``).join("\n")}

## Stakeholders

${b.stakeholders.map((s) => `- ${s}`).join("\n")}

## Constraints

${b.constraints.map((c) => `- ${c}`).join("\n")}

## Bu iterasyonda çalışacak fazlar

${neededLines.join("\n")}

${skippedLines.length > 0 ? `### Atlanacak opsiyonel fazlar\n\n${skippedLines.join("\n")}\n` : ""}
### Gerekçe

${b.needed_optional_phases_reason}
`;
}

export class Phase3Controller {
  private base: ProductionSchemaBaseController | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  public statePatch: Partial<State> = {};

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
  }

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    this.base?.submitAskqAnswer(askqId, selected_tr);
  }

  abort(): void {
    this.base?.abort();
  }

  async run(): Promise<"complete" | "fail"> {
    log.info("phase-3", "run start");

    if (!this.state.intent_summary) {
      emitError("phase-3: intent_summary missing", null);
      this.lastFailReason = "intent_summary missing (Phase 1 incomplete)";
      return "fail";
    }
    if (!this.spec.production_config) {
      emitError("phase-3 production_config missing", null);
      this.lastFailReason = "production_config missing in spec";
      return "fail";
    }

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      const convSection = await buildConversationContext(this.config, this.state)
        .then(renderConversationSection)
        .catch(() => "");
      systemPrompt = substitute(tmpl, {
        INTENT_SUMMARY: this.state.intent_summary,
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-3", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    const role = this.spec.model_role!;
    this.base = new ProductionSchemaBaseController({
      tag: "phase-3",
      phaseId: 3,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 3: write the engineering brief.",
      tools: [TOOL_WRITE_BRIEF, TOOL_APPROVAL],
      production: this.spec.production_config,
      betas: this.config.claude_code_flags.betas,
      artifactRenderer: (input) => briefToMarkdown(input as unknown as BriefData),
    });

    const outcome = await this.base.run();
    if (outcome.kind === "approved") {
      // v15.6: LLM needed_optional_phases proposes the iteration's scope.
      // Faz 3 sonrası `index.ts` ek bir scope-confirm askq emit eder; kullanıcı
      // onaylayana kadar state.needed_phases set EDİLMEZ — sadece
      // `needed_phases_proposed` (statePatch'te). Aşağıda compute + sakla.
      const optionalRaw = (outcome.writeInput.needed_optional_phases ?? []) as number[];
      const proposed = computeNeededPhases(optionalRaw);
      this.statePatch.needed_phases_proposed = proposed;
      log.info("phase-3", "needed phases proposed", { phases: proposed });

      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 3,
        event: "phase-3-brief-approve",
        caller: "user",
        detail: `sha256=${outcome.artifact_hash} scope=${proposed.join(",")}`,
      });
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 3,
        event: "phase-3-complete",
        caller: "mycl-orchestrator",
      });
      // ADR: bu iterasyonun kapsam kararı + gerekçesi (otomatik, non-blocking).
      try {
        const skipped = [5, 6, 7, 8].filter((p) => !proposed.includes(p));
        await appendDecision(this.state.project_root, {
          ts: Date.now(),
          phase: 3,
          iteration: this.state.iteration_count ?? 1,
          title: String(outcome.writeInput.title ?? "Engineering brief"),
          context: String(outcome.writeInput.summary ?? "").slice(0, 280),
          alternatives_considered: skipped.map((p) => OPTIONAL_PHASE_LABELS[p]),
          chosen: `phases [${proposed.join(",")}]`,
          reason: String(outcome.writeInput.needed_optional_phases_reason ?? ""),
        });
      } catch (err) {
        log.warn("phase-3", "decision record write failed (non-blocking)", err);
      }
      log.info("phase-3", "complete");
      return "complete";
    }
    this.lastFailReason =
      outcome.kind === "failed"
        ? outcome.reason
        : `unexpected outcome kind=${outcome.kind}`;
    return "fail";
  }
}
