// agent-acl — Merkezi ajan-tool ACL registry (v15.7, 2026-05-26).
//
// MyCL'de 3 ajan ailesi var:
//   1. Orchestrator agent — kullanıcı ile sohbet, faz tetikler, kapı bekçisi
//   2. Translator agent — TR↔EN çeviri, stateless, tool YOK
//   3. Main agents (phase controller'ları) — codegen / production / qa-askq
//
// Her ajanın hangi tool'ları kullanabileceği bu dosyada **tek kaynaktan**
// tanımlı. Yeni ajan eklerken veya tool izinleri değiştirirken sadece bu
// dosyaya bakılır. Phase controller'ları kendi tool listelerini hâlâ kendileri
// inşa eder (her tool definition'ı kendi modülünde) — bu registry **doğruluk
// referansı + audit**, runtime'da hard enforcement değil.
//
// Cross-check için `test/agent-acl.test.ts` (eklenecek) registry'deki her tool
// adının gerçekten o ajanın kullandığı listesinde olduğunu doğrular.

/**
 * Tüm ajan kimlikleri — production readiness madde 01.
 * agent_id audit'te `caller` alanına eşlenmez (caller "mycl-orchestrator" / "user");
 * bu id sadece registry içinde "hangi ajan hangi tool'ları kullanır" sorusunun
 * cevabıdır. Future: log enrichment için audit'e _agent_id alanı eklenebilir.
 */
export type AgentId =
  | "orchestrator"
  | "translator"
  | "phase-0-d1" // Debug Triage investigation (Read/Grep/Bash + report_root_cause)
  // phase-0-d3 v15.7 (2026-05-26) KALDIRILDI — Phase 0 sadece teşhis.
  // Fix uygulama Faz 5 tweak mode'da yapılır (orkestratör tetikler).
  | "phase-1"
  | "phase-2"
  | "phase-3"
  | "phase-4"
  | "phase-5" // UI codegen
  | "phase-5-tweak" // UI tweak mode (smaller scope)
  | "phase-6" // UI review — DEFERRED, no LLM call
  | "phase-7" // DB schema
  | "phase-8" // TDD codegen
  | "phase-9"
  | "mechanical"; // Phase 10-17 — mechanical scans, no LLM

/** API key + model slot mapping (config.api_keys + config.selected_models). */
export type SlotName = "orchestrator" | "main" | "translator";

export interface AgentACL {
  agent_id: AgentId;
  /** İnsan-okunabilir kısa açıklama. */
  description: string;
  /** Bu ajanın çağırabileceği tool isimleri (allowlist). */
  allowed_tools: string[];
  /** Hangi API key + model slot'unu kullanır. "none" = LLM çağrısı yok. */
  api_key_slot: SlotName | "none";
  model_slot: SlotName | "none";
  /** Risk profili — production readiness madde 15. */
  risk_level: "low" | "medium" | "high";
  /** Faz boundary notu — production readiness madde 02 (faz disiplini). */
  scope_note?: string;
}

/**
 * Single source of truth — ajan tool izinleri.
 *
 * Tool kategorileri:
 *   READ_ONLY:    "Read", "Grep", "Glob"
 *   WRITE_CAPABLE: "Write", "Edit"
 *   EXEC:         "Bash" (path sandbox + bash-guard ile sınırlı)
 *   DECIDE:       "decide_action" (orchestrator-specific)
 *   DOMAIN:       phase-specific (write_brief, ask_clarifying, report_root_cause, ...)
 */
export const AGENT_ACL_REGISTRY: readonly AgentACL[] = [
  {
    agent_id: "orchestrator",
    description: "Kapı bekçisi — user mesajını yorumlar, faz tetikler.",
    allowed_tools: ["Read", "Grep", "Bash", "decide_action"],
    api_key_slot: "orchestrator",
    model_slot: "orchestrator",
    risk_level: "low", // read-only + safe-list Bash; karar verir, kod yazmaz
    scope_note: "Asla Write/Edit yapmaz. Karar verir, ana ajanı tetikler.",
  },
  {
    agent_id: "translator",
    description: "TR↔EN çeviri — stateless, tool yok.",
    allowed_tools: [],
    api_key_slot: "translator",
    model_slot: "translator",
    risk_level: "low",
    scope_note: "Tek-turn, tool yok. One-way prompt (translator.ts).",
  },
  {
    agent_id: "phase-0-d1",
    description: "Faz 0 Debug Triage — investigation (read-only + report).",
    allowed_tools: ["Read", "Grep", "Glob", "Bash", "report_root_cause"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "medium", // Bash exec, ama fix uygulamaz
    scope_note: "Sadece teşhis. Fix uygulamak phase-0-d3 işidir.",
  },
  {
    agent_id: "phase-1",
    description: "Niyet Toplama — askq döngüsü, kullanıcı onayı.",
    allowed_tools: ["ask_clarifying", "request_intent_approval"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "low", // read/write yok, sadece askq
    scope_note: "Read/Write/Bash erişimi YOK. Sadece kullanıcıya soru sorar.",
  },
  {
    agent_id: "phase-2",
    description: "Hassasiyet Denetimi — 8-dimension audit.",
    allowed_tools: ["ask_clarifying", "abandon_iteration", "complete_precision_audit"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "low",
    scope_note: "Sadece askq. Abandon ile Faz 1'e dönebilir.",
  },
  {
    agent_id: "phase-3",
    description: "Mühendislik Brifingi — write_brief tool.",
    allowed_tools: ["write_brief", "request_brief_approval"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "medium", // brief.md dosyasına yazar
    scope_note: "Sadece brief.md yazar (orchestrator dosyaya kaydeder).",
  },
  {
    agent_id: "phase-4",
    description: "Spec Yazımı — write_spec tool.",
    allowed_tools: ["write_spec", "request_spec_approval"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "medium", // spec.md dosyasına yazar
    scope_note: "Sadece spec.md yazar. Kod yazmaz.",
  },
  {
    agent_id: "phase-5",
    description: "UI Yapımı — codegen, backend denied.",
    allowed_tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "high", // UI dosyalarını yazar, dev server başlatır
    scope_note: "Backend path'leri denied (spec.denied_paths). Sadece UI + build.",
  },
  {
    agent_id: "phase-5-tweak",
    description: "UI tweak mode — küçük değişiklik, dev server zaten ayakta.",
    allowed_tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "high",
    scope_note: "Aynı ACL ama scope minimal — tweakDesc'le sınırlı.",
  },
  {
    agent_id: "phase-6",
    description: "UI İnceleme — DEFERRED, kullanıcı browser'da inceler.",
    allowed_tools: [],
    api_key_slot: "none",
    model_slot: "none",
    risk_level: "low",
    scope_note: "LLM çağrısı YOK. Orkestratör user'a 'incele ve onayla' der.",
  },
  {
    agent_id: "phase-7",
    description: "Veritabanı Tasarımı — write_db_schema tool.",
    allowed_tools: ["write_db_schema", "request_db_approval"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "medium", // db-schema.md yazar
    scope_note: "Sadece schema design. Migration uygulamak Phase 8'in işi.",
  },
  {
    agent_id: "phase-8",
    description: "TDD Uygulama — test-first codegen.",
    allowed_tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "high",
    scope_note: "Full codegen + migration apply. AC-driven iteration.",
  },
  {
    agent_id: "phase-9",
    description: "Risk İncelemesi — askq döngüsü.",
    allowed_tools: ["ask_risk_decision", "complete_risk_review"],
    api_key_slot: "main",
    model_slot: "main",
    risk_level: "low",
    scope_note: "Sadece askq. Kod yazmaz.",
  },
  {
    agent_id: "mechanical",
    description: "Faz 10-17 mekanik taramalar — LLM yok.",
    allowed_tools: [],
    api_key_slot: "none",
    model_slot: "none",
    risk_level: "medium", // shell komutları çalıştırır (npm test, lint, vs.)
    scope_note: "Profile-driven shell commands. LLM yok, mekanik runner.",
  },
];

/** Quick lookup by id. */
export function getAgentACL(agentId: AgentId): AgentACL | undefined {
  return AGENT_ACL_REGISTRY.find((a) => a.agent_id === agentId);
}

/**
 * Verilen ajan toolName'i çağırabilir mi? Allowlist check.
 * Defansif: bilinmeyen agent_id → false. Bilinmeyen tool name → false.
 */
export function isToolAllowed(agentId: AgentId, toolName: string): boolean {
  const acl = getAgentACL(agentId);
  if (!acl) return false;
  return acl.allowed_tools.includes(toolName);
}

/** Risk level filter — yüksek riskli ajanların listesi. */
export function getHighRiskAgents(): AgentId[] {
  return AGENT_ACL_REGISTRY.filter((a) => a.risk_level === "high").map((a) => a.agent_id);
}

/**
 * v15.7 (2026-05-26): phaseId → AgentId mapping. Phase 0 D1/D3 ve Phase 5
 * normal/tweak ayrımı caller'ın sorumluluğunda; default mapping en yaygın
 * varianta düşer (D1, normal). Audit `risk-check` event için kullanılır.
 */
export function phaseIdToAgentId(
  phaseId: number,
  variant?: "tweak",
): AgentId | null {
  switch (phaseId) {
    case 0: return "phase-0-d1";
    case 1: return "phase-1";
    case 2: return "phase-2";
    case 3: return "phase-3";
    case 4: return "phase-4";
    case 5: return variant === "tweak" ? "phase-5-tweak" : "phase-5";
    case 6: return "phase-6";
    case 7: return "phase-7";
    case 8: return "phase-8";
    case 9: return "phase-9";
    case 10: case 11: case 12: case 13:
    case 14: case 15: case 16: case 17:
      return "mechanical";
    default: return null;
  }
}
