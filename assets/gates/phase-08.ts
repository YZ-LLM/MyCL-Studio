// Phase 9 gate — saf, yan etkisiz.
// Tüm AC'ler için tdd-green audit varsa complete.
// AC sayısı state.spec_hash ile spec.md'den çıkarılır (gate'in işi değil).
// Burada kabaca: ≥1 tdd-green ve hiç tdd-red kalmamış ise complete.
// Sıkı versiyon AC sayısını orchestrator'dan alıp her AC için ayrı kontrol etmeli.

import type { GateFunction } from "../../orchestrator/src/types.js";

export const phase09Gate: GateFunction = (_state, audit) => {
  const p9 = audit.filter((e) => e.phase === 9);
  if (p9.length === 0) return "incomplete";
  const greens = p9.filter((e) => e.event === "tdd-green").length;
  const reds = p9.filter((e) => e.event === "tdd-red").length;
  const lastEvent = p9[p9.length - 1].event;
  // Final test run green idi VE en az 1 prod-write yapıldı → complete.
  if (greens >= 1 && lastEvent === "tdd-green") return "complete";
  if (reds > greens) return "incomplete"; // hala kırmızı testler var
  return "incomplete";
};
