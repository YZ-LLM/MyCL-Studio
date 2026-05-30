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
}

export function PhaseSidebar({
  phases,
  currentPhase,
  disabled,
  onPhaseClick,
}: Props) {
  const byId = new Map(phases.map((p) => [p.id, p]));
  return (
    <aside className="phase-sidebar">
      <div className="phase-sidebar-header">Fazlar</div>
      <div className="phase-sidebar-list">
        {VISIBLE_PHASES.map((id) => {
          const p = byId.get(id);
          const badge =
            id < currentPhase ? "✅" : id === currentPhase ? "🔵" : "🔘";
          const name = p?.name_tr ?? p?.name_en ?? `Faz ${id}`;
          const typeLabel = p?.type ?? "";
          const isCurrent = id === currentPhase;
          const isRequired = REQUIRED_PHASES.has(id);
          return (
            <button
              key={id}
              type="button"
              className={`phase-item${isCurrent ? " current" : ""}${isRequired ? " required" : ""}`}
              disabled={disabled}
              onClick={() => onPhaseClick(id)}
              title={`Faz ${id} — ${typeLabel}${isRequired ? " (zorunlu)" : " (opsiyonel)"}`}
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
