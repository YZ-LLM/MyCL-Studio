// Kanıt taşıyan faz kapıları (YZLLM 2026-07-28: "engellerin önemini bilmesi lazım… sonucu çok kötü
// olacak bir şey varsa durur ve bana söylerdi") + sohbet model rozeti sözleşmesi.
//
// index.ts'teki PROOF_BEARING_PHASES modül-içi sabit (export edilmiyor — davranış oradaki tek dalda).
// Bu test, sözleşmenin KENDİSİNİ kilitler: hangi fazların "çalışırlık kanıtı" ürettiği ve
// mahkeme "escalate" hükmünün bu fazlarda kabul-devam ETMEMESİ gerektiği.
import { describe, expect, it } from "vitest";
import { PHASE_SPECS } from "../src/phase-registry.js";

/** Sözleşme kopyası — index.ts'teki PROOF_BEARING_PHASES ile AYNI küme olmalı (drift olursa test konuşur). */
const PROOF_BEARING = [8, 14, 15, 16];

describe("kanıt taşıyan fazlar — sözleşme", () => {
  it("küme, çalışırlık kanıtı üreten fazlardan oluşur (8 uygulama, 14 birim, 15 entegrasyon, 16 E2E)", () => {
    expect(PROOF_BEARING).toEqual([8, 14, 15, 16]);
  });

  it("her biri gerçekten var olan bir faz ve mekanik/codegen tipinde (kanıt üretir, sohbet değil)", () => {
    for (const id of PROOF_BEARING) {
      const spec = PHASE_SPECS[id as keyof typeof PHASE_SPECS];
      expect(spec, `Faz ${id} kayıtta yok`).toBeDefined();
      expect(["mechanical", "codegen"], `Faz ${id} tipi kanıt üretmiyor`).toContain(spec!.type);
    }
  });

  it("kalite/stil fazları (10 lint, 11 sadeleştirme, 12 performans) kümede DEĞİL — onlarda kabul-devam meşru", () => {
    for (const id of [10, 11, 12]) expect(PROOF_BEARING).not.toContain(id);
  });

  it("Faz 13 (güvenlik) kümede değil — kendi kullanıcı-onaylı kabul yolu var (security_accepted_by_user)", () => {
    expect(PROOF_BEARING).not.toContain(13);
  });
});
