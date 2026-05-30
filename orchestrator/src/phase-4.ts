// phase-4 — Engineering Spec Writing (production-schema).
//
// Faz-spesifik mantık: state.intent_summary kontrolü, template'e enjekte,
// production-schema base controller'ı çalıştır. Spec.md base tarafında yazılır;
// approve geldiğinde state.spec_approved + spec_hash patch'i yapılır.

import { readFile } from "node:fs/promises";
import { appendAudit, appendDecision } from "./audit.js";
import { ProductionSchemaBaseController } from "./base/production-schema-controller.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitError } from "./ipc.js";
import { log } from "./logger.js";
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
}

function specToMarkdown(spec: SpecData): string {
  const ac = spec.acceptance_criteria
    .map((a) => `- **${a.id}**: ${a.statement}`)
    .join("\n");
  const oos = spec.out_of_scope.map((s) => `- ${s}`).join("\n");
  const risks = spec.risks
    .map((r) => `### ${r.title}\n${r.detail}`)
    .join("\n\n");
  return `# ${spec.title}

## Scope

${spec.scope}

## Acceptance Criteria

${ac}

## Out of Scope

${oos}

## Risks

${risks}
`;
}

export class Phase4Controller {
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
      const convSection = await buildConversationContext(this.config, this.state)
        .then(renderConversationSection)
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

    const role = this.spec.model_role!;
    this.base = new ProductionSchemaBaseController({
      tag: "phase-4",
      phaseId: 4,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 4: write the engineering spec.",
      tools: [TOOL_WRITE_SPEC, TOOL_REQUEST_APPROVAL],
      production: this.spec.production_config,
      betas: this.config.claude_code_flags.betas,
      artifactRenderer: (input) => specToMarkdown(input as unknown as SpecData),
      artifactAuditDetail: (input, hash) => {
        const title = String((input as { title?: string }).title ?? "").slice(0, 80);
        return `sha256=${hash} title="${title}"`;
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
