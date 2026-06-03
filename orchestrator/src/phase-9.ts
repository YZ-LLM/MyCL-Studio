// phase-9 — Risk Review (qa-askq).
//
// v15.7 (2026-05-27): Dosya header rot düzeltildi (eski "phase-10" yazıyordu).
// Phase9Controller → Phase 9 = Risk review.

import { readFile } from "node:fs/promises";
import { appendAudit } from "./audit.js";
import {
  buildRelevantPhase9Audit,
  getSpecSectionMarkdown,
} from "./relevance/injectors.js";
import type { QaAskqBackend } from "./base/qa-askq-controller.js";
import { createQaAskqBackend } from "./base/qa-askq-cli-backend.js";
import {
  collectIterationTechDebt,
  renderChangedFilesList,
  renderTechDebtFindings,
} from "./phase-9-tech-debt.js";
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

const TOOL_ASK_RISK: ToolDef = {
  name: "ask_risk_decision",
  description: "Ask the user how to handle a specific risk: skip / fix / rule.",
  input_schema: {
    type: "object",
    required: ["question", "options"],
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
    },
  },
};

const TOOL_COMPLETE: ToolDef = {
  name: "complete_risk_review",
  description: "Submit the risk classification summary.",
  input_schema: {
    type: "object",
    required: ["summary", "decisions"],
    properties: {
      summary: { type: "string" },
      decisions: {
        type: "array",
        items: {
          type: "object",
          required: ["risk", "decision"],
          properties: {
            risk: { type: "string" },
            decision: {
              type: "string",
              description: "skip | fix | rule",
            },
            detail: { type: "string" },
          },
        },
      },
    },
  },
};

interface RiskDecision {
  risk: string;
  decision: string;
  detail?: string;
}

export class Phase9Controller {
  private base: QaAskqBackend | null = null;
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
    log.info("phase-9", "run start");

    if (!this.spec.askq_config) {
      emitError("phase-10 askq_config missing", null);
      this.lastFailReason = "askq_config missing in spec";
      return "fail";
    }
    // Phase 2 sonrası gelir; defensive guard relevance injection için.
    if (!this.state.intent_summary) {
      emitError("phase-10: intent_summary missing — Phase 2 önce tamamlanmalı", null);
      this.lastFailReason = "intent_summary missing (Phase 2 incomplete)";
      return "fail";
    }

    // Context enjeksiyonu:
    //   - SPEC_RISKS: deterministic — spec'in Risks section'u olduğu gibi.
    //   - PHASE_9_AUDIT: relevance-filtered — TDD codegen event'lerinden
    //     mevcut intent'e en alakalı olanlar (eskiden last-30 capping idi).
    const [specRisks, phase9Audit, techDebt] = await Promise.all([
      getSpecSectionMarkdown(this.state.project_root, "Risks"),
      buildRelevantPhase9Audit(
        this.config,
        this.state,
        this.state.intent_summary,
      ),
      // v15.12: bu iterasyonda değişen üretim dosyalarında deterministik teknik
      // borç taraması (Faz 8 per-dosya gate'ini tamamlar; SADECE bu iterasyonun işi).
      collectIterationTechDebt(this.state),
    ]);

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 9,
      event: "phase-9-tech-debt-scan",
      caller: "mycl-orchestrator",
      detail: `scanned=${techDebt.scannedCount} findings=${techDebt.totalFindings}${techDebt.truncated ? " (truncated)" : ""}`,
    });

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      const convSection = await buildConversationContext(this.config, this.state, { recentLanguage: "en" })
        .then((c) => renderConversationSection(c, { forMainAgent: true }))
        .catch(() => "");
      systemPrompt = substitute(tmpl, {
        SPEC_RISKS: specRisks,
        PHASE_9_AUDIT: phase9Audit,
        TECH_DEBT_FINDINGS: renderTechDebtFindings(techDebt),
        TECH_DEBT_FILES: renderChangedFilesList(techDebt),
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-9", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    const role = this.spec.model_role!;
    this.base = createQaAskqBackend({
      tag: "phase-9",
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 9: Risk Review. Walk residual risks.",
      tools: [TOOL_ASK_RISK, TOOL_COMPLETE],
      askq: this.spec.askq_config,
    });

    const outcome = await this.base.run();
    if (outcome.kind !== "approved") {
      const o = outcome as { kind: string; reason?: string };
      this.lastFailReason =
        o.kind === "failed" ? o.reason ?? "unknown reason" : `outcome kind=${o.kind}`;
      return "fail";
    }

    // v15.10: Array.isArray guard — ajan `decisions`'ı non-array emit ederse
    // `?? []` yakalamaz, for...of çökerdi (bkz phase-2 dimensions fix).
    const rawDecs = outcome.approvalInput.decisions;
    const decisions = (Array.isArray(rawDecs) ? rawDecs : []) as RiskDecision[];
    if (rawDecs !== undefined && !Array.isArray(rawDecs)) {
      log.warn("phase-9", "decisions array değil — boş kabul edildi", { type: typeof rawDecs });
    }
    for (const d of decisions) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 9,
        event: "risk-decision",
        caller: "mycl-orchestrator",
        detail: `${d.decision}=${d.risk.slice(0, 80)}`,
      });
    }
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 9,
      event: "phase-09-complete",
      caller: "user",
      detail: String(outcome.approvalInput.summary ?? "").slice(0, 200),
    });
    log.info("phase-9", "complete", { decisions: decisions.length });
    return "complete";
  }
}
