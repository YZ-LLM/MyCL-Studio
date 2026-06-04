// AppHeader — Custom title bar (Tauri decorations:false + titleBarStyle: Overlay).
// macOS traffic lights overlay'de durur; biz sağa proje path + faz indicator
// yerleştiririz. -webkit-app-region: drag pencereyi sürüklenebilir yapar.

import { invoke } from "@tauri-apps/api/core";
import type { PhaseId, PhaseStatus } from "../types/events";
import { UpdateButton } from "./UpdateButton";

interface Props {
  projectPath: string;
  phase: PhaseId;
  status: PhaseStatus;
  onSettingsClick?: () => void;
  /** Tek tıkla "projeyi çalıştır" intent'i gönderir; LLM classifier'ı bypass etmez ama otomatik tetikler. */
  onExecuteClick?: () => void;
  executeDisabled?: boolean;
  /** Sağ panel (Translator + Claude Code) görünürlük toggle'ı. */
  onTogglePanelsClick?: () => void;
  rightPanelsOpen?: boolean;
  /** Sol panel (Faz Sidebar) görünürlük toggle'ı. */
  onToggleLeftClick?: () => void;
  leftPanelsOpen?: boolean;
  /** v15.7: İş kuyruğu drawer'ı toggle. Badge'de kuyruk sayısı görünür. */
  onToggleTaskQueueClick?: () => void;
  taskQueueOpen?: boolean;
  taskQueueCount?: number;
  /** v15.7 (2026-05-26): Session token totals (madde 13). null = badge hidden. */
  tokenTotals?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    api_calls: number;
  };
  /** Token-timeline: token badge'ine tıklanınca faz-bazında zaman çizelgesi drawer'ı toggle. */
  onTokenBadgeClick?: () => void;
  /** v15.7 (2026-05-27): Faz/durum badge'i tıklayınca alt hata çekmecesi toggle. */
  onPhaseIndicatorClick?: () => void;
  /** Hata sayısı — badge'de küçük rozet olarak görünür (0 ise gizli). */
  errorCount?: number;
}

const STATUS_LABEL: Record<PhaseStatus, string> = {
  running: "çalışıyor",
  waiting: "yanıt bekleniyor",
  complete: "tamamlandı",
  error: "hata",
};

export function AppHeader({
  projectPath,
  phase,
  status,
  onSettingsClick,
  onExecuteClick,
  executeDisabled,
  onTogglePanelsClick,
  rightPanelsOpen,
  onToggleLeftClick,
  leftPanelsOpen,
  onToggleTaskQueueClick,
  taskQueueOpen,
  taskQueueCount,
  tokenTotals,
  onTokenBadgeClick,
  onPhaseIndicatorClick,
  errorCount,
}: Props) {
  return (
    <header className="app-header" data-tauri-drag-region>
      <span className="app-title" data-tauri-drag-region>MyCL Studio</span>
      <span
        className="app-version"
        data-tauri-drag-region
        title="Çalışan build'in zamanı (yerel). Eski/yanlış build'i çalıştırıp çalıştırmadığını buradan anla."
      >
        {__BUILD_TIME__}
      </span>
      <span className="app-project-path" data-tauri-drag-region>
        <span data-tauri-drag-region>📁</span>
        <span data-tauri-drag-region>{projectPath}</span>
        <span className="lock" data-tauri-drag-region>🔒</span>
      </span>
      {onPhaseIndicatorClick ? (
        <button
          type="button"
          className={`app-phase-indicator ${status} clickable`}
          style={{ marginLeft: "auto" }}
          onClick={onPhaseIndicatorClick}
          title="Hata detaylarını aç/kapat"
          aria-label="Hata detayları"
        >
          {phase === 0 ? "MyCL · Debug" : `MyCL · Faz ${phase}`}
          {status !== "running" && ` — ${STATUS_LABEL[status]}`}
          {typeof errorCount === "number" && errorCount > 0 && (
            <span className="app-phase-error-count">{errorCount}</span>
          )}
        </button>
      ) : (
        <span
          className={`app-phase-indicator ${status}`}
          style={{ marginLeft: "auto" }}
          data-tauri-drag-region
        >
          {phase === 0 ? "MyCL · Debug" : `MyCL · Faz ${phase}`}
          {status !== "running" && ` — ${STATUS_LABEL[status]}`}
        </span>
      )}
      {onToggleLeftClick && (
        <button
          type="button"
          onClick={onToggleLeftClick}
          className="header-toggle-left-btn"
          title={leftPanelsOpen ? "Faz menüsünü gizle" : "Faz menüsünü göster"}
          aria-label={leftPanelsOpen ? "Faz menüsünü gizle" : "Faz menüsünü göster"}
        >
          📑
        </button>
      )}
      {onExecuteClick && (
        <button
          type="button"
          onClick={onExecuteClick}
          disabled={executeDisabled}
          className="header-execute-btn"
          title="Projeyi çalıştır (chat'e otomatik 'projeyi çalıştır' mesajı gönderir)"
          aria-label="Projeyi çalıştır"
        >
          ▶ Çalıştır
        </button>
      )}
      {onTogglePanelsClick && (
        <button
          type="button"
          onClick={onTogglePanelsClick}
          className="header-toggle-panels-btn"
          title={
            rightPanelsOpen
              ? "Sağ paneli gizle (Translator + Claude Code)"
              : "Sağ paneli göster"
          }
          aria-label={rightPanelsOpen ? "Sağ paneli gizle" : "Sağ paneli göster"}
        >
          {rightPanelsOpen ? "⇥" : "⇤"}
        </button>
      )}
      {/* v15.7 (2026-05-24): İş kuyruğu drawer toggle */}
      {onToggleTaskQueueClick && (
        <button
          type="button"
          onClick={onToggleTaskQueueClick}
          style={{
            fontSize: 12,
            background: taskQueueOpen ? "var(--accent-strong)" : "transparent",
            color: taskQueueOpen ? "white" : "inherit",
            border: "1px solid var(--border)",
            padding: "4px 10px",
            position: "relative",
          }}
          title="İş kuyruğunu aç/kapat"
        >
          📋 İş Kuyruğu
          {taskQueueCount !== undefined && taskQueueCount > 0 && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                padding: "1px 6px",
                background: taskQueueOpen ? "white" : "var(--accent)",
                color: taskQueueOpen ? "var(--accent-strong)" : "white",
                borderRadius: 8,
              }}
            >
              {taskQueueCount}
            </span>
          )}
        </button>
      )}
      {/* v15.2.2: Yeni pencere — multi-instance için kullanıcı tetikli */}
      <button
        type="button"
        onClick={async () => {
          try {
            await invoke("open_new_window");
          } catch (err) {
            console.error("open_new_window failed", err);
          }
        }}
        style={{
          fontSize: 12,
          background: "transparent",
          border: "1px solid var(--border)",
          padding: "4px 10px",
        }}
        title="Yeni MyCL Studio penceresi aç (farklı bir proje için)"
      >
        ➕ Yeni Pencere
      </button>
      <UpdateButton />
      {tokenTotals && tokenTotals.api_calls > 0 && (
        <button
          type="button"
          onClick={onTokenBadgeClick}
          title={`Bu oturum: ${tokenTotals.api_calls} API çağrısı\n• input: ${tokenTotals.input_tokens.toLocaleString()}\n• output: ${tokenTotals.output_tokens.toLocaleString()}\n• cache read: ${tokenTotals.cache_read_input_tokens.toLocaleString()}\n• cache create: ${tokenTotals.cache_creation_input_tokens.toLocaleString()}${onTokenBadgeClick ? "\n\n(tıkla: faz-bazında token zaman çizelgesi)" : ""}`}
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-dim)",
            background: "var(--bg-soft, transparent)",
            border: "1px solid var(--border)",
            padding: "3px 8px",
            borderRadius: 4,
            whiteSpace: "nowrap",
            cursor: onTokenBadgeClick ? "pointer" : "default",
          }}
        >
          Σ {(tokenTotals.input_tokens + tokenTotals.output_tokens).toLocaleString()}t · {tokenTotals.api_calls}c
        </button>
      )}
      {onSettingsClick && (
        <button
          type="button"
          onClick={onSettingsClick}
          aria-label="Ayarlar"
          style={{
            fontSize: 12,
            background: "transparent",
            border: "1px solid var(--border)",
            padding: "4px 10px",
          }}
          title="Ayarlar (Cmd+,)"
        >
          ⚙
        </button>
      )}
    </header>
  );
}
