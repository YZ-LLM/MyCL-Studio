// phase-1 — Intent Gathering (qa-askq).
//
// Faz-spesifik mantık: TR niyetini EN'e çevir, template'e enjekte et, base
// qa-askq controller'ı çalıştır. Approval geldiğinde özet alanı state'in
// `intent_summary` alanına gider (Phase 4 input'u olur).

import { escalatedModelEffort } from "./escalation.js";
import { readFile } from "node:fs/promises";
import { appendAudit } from "./audit.js";
import type { QaAskqBackend } from "./base/qa-askq-controller.js";
import { createQaAskqBackend } from "./base/qa-askq-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitError } from "./ipc.js";
import { log } from "./logger.js";
import { buildCodebaseSnapshot } from "./phase-1-codebase-probe.js";
import { buildRelevantProjectContext } from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import { translate } from "./translator.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_ASK_CLARIFYING: ToolDef = {
  name: "ask_clarifying",
  description:
    "Ask the user a single clarifying question. Use this tool once per turn.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Short, specific clarifying question.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "2-4 short option labels. The user picks one (or 'Other' freeform).",
        minItems: 2,
        maxItems: 4,
      },
      suggested_answer: {
        type: "string",
        description:
          "OPTIONAL but RECOMMENDED — your best guess of the most likely answer for this user, based on project context and prior intent. MUST EXACTLY MATCH one of the option labels (case-sensitive). Used to highlight a suggested choice in the UI. Omit only if all options are truly equally likely.",
      },
    },
    required: ["question", "options"],
  },
};

const TOOL_APPROVE_INTENT: ToolDef = {
  name: "request_intent_approval",
  description:
    "Once all critical ambiguities are resolved, summarize the intent (3-5 sentences) and ask the user to approve.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Concise intent summary (3-5 sentences).",
      },
    },
    required: ["summary"],
  },
};

export class Phase1Controller {
  private base: QaAskqBackend | null = null;
  /** Approve sırasında modelin verdiği niyet özeti (EN) — Phase 4 input olur. */
  public approvedSummary: string | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;

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

  async run(user_intent_tr: string): Promise<"complete" | "fail"> {
    log.info("phase-1", "run start", { intent_len: user_intent_tr.length });

    if (!this.spec.askq_config) {
      log.error("phase-1", "askq_config missing in spec");
      emitError("phase-1 askq_config missing", null);
      return "fail";
    }

    let intent_en: string;
    try {
      const tr = await translate(this.config, user_intent_tr, "tr-to-en");
      intent_en = tr.text;
      log.info("phase-1", "intent translated", { out_len: intent_en.length });
    } catch (err) {
      log.error("phase-1", "translator failed (intent)", err);
      emitError("translator failed (intent)", String(err));
      return "fail";
    }

    // Phase 1 relevance: proje bağlamı (spec/brief/audit/abandoned/patterns/git)
    // intent_en'e göre filtrelenip prompt'a enjekte edilir. Yeni iterasyonda
    // Claude TodoMaster'ın **mevcut özelliklerini** görür → "yeni uygulama mı?"
    // gibi bağlamsız sorular sormaz. Yeni proje (chunks=0) → sentinel.
    // Fail-safe: relevance call fail → engine emitError + boş array; injector
    // sentinel döner; faz çökmez.
    const projectContext = await buildRelevantProjectContext(
      this.config,
      this.state,
      intent_en,
    );

    // v15.7 (2026-05-26): Konuşma bağlamı — son 3 user mesajı + opsiyonel
    // özet. Ana ajan kullanıcı niyetini tek "USER_INTENT" değil tüm konuşma
    // akışıyla görür. Cache'li (process-local), fail-safe.
    let convSection = "";
    try {
      const conv = await buildConversationContext(this.config, this.state, { recentLanguage: "en" });
      convSection = renderConversationSection(conv, { forMainAgent: true });
    } catch (err) {
      log.warn("phase-1", "conversation context fetch failed", err);
    }

    // v15.7 (2026-05-27): Kodbase snapshot — Phase 1 ana ajan Read/Grep'siz
    // çalıştığı için kodbase yapısını göremiyor → "frontend mi backend mi
    // eksik?" gibi yanıtı zaten kodda olan sorular soruyor. Deterministik
    // snapshot (top-level dirs, src tree, deps, routes) prompt'a enjekte
    // edilir; ana ajan WHAT-user-wants sorgusuna odaklanır.
    const codebaseSnapshot = await buildCodebaseSnapshot(this.state.project_root);

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      systemPrompt = substitute(tmpl, {
        USER_INTENT: intent_en,
        PROJECT_CONTEXT_DIGEST: projectContext,
        CONVERSATION_CONTEXT: convSection,
        CODEBASE_SNAPSHOT: codebaseSnapshot,
      });
    } catch (err) {
      log.error("phase-1", "template load failed", err);
      emitError("template load failed", String(err));
      return "fail";
    }
    // Escalation (Ümit 2026-06-11): model+efor merdivenden (escalation_rung set ise); değilse eski config[role].
    const escMe = escalatedModelEffort(this.state, this.config, "intent");
    this.base = createQaAskqBackend({
      tag: "phase-1",
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: escMe.modelId,
      effortOverride: escMe.effort,
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 1 intent clarification now.",
      tools: [TOOL_ASK_CLARIFYING, TOOL_APPROVE_INTENT],
      askq: this.spec.askq_config,
    });

    const outcome = await this.base.run();

    if (outcome.kind === "approved") {
      const summary = String(outcome.approvalInput.summary ?? "");
      this.approvedSummary = summary || null;
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-intent-approve",
        caller: "user",
        detail: summary.slice(0, 200),
      });
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-complete",
        caller: "mycl-orchestrator",
      });
      log.info("phase-1", "approved");
      return "complete";
    }
    if (outcome.kind === "cancelled") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-intent-cancel",
        caller: "user",
      });
      log.info("phase-1", "user cancelled");
      this.lastFailReason = "user cancelled";
      return "fail";
    }
    if (outcome.kind === "aborted") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-aborted",
        caller: "user",
      });
      log.info("phase-1", "aborted");
      this.lastFailReason = "aborted";
      return "fail";
    }
    if (outcome.kind === "abandoned") {
      // Phase 1 abandon_tool_name set etmediği için bu kola düşmemeli;
      // defensive log + fail (silent ignore yok — Ümit kuralı).
      log.warn("phase-1", "unexpected abandoned outcome");
      this.lastFailReason = "unexpected abandoned outcome";
      return "fail";
    }
    if (outcome.kind === "ui_tweak") {
      // Phase 1 tweak_tool_name set etmediği için bu kola düşmemeli; defensive.
      log.warn("phase-1", "unexpected ui_tweak outcome");
      this.lastFailReason = "unexpected ui_tweak outcome";
      return "fail";
    }
    if (outcome.kind === "ac_failure") {
      // Phase 1 failure_tool_name set etmediği için bu kola düşmemeli; defensive.
      log.warn("phase-1", "unexpected ac_failure outcome");
      this.lastFailReason = "unexpected ac_failure outcome";
      return "fail";
    }
    log.warn("phase-1", "failed", { reason: outcome.reason });
    this.lastFailReason = outcome.reason;
    return "fail";
  }
}
