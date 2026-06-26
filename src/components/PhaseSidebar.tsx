// PhaseSidebar — Sol panel: pipeline fazlarının tıklanabilir listesi.
//
// Niyetler bölümü (Soru Sor / Hata Ayıkla / Sohbet) buradan kaldırıldı;
// composer altına taşındı (ChatPanel.intent-row, kullanıcı talebi 2026-05-23).
// Sidebar artık sadece faz navigasyonu içerir, tüm 1-20 fazları listelenir.

import { useRef } from "react";
import type { PhaseId, PhaseSummary } from "../types/events";

const VISIBLE_PHASES: PhaseId[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
];

// v15.7 (2026-05-26): Zorunlu fazlar her geliştirmede çalışır. Opsiyoneller
// (5,6,7,8,9) orkestra ajanı tarafından Faz 1 sonrası kullanıcıya sorulur.
// Kaynak: backend phase-registry.ts (single source of truth) — burada sadece
// UI presentation cache'i. İki yerde tanımlı olduğu için değişirse senkron tut.
const REQUIRED_PHASES: ReadonlySet<PhaseId> = new Set([
  1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17,
]);

interface Props {
  phases: PhaseSummary[];
  currentPhase: PhaseId;
  disabled: boolean;
  /** ÇİFT tıklama → fazı çalıştır (eski tek-tık davranışı). */
  onPhaseClick: (id: PhaseId) => void;
  /** TEK tıklama → o fazın chat'teki ilk mesajına git (YZLLM: "tek tıklamaya başka görev veriyoruz"). */
  onPhaseNavigate?: (id: PhaseId) => void;
  /** Akış sonu hüküm: gate'i patlayan fazlar (soft-complete olsa da). Bu fazlar
   *  yeşil ✅ yerine ⚠️ gösterir — "sessiz yeşil" yalanını önler. */
  gateFailures?: PhaseId[];
  /** Ulaşılan en yüksek pipeline fazı — debug (Faz 0) sırasında "yarım kalan" fazı (⏸️) belirlemek için. */
  maxPhase: PhaseId;
}

/**
 * SAF: faz rozeti (YZLLM 2026-06-14). gate başarısızsa ⚠️ ("sessiz yeşil yalanı"nı önle — diğerlerini ezer).
 * Aksi halde: çalışan ▶️ (play), tamamlanan ✅ (yeşil — debug'a dönülse de KALIR), yarım kalan ⏸️ (pause),
 * henüz çalışmamış ⏹️ (stop). Debug'da (currentPhase=0) "ulaşılan" faz = maxPhase → ondan öncekiler ✅, o ⏸️.
 */
export function phaseBadge(
  id: PhaseId,
  currentPhase: PhaseId,
  gateFailed: boolean,
  maxPhase: PhaseId,
): string {
  if (gateFailed) return "⚠️";
  if (id === currentPhase) return "▶️"; // çalışan faz (play üçgeni)
  const reached = currentPhase === (0 as PhaseId) ? maxPhase : currentPhase;
  if (id < reached) return "✅"; // tamamlandı (yeşil kalır)
  if (id === reached) return "⏸️"; // yarım kaldı (debug'a/Faz 0'a gidildi)
  return "⏹️"; // henüz çalışmadı (stop karesi)
}

export function PhaseSidebar({
  phases,
  currentPhase,
  disabled,
  onPhaseClick,
  onPhaseNavigate,
  gateFailures,
  maxPhase,
}: Props) {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const failedSet = new Set(gateFailures ?? []);
  // Tek/çift tıklama ayrımı (300ms): tek → navigate (mesaja git), çift → çalıştır. React çift-tıkta iki
  // onClick + bir onDoubleClick atar; ilk onClick timer kurar, ikinci onClick timer'ı iptal eder, onDoubleClick çalıştırır.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSingle = (id: PhaseId): void => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return; // ikinci tık → çift tıklama; onDoubleClick halleder
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onPhaseNavigate?.(id);
    }, 280);
  };
  const handleDouble = (id: PhaseId): void => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (!disabled) onPhaseClick(id); // çalıştırma yalnız müsaitken (navigate hep çalışır)
  };
  return (
    <aside className="phase-sidebar" data-testid="phase-sidebar">
      <div className="phase-sidebar-header">Fazlar</div>
      <div className="phase-sidebar-list">
        {/* Faz 0 — Hata Ayıklama (Debug Triage). Pipeline DIŞI/standalone; en üstte,
            ayrı 🐛 rozetiyle. Tek başına "çalıştır" akışı yok — tıklanınca kullanıcıya
            hatayı chat'e yazması söylenir (orchestrator otomatik debug_triage'a yönlendirir). */}
        {(() => {
          const p0 = byId.get(0 as PhaseId);
          const p0Name = p0?.name_tr ?? p0?.name_en ?? "Hata Ayıklama";
          const isCurrent0 = currentPhase === (0 as PhaseId);
          return (
            <button
              type="button"
              data-testid="phase-item-0"
              className={`phase-item standalone${isCurrent0 ? " current" : ""}`}
              disabled={disabled}
              onClick={() => onPhaseClick(0 as PhaseId)}
              title="Faz 0 — Hata Ayıklama (Debug Triage). Pipeline dışı, standalone. Yaşadığın hatayı chat'e yaz; debug akışı otomatik başlar."
            >
              <span className="phase-badge" aria-hidden>
                {isCurrent0 ? "▶️" : "🐛"}
              </span>
              <div className="phase-text">
                <div className="phase-label">Faz 0</div>
                <div className="phase-name">{p0Name}</div>
              </div>
            </button>
          );
        })()}
        {VISIBLE_PHASES.map((id) => {
          const p = byId.get(id);
          const gateFailed = failedSet.has(id);
          const badge = phaseBadge(id, currentPhase, gateFailed, maxPhase);
          const name = p?.name_tr ?? p?.name_en ?? `Faz ${id}`;
          const typeLabel = p?.type ?? "";
          const isCurrent = id === currentPhase;
          const isRequired = REQUIRED_PHASES.has(id);
          return (
            <button
              key={id}
              type="button"
              data-testid={`phase-item-${id}`}
              className={`phase-item${isCurrent ? " current" : ""}${isRequired ? " required" : ""}${gateFailed ? " gate-failed" : ""}`}
              onClick={() => handleSingle(id)}
              onDoubleClick={() => handleDouble(id)}
              title={`Faz ${id} — ${typeLabel}${isRequired ? " (zorunlu)" : " (opsiyonel)"}. TEK tık: bu fazın chat'teki ilk mesajına git · ÇİFT tık: fazı çalıştır${gateFailed ? " — ⚠ bu gate başarısız (akış soft devam etti, sonuç tam doğrulanmadı)" : ""}`}
            >
              <span className="phase-badge" aria-hidden>
                {badge}
              </span>
              <div className="phase-text">
                <div className="phase-label">Faz {id}</div>
                <div className="phase-name">{name}</div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
