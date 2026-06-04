// PhaseSidebar — Sol panel: pipeline fazlarının tıklanabilir listesi.
//
// Niyetler bölümü (Soru Sor / Hata Ayıkla / Sohbet) buradan kaldırıldı;
// composer altına taşındı (ChatPanel.intent-row, kullanıcı talebi 2026-05-23).
// Sidebar artık sadece faz navigasyonu içerir, tüm 1-20 fazları listelenir.

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
  onPhaseClick: (id: PhaseId) => void;
  /** Akış sonu hüküm: gate'i patlayan fazlar (soft-complete olsa da). Bu fazlar
   *  yeşil ✅ yerine ⚠️ gösterir — "sessiz yeşil" yalanını önler. */
  gateFailures?: PhaseId[];
}

/**
 * SAF: faz rozeti. gate başarısızsa ⚠️ (ordinal ✅'yi ezer — soft-complete olsa
 * da gate patladıysa yeşil DEME). Aksi halde ordinal: geçmiş ✅, current 🔵, ileri 🔘.
 */
export function phaseBadge(
  id: PhaseId,
  currentPhase: PhaseId,
  gateFailed: boolean,
): string {
  if (gateFailed) return "⚠️";
  return id < currentPhase ? "✅" : id === currentPhase ? "🔵" : "🔘";
}

export function PhaseSidebar({
  phases,
  currentPhase,
  disabled,
  onPhaseClick,
  gateFailures,
}: Props) {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const failedSet = new Set(gateFailures ?? []);
  return (
    <aside className="phase-sidebar">
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
              className={`phase-item standalone${isCurrent0 ? " current" : ""}`}
              disabled={disabled}
              onClick={() => onPhaseClick(0 as PhaseId)}
              title="Faz 0 — Hata Ayıklama (Debug Triage). Pipeline dışı, standalone. Yaşadığın hatayı chat'e yaz; debug akışı otomatik başlar."
            >
              <span className="phase-badge" aria-hidden>
                {isCurrent0 ? "🔵" : "🐛"}
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
          const badge = phaseBadge(id, currentPhase, gateFailed);
          const name = p?.name_tr ?? p?.name_en ?? `Faz ${id}`;
          const typeLabel = p?.type ?? "";
          const isCurrent = id === currentPhase;
          const isRequired = REQUIRED_PHASES.has(id);
          return (
            <button
              key={id}
              type="button"
              className={`phase-item${isCurrent ? " current" : ""}${isRequired ? " required" : ""}${gateFailed ? " gate-failed" : ""}`}
              disabled={disabled}
              onClick={() => onPhaseClick(id)}
              title={`Faz ${id} — ${typeLabel}${isRequired ? " (zorunlu)" : " (opsiyonel)"}${gateFailed ? " — ⚠ bu gate başarısız (akış soft devam etti, sonuç tam doğrulanmadı)" : ""}`}
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
