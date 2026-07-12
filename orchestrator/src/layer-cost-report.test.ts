// layer-cost-report — SAF toplama + format testleri (YZLLM 2026-07-12; çapraz-aile mahkemesi 6-bulgu sonrası).
// Deterministik rapor: audit event'leri + agent-iz'den katman {koştu, süre, bulgu}; faz-toplam maliyet AYRI.
// DÜRÜSTLÜK: tek-koşu 0-bulgu "gereksiz" DEĞİL (yargı yok); izole edilemeyen katmana faz-toplamı ATFEDİLMEZ.

import { describe, expect, it } from "vitest";
import { aggregateLayerCosts, aggregatePhaseCosts, formatLayerCostReport } from "./layer-cost-report.js";
import type { AuditEvent, CostRecord } from "./types.js";
import type { AgentTraceRecord } from "./agent-trace.js";

function ev(event: string, phase: number, detail?: string, ts = 1000): AuditEvent {
  return { ts, phase: phase as AuditEvent["phase"], event, caller: "orchestrator" as AuditEvent["caller"], detail };
}
function cost(phase: number, input: number, output: number, duration_ms?: number, ts = 1000): CostRecord {
  return {
    ts, phase: phase as CostRecord["phase"], iteration: 1, duration_ms, turns: 1,
    input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  };
}

describe("aggregateLayerCosts — koştu / süre / bulgu (yargısız)", () => {
  it("mekanik gate fail → bulgu + süre gösterilmez (mekanik ölçülmüyor)", () => {
    const rows = aggregateLayerCosts([ev("lint-fail", 10, "3 hata")], []);
    const lint = rows.find((r) => r.id === "lint")!;
    expect(lint.ran).toBe(true);
    expect(lint.durationMs).toBeNull();
    expect(lint.caught).toContain("1 bulgu");
    expect(lint.hadFinding).toBe(true);
  });

  it("mekanik gate pass → temiz geçti + hadFinding=false (AMA 'gereksiz' işareti YOK — yargı yok)", () => {
    const rows = aggregateLayerCosts([ev("perf-pass", 12)], []);
    const perf = rows.find((r) => r.id === "perf")!;
    expect(perf.ran).toBe(true);
    expect(perf.caught).toContain("temiz geçti");
    expect(perf.hadFinding).toBe(false);
  });

  it("koşmayan katman → ran=false", () => {
    const rows = aggregateLayerCosts([ev("lint-pass", 10)], []);
    const e2e = rows.find((r) => r.id === "e2e")!;
    expect(e2e.ran).toBe(false);
    expect(e2e.caught).toContain("koşmadı");
  });

  it("BULGU 3/5: Faz 17 Pentest envanterde YOK (no-op; phase-17-complete 'koştu' sayılmaz)", () => {
    const rows = aggregateLayerCosts([ev("phase-17-complete", 17)], []);
    expect(rows.find((r) => r.id === "pentest")).toBeUndefined();
    expect(rows.some((r) => r.name.toLowerCase().includes("pentest"))).toBe(false);
  });

  it("BULGU 4: izole edilemeyen (grup'suz) Faz-8 LLM katmanına faz süresi ATFEDİLMEZ → durationMs=null", () => {
    // FINDING-ONLY: bu katmanlar yalnız bir şey BULUNCA iz bırakır (fail/weak) — temiz koşuda görünmez.
    const rows = aggregateLayerCosts([ev("adversarial-test-fail", 8, "AC broke"), ev("tdd-tests-weak", 8, "mutation NOT caught")], []);
    const adv = rows.find((r) => r.id === "adversarial-test")!;
    const mut = rows.find((r) => r.id === "mutation-probe")!;
    expect(adv.ran && mut.ran).toBe(true);
    expect(adv.durationMs).toBeNull(); // grup yok → süre atfedilmez
    expect(mut.durationMs).toBeNull();
    expect(adv.caught).toContain("bulgu");
  });

  it("FINDING-ONLY: düşman/mutasyon temiz geçişte iz bırakmaz (pass event YOK — gate-lastEvent koruması) → ran=false", () => {
    // Faz-8 gate `lastEvent==='tdd-green'` bekler; tanı-event'i eklemek yeşil koşuyu kırardı → eklenmedi.
    const rows = aggregateLayerCosts([ev("tdd-green", 8)], []);
    expect(rows.find((r) => r.id === "adversarial-test")!.ran).toBe(false);
    expect(rows.find((r) => r.id === "mutation-probe")!.ran).toBe(false);
  });

  it("BULGU 2: groupSpan GERÇEK iz şeklinden — completed agent_group TAŞIMAZ, agent_label ile bağlanır", () => {
    // Gerçek kod: started → agent_group+agent_label; completed → yalnız agent_label (grup YOK).
    const trace: AgentTraceRecord[] = [
      { ts: 1000, sub: "started", agent_group: "Faz 9 Paralel Düzeltme", agent_label: "fix-a" },
      { ts: 1000, sub: "started", agent_group: "Faz 9 Paralel Düzeltme", agent_label: "fix-b" }, // paralel spawn ~aynı ts
      { ts: 46_000, sub: "completed", agent_label: "fix-a" }, // grup YOK — sadece label
      { ts: 52_000, sub: "completed", agent_label: "fix-b" },
    ];
    const rows = aggregateLayerCosts([ev("risk-fix-parallel-applied", 9)], trace);
    const pfix = rows.find((r) => r.id === "parallel-risk-fix")!;
    // Eski (bozuk) kod: yalnız started ts → span≈0 → null. Yeni: label-bağlı → 52000-1000 = 51000.
    expect(pfix.durationMs).toBe(51_000);
  });

  it("BULGU 2: grup yalnız agent-iz'de görünüp audit event'i yoksa da ran=true", () => {
    const trace: AgentTraceRecord[] = [
      { ts: 1000, sub: "started", agent_group: "Faz 9 Paralel Düzeltme", agent_label: "x" },
      { ts: 5000, sub: "completed", agent_label: "x" },
    ];
    const rows = aggregateLayerCosts([], trace);
    expect(rows.find((r) => r.id === "parallel-risk-fix")!.ran).toBe(true);
  });

  it("tdd-unverified (mutasyon probu DEĞİL) mutation-probe'a SAYILMAZ", () => {
    const rows = aggregateLayerCosts([ev("tdd-unverified", 8)], []);
    expect(rows.find((r) => r.id === "mutation-probe")!.ran).toBe(false);
  });
});

describe("aggregatePhaseCosts — faz düzeyi LLM maliyeti (per-katman DEĞİL)", () => {
  it("yalnız içinde LLM doğrulama katmanı koşan fazın toplam token+süresini verir", () => {
    const rows = aggregateLayerCosts([ev("risk-decision", 9)], []);
    const pc = aggregatePhaseCosts(rows, [cost(9, 100_000, 80_000, 240_000), cost(5, 50_000, 10_000, 30_000)]);
    expect(pc).toHaveLength(1); // Faz 5 (UI codegen) doğrulama katmanı değil → dahil değil
    expect(pc[0].phase).toBe(9);
    expect(pc[0].tokens).toBe(180_000);
    expect(pc[0].durationMs).toBe(240_000);
  });

  it("mekanik-only koşuda (LLM katman yok) faz maliyeti boş", () => {
    const rows = aggregateLayerCosts([ev("lint-pass", 10)], []);
    expect(aggregatePhaseCosts(rows, [cost(10, 0, 0, 500)])).toHaveLength(0);
  });
});

describe("formatLayerCostReport — GERÇEKLER + faz-maliyet + değer-kararı notu (yargısız, oto-budama YOK)", () => {
  it("hiç katman koşmadıysa boş string (no-op)", () => {
    expect(formatLayerCostReport(aggregateLayerCosts([], []), [])).toBe("");
  });

  it("BULGU 6: mekanik satırlarda 'Faz N' TEK KEZ (ad öneki yok, etiket tek kaynak) — tech-debt dahil", () => {
    const out = formatLayerCostReport(
      aggregateLayerCosts([ev("lint-fail", 10, "x"), ev("tdd-tech-debt-clean", 8, "no debt")], []),
      [],
    );
    expect(out).toContain("[Faz 10] Lint");
    expect(out).not.toContain("[Faz 10] Faz 10");
    // 2. tur mahkeme kalıntısı: tech-debt adı '(Faz 8)' içeriyordu → '[Faz 8] ... (Faz 8)' çift; artık tek.
    expect(out).toContain("[Faz 8] Teknik borç tarayıcı");
    expect(out).not.toContain("Teknik borç tarayıcı (Faz 8)");
    expect((out.match(/Faz 8/g) || []).length).toBe(1); // tech-debt satırında 'Faz 8' tam bir kez
  });

  it("BULGU 1: tam yeşil koşuda hiçbir katman 'gereksiz olabilir' diye işaretlenMEZ", () => {
    const green = [ev("security-pass", 13), ev("lint-pass", 10), ev("unit-pass", 14), ev("e2e-pass", 16)];
    const out = formatLayerCostReport(aggregateLayerCosts(green, []), []);
    expect(out).not.toContain("Düşük değer");
    expect(out).not.toContain("gereksiz olabilir");
    expect(out).toContain("Değer kararı senin");
    expect(out).toContain("KANITLAMAZ"); // tek yeşil koşu gereksizlik kanıtı değil
    expect(out).toContain("Güvenlik"); // güvenlik gate'i görünür ama damgalanmaz
  });

  it("faz-maliyet bölümü faz düzeyi + Faz 8 codegen notu; ölçülen süreli katman önce", () => {
    const rows = aggregateLayerCosts(
      [ev("risk-decision", 9, "fix"), ev("adversarial-test-fail", 8, "AC broke"), ev("lint-pass", 10)],
      [
        { ts: 1000, sub: "started", agent_group: "Faz 9 İnceleme", agent_label: "f1" },
        { ts: 200_000, sub: "completed", agent_label: "f1" },
      ],
    );
    const pc = aggregatePhaseCosts(rows, [cost(8, 400_000, 120_000, 360_000), cost(9, 100_000, 80_000, 200_000)]);
    const out = formatLayerCostReport(rows, pc);
    expect(out).toContain("Faz LLM maliyeti");
    expect(out).toContain("çoğu ana TDD codegen");
    expect(out).toContain("token katman başına kalıcı tutulmuyor");
    // Risk İncelemesi (ölçülen süre 200sn) mekanik Lint'ten ÖNCE
    expect(out.indexOf("Risk İncelemesi")).toBeLessThan(out.indexOf("Lint"));
  });
});
