// PhaseSidebar — Sol panel: pipeline fazlarının tıklanabilir listesi.
//
// Niyetler bölümü (Soru Sor / Hata Ayıkla / Sohbet) buradan kaldırıldı
// (composer'a da taşınmadı — orkestratör ajan niyeti kendisi çıkarıyor).
// Sidebar artık sadece faz navigasyonu içerir, tüm 1-17 fazları listelenir.

import { useRef } from "react";
import type { PhaseId, PhaseStatus, PhaseSummary } from "../types/events";

const VISIBLE_PHASES: PhaseId[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
];

// YZLLM 2026-06-26 (mahkeme H2/H5): GERÇEKTEN atlanabilen (opsiyonel) fazlar YALNIZCA 5 (UI üretimi) ve 7 (DB) —
// backend isPhaseSkippedByScope'un TEK OTORİTESİYLE birebir (index.ts: "if (phaseId !== 5 && phaseId !== 7) return
// false"). Faz 6/8/9 ARTIK ZORUNLU — her zaman çalışır → ASLA "opsiyonel"/"kapsam dışı" gösterilmemeli (eski liste
// 6/8/9'u opsiyonel sayıp "çalışmayacak" yalanı veriyordu). Etiket + kapsam-soluklaştırma BU tek kaynaktan türer.
const SKIPPABLE_PHASES: ReadonlySet<PhaseId> = new Set([5, 7]);

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
  /** Faz kapsamı (YZLLM 2026-06-26): kapsam onaylanınca çalışacak fazlar. Kapsam-dışı opsiyonel fazlar SOLUK
   *  gösterilir ("Diğerleri pasif görünsün"); kapsamdakiler normal/belirgin. null/[] → kapsam yok, vurgulama yok. */
  neededPhases?: number[] | null;
  /** Ulaşılan en yüksek pipeline fazı — debug (Faz 0) sırasında "yarım kalan" fazı (⏸️) belirlemek için. */
  maxPhase: PhaseId;
  /** Mevcut fazın durumu — SON faz tamamlanınca (currentPhase ilerlemez) ✅ göstermek için (yoksa sonsuza dek ▶️). */
  phaseStatus?: PhaseStatus;
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
  currentPhaseStatus?: PhaseStatus,
): string {
  if (gateFailed) return "⚠️";
  if (id === currentPhase) {
    // CURRENT faz: TAMAMLANDIYSA ✅ (özellikle SON faz — pipeline bitince currentPhase ilerlemez → aksi halde
    // Faz 17 sonsuza dek ▶️ mavi kalırdı; YZLLM 2026-07-14 "iterasyon bitti ama faz 17 yeşil olmamış" bug'ı).
    // idle (açılışta taze/iş-bekliyor, YZLLM 2026-07-22) → nötr ⏹️ (çalışmıyor da tamamlanmadı da). running/waiting → ▶️.
    if (currentPhaseStatus === "complete") return "✅";
    if (currentPhaseStatus === "idle") return "⏹️";
    return "▶️";
  }
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
  phaseStatus,
  neededPhases,
}: Props) {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const failedSet = new Set(gateFailures ?? []);
  // Kapsam aktif mi: kapsam belirlenmişse (non-empty) kapsam-dışı OPSIYONEL fazlar soluklaşır. Zorunlu fazlar
  // ASLA soluklaşmaz (her zaman çalışır — backend isPhaseSkippedByScope da yalnız opsiyonelleri etkiler).
  const scopeActive = Array.isArray(neededPhases) && neededPhases.length > 0;
  const scopeSet = new Set(neededPhases ?? []);
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
      {/* ERİŞİLEBİLİRLİK (2026-07-18): faz listesi gezinme bölgesi; aktif faz aria-current ile duyurulur. */}
      <nav className="phase-sidebar-list" aria-label="Pipeline fazları">
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
              aria-current={isCurrent0 ? "step" : undefined}
              disabled={disabled}
              onClick={() => onPhaseClick(0 as PhaseId)}
              title="Faz 0 — Hata Ayıklama (Debug Triage). Pipeline dışı, standalone. Yaşadığın hatayı chat'e yaz; debug akışı otomatik başlar."
            >
              <span className="phase-badge" aria-hidden>
                {/* MAHKEME MEDIUM (2026-07-22): Faz 0 current iken de phaseStatus'e bak — açılışta idle olan bir debug
                    projesinde header "boşta" derken bu rozet sabit "▶️" (aktif) gösterip YENİ çelişki üretiyordu.
                    idle → ⏹️ (nötr), complete → ✅ (Faz 0'da olmaz ama tutarlı), aksi (running/waiting) → ▶️. */}
                {isCurrent0
                  ? phaseStatus === "complete"
                    ? "✅"
                    : phaseStatus === "idle"
                      ? "⏹️"
                      : "▶️"
                  : "🐛"}
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
          const badge = phaseBadge(id, currentPhase, gateFailed, maxPhase, phaseStatus);
          const name = p?.name_tr ?? p?.name_en ?? `Faz ${id}`;
          const typeLabel = p?.type ?? "";
          const isCurrent = id === currentPhase;
          const isOptional = SKIPPABLE_PHASES.has(id); // yalnız 5/7 opsiyonel (backend otoritesi)
          // Kapsam-dışı: kapsam aktif + faz GERÇEKTEN atlanabilir (5/7) + kapsamda DEĞİL → soluk ("Diğerleri pasif").
          // gate-failed faz ASLA soluklaşmaz (atlanan faz koşmaz→gate-fail olamaz; yine de savunma — mahkeme H6).
          const isOutOfScope = scopeActive && isOptional && !scopeSet.has(id) && !gateFailed;
          return (
            <button
              key={id}
              type="button"
              data-testid={`phase-item-${id}`}
              className={`phase-item${isCurrent ? " current" : ""}${isOptional ? "" : " required"}${gateFailed ? " gate-failed" : ""}${isOutOfScope ? " phase-item-inactive" : ""}`}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => handleSingle(id)}
              onDoubleClick={() => handleDouble(id)}
              title={`Faz ${id} — ${typeLabel}${isOptional ? " (opsiyonel)" : " (zorunlu)"}. ${isOutOfScope ? "Bu iterasyonun kapsamı DIŞINDA — çalışmayacak. " : ""}TEK tık: bu fazın chat'teki ilk mesajına git · ÇİFT tık: fazı çalıştır${gateFailed ? " — ⚠ bu gate başarısız (akış soft devam etti, sonuç tam doğrulanmadı)" : ""}`}
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
      </nav>
    </aside>
  );
}
