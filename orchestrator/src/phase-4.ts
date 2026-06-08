// phase-4 — Engineering Spec Writing (production-schema).
//
// Faz-spesifik mantık: state.intent_summary kontrolü, template'e enjekte,
// production-schema base controller'ı çalıştır. Spec.md base tarafında yazılır;
// approve geldiğinde state.spec_approved + spec_hash patch'i yapılır.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendAudit, appendDecision } from "./audit.js";
import type { ProductionBackend } from "./base/production-schema-controller.js";
import { createProductionSchemaBackend } from "./base/production-schema-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage, emitError } from "./ipc.js";
import { log } from "./logger.js";
import { blindspotLensDecision } from "./pre-commit-lens-gate.js";
import { runBlindspotLens, formatLensFindings } from "./pre-commit-lens.js";
import { buildRelevantEngineeringBrief } from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_WRITE_SPEC: ToolDef = {
  name: "write_spec",
  description:
    "Persist the structured engineering spec. Call once with a complete spec; orchestrator saves to disk and confirms.",
  input_schema: {
    type: "object",
    required: ["title", "scope", "acceptance_criteria", "out_of_scope", "risks"],
    properties: {
      title: { type: "string", description: "Short specific spec title (5-10 words)." },
      scope: {
        type: "string",
        description: "1-2 paragraphs — what's included AND what's excluded.",
      },
      acceptance_criteria: {
        type: "array",
        description: "3-7 testable conditions, AC1..ACn ids.",
        items: {
          type: "object",
          required: ["id", "statement"],
          properties: {
            id: { type: "string", description: "AC1, AC2, ..." },
            statement: { type: "string" },
          },
        },
      },
      out_of_scope: {
        type: "array",
        description: "1-5 deferred items.",
        items: { type: "string" },
      },
      risks: {
        type: "array",
        description: "1-4 technical risks.",
        items: {
          type: "object",
          required: ["title", "detail"],
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
      assumptions: {
        type: "array",
        description:
          "Assumptions you made that the user did NOT explicitly state but the spec depends on (e.g. you inferred an acceptance criterion, picked a default, interpreted a vague word). Each: {assumption, why}. Omit/empty if everything came directly from the user. NOT a gate — the user SEES these so they can object if one is wrong.",
        items: {
          type: "object",
          required: ["assumption", "why"],
          properties: {
            assumption: { type: "string" },
            why: { type: "string" },
          },
        },
      },
    },
  },
};

const TOOL_REQUEST_APPROVAL: ToolDef = {
  name: "request_spec_approval",
  description:
    "After spec is saved, summarize in 2-3 sentences (elevator pitch) and ask for user approval.",
  input_schema: {
    type: "object",
    required: ["pitch"],
    properties: {
      pitch: { type: "string", description: "2-3 sentence summary of the saved spec." },
    },
  },
};

interface SpecData {
  title: string;
  scope: string;
  acceptance_criteria: Array<{ id: string; statement: string }>;
  out_of_scope: string[];
  risks: Array<{ title: string; detail: string }>;
  /** #1 (varsayım görünürlüğü): kullanıcının açıkça demediği ama spec'in dayandığı varsayımlar. Opsiyonel. */
  assumptions?: Array<{ assumption: string; why: string }>;
}

export function specToMarkdown(spec: SpecData): string {
  const ac = spec.acceptance_criteria
    .map((a) => `- **${a.id}**: ${a.statement}`)
    .join("\n");
  const oos = spec.out_of_scope.map((s) => `- ${s}`).join("\n");
  const risks = spec.risks
    .map((r) => `### ${r.title}\n${r.detail}`)
    .join("\n\n");
  // #1 (varsayım görünürlüğü): yalnız varsayım VARSA bölüm yazılır (AC3 — varsayım yoksa gürültü yok).
  const assumptions =
    spec.assumptions && spec.assumptions.length > 0
      ? `
## Assumptions (kullanıcı açıkça belirtmedi — yanlışsa itiraz et)

${spec.assumptions.map((a) => `- **${a.assumption}** — ${a.why}`).join("\n")}
`
      : "";
  return `# ${spec.title}

## Scope

${spec.scope}

## Acceptance Criteria

${ac}

## Out of Scope

${oos}

## Risks

${risks}
${assumptions}`;
}

export class Phase4Controller {
  private base: ProductionBackend | null = null;
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
    log.info("phase-4", "run start");

    if (!this.state.intent_summary) {
      log.error("phase-4", "intent_summary missing in state");
      emitError("intent_summary missing — Phase 1 önce tamamlanmalı", null);
      this.lastFailReason = "intent_summary missing (Phase 1 incomplete)";
      return "fail";
    }
    if (!this.spec.production_config) {
      log.error("phase-4", "production_config missing");
      emitError("phase-4 production_config missing", null);
      this.lastFailReason = "production_config missing in spec";
      return "fail";
    }

    // Brief.md artık doğrudan okunmuyor — relevance engine ile section bazlı
    // filter ediliyor. Boş veya alakasız brief durumunda sentinel string;
    // Phase 3 skip edildiyse "(no relevant brief sections found)" döner.
    const engineeringBrief = await buildRelevantEngineeringBrief(
      this.config,
      this.state,
      this.state.intent_summary,
    );

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      const convSection = await buildConversationContext(this.config, this.state, { recentLanguage: "en" })
        .then((c) => renderConversationSection(c, { forMainAgent: true }))
        .catch(() => "");
      systemPrompt = substitute(tmpl, {
        INTENT_SUMMARY: this.state.intent_summary,
        ENGINEERING_BRIEF: engineeringBrief,
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-4", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    // v15.9 INCREMENTAL SPEC: mevcut spec.md varsa baştan yazma — KORU + yeni
    // AC ekle (Ümit: spec biriktirilsin). Model mevcut spec'i görüp full merged
    // spec üretir; AC numaralandırma mevcut max'tan devam eder. spec.md yoksa
    // (ilk spec / greenfield) varsayılan mesaj.
    let initialUserMessage = "Begin Phase 4: write the engineering spec.";
    try {
      const existingSpec = await readFile(
        join(this.state.project_root, ".mycl", "spec.md"),
        "utf-8",
      );
      if (existingSpec.trim().length > 0) {
        initialUserMessage =
          "Begin Phase 4 — INCREMENTAL spec update (this project ALREADY has a spec).\n\n" +
          "## EXISTING spec.md (PRESERVE — do NOT drop prior scope, acceptance criteria, or risks)\n" +
          "```markdown\n" +
          existingSpec.slice(0, 8000) +
          "\n```\n\n" +
          "For THIS iteration: KEEP all existing content and ADD only what the current intent " +
          "requires. Continue acceptance-criteria numbering AFTER the highest existing number — do " +
          "NOT renumber or remove existing ACs. Your write_spec output MUST be the FULL merged spec " +
          "(existing + new), not just the delta.";
        log.info("phase-4", "incremental spec mode (mevcut spec.md korunuyor)");
      }
    } catch {
      // spec.md yok → ilk spec; varsayılan mesaj kalır.
    }

    const role = this.spec.model_role!;
    this.base = createProductionSchemaBackend({
      tag: "phase-4",
      phaseId: 4,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage,
      tools: [TOOL_WRITE_SPEC, TOOL_REQUEST_APPROVAL],
      production: this.spec.production_config,
      betas: this.config.claude_code_flags.betas,
      artifactRenderer: (input) => specToMarkdown(input as unknown as SpecData),
      artifactAuditDetail: (input, hash) => {
        const title = String((input as { title?: string }).title ?? "").slice(0, 80);
        return `sha256=${hash} title="${title}"`;
      },
      // v15.15: spec KOMİT olmadan (onay askq'sı çıkmadan) ÖNCE bağımsız kör-nokta merceği —
      // bu spec'i YAZMAYAN ayrı bir ajan paranteze alınan varsayım/eksik-AC/en-güçlü-itirazı yakalar;
      // bulgular GÖRÜNÜR (onay öncesi chat). Fail-safe: mercek hatası onayı bloklamaz.
      preApprovalHook: async (writeInput) => {
        // #1 (varsayım görünürlüğü): yapay zekânın kullanıcı-demediği varsayımlarını onaydan ÖNCE görünür kıl.
        // Kapı DEĞİL (tek tek onaylatmaz; alan korunur) — kullanıcı yanlış görürse itiraz eder.
        const specInput = writeInput as unknown as SpecData;
        if (specInput.assumptions && specInput.assumptions.length > 0) {
          const lines = specInput.assumptions
            .map((a) => `• ${a.assumption} — ${a.why}`)
            .join("\n");
          emitChatMessage(
            "system",
            `🔍 Spec yazarken şu varsayımları yaptım (sen açıkça belirtmedin). Yanlış olan varsa söyle, düzeltirim:\n${lines}`,
          );
        }
        const dec = blindspotLensDecision({
          lensFlag: this.config.claude_code_flags.blindspot_lens ?? "consequential",
          isConsequential: true, // spec daima consequential
          isReversible: false,
        });
        if (dec !== "run") return;
        const lens = await runBlindspotLens(
          this.config,
          this.state.project_root,
          "spec",
          specToMarkdown(writeInput as unknown as SpecData),
          this.state.intent_summary,
        );
        if (!lens.clean) {
          const m = formatLensFindings(lens);
          if (m) emitChatMessage("system", m);
        }
      },
    });

    const outcome = await this.base.run();

    if (outcome.kind === "approved") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 4,
        event: "phase-4-spec-approve",
        caller: "user",
        detail: `sha256=${outcome.artifact_hash}`,
      });
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 4,
        event: "phase-4-complete",
        caller: "mycl-orchestrator",
      });
      // ADR: spec kapsamı + named riskler (otomatik, non-blocking).
      try {
        const wi = outcome.writeInput as {
          title?: string; scope?: string;
          out_of_scope?: string[]; risks?: Array<{ title?: string }>;
        };
        await appendDecision(this.state.project_root, {
          ts: Date.now(),
          phase: 4,
          iteration: this.state.iteration_count ?? 1,
          title: String(wi.title ?? "Engineering spec"),
          context: String(wi.scope ?? "").slice(0, 280),
          alternatives_considered: Array.isArray(wi.out_of_scope) ? wi.out_of_scope : [],
          chosen: String(wi.title ?? "Engineering spec"),
          reason: Array.isArray(wi.risks)
            ? wi.risks.map((r) => r.title ?? "").filter(Boolean).join("; ")
            : "",
        });
      } catch (err) {
        log.warn("phase-4", "decision record write failed (non-blocking)", err);
      }
      this.statePatch = {
        spec_approved: true,
        spec_hash: outcome.artifact_hash,
      };
      log.info("phase-4", "complete", { spec_hash: outcome.artifact_hash });
      return "complete";
    }
    if (outcome.kind === "cancelled") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 4,
        event: "phase-4-spec-cancel",
        caller: "user",
      });
      this.lastFailReason = "user cancelled";
      return "fail";
    }
    if (outcome.kind === "aborted") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 4,
        event: "phase-4-aborted",
        caller: "user",
      });
      log.info("phase-4", "aborted");
      this.lastFailReason = "aborted";
      return "fail";
    }
    const fallbackOutcome = outcome as { kind: string; reason?: string };
    log.warn("phase-4", "failed", { reason: fallbackOutcome.reason });
    this.lastFailReason =
      fallbackOutcome.kind === "failed"
        ? fallbackOutcome.reason ?? "unknown reason"
        : `unexpected outcome kind=${fallbackOutcome.kind}`;
    return "fail";
  }
}
