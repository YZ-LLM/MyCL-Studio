// askq-backend CONFORMANCE testi (mahkeme denetimi 2026-07-11, Fable↔Opus mutabakatı #2).
//
// NEDEN: CLI ve SDK backend'leri "birebir davranır" sözleşmesi taşır ama kopyayla yaşıyordu ve ÇOKTAN sapmıştı
// (SDK qa-askq submitAskqAnswer'da pendingRejecter sıfırlanmıyordu — 4 kopyanın 3'ünde vardı). Bu test, askq
// state-machine SÖZLEŞMESİNİ 4 backend sınıfının HEPSİNE aynı anda koşar → gelecekte bir kopyada yapılan düzeltme
// kardeşine yayılmazsa CI kırmızı olur (sapma artık kopya-disiplini değil, CI hatası — önden-çöz KATI #6).
//
// Kapsam bilinçli dar: yalnız senkron state-machine (submitAskqAnswer/abort). run()/LLM yolları canlı test ister.

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { QaAskqBaseController } from "./qa-askq-controller.js";
import { CliQaAskqBackend } from "./qa-askq-cli-backend.js";
import { ProductionSchemaBaseController } from "./production-schema-controller.js";
import { ProductionSchemaCliBackend } from "./production-schema-cli-backend.js";

// Not: constructor'lar yalnız opts saklar (yan etki yok) → minimal iskelet yeterli. tag "phase-9" →
// qa-askq submit'inin clarify-log IO dalı (yalnız phase-1/2) hiç tetiklenmez; is_approval=true da ek sigorta.
function minimalOpts(): Record<string, unknown> {
  return {
    tag: "phase-9",
    phaseId: 9,
    state: { project_root: tmpdir(), iteration_count: 1 },
    config: {},
  };
}

/** Backend'i "askq bekliyor" durumuna kur (private alanlar runtime'da erişilir — sözleşme testi). */
function arm(backend: object, askqId: string): { resolved: string[]; rejected: unknown[] } {
  const b = backend as Record<string, unknown>;
  const resolved: string[] = [];
  const rejected: unknown[] = [];
  b.currentAskqId = askqId;
  b.pendingAskq = { options_en: ["Approve"], options_tr: ["Onayla"], is_approval: true, question_tr: "soru" };
  b.pendingResolver = (s: string) => resolved.push(s);
  b.pendingRejecter = (r: unknown) => rejected.push(r);
  return { resolved, rejected };
}

const BACKENDS: Array<[string, () => object]> = [
  ["QaAskqBaseController (SDK)", () => new QaAskqBaseController(minimalOpts() as never)],
  ["CliQaAskqBackend (CLI)", () => new CliQaAskqBackend(minimalOpts() as never)],
  ["ProductionSchemaBaseController (SDK)", () => new ProductionSchemaBaseController(minimalOpts() as never)],
  ["ProductionSchemaCliBackend (CLI)", () => new ProductionSchemaCliBackend(minimalOpts() as never)],
];

describe.each(BACKENDS)("askq sözleşmesi — %s", (_name, make) => {
  it("cevap: resolver seçilenle çağrılır; resolver VE rejecter sıfırlanır (sapma-kilidi: pendingRejecter bug'ı)", () => {
    const backend = make();
    const { resolved, rejected } = arm(backend, "id-1");
    (backend as { submitAskqAnswer(id: string, sel: string): void }).submitAskqAnswer("id-1", "Onayla");
    expect(resolved).toEqual(["Onayla"]);
    expect(rejected).toEqual([]);
    const b = backend as Record<string, unknown>;
    expect(b.pendingResolver).toBeNull();
    expect(b.pendingRejecter).toBeNull(); // 2026-07-11 parite fix'inin kilidi — SDK kopyası bunu atlamıştı
  });

  it("bayat/yanlış id: resolver ÇAĞRILMAZ (soru güncelliğini yitirmiş)", () => {
    const backend = make();
    const { resolved } = arm(backend, "id-1");
    (backend as { submitAskqAnswer(id: string, sel: string): void }).submitAskqAnswer("BAŞKA-id", "Onayla");
    expect(resolved).toEqual([]);
  });

  it("abort: rejecter sentinel(symbol) ile çağrılır; tüm alanlar sıfırlanır; ikinci abort no-op", () => {
    const backend = make();
    const { resolved, rejected } = arm(backend, "id-1");
    const a = backend as { abort(): void };
    a.abort();
    expect(resolved).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(typeof rejected[0]).toBe("symbol");
    const b = backend as Record<string, unknown>;
    expect(b.pendingResolver).toBeNull();
    expect(b.pendingRejecter).toBeNull();
    expect(b.pendingAskq).toBeNull();
    expect(b.currentAskqId).toBeNull();
    a.abort(); // idempotent — ikinci çağrı rejecter'ı tekrar tetiklemez
    expect(rejected).toHaveLength(1);
  });
});
