// AppHeader — Custom title bar (Tauri decorations:false + titleBarStyle: Overlay).
// macOS traffic lights overlay'de durur; biz sağa proje path + faz indicator yerleştiririz.
// -webkit-app-region: drag pencereyi sürüklenebilir yapar.
//
// YZLLM 2026-06-17: AKSIYON butonları (Çalıştır/Duraklat/panel-toggle/İş Kuyruğu/Yeni Pencere/
// Token/Ayarlar) buradan SAĞ DİKEY bara (RightActionBar) taşındı. AppHeader artık YALNIZ bilgi:
// başlık + build-zamanı + proje yolu + o anki iş + faz göstergesi + akış hükmü.

import type { PhaseId, PhaseStatus } from "../types/events";

interface Props {
  projectPath: string;
  phase: PhaseId;
  status: PhaseStatus;
  /** v15.7 (2026-05-27): Faz/durum badge'i tıklayınca alt hata çekmecesi toggle. */
  onPhaseIndicatorClick?: () => void;
  /** Hata sayısı — badge'de küçük rozet olarak görünür (0 ise gizli). */
  errorCount?: number;
  /** Akış sonu DÜRÜST hüküm. PARTIAL/FAIL ise faz göstergesinin yanında çip. */
  pipelineVerdict?: "PASS" | "PARTIAL" | "FAIL" | null;
}

/** Hüküm çipi metni — geliştiricinin dilinde (TR). PASS/null → çip yok. */
const VERDICT_CHIP: Record<"PARTIAL" | "FAIL", string> = {
  PARTIAL: "⚠ kısmî",
  FAIL: "✕ başarısız",
};

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
  onPhaseIndicatorClick,
  errorCount,
  pipelineVerdict,
}: Props) {
  const verdictChip =
    pipelineVerdict === "PARTIAL" || pipelineVerdict === "FAIL"
      ? VERDICT_CHIP[pipelineVerdict]
      : null;
  return (
    <header className="app-header" data-testid="app-header" data-tauri-drag-region>
      <img
        src="/mycl-logo.png"
        className="app-logo"
        alt=""
        width={20}
        height={20}
        data-tauri-drag-region
      />
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
      {/* YZLLM 2026-06-27: üst bardaki KONU (currentJob) kaldırıldı — kullanıcı "üstteki konuyu yazma oraya" dedi;
          konu artık yalnız chat panelinin solunda (tek yer, ChatPanel.panel-label). */}
      {onPhaseIndicatorClick ? (
        <button
          type="button"
          data-testid="phase-indicator"
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
          data-testid="phase-indicator"
          className={`app-phase-indicator ${status}`}
          style={{ marginLeft: "auto" }}
          data-tauri-drag-region
        >
          {phase === 0 ? "MyCL · Debug" : `MyCL · Faz ${phase}`}
          {status !== "running" && ` — ${STATUS_LABEL[status]}`}
        </span>
      )}
      {verdictChip && (
        <span
          className={`app-verdict-chip ${pipelineVerdict === "FAIL" ? "fail" : "partial"}`}
          title="Akış sonu dürüst hüküm: en az bir kalite-gate'i geçemedi / güvenlik taraması atlandı — sonuç tam doğrulanmadı. Detay: chat akış özeti + soldaki ⚠️ fazlar."
        >
          {verdictChip}
        </span>
      )}
    </header>
  );
}
