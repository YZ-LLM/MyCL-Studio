// App — MyCL Studio v14 entry. Splash ↔ Main layout state machine.

import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { Splash } from "./components/Splash";
import { Settings } from "./components/Settings";
import { AgentThinkingModal } from "./components/AgentThinkingModal";
import { GuideModal } from "./components/GuideModal";
import { AppHeader } from "./components/AppHeader";
import { PhaseSidebar } from "./components/PhaseSidebar";
import {
  ChatPanel,
  type ChatMessage,
  type PendingAskq,
} from "./components/ChatPanel";
import { TranslatorPanel, type TranslationEntry } from "./components/TranslatorPanel";
import { ClaudeSimulator, type CCEvent } from "./components/ClaudeSimulator";
import { useOrchestrator } from "./hooks/useOrchestrator";
import type {
  AgentBackends,
  ModelTiers,
  DesignWorkflowMode,
  CostRecord,
  ModelInfo,
  OrchestratorEvent,
  PhaseId,
  PhaseStatus,
  PhaseSummary,
  PipelineEndEvent,
  TaskQueueItem,
} from "./types/events";
import { TaskQueuePanel } from "./components/TaskQueuePanel";
import { TokenTimelinePanel } from "./components/TokenTimelinePanel";
import { ErrorDrawer } from "./components/ErrorDrawer";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ConfigStatus =
  | { state: "unknown" }
  | { state: "ready" }
  | {
      state: "missing";
      reason:
        | "api_keys_missing"
        | "model_selection_missing"
        | "load_failed"
        | "i18n_load_failed";
      detail?: string;
    };

interface ModelsList {
  models: ModelInfo[];
  fetched_at: number;
  loading: boolean;
}

const EMPTY_LIST: ModelsList = { models: [], fetched_at: 0, loading: false };

/** v15.6 — orkestrator ajan event'i (modal'da gösterilir). */
export interface AgentThinkingEvent {
  ts: number;
  sub: "started" | "completed" | "tool_use" | "decision" | "error";
  /** Agent Teams görünürlüğü: hangi ajan (örn. "Mimari"/"UX"). Tek orkestratörde boş. */
  agent_label?: string;
  turn?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  error?: string;
}

interface MainState {
  messages: ChatMessage[];
  pendingAskq: PendingAskq | null;
  translations: TranslationEntry[];
  ccEvents: CCEvent[];
  ccBanner: {
    version: string;
    model: string;
    cwd: string;
    turn?: number;
    max_turns?: number;
    /** Cumulative token totals (faz boyunca tüm turn'ler toplanır). */
    tokens_input: number;
    tokens_output: number;
    cache_read: number;
    cache_write: number;
    turns_counted: number;
  } | null;
  phase: PhaseId;
  phaseStatus: PhaseStatus;
  /** Sticky loading banner — emitPhaseRunning / emitPhaseIdle ile yönetilir. */
  runningBanner: { label: string; detail?: string; ts: number } | null;
  /** Feature 3 history state. */
  historyLoaded: boolean;
  oldestLoadedTs: number;
  olderAvailable: boolean;
  loadingOlder: boolean;
  /** v15.6 — Orkestrator ajan event listesi (max 100 entry, dedup by ts). */
  agentEvents: AgentThinkingEvent[];
  /**
   * v15.6 — Aktif agent.respond() çağrı sayısı. started → +1, completed → -1.
   * 0 değil ise composer'da loading spinner gösterilir. Paralel boot + user
   * message akışı için counter (bool değil).
   */
  agentBusyCount: number;
  /** v15.7 — İş kuyruğu (proje-spesifik). Backend `task_queue_loaded` ve
   *  `task_queue_changed` ile günceller. */
  taskQueue: TaskQueueItem[];
  /** v15.7 (2026-05-26) — Session token totals (madde 13). Header badge. */
  tokenTotals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    api_calls: number;
  };
  /** Token-timeline — faz-bazında token harcaması (cost.jsonl). cost_phase canlı
   *  upsert eder, cost_history (load_costs yanıtı) tümünü değiştirir. */
  costTimeline: CostRecord[];
  /** Akış sonu DÜRÜST hüküm (pipeline_end). null = henüz akış bitmedi / yeni akış.
   *  PARTIAL/FAIL ise sidebar başarısız gate'lere ⚠️ basar, header çip gösterir. */
  pipelineVerdict: PipelineEndEvent["data"] | null;
}

const INITIAL_STATE: MainState = {
  messages: [],
  pendingAskq: null,
  translations: [],
  ccEvents: [],
  ccBanner: null,
  runningBanner: null,
  phase: 1,
  phaseStatus: "running",
  historyLoaded: false,
  oldestLoadedTs: 0,
  olderAvailable: true,
  loadingOlder: false,
  agentEvents: [],
  agentBusyCount: 0,
  taskQueue: [],
  tokenTotals: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    api_calls: 0,
  },
  costTimeline: [],
  pipelineVerdict: null,
};

function reduce(state: MainState, ev: OrchestratorEvent): MainState {
  if (ev.kind === "chat_message") {
    const data = ev.data;
    const newMsg = {
      id: state.messages.length + 1,
      role: data.role,
      text: data.text,
      ts: data.ts,
    };
    // Runtime hata mesajları rolling window — chat'e spam etmesin (2026-05-22).
    // Yeni "🔴 Runtime hata yakalandı" mesajı gelince eski runtime mesajlarından
    // son 1 tanesini koru, geri kalanı sil. Yeni mesajla birlikte ekranda max 2.
    const isRuntimeErrorMsg = /^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(
      data.text,
    );
    if (isRuntimeErrorMsg) {
      const nonRuntime = state.messages.filter(
        (m) =>
          !/^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(m.text),
      );
      const runtimeMessages = state.messages.filter((m) =>
        /^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(m.text),
      );
      // Son 1 eski runtime mesajını koru → yenisiyle birlikte ekranda 2 görünür.
      const keepRecentRuntime = runtimeMessages.slice(-1);
      return {
        ...state,
        messages: [...nonRuntime, ...keepRecentRuntime, newMsg],
      };
    }
    return {
      ...state,
      messages: [...state.messages, newMsg],
    };
  }
  if (ev.kind === "error") {
    const d = ev.data;
    const detailText = d.detail
      ? typeof d.detail === "string"
        ? d.detail
        : JSON.stringify(d.detail, null, 2)
      : undefined;
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: state.messages.length + 1,
          role: "error",
          text: d.reason,
          detail: detailText,
          ts: Date.now(),
        },
      ],
    };
  }
  if (ev.kind === "translation") {
    const d = ev.data;
    return {
      ...state,
      translations: [
        ...state.translations,
        {
          id: state.translations.length + 1,
          dir: d.dir,
          input: d.input,
          output: d.output,
          model: d.model,
          elapsed_ms: d.elapsed_ms,
          ok: d.ok,
          ts: d.ts,
        },
      ],
    };
  }
  if (ev.kind === "askq") {
    return {
      ...state,
      pendingAskq: {
        id: ev.data.id,
        ts: Date.now(), // mesajlar da Date.now() → sonra yazılan mesaj kartın altında görünür
        question: ev.data.question,
        options: ev.data.options,
        allow_other: ev.data.allow_other,
        multi_select: ev.data.multi_select,
        suggested_option: ev.data.suggested_option,
      },
      phaseStatus: "waiting",
    };
  }
  if (ev.kind === "token_totals") {
    return { ...state, tokenTotals: ev.data };
  }
  if (ev.kind === "cost_phase") {
    // Token-timeline: canlı faz-cost. Aynı (phase, iteration) varsa GÜNCELLE, yoksa EKLE
    // (faz yeniden koşarsa duplike olmasın); ts'e göre sıralı kalsın.
    const rec = ev.data;
    const idx = state.costTimeline.findIndex(
      (c) => c.phase === rec.phase && c.iteration === rec.iteration,
    );
    const costTimeline =
      idx >= 0
        ? state.costTimeline.map((c, i) => (i === idx ? rec : c))
        : [...state.costTimeline, rec];
    return { ...state, costTimeline };
  }
  if (ev.kind === "cost_history") {
    // load_costs yanıtı — geçmiş tüm faz-cost'u (proje açılışı). Tümünü değiştir.
    return { ...state, costTimeline: ev.data.costs };
  }
  if (ev.kind === "askq_resolved") {
    // v15.7 (2026-05-26): Backend askq cevap işledi (kapı bekçisi answer_askq
    // veya askq UI click). pendingAskq eşleşirse clear et — askq kartı UI'dan kalkar.
    if (state.pendingAskq && state.pendingAskq.id === ev.data.id) {
      return { ...state, pendingAskq: null };
    }
    return state;
  }
  if (ev.kind === "phase_running") {
    return {
      ...state,
      runningBanner: {
        label: ev.data.label,
        detail: ev.data.detail,
        ts: ev.data.ts,
      },
    };
  }
  if (ev.kind === "phase_idle") {
    return { ...state, runningBanner: null };
  }
  if (ev.kind === "phase_changed") {
    // Banner phase_changed status=running ile AÇILMAZ (yanıltıcı: Phase 7
    // deferred Claude turn'ü yok). Banner sadece claude_stream init ile açılır.
    // Ama complete/error/waiting → generic claude banner'ı kapat. Spesifik
    // emitPhaseRunning ile açılmışsa (label != "🤖 Model çalışıyor") korunur.
    const isGenericClaude =
      state.runningBanner?.label === "🤖 Model çalışıyor";
    const closeBanner =
      isGenericClaude &&
      (ev.data.status === "complete" ||
        ev.data.status === "error" ||
        ev.data.status === "waiting");
    // Yeni akış/iterasyon Faz 1'de "running" ile başlar → eski hüküm rozetlerini
    // temizle (önceki koşunun ⚠️'leri yeni akışa sızmasın).
    const freshRun = ev.data.to === 1 && ev.data.status === "running";
    return {
      ...state,
      phase: ev.data.to,
      phaseStatus: ev.data.status,
      pendingAskq: null,
      runningBanner: closeBanner ? null : state.runningBanner,
      pipelineVerdict: freshRun ? null : state.pipelineVerdict,
    };
  }
  if (ev.kind === "pipeline_end") {
    // Akış sonu DÜRÜST hüküm — sidebar/header bu sayede gate-fail'i gösterir.
    return { ...state, pipelineVerdict: ev.data };
  }
  if (ev.kind === "history_chunk") {
    const d = ev.data;
    const chatMessages: ChatMessage[] = [];
    const translations: TranslationEntry[] = [];
    const ccEvents: CCEvent[] = [];
    for (const e of d.events) {
      const data = e.data as Record<string, unknown>;
      if (e.kind === "chat_message") {
        chatMessages.push({
          id: 0,
          role: data.role as ChatMessage["role"],
          text: String(data.text ?? ""),
          ts: e.ts,
        });
      } else if (e.kind === "translation") {
        translations.push({
          id: 0,
          dir: data.dir as TranslationEntry["dir"],
          input: String(data.input ?? ""),
          output: String(data.output ?? ""),
          model: String(data.model ?? ""),
          elapsed_ms: Number(data.elapsed_ms ?? 0),
          ok: Boolean(data.ok),
          ts: e.ts,
        });
      } else if (e.kind === "claude_stream") {
        const sub = String(data.sub ?? "");
        // token_usage ve init Reducer'da banner için kullanılır; visible stream'e
        // dahil değil. Tarihte de panel'de gösterilmesin → skip.
        if (sub === "token_usage" || sub === "init" || sub === "relevance_call") {
          continue;
        }
        ccEvents.push({
          id: 0,
          sub: sub as CCEvent["sub"],
          text: typeof data.text === "string" ? data.text : undefined,
          tool_name: typeof data.tool_name === "string" ? data.tool_name : undefined,
          tool_input:
            typeof data.tool_input === "object" && data.tool_input !== null
              ? (data.tool_input as Record<string, unknown>)
              : undefined,
          is_error: typeof data.is_error === "boolean" ? data.is_error : undefined,
          system: typeof data.system === "string" ? data.system : undefined,
          user_message:
            typeof data.user_message === "string" ? data.user_message : undefined,
          ts: e.ts,
        });
      }
    }
    // History chunk her zaman PREPEND + stable sort by ts. `isInitial` ayrımı
    // yanlıştı: boot sırasında user mesaj yazarsa (state.messages dolarken
    // historyLoaded=false), gelen history_chunk live mesajı override ediyordu
    // (3. göz QC HIGH 4 bulgusu). Şimdi her zaman merge + sort: history
    // event'leri normalde state.messages'ın ts'lerinden eski olur, sort sadece
    // defensive (clock skew / lazy chunk overlap edge case'i).
    const stableSort = <T extends { ts: number }>(arr: T[]): T[] => {
      // ts EQ olan event'lerin göreli sırası korunsun → indexed sort.
      return arr
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => a.item.ts - b.item.ts || a.idx - b.idx)
        .map(({ item }) => item);
    };
    // ts-based dedupe: history_chunk birden fazla kez gelirse (boot effect
    // duplicate dispatch ya da backend echo) aynı event'leri tekrar prepend
    // etmez. Üretim raporu (2026-05-20): "1 yazdım 6 görünüyor" — kullanıcı
    // 1 user mesajı + 3 history user msg → 4 beklenir, 6 göründü. Reducer
    // idempotent değildi. Şimdi: mevcut state'in ts setine bakar, varsa skip.
    const existingMsgTs = new Set(state.messages.map((m) => m.ts));
    const existingTrTs = new Set(state.translations.map((t) => t.ts));
    const existingCcTs = new Set(state.ccEvents.map((c) => c.ts));
    const dedupedChat = chatMessages.filter((m) => !existingMsgTs.has(m.ts));
    const dedupedTr = translations.filter((t) => !existingTrTs.has(t.ts));
    const dedupedCc = ccEvents.filter((c) => !existingCcTs.has(c.ts));
    const newMessages = stableSort([...dedupedChat, ...state.messages]);
    const newTranslations = stableSort([...dedupedTr, ...state.translations]);
    const newCcEvents = stableSort([...dedupedCc, ...state.ccEvents]);
    return {
      ...state,
      messages: newMessages.map((m, i) => ({ ...m, id: i + 1 })),
      translations: newTranslations.map((t, i) => ({ ...t, id: i + 1 })),
      ccEvents: newCcEvents.map((c, i) => ({ ...c, id: i + 1 })),
      historyLoaded: true,
      oldestLoadedTs:
        d.oldest_returned_ts > 0 ? d.oldest_returned_ts : state.oldestLoadedTs,
      olderAvailable: d.older_available,
      loadingOlder: false,
    };
  }
  if (ev.kind === "claude_stream") {
    const d = ev.data;
    if (d.sub === "init") {
      // Yeni faz başladı → cumulative token sayaçlarını sıfırla. Faz değişimi
      // sırasında system prompt değiştiği için cache de invalidate olur; ayrı
      // ayrı izlemek anlamlı.
      // Sticky loading banner: gerçek model turn'ü başlıyor. Spesifik
      // emitPhaseRunning ile zaten detaylı banner açıksa (Hata Ara, smoke test)
      // KORUNUR; aksi takdirde generic "🤖 Model çalışıyor" banner açılır.
      // sub="stop" veya "token_usage" ile bu generic banner kapanır.
      return {
        ...state,
        ccBanner: {
          version: d.text ?? "v?",
          model: d.model ?? state.ccBanner?.model ?? "?",
          cwd: d.cwd ?? state.ccBanner?.cwd ?? "?",
          turn: d.turn ?? state.ccBanner?.turn,
          max_turns: d.max_turns ?? state.ccBanner?.max_turns,
          tokens_input: 0,
          tokens_output: 0,
          cache_read: 0,
          cache_write: 0,
          turns_counted: 0,
        },
        runningBanner: state.runningBanner ?? {
          label: "🤖 Model çalışıyor",
          detail: d.model,
          ts: d.ts ?? Date.now(),
        },
      };
    }
    // sub === "stop": model bir turn'ü tamamladı → generic "🤖 Model çalışıyor"
    // banner'ı kapat. Codegen loop'unda kısa flicker olabilir; kullanıcı
    // (2026-05-23) yanıltıcı görünmektense flicker'ı tercih etti. Spesifik
    // emitPhaseRunning banner'ları (Hata Ara, smoke test) korunur.
    if (d.sub === "stop") {
      const isGenericClaude =
        state.runningBanner?.label === "🤖 Model çalışıyor";
      return {
        ...state,
        runningBanner: isGenericClaude ? null : state.runningBanner,
      };
    }
    if (d.sub === "token_usage" && d.usage) {
      // Cumulative — her runTurn sonunda bir kez emit edilir.
      const prev = state.ccBanner;
      const cacheRead = d.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = d.usage.cache_creation_input_tokens ?? 0;
      return {
        ...state,
        ccBanner: {
          version: prev?.version ?? "v?",
          model: d.model ?? prev?.model ?? "?",
          cwd: prev?.cwd ?? "?",
          turn: prev?.turn,
          max_turns: prev?.max_turns,
          tokens_input: (prev?.tokens_input ?? 0) + d.usage.input_tokens,
          tokens_output: (prev?.tokens_output ?? 0) + d.usage.output_tokens,
          cache_read: (prev?.cache_read ?? 0) + cacheRead,
          cache_write: (prev?.cache_write ?? 0) + cacheWrite,
          turns_counted: (prev?.turns_counted ?? 0) + 1,
        },
      };
    }
    // Diğer sub'lar (text/tool_use/tool_result/retry/error/stop/request) →
    // visible event stream'e ekle. CCEventKind union'ı token_usage'ı içermez.
    return {
      ...state,
      ccEvents: [
        ...state.ccEvents,
        {
          id: state.ccEvents.length + 1,
          sub: d.sub as CCEvent["sub"],
          text: d.text,
          tool_name: d.tool_name,
          tool_input: d.tool_input,
          is_error: d.is_error,
          system: d.system,
          user_message: d.user_message,
          ts: d.ts,
        },
      ],
    };
  }
  // v15.6: Orkestrator ajan event'leri — "🧠 Orkestrator" modal'da listelenir.
  // Dedup by ts; max 100 entry (en eski drop). Reverse-chronological görünüm
  // için modal kendisi reverse() yapar; store kronolojik tutar.
  if (ev.kind === "agent_event") {
    const d = ev.data;
    // Busy counter: started/completed sayaca etki eder. ETİKETSİZ (tek orkestratör) → yalnız sayaç.
    // ETİKETLİ (Agent Teams perspektif/modül ajanı) → ayrıca listele ki "hangi ajan başladı/bitti" görünsün.
    if (d.sub === "started" || d.sub === "completed") {
      const agentBusyCount =
        d.sub === "started"
          ? state.agentBusyCount + 1
          : Math.max(0, state.agentBusyCount - 1);
      if (!d.agent_label) return { ...state, agentBusyCount };
      const teamEvent: AgentThinkingEvent = {
        ts: d.ts,
        sub: d.sub,
        agent_label: d.agent_label,
      };
      const m = [...state.agentEvents, teamEvent];
      return {
        ...state,
        agentBusyCount,
        agentEvents: m.length > 100 ? m.slice(m.length - 100) : m,
      };
    }
    const newEvent: AgentThinkingEvent = {
      ts: d.ts,
      sub: d.sub,
      agent_label: d.agent_label,
      turn: d.turn,
      tool_name: d.tool_name,
      tool_input: d.tool_input,
      decision: d.decision,
      error: d.error,
    };
    // Dedup by ts
    if (state.agentEvents.some((e) => e.ts === d.ts)) return state;
    const merged = [...state.agentEvents, newEvent];
    // Max 100 entry — en eskileri drop (slice from end)
    const capped = merged.length > 100 ? merged.slice(merged.length - 100) : merged;
    return { ...state, agentEvents: capped };
  }
  // v15.7 (2026-05-24): İş kuyruğu — backend her değişiklikte tam listeyi yollar
  if (ev.kind === "task_queue_loaded" || ev.kind === "task_queue_changed") {
    return { ...state, taskQueue: ev.data.items };
  }
  // v15.7 (2026-05-25): Feature flags — read_features / save_features sonrası
  // backend push. Stored in MainState yerine ayrı state'te (Settings'e prop geçirilir).
  return state;
}

function App() {
  const orch = useOrchestrator();
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [mainState, setMainState] = useState<MainState>(INITIAL_STATE);
  const [processedCount, setProcessedCount] = useState(0);
  // v15.13 (saha 3/5): Oto-cevap toggle (Orkestrator yanındaki checkbox). localStorage'da
  // saklanır; backend'e config_status ready'de (restore) + her değişimde komutla bildirilir.
  const [autoAnswer, setAutoAnswer] = useState<boolean>(
    () => localStorage.getItem("mycl_auto_answer") === "1",
  );
  const handleAutoAnswerToggle = (enabled: boolean): void => {
    setAutoAnswer(enabled);
    localStorage.setItem("mycl_auto_answer", enabled ? "1" : "0");
    void orch.send({ kind: "set_auto_answer", data: { enabled } });
  };

  // v15.13 (saha 5/5): kullanıcı aksiyonu beklenirken (askq) OS bildirimi.
  // Açılışta izin iste (sessiz başarısız — bildirim plugin'i yoksa akışı bozma).
  useEffect(() => {
    void (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch {
        /* bildirim yoksa sessiz geç */
      }
    })();
  }, []);

  // Yeni bir askq gelince (id değişince) bildirim — yalnız pencere ODAKTA DEĞİLSE
  // (kullanıcı zaten bakıyorsa spam etme). Tek askq başına bir kez.
  const lastNotifiedAskq = useRef<string | null>(null);
  useEffect(() => {
    const askq = mainState.pendingAskq;
    if (!askq || lastNotifiedAskq.current === askq.id) return;
    lastNotifiedAskq.current = askq.id;
    void (async () => {
      try {
        const focused = await getCurrentWindow()
          .isFocused()
          .catch(() => true);
        if (focused) return; // odakta → bildirme
        if (!(await isPermissionGranted())) return;
        sendNotification({
          title: "MyCL — yanıtın bekleniyor",
          body: askq.question.slice(0, 140),
        });
      } catch {
        /* sessiz */
      }
    })();
  }, [mainState.pendingAskq]);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({
    state: "unknown",
  });
  const [savingKeys, setSavingKeys] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v15.6: Orkestrator ajan düşünceler modalı.
  const [orchestratorModalOpen, setOrchestratorModalOpen] = useState(false);
  // v15.11: UI kullanma kılavuzu (Kılavuz sekmesi) — içerik user_guide event'inden.
  const [userGuide, setUserGuide] = useState("");
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  // 2026-06-11 (Ümit): Model Güç Raporu popup — composer'daki "📊 Model Raporu" butonu açar; içerik backend
  // model_strength_report event'inden gelir.
  const [modelReportOpen, setModelReportOpen] = useState(false);
  const [modelReportText, setModelReportText] = useState("");
  // v15.7: İş kuyruğu drawer açık/kapalı
  const [taskQueueOpen, setTaskQueueOpen] = useState(false);
  const [tokenTimelineOpen, setTokenTimelineOpen] = useState(false);
  // v15.7 (2026-05-25): Feature flags (Playwright vb.). Backend read_features → features_value event ile dolur.
  const [features, setFeatures] = useState<{
    playwright_enabled: boolean;
  }>({
    playwright_enabled: true,
  });
  // v15.8 (2026-05-30): Main model efor seçimi (CLI backend için). selected_models event'inden gelir.
  const [currentEffort, setCurrentEffort] = useState<string>("max");
  // v15.8: rol başına backend (api/cli). selected_models event'inden gelir.
  const [currentBackends, setCurrentBackends] = useState<AgentBackends | undefined>(undefined);
  const [phasesList, setPhasesList] = useState<PhaseSummary[]>([]);
  const [modelsTranslator, setModelsTranslator] = useState<ModelsList>(EMPTY_LIST);
  const [modelsMain, setModelsMain] = useState<ModelsList>(EMPTY_LIST);
  const [currentSelected, setCurrentSelected] = useState<{ translator?: string; main?: string } | null>(null);
  // v15.13 (auto-model + çok-ajanlı tasarım): Settings seçicileri için mevcut değerler.
  const [currentModelTiers, setCurrentModelTiers] = useState<ModelTiers | undefined>(undefined);
  const [currentDesignWorkflow, setCurrentDesignWorkflow] = useState<DesignWorkflowMode | undefined>(undefined);
  const [currentAgentTeamsOptIn, setCurrentAgentTeamsOptIn] = useState<boolean | undefined>(undefined);
  const [currentMultiAgentSelection, setCurrentMultiAgentSelection] = useState<boolean | undefined>(undefined);
  const [currentCacheTtl, setCurrentCacheTtl] = useState<"5m" | "1h" | undefined>(undefined);
  // 2026-06-11 (Ümit): tırmanılan per-domain escalation seviyeleri — Settings'te read-only gösterilir.
  const [currentEscalationRungs, setCurrentEscalationRungs] = useState<
    Record<string, { tier: string; effort: string }>
  >({});
  /**
   * Boot history load guard: request yolda iken effect re-fire ederse 2.
   * send'i bloklar. onProjectSelected'ta reset (yeni proje = fresh request).
   */
  const historyRequestedRef = useRef(false);
  /** Sağ panel (Translator + Claude Code) açık/kapalı toggle. Default kapalı —
   *  kullanıcı chat'e odaklansın; ihtiyaç halinde header `⇤` ile açar. */
  const [rightPanelsOpen, setRightPanelsOpen] = useState(false);
  /** Sol panel (Faz Sidebar) açık/kapalı toggle. Default açık — kullanıcı
   *  fazları kolayca görsün; gerekirse header `📑` ile gizler. */
  const [leftPanelsOpen, setLeftPanelsOpen] = useState(true);
  /** v15.7 (2026-05-27): Alt hata çekmecesi. Header "HATA" badge'ine tıklayınca
   *  açılır; chat'teki role:"error" + "❌" prefix system mesajlarını gösterir. */
  const [errorDrawerOpen, setErrorDrawerOpen] = useState(false);
  // v15.7 (2026-05-24): activeIntent state kaldırıldı — composer altındaki
  // "Soru Sor" / "Hata Ayıkla" button'ları kalktı. Orchestrator ajan composer
  // metnini otomatik classify ediyor (question/debug/chat/develop), kullanıcı
  // manuel intent seçmeye gerek duymuyor.
  /**
   * Cross-panel focus: chat'te tıklanan mesajın ts'i. null iken highlight yok.
   * Pencere mantığı: [selectedTs, sonraki user/askq-answer ts'i) — translator
   * ve claude_stream event'leri bu pencerede associated sayılır.
   */
  const [selectedTs, setSelectedTs] = useState<number | null>(null);

  // Yeni event'leri reducer'a feed et + config/model/selection event'lerini izole et.
  // KRİTİK: `mainState` deps'te OLMAMALI — setMainState async tamamlanmadan
  // mainState yeni referans alıp effect'i re-fire ederse, processedCount henüz
  // güncellenmediği için aynı `fresh` slice tekrar işlenir → user mesajları
  // duplicate eklenir (3-4 kez). Fix: functional setState + minimal deps.
  // Yan-effect (setConfigStatus / setSettingsOpen / setCurrentSelected /
  // setPhasesList / setModelsTranslator / setModelsMain / setSavingKeys /
  // setSavingModels) idempotent oldukları için duplicate risk yok; sadece
  // reducer state ekleme non-idempotent → functional callback ile race-free.
  useEffect(() => {
    if (orch.events.length <= processedCount) return;
    const fresh = orch.events.slice(processedCount);
    for (const ev of fresh) {
      if (ev.kind === "config_status") {
        if (ev.data.ready) {
          setConfigStatus({ state: "ready" });
          void orch.send({ kind: "read_selected_models" });
          void orch.send({ kind: "read_features" });
          // v15.13 (saha 3/5): oto-cevap tercihini (localStorage) backend'e geri yükle.
          void orch.send({ kind: "set_auto_answer", data: { enabled: autoAnswer } });
        } else {
          setConfigStatus({
            state: "missing",
            reason: ev.data.reason,
            detail: ev.data.detail,
          });
          // v15.8: İlk açılış onboarding — config eksik OLAN HER durumda Settings'i
          // otomatik aç. Önceden yalnız model_selection_missing açıyordu; ama boot'ta
          // ÖNCE api_keys_missing emit ediliyor (index.ts) → yeni kullanıcı boş ekranda
          // kalıyordu. Settings render `initialTab`'ı reason'a göre seçer (api_keys vb.).
          setSettingsOpen(true);
        }
        setSavingKeys(false);
        setSavingModels(false);
      } else if (ev.kind === "models_list") {
        const update = {
          models: ev.data.models,
          fetched_at: ev.data.fetched_at,
          loading: false,
        };
        if (ev.data.which === "translator") setModelsTranslator(update);
        else setModelsMain(update);
      } else if (ev.kind === "model_strength_report") {
        // 2026-06-11: backend rapor metnini yolladı → popup'ı aç.
        setModelReportText(ev.data.text ?? "");
        setModelReportOpen(true);
      } else if (ev.kind === "selected_models") {
        setCurrentSelected(ev.data.selected ?? null);
        if (ev.data.effort) setCurrentEffort(ev.data.effort);
        if (ev.data.backends) setCurrentBackends(ev.data.backends);
        if (ev.data.model_tiers) setCurrentModelTiers(ev.data.model_tiers);
        if (ev.data.design_workflow) setCurrentDesignWorkflow(ev.data.design_workflow);
        if (typeof ev.data.agent_teams_optin === "boolean")
          setCurrentAgentTeamsOptIn(ev.data.agent_teams_optin);
        if (typeof ev.data.multi_agent_selection === "boolean")
          setCurrentMultiAgentSelection(ev.data.multi_agent_selection);
        if (ev.data.cache_ttl) setCurrentCacheTtl(ev.data.cache_ttl);
        if (ev.data.escalation_rungs) setCurrentEscalationRungs(ev.data.escalation_rungs);
      } else if (ev.kind === "phases_list") {
        setPhasesList(ev.data.phases);
      } else if (ev.kind === "features_value") {
        setFeatures({
          playwright_enabled: ev.data.features.playwright_enabled,
        });
      } else if (ev.kind === "user_guide") {
        setUserGuide(ev.data.content);
      }
    }
    setMainState((current) => {
      let next = current;
      for (const ev of fresh) {
        if (
          ev.kind === "config_status" ||
          ev.kind === "models_list" ||
          ev.kind === "selected_models" ||
          ev.kind === "phases_list" ||
          ev.kind === "features_value" ||
          ev.kind === "user_guide"
        ) {
          continue;
        }
        next = reduce(next, ev);
      }
      return next;
    });
    setProcessedCount(orch.events.length);
  }, [orch.events, processedCount, orch]);

  // WP4 DAST: 🛡️ buton → backend açıklama+onay askq'ı açar (buton doğrudan taramaz).
  const sendRunDast = () => {
    void orch.send({ kind: "run_dast" });
  };

  const handleSaveApiKeys = (
    translator: string,
    main: string,
    orchestrator?: string,
  ) => {
    setSavingKeys(true);
    void orch.send({
      kind: "save_api_keys",
      data: orchestrator
        ? { translator, main, orchestrator }
        : { translator, main },
    });
  };

  const handleSaveModels = (
    translator: string,
    main: string,
    orchestrator?: string,
    effort?: string,
    backends?: AgentBackends,
    modelTiers?: ModelTiers,
    designWorkflow?: DesignWorkflowMode,
    agentTeamsOptIn?: boolean,
    cacheTtl?: "5m" | "1h",
    multiAgentSelection?: boolean,
  ) => {
    setSavingModels(true);
    if (effort) setCurrentEffort(effort);
    if (backends) setCurrentBackends(backends);
    if (modelTiers) setCurrentModelTiers(modelTiers);
    if (designWorkflow) setCurrentDesignWorkflow(designWorkflow);
    if (typeof agentTeamsOptIn === "boolean") setCurrentAgentTeamsOptIn(agentTeamsOptIn);
    if (typeof multiAgentSelection === "boolean") setCurrentMultiAgentSelection(multiAgentSelection);
    if (cacheTtl) setCurrentCacheTtl(cacheTtl);
    void orch.send({
      kind: "save_settings",
      data: {
        translator,
        main,
        ...(orchestrator ? { orchestrator } : {}),
        ...(effort ? { effort } : {}),
        ...(backends ? { backends } : {}),
        ...(modelTiers ? { model_tiers: modelTiers } : {}),
        ...(designWorkflow ? { design_workflow: designWorkflow } : {}),
        ...(typeof agentTeamsOptIn === "boolean" ? { agent_teams_optin: agentTeamsOptIn } : {}),
        ...(typeof multiAgentSelection === "boolean" ? { multi_agent_selection: multiAgentSelection } : {}),
        ...(cacheTtl ? { cache_ttl: cacheTtl } : {}),
      },
    });
    // config_status sonrası modal kapanır
    setSettingsOpen(false);
  };

  const handleFetchModels = (which: "translator" | "main", force: boolean) => {
    if (which === "translator")
      setModelsTranslator((p) => ({ ...p, loading: true }));
    else setModelsMain((p) => ({ ...p, loading: true }));
    void orch.send({ kind: "list_models", data: { which, force } });
  };

  // Cmd+, klavye kısayolu — Settings toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        // Model selection missing iken kapatma engellenir; toggle değil sadece aç.
        if (configStatus.state === "missing" && configStatus.reason === "model_selection_missing") {
          setSettingsOpen(true);
        } else {
          setSettingsOpen((p) => !p);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [configStatus]);

  const onProjectSelected = (path: string) => {
    // Yeni proje = fresh history request gerekir → ref reset (boot effect
    // tekrar tetiklensin). open_project send'i tek noktadan (useEffect)
    // tetiklenir — burada inline send YAPMA, aksi takdirde projectPath dep'i
    // değişip useEffect de tetikleniyor → çift open_project + duplicate
    // backend boot mesajları.
    historyRequestedRef.current = false;
    setProjectPath(path);
    setMainState({ ...INITIAL_STATE });
  };

  // Orchestrator hazır olduğunda proje aç event'ini yolla (gecikme olursa).
  // `orch.bootSequence` her ready event'inde artar — orchestrator restart
  // (auto-update veya crash recovery) sonrası open_project'i YENİDEN gönder
  // ki runtime.state null kalmasın (L1 — "no active project" fix).
  useEffect(() => {
    if (orch.ready && projectPath) {
      void orch.send({ kind: "open_project", data: { path: projectPath } }).catch(
        () => {},
      );
      // v15.7 (2026-05-24): Rust state'e window→project register et — diğer
      // pencerelerin Splash'i bu projeyi "açık" görüp grizleyecek.
      void (async () => {
        try {
          const win = await import("@tauri-apps/api/window");
          const label = win.getCurrentWindow().label;
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("register_window_project", {
            windowLabel: label,
            projectPath,
          });
        } catch (err) {
          console.warn("register_window_project failed", err);
        }
      })();
      // Restart sonrası history de yeniden yüklenmeli — guard reset.
      if (orch.bootSequence > 1) {
        historyRequestedRef.current = false;
        setMainState((s) => ({ ...s, historyLoaded: false }));
      }
    }
  }, [orch.ready, orch.bootSequence, projectPath]);

  // Sol sidebar için faz listesi — orchestrator hazır olur olmaz bir kez çek.
  // phasesList boş kalırsa PhaseSidebar TR isimleri gösteremez (fallback "Faz N").
  // Restart sonrası bootSequence artar → liste yeniden gelir.
  useEffect(() => {
    if (orch.ready) {
      void orch.send({ kind: "list_phases" }).catch(() => {});
    }
  }, [orch.ready, orch.bootSequence]);

  // Feature 3 boot load: config hazır + proje açıkken bir kez 48h history çek.
  // İki katmanlı guard:
  //   1. `mainState.historyLoaded` — reducer history_chunk'ı işledikten sonra
  //      true; yeniden send tetiklenmez.
  //   2. `historyRequestedRef` — request yolda iken (response gelmeden)
  //      effect re-fire ederse send tekrarlanmasın. mainState referansı
  //      başka state değişimlerinde de yenilenir; deps `mainState.history
  //      Loaded` boolean ama React shallow refleks yine fire edebilir.
  //   `onProjectSelected`'ta ref reset edilir (yeni proje = fresh request).
  useEffect(() => {
    if (
      configStatus.state === "ready" &&
      projectPath &&
      !mainState.historyLoaded &&
      !historyRequestedRef.current
    ) {
      historyRequestedRef.current = true;
      // 48h boot load. Limit 2000 — yoğun aktivite günlerinde (claude_stream
      // text deltaları event sayısını şişirir) 500 sınırı erken cut-off'a yol
      // açıyordu, kullanıcı "geçmiş gelmiyor" raporladı (2026-05-23).
      const since_ts = Date.now() - 48 * 60 * 60 * 1000;
      void orch
        .send({ kind: "load_messages", data: { since_ts, limit: 2000 } })
        .catch(() => {
          historyRequestedRef.current = false; // retry mümkün
        });
      // Token-timeline: proje açılışında tüm faz-cost geçmişini de iste (cost_history
      // yanıtı costTimeline'ı doldurur; sonra cost_phase canlı upsert eder).
      void orch.send({ kind: "load_costs" }).catch(() => {});
    }
  }, [configStatus.state, projectPath, mainState.historyLoaded, orch]);

  // ChatPanel üst scroll → 24h daha eski chunk yükle.
  const handleLoadOlder = () => {
    if (!mainState.olderAvailable || mainState.loadingOlder) return;
    if (mainState.oldestLoadedTs <= 0) return;
    setMainState((s) => ({ ...s, loadingOlder: true }));
    void orch
      .send({
        kind: "load_messages",
        data: {
          since_ts: mainState.oldestLoadedTs - 24 * 60 * 60 * 1000,
          until_ts: mainState.oldestLoadedTs,
          limit: 2000,
        },
      })
      .catch(() => {
        setMainState((s) => ({ ...s, loadingOlder: false }));
      });
  };

  /**
   * ▶ Çalıştır butonu gibi deterministic intent için classifier bypass:
   * `command_direct` IPC → orchestrator handleCommandIntent direkt çağrılır.
   * Chat'e user balon optimistic eklenir (sendUserMessage paraleli).
   */
  const sendRunCommand = () => {
    const text = "projeyi çalıştır";
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: s.messages.length + 1, role: "user", text, ts: Date.now() },
      ],
    }));
    void orch.send({
      kind: "command_direct",
      data: { text, intent_kind: "run" },
    });
  };

  /**
   * Sol sidebar — faz tıklaması: backend askq açar (Çalıştır / Vazgeç).
   * v15.7 (2026-05-28): Tek deterministik mod. Chat'e optimistic balon eklenir.
   */
  const sendPhaseRunRequest = (id: PhaseId) => {
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          id: s.messages.length + 1,
          role: "user",
          text: `Faz ${id} tıklandı`,
          ts: Date.now(),
        },
      ],
    }));
    void orch.send({ kind: "phase_run_request", data: { id } });
  };

  const sendUserMessage = (text: string) => {
    // v15.7 (2026-05-26): KAPI BEKÇİSİ — composer mesajı HER ZAMAN orkestratöre
    // gider. Eski bypass (askq açıkken otomatik askq_answer) kaldırıldı: orkestratör
    // ajan kapı bekçisi rolünde mesajı yorumlar (askq cevabı mı, bağlam değişimi mi,
    // sohbet mi). Orkestratör answer_askq action seçerse askq programatik cevaplanır;
    // chat seçerse askq UI açık kalır.
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: s.messages.length + 1, role: "user", text, ts: Date.now() },
      ],
    }));
    void orch.send({ kind: "user_message", data: { text } });
  };

  // v15.7: handleIntentClick kaldırıldı — intent button'ları yok artık.

  // v15.7 (2026-05-24): İş kuyruğu handler'ları
  const handleAddTaskToQueue = (text: string) => {
    void orch.send({ kind: "task_queue_add", data: { text } });
  };
  const handleTaskDelete = (id: string) => {
    void orch.send({ kind: "task_queue_remove", data: { id } });
  };
  const handleTaskApply = (item: TaskQueueItem) => {
    // Faz kontrolü TaskQueuePanel'de zaten yapıldı (disabled buton); burada
    // ekstra güvenlik. Faz 1'desek prompt olarak gönder.
    if (mainState.phase !== 1) {
      setMainState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: s.messages.length + 1,
            role: "system",
            text: `İş yalnızca Faz 1'de uygulanabilir (şu an Faz ${mainState.phase}).`,
            ts: Date.now(),
          },
        ],
      }));
      return;
    }
    sendUserMessage(item.text);
  };

  const answerAskq = (id: string, selected: string | string[]) => {
    const display = Array.isArray(selected)
      ? selected.length === 0
        ? "Vazgeç"
        : `${selected.length} seçim`
      : selected;
    setMainState((s) => {
      const now = Date.now();
      const newMessages = [...s.messages];
      // v15.6 (2026-05-24): Cevap sonrası askq kartı kaybolduğunda kullanıcı
      // ne sorulduğunu görebilsin diye soruyu chat history'sine sistem mesajı
      // olarak yansıt. Backend zaten history.log'a appendHistory yapıyor
      // (reload için), bu sadece live session UI.
      if (s.pendingAskq) {
        newMessages.push({
          id: newMessages.length + 1,
          role: "system",
          text: s.pendingAskq.question,
          ts: now - 1, // kullanıcı cevabından milisaniye önce → kronolojik sıra
        });
      }
      newMessages.push({
        id: newMessages.length + 1,
        role: "user",
        text: display,
        ts: now,
      });
      return {
        ...s,
        pendingAskq: null,
        messages: newMessages,
      };
    });
    void orch.send({ kind: "askq_answer", data: { id, selected } });
  };

  // Composer her zaman açık (yalnız orch hazır değilse kapalı). Askq pending
  // olsa bile kullanıcı yazabilsin; gönderdiğinde askq otomatik cancel edilir
  // (sendUserMessage içinde). Buton'lar (Çalıştır/Hata Ara) askq açıkken
  // disabled — yan akışı bozmasınlar.
  const composerDisabled = !orch.ready;
  const buttonsDisabled = useMemo(
    () => !orch.ready || mainState.pendingAskq !== null,
    [orch.ready, mainState.pendingAskq],
  );

  /**
   * Highlight penceresi: [selectedTs, nextBoundaryTs). nextBoundaryTs =
   * selectedTs'den büyük ilk user/askq-answer (frontend "user" rolü) mesajı ts.
   * Yoksa +Infinity (yani selectedTs sonrası tüm event'ler). selectedTs null →
   * pencere null → hiç highlight yok.
   */
  const highlightWindow = useMemo<{ from: number; to: number } | null>(() => {
    if (selectedTs === null) return null;
    const next = mainState.messages.find(
      (m) => m.ts > selectedTs && m.role === "user",
    );
    return { from: selectedTs, to: next?.ts ?? Number.POSITIVE_INFINITY };
  }, [selectedTs, mainState.messages]);

  const settingsView = (
    <Settings
      open={settingsOpen}
      initialTab={
        configStatus.state === "missing" && configStatus.reason === "api_keys_missing"
          ? "api_keys"
          : "models"
      }
      forceModelSetup={
        configStatus.state === "missing" &&
        (configStatus.reason === "model_selection_missing" ||
          configStatus.reason === "api_keys_missing")
      }
      currentSelected={currentSelected}
      currentBackends={currentBackends}
      currentModelTiers={currentModelTiers}
      currentEscalationRungs={currentEscalationRungs}
      currentDesignWorkflow={currentDesignWorkflow}
      currentAgentTeamsOptIn={currentAgentTeamsOptIn}
      currentMultiAgentSelection={currentMultiAgentSelection}
      currentCacheTtl={currentCacheTtl}
      modelsTranslator={modelsTranslator}
      modelsMain={modelsMain}
      onFetchModels={handleFetchModels}
      onSaveModels={handleSaveModels}
      onSaveApiKeys={handleSaveApiKeys}
      onClose={() => setSettingsOpen(false)}
      savingModels={savingModels}
      savingKeys={savingKeys}
      errorDetail={
        configStatus.state === "missing" && configStatus.reason === "load_failed"
          ? configStatus.detail
          : undefined
      }
      features={features}
      effort={currentEffort}
      onSaveFeatures={(f) => {
        // v15.8: kısmi toggle — mevcut state'e merge (her checkbox kendi alanını gönderir).
        setFeatures((cur) => ({ ...cur, ...f }));
        void orch.send({ kind: "save_features", data: f });
      }}
    />
  );

  // Setup zorlu (api_keys veya model_selection eksik) → splash/main yerine
  // sadece header + Settings overlay.
  if (configStatus.state === "missing") {
    return (
      <div className="app">
        <header className="app-header" data-tauri-drag-region>
          <span className="app-title" data-tauri-drag-region>MyCL Studio</span>
          <span className="app-version" data-tauri-drag-region title="Çalışan build zamanı (yerel)">
            {__BUILD_TIME__}
          </span>
          <span className="app-phase-indicator" data-tauri-drag-region>kurulum</span>
        </header>
        {settingsView}
      </div>
    );
  }

  if (!projectPath) {
    return (
      <div className="app">
        <header className="app-header" data-tauri-drag-region>
          <span className="app-title" data-tauri-drag-region>MyCL Studio</span>
          <span className="app-version" data-tauri-drag-region title="Çalışan build zamanı (yerel)">
            {__BUILD_TIME__}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            style={{
              marginLeft: "auto",
              fontSize: 12,
              background: "transparent",
              border: "1px solid var(--border)",
              padding: "4px 10px",
            }}
            title="Ayarlar (Cmd+,)"
          >
            ⚙ Ayarlar
          </button>
          <span className="app-phase-indicator">
            {configStatus.state === "ready"
              ? "hazır"
              : orch.ready
                ? "config kontrol ediliyor..."
                : "boot..."}
          </span>
        </header>
        <Splash onProjectSelected={onProjectSelected} />
        {orch.lastError && (
          <p
            style={{
              padding: "12px 16px",
              color: "var(--error)",
              fontSize: 12,
            }}
          >
            {orch.lastError}
          </p>
        )}
        {settingsView}
      </div>
    );
  }

  const translatorLabel = currentSelected?.translator ?? "—";
  const mainLabel = currentSelected?.main ?? "—";

  // v15.7 (2026-05-27): Hata kayıtları — drawer için filtrele.
  // role:"error" emitError + emitChatMessage("error",...) kaynaklı.
  // role:"system" + ❌ prefix mechanical fail mesajları (e2e-fail vb).
  const errorEntries = mainState.messages.filter(
    (m) =>
      m.role === "error" ||
      (m.role === "system" && m.text.trimStart().startsWith("❌")),
  );

  return (
    <div className="app">
      <AppHeader
        projectPath={projectPath}
        phase={mainState.phase}
        status={mainState.phaseStatus}
        onSettingsClick={() => setSettingsOpen(true)}
        onExecuteClick={sendRunCommand}
        executeDisabled={buttonsDisabled}
        onTogglePanelsClick={() => setRightPanelsOpen((p) => !p)}
        rightPanelsOpen={rightPanelsOpen}
        onToggleLeftClick={() => setLeftPanelsOpen((p) => !p)}
        leftPanelsOpen={leftPanelsOpen}
        onToggleTaskQueueClick={() => setTaskQueueOpen((o) => !o)}
        taskQueueOpen={taskQueueOpen}
        taskQueueCount={mainState.taskQueue.length}
        tokenTotals={mainState.tokenTotals}
        onTokenBadgeClick={() => setTokenTimelineOpen((o) => !o)}
        onPhaseIndicatorClick={() => setErrorDrawerOpen((o) => !o)}
        errorCount={errorEntries.length}
        pipelineVerdict={mainState.pipelineVerdict?.verdict ?? null}
      />
      <div
        className={
          "app-main" +
          (leftPanelsOpen ? "" : " left-collapsed") +
          (rightPanelsOpen ? "" : " right-collapsed")
        }
      >
        {leftPanelsOpen && (
          <>
            <PhaseSidebar
              phases={phasesList}
              currentPhase={mainState.phase}
              disabled={buttonsDisabled}
              onPhaseClick={sendPhaseRunRequest}
              gateFailures={mainState.pipelineVerdict?.gateFailures}
            />
            <div className="divider" />
          </>
        )}
        <ChatPanel
          messages={mainState.messages}
          pendingAskq={mainState.pendingAskq}
          runningBanner={mainState.runningBanner}
          disabled={composerDisabled}
          onSend={sendUserMessage}
          onAskqAnswer={answerAskq}
          selectedTs={selectedTs}
          onMessageSelected={setSelectedTs}
          olderAvailable={mainState.olderAvailable}
          loadingOlder={mainState.loadingOlder}
          onLoadOlder={handleLoadOlder}
          onOrchestratorClick={() => setOrchestratorModalOpen(true)}
          agentEventsCount={mainState.agentEvents.length}
          agentBusy={mainState.agentBusyCount > 0}
          onAddTaskToQueue={handleAddTaskToQueue}
          autoAnswer={autoAnswer}
          onAutoAnswerToggle={handleAutoAnswerToggle}
          onGuideClick={() => setGuideModalOpen(true)}
          guideAvailable={userGuide.trim().length > 0}
          onModelReportClick={() => void orch.send({ kind: "get_model_strength_report" })}
          onDastClick={sendRunDast}
          dastRunning={mainState.runningBanner?.label === "🛡️ Güvenlik Taraması (DAST)"}
        />
        {rightPanelsOpen && (
          <>
            <div className="divider" />
            <div className="panel-right-split">
              <TranslatorPanel
                entries={mainState.translations}
                modelLabel={translatorLabel}
                highlightWindow={highlightWindow}
              />
              <div className="divider-h" />
              <ClaudeSimulator
                events={mainState.ccEvents}
                banner={mainState.ccBanner}
                modelLabel={mainLabel}
                highlightWindow={highlightWindow}
              />
            </div>
          </>
        )}
      </div>
      {settingsView}
      <AgentThinkingModal
        open={orchestratorModalOpen}
        events={mainState.agentEvents}
        onClose={() => setOrchestratorModalOpen(false)}
      />
      <GuideModal
        open={guideModalOpen}
        content={userGuide}
        onClose={() => setGuideModalOpen(false)}
      />
      {/* 2026-06-11 (Ümit): Model Güç Raporu popup — GuideModal markdown gösterimini yeniden kullanır. */}
      <GuideModal
        open={modelReportOpen}
        content={modelReportText}
        onClose={() => setModelReportOpen(false)}
      />
      <TaskQueuePanel
        open={taskQueueOpen}
        items={mainState.taskQueue}
        currentPhase={mainState.phase}
        onClose={() => setTaskQueueOpen(false)}
        onItemApply={handleTaskApply}
        onItemDelete={handleTaskDelete}
      />
      <TokenTimelinePanel
        open={tokenTimelineOpen}
        costs={mainState.costTimeline}
        onClose={() => setTokenTimelineOpen(false)}
      />
      <ErrorDrawer
        open={errorDrawerOpen}
        errors={errorEntries}
        onClose={() => setErrorDrawerOpen(false)}
      />
    </div>
  );
}

export default App;
