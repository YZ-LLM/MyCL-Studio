// phase-4 — Engineering Spec Writing (production-schema).
//
// Faz-spesifik mantık: state.intent_summary kontrolü, template'e enjekte,
// production-schema base controller'ı çalıştır. Spec.md base tarafında yazılır;
// approve geldiğinde state.spec_approved + spec_hash patch'i yapılır.

import { readFile } from "node:fs/promises";
import { appendAudit, appendDecision } from "./audit.js";
import type { ProductionBackend } from "./base/production-schema-controller.js";
import { createProductionSchemaBackend } from "./base/production-schema-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { emitChatMessage, emitError } from "./ipc.js";
import { log } from "./logger.js";
import { translate } from "./translator.js";
import { escalatedModelEffort } from "./escalation.js";
import { modelChoiceLineIfChanged } from "./model-catalog.js";
import { blindspotLensDecision, specIsConsequential } from "./pre-commit-lens-gate.js";
import { withDevsPath } from "./devs-paths.js";
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
        description:
          "3-7 testable conditions, AC1..ACn ids. PREFER behavioral (Given/When/Then) " +
          "shape for each: fill given/when/then with the precondition, the action/event, and the " +
          "OBSERVABLE outcome to assert. This makes WHAT to test explicit (BDD-as-spec; the test " +
          "asserts the 'then'). For a trivial binary check, statement alone is fine (given/when/then optional).",
        items: {
          type: "object",
          required: ["id", "statement"],
          properties: {
            id: { type: "string", description: "AC1, AC2, ..." },
            statement: { type: "string", description: "One-line human-readable summary of the criterion." },
            given: { type: "string", description: "Optional (BDD): the precondition / starting state." },
            when: { type: "string", description: "Optional (BDD): the action or event that occurs." },
            then: { type: "string", description: "Optional (BDD): the OBSERVABLE outcome the test must assert." },
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
  acceptance_criteria: Array<{
    id: string;
    statement: string;
    /** Birim 3 (BDD-as-spec): opsiyonel davranış şekli. Boşsa düz statement (geri-uyumlu). */
    given?: string;
    when?: string;
    then?: string;
  }>;
  out_of_scope: string[];
  risks: Array<{ title: string; detail: string }>;
  /** #1 (varsayım görünürlüğü): kullanıcının açıkça demediği ama spec'in dayandığı varsayımlar. Opsiyonel. */
  assumptions?: Array<{ assumption: string; why: string }>;
}

export function specToMarkdown(spec: SpecData): string {
  // Birim 3 (BDD-as-spec): given/when/then VARSA girintili alt-bullet olarak render edilir
  // (davranışı + assert edilecek "then"i görünür kılar). Alt-bullet'lar `**ACn**:` desenine
  // UYMAZ → parseAcIds/parseAcTexts/countAcceptanceCriteria onları AC saymaz (geri-uyumlu).
  // GWT değerini tek-satıra indir + placeholder/boş ele. KRİTİK (düşman-gözü K3-c): newline
  // bırakırsak 2.+ satırlar sütun-0'a düşer → kozmetik bozulma + metin `- **ACn**:` içerirse
  // parseAcIds FANTOM AC üretir (countAC şişer → yanlış-fail). K1: cli-skeleton "..."
  // placeholder'ını da ele (zayıf CLI ajanı literal kopyalarsa gürültü sızmasın).
  const cleanGwt = (s?: string): string | null => {
    if (!s) return null;
    const t = s.trim().replace(/\s*\n\s*/g, " ");
    return t === "" || t === "..." ? null : t;
  };
  const ac = spec.acceptance_criteria
    .map((a) => {
      let line = `- **${a.id}**: ${a.statement}`;
      const gwt: string[] = [];
      const g = cleanGwt(a.given);
      const w = cleanGwt(a.when);
      const th = cleanGwt(a.then);
      if (g) gwt.push(`  - _Given:_ ${g}`);
      if (w) gwt.push(`  - _When:_ ${w}`);
      if (th) gwt.push(`  - _Then:_ ${th}`);
      if (gwt.length > 0) line += "\n" + gwt.join("\n");
      return line;
    })
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
      emitError("Niyet özeti eksik — önce Faz 1 tamamlanmalı", null);
      this.lastFailReason = "intent_summary missing (Phase 1 incomplete)";
      return "fail";
    }
    if (!this.spec.production_config) {
      log.error("phase-4", "production_config missing");
      emitError("Faz 4 üretim yapılandırması eksik", null);
      this.lastFailReason = "production_config missing in spec";
      return "fail";
    }

    // Brief.md artık doğrudan okunmuyor — relevance engine ile section bazlı
    // filter ediliyor. Boş veya alakasız brief durumunda sentinel string;
    // Phase 3 skip edildiyse "(no relevant brief sections found)" döner.
    let systemPrompt: string;
    try {
      // YZLLM 2026-06-12 (sıfır-risk perf): brief + template + conversation-context BAĞIMSIZ salt-okunur (ikisi LLM)
      // → paralel. Hiçbiri diğerinin sonucunu kullanmaz, yazma yok. readFile throw ederse Promise.all reddeder → try yakalar.
      const [tmpl, engineeringBrief, convSection] = await Promise.all([
        readFile(this.spec.prompt_template_path!, "utf-8"),
        buildRelevantEngineeringBrief(this.config, this.state, this.state.intent_summary),
        buildConversationContext(this.config, this.state, { recentLanguage: "en" })
          .then((c) => renderConversationSection(c, { forMainAgent: true }))
          .catch((e) => {
            log.warn("phase-4", "konuşma-bağlamı kurulamadı — prompt bölümü boş (degraded)", { error: String(e) });
            return "";
          }),
      ]);
      systemPrompt = substitute(tmpl, {
        INTENT_SUMMARY: this.state.intent_summary,
        ENGINEERING_BRIEF: engineeringBrief,
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-4", "template load failed", err);
      emitError("Şablon yüklenemedi", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    // YZLLM 2026-06-16: HER SPEC KENDİNE ÖZEL. Eski "INCREMENTAL/merge" modu (v15.9
    // "spec biriktirilsin") KALDIRILDI — alakasız önceki işin spec'ini (scope/AC/risk)
    // diriltip yeni işe taşıyordu (canlı kanıt: survey işi eski user-list "UNIT A"yı
    // merge etti → 7 AC/2 alakasız birim → Faz 8 boğuldu → yanlış-pozitif gate fail).
    // Spec yalnız BU iterasyonun niyetini kapsar; eski spec.md ARTIK merge edilmez.
    // (Çakışma kontrolü Faz 2'de EXISTING_SPEC_DIGEST ile ZATEN ayrıca yapılıyor.)
    const initialUserMessage =
      "Begin Phase 4: write the engineering spec for THIS iteration's intent ONLY. " +
      "Cover only the current task; do NOT carry forward or merge scope, acceptance criteria, " +
      "or risks from any prior/existing spec — each spec is self-contained for its own task.";

    // Escalation (YZLLM 2026-06-11): spec model+eforu PER-DOMAIN merdivenden — bu domain'in öğrenilmiş basamağından
    // YZLLM 2026-06-16: merdiven kaldırıldı — model+efor iş-türüne göre (escalatedModelEffort, config kral).
    const me = escalatedModelEffort(this.state, this.config, "spec");
    const specModelLine = modelChoiceLineIfChanged("phase-4", `🧠 Spec: **${me.modelLabel}** · efor ${me.effort}`);
    if (specModelLine) emitChatMessage("system", specModelLine);
    this.base = createProductionSchemaBackend({
      tag: "phase-4",
      phaseId: 4,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: me.modelId,
      effortOverride: me.effort,
      apiKey: this.config.api_keys.main,
      initialUserMessage,
      tools: [TOOL_WRITE_SPEC, TOOL_REQUEST_APPROVAL],
      // Faz 2 (devs/ yapısı, YZLLM 2026-06-16): spec'i kök .mycl/spec.md yerine
      // devs/_pending/<ts>/iter-spec.md'ye yaz (her iterasyon kendi spec'i). withDevsPath
      // TEK choke-point → ikiz yazıcılar (SDK+CLI) paritesi yapısal garanti.
      production: withDevsPath(this.spec.production_config, this.state),
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
          const enLines = specInput.assumptions
            .map((a) => `• ${a.assumption} — ${a.why}`)
            .join("\n");
          // DİL HATTI: varsayımlar spec'ten gelir → İngilizce. Kullanıcı İngilizce bilmez → translator ile
          // Türkçeye çevir (anlam kaybı olmadan). Çeviri başarısızsa İngilizce göster (bloklamaz).
          let lines = enLines;
          try {
            lines = (await translate(this.config, enLines, "en-to-tr")).text;
          } catch (e) {
            log.warn("phase-4", "varsayım çevirisi başarısız — İngilizce gösterilecek", e);
          }
          emitChatMessage(
            "system",
            `🔍 Spec yazarken şu varsayımları yaptım (sen açıkça belirtmedin). Yanlış olan varsa söyle, düzeltirim:\n${lines}`,
          );
        }
        const dec = blindspotLensDecision({
          lensFlag: this.config.claude_code_flags.blindspot_lens ?? "consequential",
          // YZLLM 2026-06-16 (perf): spec'i "daima consequential" yerine içeriğe göre değerlendir —
          // önemsiz spec'lerde (≤3 AC + risk imzası yok) merceği atla, riskli/karmaşık spec'lerde koş.
          isConsequential: specIsConsequential(specInput),
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
        // ADR karar-kaydı (sessiz-fallback denetimi): spec başlık/kapsam/risk → müfettiş/orkestratör
        // trajectory'sini besler. Sessiz log.warn → bağlam-kaybı (tekrarlayan = disk/izin). log.error + görünür.
        log.error("phase-4", "spec karar-kaydı (ADR) yazılamadı — orkestratör belleği eksik kalabilir", err);
        emitChatMessage("system", "⚠️ Faz 4: spec karar kaydı yazılamadı (disk/izin?) — orkestratör belleği eksik kalabilir.");
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
