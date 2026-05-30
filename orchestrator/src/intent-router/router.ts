// intent-router/router — DispatchOutcome type (legacy).
//
// v15.7 (2026-05-25): Classifier ve tüm dispatch fonksiyonları (`classifyForDispatch`,
// `dispatchByIntent`, `dispatchByIntentDirect`, `dispatchUserMessage`) KALDIRILDI.
// Orkestrator agent her user message'da çalışıyor, fail durumunda graceful chat
// mesajıyla bilgilendirir — Haiku classifier fallback yok artık.
//
// Geriye kalan: `DispatchOutcome` type. Agent decision'ı `executeDispatchedIntent`
// (index.ts) için fake outcome formatına map ediyor — bu chain hâlâ kullanılıyor.

import type { IntentClassification } from "./types.js";

/**
 * Caller'a dispatch sonucunu söyleyen outcome. v15.7 öncesi router.ts içinde
 * dispatchByIntent tarafından üretilirdi; şimdi sadece executeAgentDecision
 * (index.ts) `fakeOutcome` olarak construct ediyor.
 *
 * `handled: true` = router yan-eylem yaptı (chat/command/question handler);
 * caller başka iş yapmaz. `handled: false` = caller develop/resume/debug/
 * approve_ui/revise_ui/cancel_pipeline akışını çalıştırmalı.
 */
export type DispatchOutcome =
  | { handled: true; intent: IntentClassification }
  | {
      handled: false;
      intent: IntentClassification;
      action:
        | "develop_new_or_iter"
        | "resume_pipeline"
        | "debug_triage"
        | "approve_ui"
        | "revise_ui"
        | "cancel_pipeline";
    };
