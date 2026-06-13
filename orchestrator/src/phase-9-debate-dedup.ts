// phase-9-debate-dedup — debate-review bulgularını dedup eder (SAF, test edilebilir).
//
// Farklı eksen bulucuları AYNI riski rapor edebilir → çürütücü maliyetinden önce tekille.
// Muhafazakâr: yalnız normalize-edilmiş risk metni AYNI olanları birleştir (yakın-ama-farklı
// metni ayrı tutar; çürütücüler zaten yanlış-pozitifi eler). Çakışmada daha yüksek önem'i,
// eşitlikte "fix"i ("rule" yerine) korur.

import type { DebateFinding } from "./phase-9-debate-review.js";

const SEV_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Küçük-harf + boşluk-normalize (tek küçük regex yalnız boşluk için — substring eşleştirme değil). */
export function normalizeRisk(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function dedupeFindings(findings: DebateFinding[]): DebateFinding[] {
  const byKey = new Map<string, DebateFinding>();
  for (const f of findings) {
    const key = normalizeRisk(f.risk);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      continue;
    }
    const fRank = SEV_RANK[f.severity] ?? 0;
    const eRank = SEV_RANK[existing.severity] ?? 0;
    const higherSeverity = fRank > eRank;
    const sameSeverityFixWins =
      fRank === eRank && f.decision === "fix" && existing.decision === "rule";
    if (higherSeverity || sameSeverityFixWins) byKey.set(key, f);
  }
  return [...byKey.values()];
}
