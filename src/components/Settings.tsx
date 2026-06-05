// Settings — ayarlar paneli. Tab'lar: Modeller, API Keys, Hakkında.

import { useEffect, useMemo, useState } from "react";
import { t as i18nT } from "../i18n";
import type { ModelInfo, AgentBackend, AgentBackends, ModelTiers, DesignWorkflowMode } from "../types/events";
import { isAutoUpdateOnBootEnabled } from "./UpdateButton";

/**
 * Hakkında tab'ında auto-update toggle — localStorage flag (L8).
 * Default true; user kapatabilir.
 */
function AutoUpdateToggle() {
  const [enabled, setEnabled] = useState(isAutoUpdateOnBootEnabled());
  const onToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.checked;
    setEnabled(v);
    try {
      localStorage.setItem("mycl.auto_update_on_boot", v ? "true" : "false");
    } catch {
      // localStorage erişimi başarısızsa sessizce yut
    }
  };
  return (
    <p style={{ marginTop: 12 }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span>Açılışta otomatik güncelle</span>
      </label>
      <span style={{ display: "block", fontSize: 10, color: "var(--fg-dim)", marginTop: 4 }}>
        Kaynak değiştiğinde uygulama açılırken 1.5 sn sonra rebuild + restart başlar.
        Kapatırsan sağ üst ↻ butonuyla manuel yaparsın.
      </span>
    </p>
  );
}

type Tab = "models" | "api_keys" | "features" | "about";

interface ModelsList {
  models: ModelInfo[];
  fetched_at: number;
  loading: boolean;
}

interface Props {
  open: boolean;
  initialTab?: Tab;
  /** Settings ekranı zorla açıldıysa (model selection missing gibi) kapatılamasın. */
  forceModelSetup?: boolean;
  currentSelected: { translator?: string; main?: string; orchestrator?: string } | null;
  modelsTranslator: ModelsList;
  modelsMain: ModelsList;
  onFetchModels: (which: "translator" | "main", force: boolean) => void;
  onSaveModels: (
    translator: string,
    main: string,
    orchestrator?: string,
    effort?: string,
    backends?: AgentBackends,
    modelTiers?: ModelTiers,
    designWorkflow?: DesignWorkflowMode,
    agentTeamsOptIn?: boolean,
  ) => void;
  /** v15.8: rol başına backend (api/cli) mevcut değerleri — seçiciler için. */
  currentBackends?: AgentBackends;
  onSaveApiKeys: (translator: string, main: string, orchestrator?: string) => void;
  onClose: () => void;
  savingModels: boolean;
  savingKeys: boolean;
  errorDetail?: string;
  /** v15.7 (2026-05-25): Feature flags */
  features?: { playwright_enabled: boolean };
  onSaveFeatures?: (features: { playwright_enabled?: boolean }) => void;
  /** v15.8 (2026-05-30): Main model efor seçimi (CLI backend için). */
  effort?: string;
  /** v15.13 (auto-model): mevcut iş-seviyesi model katmanları (seçiciler için). */
  currentModelTiers?: ModelTiers;
  /** v15.13: mevcut çok-ajanlı tasarım fan-out kapsamı. */
  currentDesignWorkflow?: DesignWorkflowMode;
  /** v15.13: mevcut Agent Teams müzakere opt-in. */
  currentAgentTeamsOptIn?: boolean;
}

function ModelDropdown({
  label,
  selected,
  models,
  loading,
  onChange,
  onRefresh,
}: {
  label: string;
  selected: string | undefined;
  models: ModelInfo[];
  loading: boolean;
  onChange: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: "var(--fg-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          value={selected ?? ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={loading || models.length === 0}
          style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}
        >
          {!selected && <option value="">— seçin —</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name} ({m.id})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          style={{ fontSize: 11 }}
          title="Modelleri yeniden çek"
        >
          {loading ? "..." : "↻"}
        </button>
      </div>
      <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
        {loading
          ? "Modeller yükleniyor..."
          : models.length === 0
            ? "Liste boş — 'Yenile' butonuna basın"
            : `${models.length} model · en yeni başta`}
      </span>
    </div>
  );
}

/**
 * v15.8: Rol başına backend seçici — API (Anthropic SDK, faturalı) vs Claude Code
 * Aboneliği (`claude` CLI, abonelikle çalışır, API faturası yok). Her ajan ayrı.
 */
function BackendSelector({
  value,
  onChange,
}: {
  value: AgentBackend;
  onChange: (v: AgentBackend) => void;
}) {
  const LABELS: Record<AgentBackend, string> = {
    api: "API",
    cli: "Abonelik (CLI)",
    auto: "Auto",
  };
  const TITLES: Record<AgentBackend, string> = {
    api: "Anthropic API (API key gerekir, çağrı başına faturalı)",
    cli: "Claude Code Aboneliği — `claude` CLI ile çalışır, API faturası yok (abonelik kullanılır)",
    auto: "Auto Mode — Claude Code Aboneliği (CLI) ile başlar; abonelik limiti dolunca otomatik API'ye geçer, limit açılınca CLI'ye döner.",
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      {(["api", "cli", "auto"] as const).map((b) => {
        const active = value === b;
        return (
          <button
            key={b}
            type="button"
            onClick={() => onChange(b)}
            style={{
              flex: 1,
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 5,
              cursor: "pointer",
              border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: active ? "var(--accent-dim, rgba(80,160,255,0.15))" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-dim)",
              fontWeight: active ? 600 : 400,
            }}
            title={TITLES[b]}
          >
            {LABELS[b]}
          </button>
        );
      })}
    </div>
  );
}

export function Settings({
  open,
  initialTab = "models",
  forceModelSetup,
  currentSelected,
  modelsTranslator,
  modelsMain,
  onFetchModels,
  onSaveModels,
  onSaveApiKeys,
  onClose,
  savingModels,
  savingKeys,
  errorDetail,
  features,
  onSaveFeatures,
  effort,
  currentBackends,
  currentModelTiers,
  currentDesignWorkflow,
  currentAgentTeamsOptIn,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [translatorSel, setTranslatorSel] = useState<string>(
    currentSelected?.translator ?? "",
  );
  const [mainSel, setMainSel] = useState<string>(currentSelected?.main ?? "");
  // v15.5 Orkestrator agent — opsiyonel; boş bırakılırsa main model fallback.
  const [orchestratorSel, setOrchestratorSel] = useState<string>(
    currentSelected?.orchestrator ?? "",
  );
  // v15.8 (2026-05-30): Main model efor seçimi (CLI backend için).
  const [effortSel, setEffortSel] = useState<string>(effort ?? "max");
  // v15.8: rol başına backend (api/cli). Default hepsi "api" (bugünkü SDK).
  const DEFAULT_BACKENDS: AgentBackends = {
    orchestrator: "api",
    translator: "api",
    main: "api",
  };
  const [backends, setBackends] = useState<AgentBackends>(
    currentBackends ?? DEFAULT_BACKENDS,
  );
  const setBackend = (role: keyof AgentBackends, v: AgentBackend) =>
    setBackends((prev) => ({ ...prev, [role]: v }));
  // v15.13 (auto-model + çok-ajanlı tasarım): iş-seviyesi model katmanları + tasarım flag'leri.
  const [modelTiersSel, setModelTiersSel] = useState<ModelTiers>(currentModelTiers ?? {});
  const setTier = (tier: keyof ModelTiers, v: string) =>
    setModelTiersSel((prev) => ({ ...prev, [tier]: v || undefined }));
  const [designWorkflowSel, setDesignWorkflowSel] = useState<DesignWorkflowMode>(
    currentDesignWorkflow ?? "off",
  );
  const [agentTeamsOptInSel, setAgentTeamsOptInSel] = useState<boolean>(
    currentAgentTeamsOptIn ?? false,
  );

  // API Keys form state
  const [apiKeyTranslator, setApiKeyTranslator] = useState("");
  const [apiKeyMain, setApiKeyMain] = useState("");
  // v15.5 Orkestrator agent API key — opsiyonel; explicit set edilirse agent
  // aktif olur, boş bırakılırsa klasik Haiku classifier kullanılır.
  const [apiKeyOrchestrator, setApiKeyOrchestrator] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  // Modeller tabı ilk açılıştaysa auto-fetch.
  useEffect(() => {
    if (!open) return;
    if (tab === "models") {
      if (modelsTranslator.models.length === 0 && !modelsTranslator.loading) {
        onFetchModels("translator", false);
      }
      if (modelsMain.models.length === 0 && !modelsMain.loading) {
        onFetchModels("main", false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  // Current selected değişince form state'i güncelle.
  useEffect(() => {
    setTranslatorSel(currentSelected?.translator ?? "");
    setMainSel(currentSelected?.main ?? "");
    setOrchestratorSel(currentSelected?.orchestrator ?? "");
  }, [currentSelected]);
  // v15.8: efor prop'u değişince senkronize et.
  useEffect(() => {
    if (effort) setEffortSel(effort);
  }, [effort]);
  // v15.8: rol-backend'leri prop'u (config'ten) değişince senkronize et.
  useEffect(() => {
    if (currentBackends) setBackends(currentBackends);
  }, [currentBackends]);

  const modelsValid = translatorSel && mainSel;
  const apiKeysValid =
    apiKeyTranslator.trim().startsWith("sk-ant-") &&
    apiKeyMain.trim().startsWith("sk-ant-");

  const overlayStyle = useMemo(
    () => ({
      position: "fixed" as const,
      inset: 0,
      background: "rgba(0,0,0,0.7)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }),
    [],
  );

  // ESC tuşu ile kapat (forceModelSetup hariç). Bu hook erken return'den ÖNCE
  // olmalı — Hooks Rules: aynı sırada her render.
  useEffect(() => {
    if (!open || forceModelSetup) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, forceModelSetup, onClose]);

  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={forceModelSetup ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 24,
          width: 560,
          maxWidth: "90vw",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <h2 id="settings-title" style={{ margin: 0, fontSize: 18, color: "var(--fg-bright)" }}>
            {i18nT("settings.title")}
          </h2>
          {!forceModelSetup && (
            <button
              type="button"
              onClick={onClose}
              style={{
                marginLeft: "auto",
                fontSize: 12,
                background: "transparent",
                border: "1px solid var(--border)",
              }}
            >
              {i18nT("settings.close")}
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid var(--border)" }}>
          {(["models", "api_keys", "features", "about"] as Tab[]).map((tabId) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setTab(tabId)}
              style={{
                background: tab === tabId ? "var(--bg-elev)" : "transparent",
                borderBottom: tab === tabId ? "2px solid var(--accent)" : "2px solid transparent",
                border: "none",
                padding: "8px 14px",
                fontSize: 13,
                color: tab === tabId ? "var(--fg-bright)" : "var(--fg-dim)",
                cursor: "pointer",
              }}
            >
              {i18nT(`settings.tab.${tabId}`)}
            </button>
          ))}
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {tab === "models" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>
                Translator: Phase 1 (askq) + TR↔EN çeviri için kullanılır. Main: Phase 4/9
                (production, codegen) için kullanılır. Liste Anthropic API'den çekilir.
              </p>
              <div>
                <ModelDropdown
                  label="Translator Modeli"
                  selected={translatorSel}
                  models={modelsTranslator.models}
                  loading={modelsTranslator.loading}
                  onChange={setTranslatorSel}
                  onRefresh={() => onFetchModels("translator", true)}
                />
                <BackendSelector
                  value={backends.translator}
                  onChange={(v) => setBackend("translator", v)}
                />
              </div>
              <div>
                <ModelDropdown
                  label="Main Modeli"
                  selected={mainSel}
                  models={modelsMain.models}
                  loading={modelsMain.loading}
                  onChange={setMainSel}
                  onRefresh={() => onFetchModels("main", true)}
                />
                <BackendSelector
                  value={backends.main}
                  onChange={(v) => setBackend("main", v)}
                />
              </div>
              {/* v15.5 Orkestrator Agent Model — opsiyonel. Main model
                  fallback olduğundan boş bırakılabilir. */}
              <div>
                <ModelDropdown
                  label="Orkestrator Ajan Model (opsiyonel)"
                  selected={orchestratorSel || undefined}
                  models={modelsMain.models}
                  loading={modelsMain.loading}
                  onChange={setOrchestratorSel}
                  onRefresh={() => onFetchModels("main", true)}
                />
                <BackendSelector
                  value={backends.orchestrator}
                  onChange={(v) => setBackend("orchestrator", v)}
                />
              </div>
              <p style={{ fontSize: 10, color: "var(--fg-dim)", margin: 0 }}>
                Boş bırakırsan main model kullanılır. Agent kullanıcı niyetini
                doğru anlamak için daha güçlü model seçilebilir (örn. Opus).
                <br />
                <strong>Backend</strong>: API = Anthropic (çağrı başına faturalı);
                Claude Code Aboneliği = `claude` CLI ile çalışır, API faturası yok
                (abonelik kullanılır). Her ajan ayrı ayarlanır.
              </p>
              {/* v15.8 (2026-05-30): Main model efor seçimi — Claude Code CLI
                  backend aktifse `--effort` olarak kullanılır. */}
              <div style={{ marginTop: 4 }}>
                <label
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--fg-dim)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Main Model Eforu (CLI aktifse)
                </label>
                <select
                  value={effortSel}
                  onChange={(e) => setEffortSel(e.target.value)}
                  style={{ width: "100%" }}
                >
                  {(["low", "medium", "high", "xhigh", "max", "ultracode"] as const).map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </select>
                <p style={{ fontSize: 10, color: "var(--fg-dim)", margin: "4px 0 0" }}>
                  Sadece Main backend "Claude Code Aboneliği" seçiliyken etkili.
                  Yüksek efor = daha derin akıl yürütme, daha çok token.
                  <strong> ultracode</strong> = xhigh + dinamik iş akışları; yalnızca Opus 4.7/4.8.
                </p>
              </div>
              {/* v15.13: Çok-ajanlı tasarım (deneysel) — Faz 5 tasarım paneli + auto-model katmanları. */}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <label
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--fg-dim)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Çok-ajanlı tasarım (deneysel)
                </label>
                <select
                  value={designWorkflowSel}
                  onChange={(e) => setDesignWorkflowSel(e.target.value as DesignWorkflowMode)}
                  style={{ width: "100%" }}
                >
                  <option value="off">Tasarım paneli: kapalı</option>
                  <option value="create-only">Tasarım paneli: yalnız yeni proje (önerilen)</option>
                  <option value="always">Tasarım paneli: her Faz 5</option>
                </select>
                <p style={{ fontSize: 10, color: "var(--fg-dim)", margin: "4px 0 0" }}>
                  Faz 5'te architect/ux/security/data perspektifleri paralel → sentez → tasarım planı (.mycl/design.md).
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={agentTeamsOptInSel}
                    onChange={(e) => setAgentTeamsOptInSel(e.target.checked)}
                  />
                  Tasarım çatışmalarını gerçek Agent Teams müzakeresiyle çöz (abonelik; ek maliyet)
                </label>
                <p
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--fg-dim)",
                    margin: "8px 0 4px",
                  }}
                >
                  İş-seviyesi modelleri (boş = main)
                </p>
                {(["strong", "balanced", "cheap"] as const).map((tier) => (
                  <div key={tier} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, width: 72, color: "var(--fg-dim)" }}>{tier}</span>
                    <select
                      value={modelTiersSel[tier] ?? ""}
                      onChange={(e) => setTier(tier, e.target.value)}
                      style={{ flex: 1 }}
                    >
                      <option value="">(main)</option>
                      {modelsMain.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name || m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <p style={{ fontSize: 10, color: "var(--fg-dim)", margin: "2px 0 0" }}>
                  Fan-out rolleri işe göre OTOMATİK dağıtılır: architect/synthesizer/verifier→strong,
                  ux/security/data→balanced.
                </p>
              </div>
              <button
                type="button"
                className="primary"
                disabled={!modelsValid || savingModels}
                onClick={() =>
                  onSaveModels(
                    translatorSel,
                    mainSel,
                    orchestratorSel.trim() || undefined,
                    effortSel,
                    backends,
                    modelTiersSel,
                    designWorkflowSel,
                    agentTeamsOptInSel,
                  )
                }
              >
                {savingModels ? "Kaydediliyor..." : "Modelleri Kaydet"}
              </button>
              {errorDetail && (
                <p style={{ fontSize: 12, color: "var(--error)", margin: 0 }}>
                  {errorDetail}
                </p>
              )}
            </div>
          )}

          {tab === "api_keys" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>
                İki ayrı Anthropic API key. Translator hafif çağrılar için (Phase 1),
                main üretim fazları için. <strong>~/.mycl/secrets.json</strong> chmod
                600 olarak kaydedilir.
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                  Translator API Key
                </span>
                <input
                  type={showSecret ? "text" : "password"}
                  placeholder="sk-ant-..."
                  value={apiKeyTranslator}
                  onChange={(e) => setApiKeyTranslator(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                  Main API Key
                </span>
                <input
                  type={showSecret ? "text" : "password"}
                  placeholder="sk-ant-..."
                  value={apiKeyMain}
                  onChange={(e) => setApiKeyMain(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
              </label>
              {/* v15.5 Orkestrator Agent API Key — opsiyonel. Explicit set ise
                  agent aktif, yoksa klasik Haiku classifier kullanılır. */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                  Orkestrator Ajan API Key (opsiyonel)
                </span>
                <input
                  type={showSecret ? "text" : "password"}
                  placeholder="sk-ant-... (boş bırak → klasik classifier kullanılır)"
                  value={apiKeyOrchestrator}
                  onChange={(e) => setApiKeyOrchestrator(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
                <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                  Ayarlanırsa agent her mesajı main model ile yorumlar — daha
                  akıllı niyet anlama, askq atlama, Phase 6'da "onayla" direkt
                  approve. Latency +3-6sn her mesaj için.
                </span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--fg-dim)" }}>
                <input
                  type="checkbox"
                  checked={showSecret}
                  onChange={(e) => setShowSecret(e.target.checked)}
                />
                Key'leri göster
              </label>
              <button
                type="button"
                className="primary"
                disabled={!apiKeysValid || savingKeys}
                onClick={() =>
                  onSaveApiKeys(
                    apiKeyTranslator.trim(),
                    apiKeyMain.trim(),
                    apiKeyOrchestrator.trim() || undefined,
                  )
                }
              >
                {savingKeys ? "Kaydediliyor..." : "API Key'leri Kaydet"}
              </button>
              <p style={{ fontSize: 11, color: "var(--fg-dim)", margin: 0 }}>
                Key'leri <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>console.anthropic.com</a>'dan alabilirsiniz.
              </p>
            </div>
          )}

          {tab === "features" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>
                Pipeline özellikleri açıp kapatabilirsin. Kapalı özellikler
                ilgili fazlarda atlanır.
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: 12,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={features?.playwright_enabled ?? true}
                  onChange={(e) =>
                    onSaveFeatures?.({ playwright_enabled: e.target.checked })
                  }
                  style={{ width: 18, height: 18 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: "var(--fg-bright)" }}>
                    🎭 Playwright (E2E Testler)
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--fg-dim)",
                      marginTop: 2,
                    }}
                  >
                    Açık: Faz 16 E2E testleri Playwright ile çalışır, Faz 5
                    codegen `@playwright/test` install eder. Kapalı: Faz 16
                    atlanır, install yapılmaz.
                  </div>
                </div>
              </label>

              {/* v15.8: Claude Code CLI backend artık Modeller sekmesinde rol
                  başına seçilir (her ajan için API / Claude Code Aboneliği).
                  Eski tek-checkbox kaldırıldı — main backend seçici devraldı. */}
              <p style={{ fontSize: 11, color: "var(--fg-dim)", margin: 0 }}>
                🤖 Backend seçimi (API / Claude Code Aboneliği) artık her ajan için
                ayrı ayrı <strong>Modeller</strong> sekmesinde yapılır.
              </p>
            </div>
          )}

          {tab === "about" && (
            <div style={{ fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.7 }}>
              <p><strong style={{ color: "var(--fg-bright)" }}>MyCL Studio v14</strong> · 0.1.0-e1</p>
              <AutoUpdateToggle />
              <p style={{ marginTop: 12 }}>Log dosyaları:</p>
              <ul style={{ fontFamily: "var(--font-mono)", fontSize: 11, paddingLeft: 18 }}>
                <li>~/.mycl/trace.log (boot)</li>
                <li>&lt;project&gt;/.mycl/trace.log (per-proje)</li>
                <li>~/.mycl/tauri-stderr.log (Tauri Rust stderr)</li>
              </ul>
              <p>Ayarlar: ~/.mycl/config.json (chmod 600)</p>
              <p>Secrets: ~/.mycl/secrets.json (chmod 600)</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
