// design-panel-gate — Faz 5 çok-perspektifli tasarım paneli için SAF karar.
//
// Karar phase-5.ts run() içinden çıkarıldı (SOLID: tek sorumluluk + izole test).
// Üç durum:
//   - "run":         panel koşar (flag açık + create/always + tweak değil + UI "simple" DEĞİL).
//   - "skip-simple": panel-uygun AMA UI "simple" → tek-ajan tasarım (GÖRÜNÜR bilgi mesajı).
//   - "off":         flag kapalı / tweak / create-only iken iterasyon>1 → panel hiç düşünülmez.
//
// v15.13 spec gate: yalnız "simple" paneli atlar; undefined/moderate/complex → panel KOŞAR
// (regresyon-güvenli — eski state'ler + classifier'ı atlamış akışlar undefined kalır).

import type { UiComplexity } from "./types.js";

export type DesignPanelDecision = "run" | "skip-simple" | "off";

export function designPanelDecision(params: {
  /** claude_code_flags.design_workflow ("off" | "create-only" | "always" | ...). */
  designFlag: string;
  isTweakMode: boolean;
  /** iteration_count <= 1 (ilk = CREATE iterasyonu). */
  isCreateIteration: boolean;
  uiComplexity: UiComplexity | undefined;
}): DesignPanelDecision {
  const { designFlag, isTweakMode, isCreateIteration, uiComplexity } = params;
  const eligible =
    !isTweakMode && designFlag !== "off" && (designFlag === "always" || isCreateIteration);
  if (!eligible) return "off";
  if (uiComplexity === "simple") return "skip-simple";
  return "run";
}

/**
 * Boot-resume israf önleme (Ümit 2026-06-10: "kapatıp açınca fazın başına gidiyor"): audit
 * kuyruğunda (eski→yeni sıralı) bu iterasyonda panel sentezi var mı? Sondan tara: bir
 * `iteration-N-start` görülürse ondan ÖNCEKİ sentez başka iterasyona aittir → false.
 * SAF — dosya varlığını (design.md) caller kontrol eder.
 */
export function designSynthesizedInCurrentIteration(
  eventsOldestFirst: Array<{ event: string }>,
): boolean {
  for (let i = eventsOldestFirst.length - 1; i >= 0; i--) {
    const e = eventsOldestFirst[i].event;
    if (/^iteration-\d+-start$/.test(e)) return false;
    if (e === "ui-design-synthesized") return true;
  }
  return false;
}
