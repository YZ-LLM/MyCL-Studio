// open-status — açılış "Durum + Yapman gereken" özeti (YZLLM 2026-07-19: "ne durumda + ne yapmam
// gerektiğini kısaca yazsın her zaman"). Deterministik → saf, öncelik-sırası pinli.
import { describe, expect, it } from "vitest";
import { composeOpenStatus, formatOpenStatus, type OpenStatusInput } from "../src/open-status.js";

const base: OpenStatusInput = {
  currentPhase: 1,
  intentEmpty: true,
  isForeign: false,
  pendingDiagnostic: false,
  pendingUiReview: false,
  runningTaskText: null,
  pendingTaskCount: 0,
  eddDone: 0,
  eddTotal: 0,
  eddPending: 0,
  neverAsk: false,
};

describe("composeOpenStatus — öncelik sırası", () => {
  it("debug çözüm seçimi bekliyor → en yüksek öncelik", () => {
    const s = composeOpenStatus({ ...base, pendingDiagnostic: true, currentPhase: 8 });
    expect(s.durum).toContain("çözüm seçimi");
    expect(s.action).toContain("yanıtla");
  });

  it("UI incelemesi parkı → Faz 6 inceleme + onay eylemi", () => {
    const s = composeOpenStatus({ ...base, pendingUiReview: true });
    expect(s.durum).toContain("UI incelemesi");
    expect(s.action).toContain("onayla");
  });

  it("mid-pipeline (Faz 8) → otomatik sürüyor, kullanıcı bir şey yapmaz", () => {
    const s = composeOpenStatus({ ...base, currentPhase: 8, intentEmpty: false });
    expect(s.durum).toContain("Faz 8");
    expect(s.durum).toContain("BDD + TDD");
    expect(s.action).toContain("gerek yok");
  });

  it("koşan kuyruk işi → önceki iş sürüyor + metin", () => {
    const s = composeOpenStatus({ ...base, runningTaskText: "wellcome sayfası açılmıyor" });
    expect(s.durum).toContain("wellcome sayfası açılmıyor");
    expect(s.action).toContain("bekle");
  });

  it("bekleyen kuyruk işi → N iş bekliyor", () => {
    const s = composeOpenStatus({ ...base, pendingTaskCount: 3 });
    expect(s.durum).toContain("3 iş bekliyor");
  });

  it("foreign + EDD sürüyor → analiz done/total", () => {
    const s = composeOpenStatus({ ...base, isForeign: true, eddDone: 716, eddTotal: 978, eddPending: 5 });
    expect(s.durum).toContain("716/978");
    expect(s.durum).toContain("EDD");
  });

  it("foreign + EDD pending=0 → EDD durumuna DÜŞMEZ, niyet bekleme kazanır", () => {
    const s = composeOpenStatus({ ...base, isForeign: true, eddDone: 978, eddTotal: 978, eddPending: 0 });
    expect(s.durum).toContain("Proje analizi tamam");
    expect(s.action).toContain("yaz");
  });

  it("Faz 1 + intent boş + temiz → yeni iş bekleniyor", () => {
    expect(composeOpenStatus(base).durum).toContain("Yeni bir iş");
  });

  it("koşan iş, mid-pipeline'dan SONRA gelir (mid-pipeline önce)", () => {
    const s = composeOpenStatus({ ...base, currentPhase: 5, runningTaskText: "x" });
    expect(s.durum).toContain("Faz 5"); // mid-pipeline kazanır
  });

  it("formatOpenStatus: 📍 Durum + Yapman gereken iki satır", () => {
    const t = formatOpenStatus({ durum: "D", action: "A" });
    expect(t).toBe("📍 **Durum:** D\n**Yapman gereken:** A");
  });
});
