// RightActionBar — YZLLM 2026-06-17: AppHeader'daki aksiyon butonları (Çalıştır/Duraklat/
// panel-toggle/İş Kuyruğu/Yeni Pencere/Token/Ayarlar) sağ kenarda DİKEY bir bara taşındı.
// AppHeader artık yalnız bilgi (başlık/proje/faz); aksiyonlar burada alt-alta. Handler'lar
// App.tsx'ten prop olarak gelir (davranış aynı, yalnız konum/yerleşim değişti).

import { invoke } from "@tauri-apps/api/core";
import { UpdateButton } from "./UpdateButton";

/** Sağ panelde aynı anda yalnız biri açık olabilen üç ajan görünümü. */
export type RightPanel = "main" | "translator" | "orchestrator";

/** Main Ajan (Claude Code) için ciddi AI ikonu — inline SVG (currentColor → dark/light uyumlu). 4-köşeli
 *  sparkle, modern AI işareti (robot emoji değil; YZLLM: "ciddi iş yapıyoruz"). */
function AiIcon() {
  return (
    <svg className="rab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 1.7c.33 3.7 1.5 6.2 3.5 7.7 1.45 1.05 3.3 1.7 6.1 1.9-2.8.2-4.65.85-6.1 1.9-2 1.5-3.17 4-3.5 7.7-.33-3.7-1.5-6.2-3.5-7.7-1.45-1.05-3.3-1.7-6.1-1.9 2.8-.2 4.65-.85 6.1-1.9 2-1.5 3.17-4 3.5-7.7z" />
    </svg>
  );
}

interface Props {
  onExecuteClick?: () => void;
  executeDisabled?: boolean;
  onPauseToggle?: () => void;
  paused?: boolean;
  /** Sağ panelde şu an açık olan ajan görünümü (null → kapalı). */
  activeRightPanel?: RightPanel | null;
  /** Bir ajan butonuna basıldı — App toggle eder (aynıysa kapat, farklıysa o panele geç). */
  onRightPanelToggle?: (panel: RightPanel) => void;
  onToggleLeftClick?: () => void;
  leftPanelsOpen?: boolean;
  onToggleTaskQueueClick?: () => void;
  taskQueueOpen?: boolean;
  taskQueueCount?: number;
  tokenTotals?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    api_calls: number;
  };
  onTokenBadgeClick?: () => void;
  onSettingsClick?: () => void;
}

export function RightActionBar({
  onExecuteClick,
  executeDisabled,
  onPauseToggle,
  paused,
  activeRightPanel,
  onRightPanelToggle,
  onToggleLeftClick,
  leftPanelsOpen,
  onToggleTaskQueueClick,
  taskQueueOpen,
  taskQueueCount,
  tokenTotals,
  onTokenBadgeClick,
  onSettingsClick,
}: Props) {
  return (
    <nav className="right-action-bar" data-testid="right-action-bar" aria-label="Eylemler">
      {onExecuteClick && (
        <button
          type="button"
          onClick={onExecuteClick}
          disabled={executeDisabled}
          className="rab-btn rab-execute"
          data-testid="execute-btn"
          title="Projeyi çalıştır (chat'e otomatik 'projeyi çalıştır' mesajı gönderir)"
          aria-label="Projeyi çalıştır"
        >
          ▶ Çalıştır
        </button>
      )}
      {onPauseToggle && (
        <button
          type="button"
          onClick={onPauseToggle}
          className={`rab-btn${paused ? " rab-active" : ""}`}
          data-testid="pause-btn"
          title={
            paused
              ? "Devam et — kaldığı yerden sürer"
              : "Duraklat — yeni LLM çağrısı başlatmaz (mevcut tur bitince durur), token yakmaz"
          }
          aria-label={paused ? "Devam et" : "Duraklat"}
        >
          {paused ? "▶ Devam" : "⏸ Duraklat"}
        </button>
      )}
      {onToggleTaskQueueClick && (
        <button
          type="button"
          onClick={onToggleTaskQueueClick}
          className={`rab-btn${taskQueueOpen ? " rab-active" : ""}`}
          title="İş kuyruğunu aç/kapat"
          aria-label="İş kuyruğu"
        >
          📋 İş Kuyruğu
          {taskQueueCount !== undefined && taskQueueCount > 0 && (
            <span className="rab-badge">{taskQueueCount}</span>
          )}
        </button>
      )}
      {onRightPanelToggle && (
        <>
          <button
            type="button"
            onClick={() => onRightPanelToggle("main")}
            className={`rab-btn${activeRightPanel === "main" ? " rab-active" : ""}`}
            data-testid="panel-main-btn"
            title="Main Ajanı (Claude Code — kod yazan ajan) panelini aç/kapat"
            aria-label="Main Ajan paneli"
          >
            <AiIcon /> Main Ajan
          </button>
          <button
            type="button"
            onClick={() => onRightPanelToggle("translator")}
            className={`rab-btn${activeRightPanel === "translator" ? " rab-active" : ""}`}
            data-testid="panel-translator-btn"
            title="Çeviri Ajanı (TR↔EN) panelini aç/kapat"
            aria-label="Çeviri Ajanı paneli"
          >
            🌐 Çeviri Ajanı
          </button>
          <button
            type="button"
            onClick={() => onRightPanelToggle("orchestrator")}
            className={`rab-btn${activeRightPanel === "orchestrator" ? " rab-active" : ""}`}
            data-testid="panel-orchestrator-btn"
            title="Orkestra Ajanı — orkestratörün tüm önemli kararları panelini aç/kapat"
            aria-label="Orkestra Ajanı paneli"
          >
            🧠 Orkestra Ajanı
          </button>
        </>
      )}
      {onToggleLeftClick && (
        <button
          type="button"
          onClick={onToggleLeftClick}
          className="rab-btn"
          title={leftPanelsOpen ? "Faz menüsünü gizle" : "Faz menüsünü göster"}
          aria-label={leftPanelsOpen ? "Faz menüsünü gizle" : "Faz menüsünü göster"}
        >
          📑 Faz Menüsü
        </button>
      )}
      <button
        type="button"
        data-testid="new-window-btn"
        onClick={async () => {
          try {
            await invoke("open_new_window");
          } catch (err) {
            console.error("open_new_window failed", err);
          }
        }}
        className="rab-btn"
        title="Yeni MyCL Studio penceresi aç (farklı bir proje için)"
        aria-label="Yeni pencere"
      >
        ➕ Yeni Pencere
      </button>

      <div className="rab-spacer" />

      <UpdateButton />
      {tokenTotals && tokenTotals.api_calls > 0 && (
        <button
          type="button"
          onClick={onTokenBadgeClick}
          className="rab-btn rab-token"
          title={`Bu oturum: ${tokenTotals.api_calls} API çağrısı\n• input: ${tokenTotals.input_tokens.toLocaleString()}\n• output: ${tokenTotals.output_tokens.toLocaleString()}\n• cache read: ${tokenTotals.cache_read_input_tokens.toLocaleString()}\n• cache create: ${tokenTotals.cache_creation_input_tokens.toLocaleString()}${onTokenBadgeClick ? "\n\n(tıkla: faz-bazında token zaman çizelgesi)" : ""}`}
          aria-label="Token özeti / zaman çizelgesi"
        >
          Σ {(tokenTotals.input_tokens + tokenTotals.output_tokens).toLocaleString()}t · {tokenTotals.api_calls}c
        </button>
      )}
      {onSettingsClick && (
        <button
          type="button"
          onClick={onSettingsClick}
          data-testid="settings-btn"
          className="rab-btn rab-settings"
          aria-label="Ayarlar"
          title="Ayarlar (Cmd+,)"
        >
          ⚙ Ayarlar
        </button>
      )}
    </nav>
  );
}
