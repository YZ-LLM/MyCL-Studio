// phase-2 — Precision Audit (qa-askq).
//
// Faz 1'in intent_summary'sini alır, 7 boyutta belirsizlikleri sorar ve
// enriched_summary üretir. enriched_summary state.intent_summary üzerine yazılır
// (Phase 3/4 bunu kullanır).

import { readFile } from "node:fs/promises";
import { appendAudit } from "./audit.js";
import type { QaAskqBackend } from "./base/qa-askq-controller.js";
import { createQaAskqBackend } from "./base/qa-askq-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage, emitError } from "./ipc.js";
import { log } from "./logger.js";
import {
  classifyProjectType,
  shouldSkipUiPhases,
} from "./project-type-classifier.js";
import {
  buildRelevantAbandonedDigest,
  buildRelevantSpecDigest,
} from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_ASK_CLARIFYING: ToolDef = {
  name: "ask_clarifying",
  description:
    "Ask the user a single clarifying question about one of the 7 precision dimensions.",
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
      suggested_answer: {
        type: "string",
        description:
          "OPTIONAL but RECOMMENDED — your best guess of the most likely answer for this user, based on intent_summary and project context. MUST EXACTLY MATCH one of the option labels (case-sensitive). Used to highlight a suggested choice in the UI.",
      },
    },
  },
};

const TOOL_ABANDON: ToolDef = {
  name: "abandon_iteration",
  description:
    "Call this when the user, after seeing compliance concerns, chose to abandon this iteration. Pass the concise reason + the listed concerns that drove the decision. After this, MyCL resets state to Phase 1 and persists the abandoned intent to disk.",
  input_schema: {
    type: "object",
    required: ["reason", "concerns"],
    properties: {
      reason: {
        type: "string",
        description: "One or two sentences explaining why the user abandoned.",
      },
      concerns: {
        type: "array",
        items: { type: "string" },
        description:
          "The compliance concerns surfaced during the COMPLIANCE pass that influenced the user's decision.",
      },
    },
  },
};

const TOOL_COMPLETE: ToolDef = {
  name: "complete_precision_audit",
  description:
    "After all 7 dimensions are addressed, submit the enriched intent summary and per-dimension decisions.",
  input_schema: {
    type: "object",
    required: ["enriched_summary", "dimensions"],
    properties: {
      enriched_summary: {
        type: "string",
        description: "4-6 sentence summary preserving user's literal choices.",
      },
      dimensions: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "decision"],
          properties: {
            name: {
              type: "string",
              description: "SCOPE / USERS / DATA / SUCCESS / EDGE / PERFORMANCE / SECURITY",
            },
            decision: {
              type: "string",
              description: "covered | defaulted | asked",
            },
            detail: { type: "string" },
          },
        },
      },
    },
  },
};

interface AuditDimension {
  name: string;
  decision: string;
  detail?: string;
}

export class Phase2Controller {
  private base: QaAskqBackend | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  public statePatch: Partial<State> = {};
  /**
   * Compliance check sonrası kullanıcı vazgeçerse Claude'un abandon_iteration
   * tool'una verdiği reason + concerns. Orchestrator bu alanı okuyup
   * abandoned-intents.jsonl'a + audit'e kalıcı kayıt yazar.
   */
  public abandonInput?: { reason: string; concerns: string[] };

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

  async run(): Promise<"complete" | "fail" | "abandoned"> {
    log.info("phase-2", "run start");

    if (!this.state.intent_summary) {
      emitError("phase-2: intent_summary missing — Phase 1 önce tamamlanmalı", null);
      this.lastFailReason = "intent_summary missing (Phase 1 incomplete)";
      return "fail";
    }
    if (!this.spec.askq_config) {
      emitError("phase-2 askq_config missing", null);
      this.lastFailReason = "askq_config missing in spec";
      return "fail";
    }

    // Compliance pass context'i — relevance engine ile mevcut intent'e
    // alakalı geçmiş bilgileri seçer. Eskiden hardcoded truncate (spec.md
    // ilk 1500 char + son 5 abandoned) idi; şimdi LLM-based scoring ile
    // yalnızca **bu istekle ilgili** section'lar ve abandoned entry'ler.
    //
    // Fail policy: relevance API fail → injector "(no relevant ... found)"
    // sentinel döner; faz çökmez. relevance-engine emitError + log.warn
    // yapar — hata GİZLENMEZ ama compliance pass context'siz devam eder.
    const existingSpecDigest = await buildRelevantSpecDigest(
      this.config,
      this.state,
      this.state.intent_summary,
    );
    const abandonedDigest = await buildRelevantAbandonedDigest(
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
        EXISTING_SPEC_DIGEST: existingSpecDigest,
        ABANDONED_INTENTS_DIGEST: abandonedDigest,
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-2", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    const role = this.spec.model_role!;
    this.base = createQaAskqBackend({
      tag: "phase-2",
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage:
        "Begin Phase 2 Precision Audit. Walk through the 8 dimensions; COMPLIANCE is last.",
      tools: [TOOL_ASK_CLARIFYING, TOOL_ABANDON, TOOL_COMPLETE],
      askq: this.spec.askq_config,
    });

    const outcome = await this.base.run();

    if (outcome.kind === "abandoned") {
      // Yan etkileri (kalıcı kayıt + state reset) orchestrator yapar — tek
      // sorumluluk: kontrolör sadece sonucu raporlar.
      const reason = String(outcome.abandonInput.reason ?? "");
      const concernsRaw = outcome.abandonInput.concerns;
      const concerns = Array.isArray(concernsRaw)
        ? concernsRaw.map((c) => String(c))
        : [];
      this.abandonInput = { reason, concerns };
      log.info("phase-2", "abandoned by user", {
        concerns_count: concerns.length,
        reason_len: reason.length,
      });
      return "abandoned";
    }

    if (outcome.kind !== "approved") {
      log.warn("phase-2", "did not complete", { kind: outcome.kind });
      this.lastFailReason =
        outcome.kind === "failed"
          ? outcome.reason
          : `outcome kind=${outcome.kind}`;
      return "fail";
    }

    const enriched = String(outcome.approvalInput.enriched_summary ?? "");
    // v15.10: `?? []` yalnız null/undefined'ı yakalar; ajan (CLI text-JSON)
    // `dimensions`'ı non-array (obje/string) emit ederse for...of çöker
    // (TypeError: dimensions is not iterable). Array.isArray ile katı guard —
    // malformed dimensions audit detayını düşürür ama pipeline'ı bozmaz.
    const rawDims = outcome.approvalInput.dimensions;
    const dimensions = (Array.isArray(rawDims) ? rawDims : []) as AuditDimension[];
    if (rawDims !== undefined && !Array.isArray(rawDims)) {
      log.warn("phase-2", "dimensions array değil — boş kabul edildi (audit detayı düştü)", {
        type: typeof rawDims,
      });
    }
    if (!enriched) {
      emitError("phase-2: enriched_summary missing in completion", null);
      this.lastFailReason = "enriched_summary missing";
      return "fail";
    }

    for (const d of dimensions) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 2,
        event: "precision-dimension",
        caller: "mycl-orchestrator",
        detail: `${d.name}=${d.decision}`,
      });
    }
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 2,
      event: "phase-2-precision-complete",
      caller: "user",
      detail: enriched.slice(0, 200),
    });
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 2,
      event: "phase-2-complete",
      caller: "mycl-orchestrator",
    });
    // v15.0 Batch D: project_type sınıflandırma. Haiku ile spec özetinden
    // tip türetilir; state'e yazılır. Faz 16/18 runner seçimi + Faz 5/7 skip
    // kararı buna bağlı. Confirm askq v15.1'e ertelendi — şimdilik auto +
    // chat'e bilgi mesajı; yanlış tespit edilirse kullanıcı sonraki fazlarda
    // fark edip sidebar üzerinden müdahale eder.
    const classification = await classifyProjectType(this.config, enriched);
    const projectType = classification.project_type;
    const hasDatabase = classification.has_database;
    const skipUi = shouldSkipUiPhases(projectType);
    // QC C: "unknown" durumunda kullanıcı sessiz miscategorization fark
    // etmesin — net uyarı mesajı. Diğer tipler için tespit + skip kararı bildir.
    if (projectType === "unknown") {
      emitChatMessage(
        "system",
        `⚠️ Proje tipi otomatik belirlenemedi. UI fazları varsayılan olarak çalıştırılacak. ` +
          `Yanlışsa Phase 5 öncesi mesaj yazarak yönlendirme yapabilirsin (v15.1'de ayarlardan override gelecek).`,
      );
    } else {
      const dbNote =
        hasDatabase === false
          ? " Veritabanı yok — Faz 7 atlanacak."
          : hasDatabase === true
            ? " Veritabanı var — Faz 7 çalışacak."
            : "";
      emitChatMessage(
        "system",
        `🧭 Proje tipi: **${PROJECT_TYPE_TR[projectType]}** (${projectType}). ` +
          (skipUi
            ? `UI fazları (6/7) atlanacak.`
            : `UI fazları çalıştırılacak.`) +
          dbNote,
      );
    }
    log.info("phase-2", "project_type classified", {
      project_type: projectType,
      skip_ui_phases: skipUi,
      has_database: hasDatabase,
    });

    this.statePatch = {
      intent_summary: enriched,
      project_type: projectType,
      skip_ui_phases: skipUi,
      ...(hasDatabase !== undefined ? { has_database: hasDatabase } : {}),
    };
    log.info("phase-2", "complete", {
      enriched_len: enriched.length,
      dim_count: dimensions.length,
      project_type: projectType,
      has_database: hasDatabase,
    });
    return "complete";
  }
}

/** Türkçe etiketler — kullanıcıya gösterilen chat mesajları için. */
const PROJECT_TYPE_TR: Record<string, string> = {
  web: "Web Uygulaması",
  api: "REST/GraphQL Servisi",
  cli: "Komut Satırı Aracı",
  library: "Kütüphane / SDK",
  mobile: "Mobil Uygulama",
  desktop: "Masaüstü Uygulaması",
  ml: "ML Modeli / Pipeline",
  game: "Oyun",
  unknown: "Belirsiz",
};
