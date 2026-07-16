// full-test — saf sınıflandırma/rapor/fix-işi testleri + deps-enjekteli koşum (tarayıcı/LLM YOK).
import { describe, expect, it } from "vitest";
import {
  classifySuiteResult,
  formatFullTestReport,
  fixTasksFromReport,
  runFullTest,
  type FullTestReport,
} from "../src/full-test.js";
import type { State } from "../src/types.js";

describe("classifySuiteResult", () => {
  it("exit 0 → pass", () => {
    const s = classifySuiteResult("unit", "Birim testleri", { code: 0, stdout: "ok", stderr: "" });
    expect(s.status).toBe("pass");
  });

  it("komut yok (127) → skipped + görünür neden (sahte yeşil değil)", () => {
    const s = classifySuiteResult("unit", "Birim testleri", {
      code: 127,
      stdout: "",
      stderr: "sh: vitest: command not found",
    });
    expect(s.status).toBe("skipped");
    expect(s.detail_tr).toContain("bulunamadı");
  });

  it("kırmızı + parse edilen test adları → fail + failures listesi", () => {
    const out = "FAIL src/a.test.ts > toplama\nFAIL src/b.test.ts > çıkarma\n";
    const s = classifySuiteResult("unit", "Birim testleri", { code: 1, stdout: out, stderr: "" });
    expect(s.status).toBe("fail");
    expect(s.failures?.length).toBeGreaterThan(0);
  });

  it("kırmızı ama 0 parse (runner anlaşılamadı) → yine fail + çıktı kuyruğu", () => {
    const s = classifySuiteResult("unit", "Birim testleri", { code: 2, stdout: "garip çıktı", stderr: "" });
    expect(s.status).toBe("fail");
    expect(s.detail_tr).toContain("kırmızı");
  });
});

describe("runFullTest — deps enjekte, bölüm izolasyonu", () => {
  const fakeState = {
    project_root: "/tmp/nonexistent-mycl-fulltest",
    stack: "unknown",
    project_type: "web",
  } as unknown as State;

  it("dev server kalkmadı → canlı bölümler GÖRÜNÜR atlanır; birim/entegrasyon yine denenir", async () => {
    const r = await runFullTest(fakeState, {
      ensureDevServer: async () => ({ ok: false }),
      ensureE2E: async () => ({ proceed: true }),
    });
    const byId = new Map(r.sections.map((s) => [s.id, s]));
    // unknown stack → profil komutu yok → birim/entegrasyon görünür atlandı (fail DEĞİL)
    expect(byId.get("unit")?.status).toBe("skipped");
    expect(byId.get("integration")?.status).toBe("skipped");
    // canlı bölümler dev-server nedeniyle atlandı — nedeni açık
    for (const id of ["e2e", "route-sweep", "a11y", "visual"] as const) {
      expect(byId.get(id)?.status).toBe("skipped");
      expect(byId.get(id)?.detail_tr).toContain("dev server");
    }
    // hiçbir çekirdek fail yok → ok (atlanmışlar rapor içinde görünür)
    expect(r.ok).toBe(true);
    expect(r.sections).toHaveLength(6);
  });

  it("ensureDevServer throw etse bile rapor döner (bölüm izolasyonu)", async () => {
    const r = await runFullTest(fakeState, {
      ensureDevServer: async () => {
        throw new Error("patladı");
      },
      ensureE2E: async () => ({ proceed: true }),
    });
    expect(r.sections).toHaveLength(6);
  });
});

describe("formatFullTestReport + fixTasksFromReport", () => {
  const report: FullTestReport = {
    ok: false,
    durationMs: 12_000,
    sections: [
      { id: "unit", label_tr: "Birim testleri", status: "fail", detail_tr: "2 test düştü", failures: ["a", "b"] },
      { id: "integration", label_tr: "Entegrasyon testleri", status: "skipped", detail_tr: "profilde integration yok" },
      { id: "e2e", label_tr: "E2E (Playwright)", status: "pass", detail_tr: "yeşil" },
      { id: "route-sweep", label_tr: "Rota taraması", status: "fail", detail_tr: "`/admin`: konsol hatası", failures: ["/admin — konsol hatası: x"] },
      { id: "a11y", label_tr: "Erişilebilirlik (bilgi)", status: "pass", detail_tr: "temiz" },
      { id: "visual", label_tr: "Görsel karşılaştırma (bilgi)", status: "pass", detail_tr: "değişim yok" },
    ],
  };

  it("rapor her bölümü ✅/❌/⏭ ile listeler; başarısızlıkta kuyruk notu", () => {
    const msg = formatFullTestReport(report);
    expect(msg).toContain("❌ **Birim testleri:**");
    expect(msg).toContain("⏭ **Entegrasyon testleri:**");
    expect(msg).toContain("✅ **E2E (Playwright):**");
    expect(msg).toContain("iş kuyruğuna eklendi");
  });

  it("fix işleri YALNIZ düşen çekirdek bölümlerden; bölüm başına ≤1", () => {
    const tasks = fixTasksFromReport(report);
    expect(tasks).toHaveLength(2); // unit + route-sweep; a11y/visual/skipped üretmez
    expect(tasks[0]).toContain("Birim testleri");
    expect(tasks[1]).toContain("Rota taraması");
  });

  it("bilgi bölümü (a11y/görsel) fail olsa bile hükme/fix işine girmez", () => {
    const r2: FullTestReport = {
      ...report,
      ok: true,
      sections: report.sections.map((s) =>
        s.id === "a11y" ? { ...s, status: "fail" as const } : s.id === "unit" || s.id === "route-sweep" ? { ...s, status: "pass" as const } : s,
      ),
    };
    expect(fixTasksFromReport(r2)).toHaveLength(0);
  });
});
