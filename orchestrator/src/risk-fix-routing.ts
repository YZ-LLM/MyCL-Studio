// risk-fix-routing — Faz 9 risk-fix dispatch'inin SAF yönlendirme kararı (Ümit 2026-06-13).
//
// Bir "fix" kararının fix_phase alanını (ui/db/code) hedef faza (5/7/8) çevirir + kapsam korumasını
// uygular (UI'sız projede UI riski, DB'siz projede DB riski → atla). Saf + yan-etkisiz → test edilebilir
// (dispatchRiskFixes'in side-effect'li gövdesinden ayrıldı; shouldFolderGuard deseni).

export type RiskFixTarget = 5 | 7 | 8;

export interface RiskFixRoute {
  /** Hedef faz; null → kapsam dışı, atla. */
  target: RiskFixTarget | null;
  /** target null ise neden atlandığı (görünür mesaj için). */
  skipReason?: "no-ui" | "no-db";
  /** fix_phase yok/bilinmiyordu → 'code' (Faz 8) varsayıldı (uyarı logu için). */
  assumedCode?: boolean;
}

/**
 * fix_phase → hedef faz. ui→5, db→7, code→8; yok/bilinmeyen/none ama "fix" → code (Faz 8, en genel) + assumedCode.
 * Sonra kapsam koruması: UI hedefi ama proje UI'sız → atla; DB hedefi ama proje DB'siz → atla.
 */
export function resolveRiskFixTarget(
  fixPhase: string | undefined,
  opts: { skipUi: boolean; noDb: boolean },
): RiskFixRoute {
  const dom = String(fixPhase ?? "").trim().toLowerCase();
  let target: RiskFixTarget;
  let assumedCode = false;
  if (dom === "ui") target = 5;
  else if (dom === "db") target = 7;
  else if (dom === "code") target = 8;
  else {
    target = 8;
    assumedCode = true;
  }

  if (target === 5 && opts.skipUi) {
    return { target: null, skipReason: "no-ui", ...(assumedCode ? { assumedCode } : {}) };
  }
  if (target === 7 && opts.noDb) {
    return { target: null, skipReason: "no-db", ...(assumedCode ? { assumedCode } : {}) };
  }
  return { target, ...(assumedCode ? { assumedCode } : {}) };
}
