// orchestrator-agent/decision — AgentDecision tipi + parser.
//
// Agent `decide_action` tool'unu çağırarak son kararını verir. Bu modül
// tool input JSON'ını AgentDecision'a dönüştürür, validation yapar.

import type { PhaseId } from "../types.js";

export type AgentAction =
  /** Sadece chat mesajı — hiç phase tetikleme. */
  | "chat"
  /** Tek açıklayıcı soru sor (askq). */
  | "ask_clarify"
  /** Belirli phase'i tetikle (target_phase ile). */
  | "run_phase"
  /** Phase 6 → 7 onayı. */
  | "approve_ui"
  /** Phase 6 → pending_ui_tweak + Phase 5. */
  | "revise_ui"
  /** Pipeline'ı durdur. */
  | "cancel_pipeline"
  /** Mevcut current_phase'ten devam. */
  | "resume_pipeline"
  /** Phase 0 standalone debug triage. */
  | "debug_triage"
  /** Yeni iş (Phase 1 → fresh veya iteration_count+1). */
  | "develop_new_or_iter"
  /** v15.6: 2. confirmation tetiklendi — hafızaya kayıt öner. */
  | "save_memory_proposal"
  /** v15.7 (2026-05-26): Opsiyonel faz scope'unu set et. Faz 1 sonrası
   *  intent_summary'den UI/DB/TDD/Risk ihtiyacını çıkarınca agent bu action ile
   *  state.needed_phases'i günceller ve pipeline opsiyonel scope'u uygular. */
  | "set_optional_phases"
  /** v15.7 (2026-05-26): Kapı bekçisi — askq açıkken kullanıcı composer'dan
   *  yazdı, mesaj askq'ya uygun cevap. Orkestratör programatik olarak
   *  submitAskqAnswer çağırır; ana ajan askq cevabı gelmiş gibi devam eder. */
  | "answer_askq"
  /** v15.8 (2026-05-30): Spesifik bir özelliği GERÇEKTEN test et — ana ajan
   *  o özellik için hedefli bir Playwright E2E testi yazar + çalıştırır + dürüst
   *  rapor verir. "X özelliğini test et" gibi spesifik istekler için (genel
   *  "tüm testleri çalıştır" değil — o run_phase 16). target_feature taşır. */
  | "verify_feature"
  /** Agent emin değil → klasik Haiku classifier devreye girer. */
  | "fallback_to_classifier";

/**
 * v15.6: Hafıza kayıt teklifi payload'u. save_memory_proposal action'ında
 * doldurulur — orchestrator user'a askq açıp seçimine göre disk'e yazar.
 */
export interface MemoryProposal {
  /** Agent'ın önerdiği tip — user farklı seçebilir. */
  type_suggestion: "project" | "general" | "both";
  /** 1-3 cümle TR özet. */
  summary: string;
  affected_files?: string[];
  affected_db_tables?: string[];
  affected_algorithms?: string[];
  change_description?: string;
  /**
   * v15.7 (2026-05-26): Cross-project leak koruması — general/both kayıtlarda
   * zorunlu. "universal" = tüm projelerde uygulanır (örn. davranış tercihi);
   * "stack-specific" = sadece aynı stack projelerinde (orkestratör default
   * "stack-specific" önersin — leak riski minimum).
   */
  scope?: "universal" | "stack-specific";
}

export interface AgentDecision {
  action: AgentAction;
  /** Türkçe 1-2 cümle gerekçe — kullanıcıya gösterilebilir. */
  reason: string;
  /** Adım adım muhakeme (Düşünceler panelinde gösterilir). reason=kısa gerekçe, thinking=süreç. */
  thinking?: string;
  /** Sadece action="run_phase" için: hedef faz. */
  target_phase?: PhaseId;
  /** Opsiyonel ek chat mesajı — chat/ask_clarify action'ları için kullanılır. */
  message_to_user?: string;
  /** v15.6: Agent-generated kategorize anahtarı (kebab-case). Aynı slug = aynı
   *  konu — 2. confirmation detection input'u. */
  topic_slug?: string;
  /** v15.6: save_memory_proposal action'ında doldurulan kayıt teklifi. */
  memory_proposal?: MemoryProposal;
  /** v15.7 (2026-05-26): set_optional_phases için opsiyonel faz scope'u.
   *  Sadece {5,6,7,8,9} alt kümesi geçerli; zorunlu fazlar (1,2,3,4,10-17)
   *  her zaman çalışır, listede olmaları gerekmez. */
  optional_phases_to_run?: PhaseId[];
  /** v15.7 (2026-05-26): answer_askq için askq'ya verilecek cevap. Aktif
   *  askq'nın TR option label'larından biri (EXACT match) veya freeform text. */
  askq_answer?: string;
  /** v15.8 (2026-05-30): verify_feature için test edilecek özelliğin Türkçe
   *  ifadesi (örn. "anket oluşturma sayfası"). Handler bunu EN'e çevirip ana
   *  ajana hedefli E2E testi yazdırır. */
  target_feature?: string;
  /** Doğru-karar/proaktif-risk (2026-06-04): action="ask_clarify" için SOMUT
   *  seçenekler. Risk/belirsizlikte jenerik Evet/Hayır yerine ajan gerçek
   *  alternatifleri sunar (örn. ["JWT kullan","session-cookie kullan"]). Boş/yok
   *  → handler eski Evet/Hayır/Vazgeç davranışına düşer. Cevap akışı değişmez
   *  (agent_clarify_ → handleAskqAnswer → seçilen metin handleUserMessage'e). */
  clarify_options?: string[];
}

const VALID_ACTIONS: ReadonlySet<AgentAction> = new Set<AgentAction>([
  "chat",
  "ask_clarify",
  "run_phase",
  "approve_ui",
  "revise_ui",
  "cancel_pipeline",
  "resume_pipeline",
  "debug_triage",
  "develop_new_or_iter",
  "save_memory_proposal",
  "set_optional_phases",
  "answer_askq",
  "verify_feature",
  "fallback_to_classifier",
]);

const VALID_OPTIONAL_PHASE_IDS: ReadonlySet<number> = new Set([5, 6, 7, 8, 9]);

const VALID_PHASE_IDS: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
]);

export class AgentDecisionError extends Error {
  override readonly name = "AgentDecisionError";
}

/**
 * `decide_action` tool input'unu parse + validate. Tool schema strict,
 * Anthropic SDK genelde doğru JSON üretir; yine de runtime guard.
 */
export function parseAgentDecision(input: unknown): AgentDecision {
  if (typeof input !== "object" || input === null) {
    throw new AgentDecisionError("decide_action input not an object");
  }
  const obj = input as Record<string, unknown>;

  const action = obj.action;
  if (typeof action !== "string" || !VALID_ACTIONS.has(action as AgentAction)) {
    throw new AgentDecisionError(`invalid action: ${String(action)}`);
  }

  const reason = obj.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new AgentDecisionError("reason missing or empty");
  }

  const decision: AgentDecision = {
    action: action as AgentAction,
    reason,
  };
  // Düşünme süreci (opsiyonel) — Düşünceler panelinde gösterilir.
  if (typeof obj.thinking === "string" && obj.thinking.length > 0) {
    decision.thinking = obj.thinking;
  }

  // run_phase için target_phase zorunlu
  if (decision.action === "run_phase") {
    const tp = obj.target_phase;
    if (typeof tp !== "number" || !VALID_PHASE_IDS.has(tp)) {
      throw new AgentDecisionError(
        `run_phase requires valid target_phase (0-17), got: ${String(tp)}`,
      );
    }
    decision.target_phase = tp as PhaseId;
  }

  // message_to_user opsiyonel
  if (typeof obj.message_to_user === "string" && obj.message_to_user.length > 0) {
    decision.message_to_user = obj.message_to_user;
  }

  // v15.6: topic_slug opsiyonel — agent her decision'da kategorize üretmeli
  // ama eski test/decision'lar için undefined OK.
  if (typeof obj.topic_slug === "string" && obj.topic_slug.length > 0) {
    decision.topic_slug = obj.topic_slug;
  }

  // v15.6: memory_proposal sadece save_memory_proposal action'ında zorunlu
  if (decision.action === "save_memory_proposal") {
    const mp = obj.memory_proposal as Record<string, unknown> | undefined;
    if (!mp || typeof mp !== "object") {
      throw new AgentDecisionError(
        "save_memory_proposal requires memory_proposal payload",
      );
    }
    const typeSugg = mp.type_suggestion;
    if (typeSugg !== "project" && typeSugg !== "general" && typeSugg !== "both") {
      throw new AgentDecisionError(
        `memory_proposal.type_suggestion invalid: ${String(typeSugg)}`,
      );
    }
    const summary = typeof mp.summary === "string" ? mp.summary : "";
    if (!summary) {
      throw new AgentDecisionError("memory_proposal.summary missing");
    }
    // v15.7 (2026-05-26): scope alanı general/both için validate edilir.
    // "universal" | "stack-specific" dışı değer veya project-only kayıtta
    // belirtildiyse sessizce ignore (defansif — orchestrator project tipi
    // için scope vermesi gerek değil).
    let scope: "universal" | "stack-specific" | undefined;
    if (mp.scope === "universal" || mp.scope === "stack-specific") {
      scope = mp.scope;
    } else if (
      (typeSugg === "general" || typeSugg === "both") &&
      mp.scope !== undefined
    ) {
      throw new AgentDecisionError(
        `memory_proposal.scope must be "universal" or "stack-specific" for general/both, got: ${String(mp.scope)}`,
      );
    }
    decision.memory_proposal = {
      type_suggestion: typeSugg,
      summary,
      ...(Array.isArray(mp.affected_files)
        ? { affected_files: mp.affected_files.map(String) }
        : {}),
      ...(Array.isArray(mp.affected_db_tables)
        ? { affected_db_tables: mp.affected_db_tables.map(String) }
        : {}),
      ...(Array.isArray(mp.affected_algorithms)
        ? { affected_algorithms: mp.affected_algorithms.map(String) }
        : {}),
      ...(typeof mp.change_description === "string"
        ? { change_description: mp.change_description }
        : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
  } else if (typeof obj.memory_proposal === "object" && obj.memory_proposal !== null) {
    // Diğer action'larda memory_proposal var ise sessizce ignore — agent
    // yanlışlıkla göndermiş.
  }

  // v15.7 (2026-05-26): answer_askq için askq_answer zorunlu (non-empty string).
  if (decision.action === "answer_askq") {
    const ans = obj.askq_answer;
    if (typeof ans !== "string" || ans.trim().length === 0) {
      throw new AgentDecisionError(
        "answer_askq requires non-empty askq_answer string",
      );
    }
    decision.askq_answer = ans.trim();
  }

  // v15.7 (2026-05-26): set_optional_phases için optional_phases_to_run zorunlu.
  // Değerler {5,6,7,8,9} alt kümesinde olmalı; geçersiz değer hata fırlatır.
  if (decision.action === "set_optional_phases") {
    const raw = obj.optional_phases_to_run;
    if (!Array.isArray(raw)) {
      throw new AgentDecisionError(
        "set_optional_phases requires optional_phases_to_run array",
      );
    }
    const validated: PhaseId[] = [];
    for (const v of raw) {
      if (typeof v !== "number" || !VALID_OPTIONAL_PHASE_IDS.has(v)) {
        throw new AgentDecisionError(
          `optional_phases_to_run: invalid phase ${String(v)} (allowed: 5,6,7,8,9)`,
        );
      }
      const pid = v as PhaseId;
      if (!validated.includes(pid)) validated.push(pid);
    }
    decision.optional_phases_to_run = validated.sort((a, b) => a - b);
  }

  // v15.8 (2026-05-30): verify_feature için target_feature zorunlu (non-empty).
  if (decision.action === "verify_feature") {
    const tf = obj.target_feature;
    if (typeof tf !== "string" || tf.trim().length === 0) {
      throw new AgentDecisionError(
        "verify_feature requires non-empty target_feature (test edilecek özellik)",
      );
    }
    decision.target_feature = tf.trim();
  }

  // Doğru-karar/proaktif-risk (2026-06-04): ask_clarify için opsiyonel somut
  // seçenekler (risk/belirsizlikte zengin askq). trim + boş eleme + dedup; cap 6
  // (askq aşırı kalabalık olmasın). Diğer action'larda verilmişse sessizce ignore.
  if (decision.action === "ask_clarify" && Array.isArray(obj.clarify_options)) {
    const seen = new Set<string>();
    const opts: string[] = [];
    for (const o of obj.clarify_options) {
      const t = typeof o === "string" ? o.trim() : "";
      if (t === "" || seen.has(t)) continue;
      seen.add(t);
      opts.push(t);
      if (opts.length >= 6) break;
    }
    if (opts.length > 0) decision.clarify_options = opts;
  }

  return decision;
}

/**
 * `decide_action` tool JSON Schema — Anthropic SDK'ya verilir. Strict schema
 * sayesinde model'in hatalı output verme ihtimali minimize edilir.
 */
export const DECIDE_ACTION_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    thinking: {
      type: "string",
      description:
        "ÖNCE düşün, sonra karar ver. Bu kararı verirken ADIM ADIM muhakemen (Türkçe): hangi sinyalleri gördün " +
        "(state, önceki iş, kullanıcı niyeti), hangi seçenekleri tarttın, neden bu action'a vardın? 'reason' kısa " +
        "gerekçedir; 'thinking' düşünme SÜRECİDİR. Kullanıcı bunu 'Düşünceler' panelinde görür → her zaman DOLDUR.",
    },
    action: {
      type: "string",
      enum: Array.from(VALID_ACTIONS),
      description:
        "Sonraki aksiyon. chat=sadece sohbet, ask_clarify=tek soru, run_phase=belirli faz tetikle, approve_ui=Phase 6 onay, revise_ui=Phase 6 değişiklik, cancel_pipeline=durdur, resume_pipeline=devam, debug_triage=Phase 0 bug, develop_new_or_iter=Phase 1 yeni iş, set_optional_phases=opsiyonel faz scope'u set et (Faz 1 sonrası), answer_askq=aktif askq'ya programatik cevap (kullanıcı composer'dan askq'ya cevap yazdı), verify_feature=SPESİFİK bir özelliği gerçekten test et (o özellik için hedefli E2E testi yaz+çalıştır; 'X özelliğini test et' istekleri — genel 'tüm testleri çalıştır' DEĞİL, o run_phase 16), fallback_to_classifier=klasik Haiku classifier'a bırak.",
    },
    reason: {
      type: "string",
      description:
        "Türkçe 1-2 cümle gerekçe. Kullanıcıya gösterilebilir (örn. 'Phase 6 onayı — onayla = approve_ui').",
    },
    target_phase: {
      type: "number",
      enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      description:
        "Sadece action='run_phase' için: hedef faz ID'si. Diğer action'larda VERME.",
    },
    message_to_user: {
      type: "string",
      description:
        "Opsiyonel ek chat mesajı. action='chat' veya 'ask_clarify' için tipik kullanım.",
    },
    topic_slug: {
      type: "string",
      description:
        "v15.6 — Kategorize anahtarı (kebab-case, örn. 'user-auth'). Aynı slug = aynı konu. 2. confirmation detection için kullanılır. Mevcut RELEVANT MEMORY listesinde benzer slug varsa ONA UY.",
    },
    memory_proposal: {
      type: "object",
      description:
        "Sadece action='save_memory_proposal' için ZORUNLU. Hafıza kayıt teklifi: tip önerisi + özet + etkilenen dosya/tablo/algoritma + değişiklik açıklaması.",
      properties: {
        type_suggestion: {
          type: "string",
          enum: ["project", "general", "both"],
          description:
            "'project' = sadece bu projeye özel, 'general' = başka projelerde de pattern, 'both' = genelde her ikisi.",
        },
        summary: { type: "string", description: "1-3 cümle TR özet." },
        affected_files: { type: "array", items: { type: "string" } },
        affected_db_tables: { type: "array", items: { type: "string" } },
        affected_algorithms: { type: "array", items: { type: "string" } },
        change_description: { type: "string", description: "TR değişiklik özeti." },
        scope: {
          type: "string",
          enum: ["universal", "stack-specific"],
          description:
            "v15.7 — general/both için ZORUNLU. 'universal' = tüm projelerde uygula (örn. 'kullanıcı kısa cevap ister' gibi davranış tercihi). 'stack-specific' = sadece aynı stack projelerinde uygula (örn. 'bu projede Postgres tercih edildi' — başka stack'te yanlış olabilir). DEFAULT 'stack-specific' — leak riski minimum. Sadece kayıt gerçekten stack-bağımsız bir davranış kuralıysa 'universal' seç.",
        },
      },
      required: ["type_suggestion", "summary"],
    },
    optional_phases_to_run: {
      type: "array",
      description:
        "v15.7 — Sadece action='set_optional_phases' için ZORUNLU. Hangi opsiyonel fazların pipeline'da çalışacağı. Sadece {5,6,7,8,9} alt kümesi geçerli. Boş array [] = hiç opsiyonel faz yok (sadece zorunlu fazlar). Zorunlu fazlar (1,2,3,4,10-17) listede OLMAMALI — onlar her zaman çalışır.",
      items: { type: "number", enum: [5, 6, 7, 8, 9] },
      uniqueItems: true,
    },
    askq_answer: {
      type: "string",
      description:
        "v15.7 — Sadece action='answer_askq' için ZORUNLU. Askq açıkken kullanıcı composer'dan yazdı ve mesaj askq cevabı olarak yorumlandı. Bu alan aktif askq'nın TR option label'larından birine EXACT match olmalı (case-sensitive). Eğer hiçbir option'a uymuyorsa askq freeform 'Cevap yaz' input olarak iletilecek text yaz.",
    },
    target_feature: {
      type: "string",
      description:
        "v15.8 — Sadece action='verify_feature' için ZORUNLU. Test edilecek özelliğin kullanıcının dilindeki (Türkçe) ifadesi, örn. 'anket oluşturma sayfası', 'kullanıcı girişi'. Handler bunu İngilizceye çevirip ana ajana o özellik için hedefli E2E testi yazdırır.",
    },
    clarify_options: {
      type: "array",
      items: { type: "string" },
      description:
        "OPSİYONEL, sadece action='ask_clarify' için. Risk/belirsizlikte kullanıcıya SOMUT seçenekler sun (Türkçe, 2-4 madde) — jenerik Evet/Hayır yerine gerçek alternatifler, örn. ['JWT ile token-tabanlı auth','session-cookie tabanlı auth']. Önerini reason'da belirt. VERME → handler Evet/Hayır/Vazgeç'e düşer. Her küçük şeyde değil; yalnız gerçekten kararsız / geri-dönülemez / geçerli-seçenekler-arası-tercih durumunda kullan.",
    },
  },
  required: ["action", "reason"],
} as const;
