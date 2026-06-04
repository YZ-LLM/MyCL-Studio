// buildRelevantOrchestratorContext — doğru-karar/recall injector'ı (orkestratör
// karar anında relevance-tabanlı "en ilgili geçmiş"). Triviyal-query skip +
// fail-safe boş-sonuç sözleşmesi. (Gerçek relevance skorlama LLM çağrısı; burada
// deterministik kollar: kısa-query atlama + no-chunks fail-safe → "".)
//
// NOT (2026-06-04): abonelik modu ARTIK relevance'ı atlamaz (text-JSON CLI ile
// skorlar). Bu testte proje dizini var-olmadığından chunk toplanamaz → gatherChunks
// boş → getRelevantChunks scoring'e GİTMEDEN [] döner (no-chunks fail-safe). Yani
// burada CLI spawn'ı tetiklenmez; abonelik config'i yalnız config-şekli için kullanılır.

import { describe, expect, it } from "vitest";
import { buildRelevantOrchestratorContext } from "../src/relevance/injectors.js";
import type { MyclConfig } from "../src/config.js";
import type { State } from "../src/types.js";

// Saf-abonelik config (tüm roller cli). var-olmayan proje → no-chunks → [].
const subscriptionConfig = (): MyclConfig =>
  ({
    selected_models: { translator: "m", main: "m", orchestrator: "m", relevance: "m" },
    api_keys: { translator: "k", main: "k", orchestrator: "k", relevance: "k" },
    claude_code_flags: { betas: [], effort: "high" },
    agent_backends: { orchestrator: "cli", translator: "cli", main: "cli" },
    features: { claude_code_cli_enabled: true },
  }) as unknown as MyclConfig;

const fakeState = (): State =>
  ({ project_root: "/tmp/mycl-nonexistent-xyz-123", stack: "node-npm" }) as unknown as State;

describe("buildRelevantOrchestratorContext", () => {
  it("triviyal query (kısa onay) → '' (relevance call ATLA)", async () => {
    expect(await buildRelevantOrchestratorContext(subscriptionConfig(), fakeState(), "evet")).toBe("");
    expect(await buildRelevantOrchestratorContext(subscriptionConfig(), fakeState(), "  tamam ")).toBe("");
    expect(await buildRelevantOrchestratorContext(subscriptionConfig(), fakeState(), "")).toBe("");
  });

  it("no-chunks / boş sonuç → '' (bölüm eklenmez, fail-safe — karar bloklanmaz)", async () => {
    const r = await buildRelevantOrchestratorContext(
      subscriptionConfig(),
      fakeState(),
      "anket modülüne yeni bir soru tipi ekle",
    );
    expect(r).toBe("");
  });
});
