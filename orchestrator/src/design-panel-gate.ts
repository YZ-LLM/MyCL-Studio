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
