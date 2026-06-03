// Tauri ↔ orchestrator event tipleri.
//
// Orchestrator stdout'a NDJSON yazar; Tauri Rust her satırı parse edip
// `orchestrator-event` Tauri event'i olarak frontend'e emit eder.

export type PhaseId =
  | 0  // Debug Triage — standalone, pipeline'a girmez
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17;

export type PhaseType = "qa" | "production" | "codegen" | "mechanical" | "validation" | "unknown";
export type ModelRole = "translator" | "main";

export interface PhaseSummary {
  id: PhaseId;
  type: PhaseType;
  name_tr: string;
  name_en: string;
  has_controller: boolean;
  model_role: ModelRole | null;
  allowed_tools: string[] | null;
  denied_paths: string[] | null;
  required_audits: string[];
  askq_config: Record<string, unknown> | null;
  production_config: Record<string, unknown> | null;
  mechanical_config: Record<string, unknown> | null;
  next_phase: PhaseId | null;
}

export interface PhasesListEvent {
  kind: "phases_list";
  data: { phases: PhaseSummary[] };
}

export type PhaseStatus = "running" | "waiting" | "complete" | "error";

/** Orchestrator → UI event'leri.
 *  UnknownEvent union'a dahil DEĞİL — discriminated narrowing'i bozar.
 *  Bilinmeyen event'ler runtime'da kind === string literal'larını eşlemeyince
 *  default branch'e düşer. */
export type OrchestratorEvent =
  | ReadyEvent
  | ConfigStatusEvent
  | ChatMessageEvent
  | TranslationEvent
  | AskqEvent
  | AskqResolvedEvent
  | TokenTotalsEvent
  | RuntimeErrorEvent
  | PhaseRunningEvent
  | PhaseIdleEvent
  | PhaseChangedEvent
  | ClaudeStreamEvent
  | ModelsListEvent
  | SelectedModelsEvent
  | PhasesListEvent
  | HistoryChunkEvent
  | AgentEvent
  | TaskQueueLoadedEvent
  | TaskQueueChangedEvent
  | FeaturesValueEvent
  | UserGuideEvent
  | ErrorEvent;

/**
 * v15.6: Orkestrator ajan event'leri — frontend "🧠 Orkestrator" modalında
 * gösterilir. tool_use her Read/Grep/Bash çağrısında, decision son karar için.
 */
export interface AgentEvent {
  kind: "agent_event";
  data: {
    sub: "started" | "completed" | "tool_use" | "decision" | "error";
    ts: number;
    turn?: number;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    error?: string;
  };
}

/** v15.7 (2026-05-24): İş kuyruğu — proje aç sırasında initial yükleme. */
export interface TaskQueueItem {
  id: string;
  ts: number;
  text: string;
}
export interface TaskQueueLoadedEvent {
  kind: "task_queue_loaded";
  data: { items: TaskQueueItem[] };
}
export interface TaskQueueChangedEvent {
  kind: "task_queue_changed";
  data: { items: TaskQueueItem[] };
}

/** v15.7 (2026-05-25): Feature flags backend'den frontend'e push event. */
export interface FeaturesValueEvent {
  kind: "features_value";
  data: { features: { playwright_enabled: boolean } };
}

/** v15.11: UI kullanma kılavuzu (.mycl/user-guide.md) içeriği — "Kılavuz"
 * sekmesi/modalında gösterilir. Açılışta (varsa) + her güncellemede push edilir. */
export interface UserGuideEvent {
  kind: "user_guide";
  data: { content: string };
}

export interface ConfigStatusEvent {
  kind: "config_status";
  data:
    | { ready: true }
    | {
        ready: false;
        reason:
          | "api_keys_missing"
          | "model_selection_missing"
          | "load_failed"
          | "i18n_load_failed";
        detail?: string;
      };
}

export interface ModelInfo {
  id: string;
  display_name: string;
  created_at: string;
}

export interface ModelsListEvent {
  kind: "models_list";
  data: {
    which: "translator" | "main";
    models: ModelInfo[];
    fetched_at: number;
    cached: boolean;
  };
}

/**
 * v15.8: rol başına backend — "api" (Anthropic SDK) | "cli" (Claude Code Aboneliği).
 * v15.12: "auto" = Auto Mode — CLI ile başla, abonelik limiti dolunca API kullan,
 * limit açılınca CLI'ye dön.
 */
export type AgentBackend = "api" | "cli" | "auto";
export interface AgentBackends {
  orchestrator: AgentBackend;
  translator: AgentBackend;
  main: AgentBackend;
}

export interface SelectedModelsEvent {
  kind: "selected_models";
  data: {
    selected: { translator?: string; main?: string; orchestrator?: string } | null;
    effort?: string;
    /** v15.8: rol-backend'leri — Modeller sekmesindeki seçiciler için. */
    backends?: AgentBackends;
  };
}

export interface ReadyEvent {
  kind: "ready";
  data: { version: string; pid: number; node: string };
}

export interface ChatMessageEvent {
  kind: "chat_message";
  data: {
    role: "user" | "assistant" | "system" | "error";
    text: string;
    ts: number;
  };
}

export interface TranslationEvent {
  kind: "translation";
  data: {
    dir: "tr-to-en" | "en-to-tr";
    input: string;
    output: string;
    model: string;
    elapsed_ms: number;
    ok: boolean;
    /** Cross-panel focus için backend Date.now() emit eder. */
    ts: number;
  };
}

export type AskqOptionWire = string | { label: string; value: string };

export interface PhaseRunningEvent {
  kind: "phase_running";
  data: { label: string; detail?: string; ts: number };
}

export interface PhaseIdleEvent {
  kind: "phase_idle";
  data: { ts: number };
}

export interface RuntimeErrorEvent {
  kind: "runtime_error";
  data: {
    ts: number;
    error_code: string;
    location: string;
    description_tr: string;
  };
}

export interface AskqEvent {
  kind: "askq";
  data: {
    id: string;
    question: string;          // TR'ye çevrilmiş
    options: AskqOptionWire[]; // TR'ye çevrilmiş
    allow_other?: boolean;
    multi_select?: boolean;
    /** v15.7 (2026-05-26): Faz 1/2 ana ajan önerisi (TR option label). UI highlight. */
    suggested_option?: string;
  };
}

/** v15.7 (2026-05-26): Askq cevap işlendi — frontend pendingAskq.id eşleşirse clear. */
export interface AskqResolvedEvent {
  kind: "askq_resolved";
  data: { id: string };
}

/** v15.7 (2026-05-26): Session token totals — header badge için (madde 13). */
export interface TokenTotalsEvent {
  kind: "token_totals";
  data: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    api_calls: number;
  };
}

export interface PhaseChangedEvent {
  kind: "phase_changed";
  data: {
    from: PhaseId;
    to: PhaseId;
    status: PhaseStatus;
  };
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  /** Prompt caching aktifse: bu turda cache'e yazılan token miktarı. */
  cache_creation_input_tokens?: number;
  /** Prompt caching aktifse: bu turda cache'ten okunan token miktarı (%90 indirim). */
  cache_read_input_tokens?: number;
}

export interface ClaudeStreamEvent {
  kind: "claude_stream";
  data: {
    sub:
      | "init"
      | "request"
      | "text"
      | "tool_use"
      | "tool_result"
      | "retry"
      | "error"
      | "stop"
      | "token_usage"
      | "relevance_call";
    text?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    is_error?: boolean;
    model?: string;
    cwd?: string;
    /** Codegen / qa-askq loop turn progress. */
    turn?: number;
    max_turns?: number;
    /**
     * `sub: "request"` payload — Claude API'ye giden istek (ilk turn'de):
     * system prompt (EN) + initial user message. UI'da ClaudeSimulator
     * collapsible blok olarak render eder. Bu sayede kullanıcı **gerçekten**
     * EN gittiğini görür (ADR-009 doğrulama).
     */
    system?: string;
    user_message?: string;
    /** `sub: "token_usage"` payload — runTurn sonrası emit. */
    usage?: ClaudeUsage;
    /** Cross-panel focus için backend Date.now() emit eder. */
    ts: number;
  };
}

export interface HistoryEntry {
  ts: number;
  kind: string;
  data: unknown;
}

export interface HistoryChunkEvent {
  kind: "history_chunk";
  data: {
    events: HistoryEntry[];
    older_available: boolean;
    oldest_returned_ts: number;
  };
}

export interface ErrorEvent {
  kind: "error";
  data: { reason: string; detail?: unknown };
}

export interface UnknownEvent {
  kind: string;
  data?: unknown;
}

/** UI → orchestrator komut tipleri. */
export type OrchestratorCommand =
  | { kind: "ping"; data?: unknown }
  | { kind: "open_project"; data: { path: string } }
  | { kind: "user_message"; data: { text: string } }
  /** ▶ Çalıştır butonu gibi deterministic intent — classifier bypass.
   * v15.7 (2026-05-27): intent_kind eklendi; orchestrator metni regex'le
   * sınıflandırmıyor — UI butonu kind'ı doğrudan veriyor. */
  | {
      kind: "command_direct";
      data: {
        text: string;
        intent_kind: "run" | "test" | "build" | "install" | "lint";
      };
    }
  /** Sol sidebar — faz tıklaması: backend askq açar (Çalıştır / Vazgeç — v15.7 deterministik). */
  | { kind: "phase_run_request"; data: { id: PhaseId } }
  // v15.7 (2026-05-25): intent_direct kaldırıldı — classifier ve sidebar
  // intent button'ları yok artık.
  | {
      kind: "askq_answer";
      data: { id: string; selected: string | string[] };
    }
  | { kind: "save_api_keys"; data: { translator: string; main: string; orchestrator?: string } }
  | { kind: "list_models"; data: { which: "translator" | "main"; force?: boolean } }
  | {
      kind: "save_settings";
      data: {
        translator: string;
        main: string;
        orchestrator?: string;
        effort?: string;
        /** v15.8: rol başına backend (api/cli) — modellerle birlikte kaydedilir. */
        backends?: Partial<AgentBackends>;
      };
    }
  | { kind: "read_selected_models" }
  | { kind: "list_phases" }
  | { kind: "check_config" }
  | { kind: "abort_phase" }
  | {
      kind: "load_messages";
      data: { since_ts: number; until_ts?: number; limit: number };
    }
  | { kind: "shutdown" }
  | { kind: "task_queue_add"; data: { text: string } }
  | { kind: "task_queue_remove"; data: { id: string } }
  | { kind: "set_auto_answer"; data: { enabled: boolean } }
  | { kind: "save_features"; data: { playwright_enabled?: boolean } }
  | { kind: "read_features" };
