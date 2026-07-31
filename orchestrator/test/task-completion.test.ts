// task-completion — "Tamamlandı" damgası gerçek iş kanıtına bağlı mı (SAF).
//
// Canlı cave kanıtı (2026-07-30): 13 Temmuz 15:52-15:58 arasında altı standart iş ortalama 70 saniyede
// "tamamlandı" damgalandı; o dakikalarda audit'te TEK bir dosya yazma olayı yok — bütün fazlar atlandı
// ya da denetim yapılamadan geçildi. Kuyruk "26 tamamlandı" gösteriyordu, kullanıcı ise hiçbir sonuç
// görmüyordu. Bu testler o sahte damgayı imkânsız kılar.

import { describe, expect, it } from "vitest";
import { decideTaskCompletion, filterAgentAuthored, NON_EVIDENCE_EVENTS } from "../src/task-completion.js";
import { WRITE_EVENTS } from "../src/fix/scope.js";

const base = {
  auditReadable: true,
  iterationWindowKnown: true,
  deliverableExists: true,
  writeEvents: WRITE_EVENTS,
};
const ev = (event: string, detail?: string) => ({ event, detail, ts: 10 });

describe("decideTaskCompletion", () => {
  it("CANLI BUG: hiç dosya yazılmamış koşu → 'Tamamlandı' DAMGALANMAZ", () => {
    const d = decideTaskCompletion({
      ...base,
      events: [
        ev("phase-10-skipped", "missing_command"),
        ev("phase-13-complete", "security_accepted_by_user"),
        ev("mahkeme-escalate-accept-continue", "Müfettiş değerlendirmesi üretilemedi"),
        ev("phase-17-complete"),
      ],
    });
    expect(d.verdict).toBe("requeue");
    if (d.verdict === "requeue") expect(d.userMessage).toContain("DAMGALANMADI");
  });

  it("dosya yazma olayı varsa → tamamlandı", () => {
    for (const w of [...WRITE_EVENTS]) {
      const d = decideTaskCompletion({ ...base, events: [ev(w, "/proj/app.js")] });
      expect(d.verdict).toBe("done");
    }
  });

  it("REGRESYON KİLİDİ: MyCL'in kendi pipeline sonu çıktıları kanıt SAYILMAZ", () => {
    // living-docs + kılavuz görselleri HER koşuda yazılır; kanıt sayılsalardı düzeltme etkisiz olurdu.
    const d = decideTaskCompletion({
      ...base,
      events: [...NON_EVIDENCE_EVENTS].map((e) => ev(e)),
    });
    expect(d.verdict).toBe("requeue");
  });

  it("'değişiklik gerekmedi' POZİTİF kanıtları tamamlandı sayılır", () => {
    for (const sig of ["phase-5-no-change-needed", "mahkeme-suppress-accept-continue", "realapp-verify-pass"]) {
      const d = decideTaskCompletion({ ...base, events: [ev(sig)] });
      expect(d.verdict).toBe("done");
      if (d.verdict === "done") expect(d.evidence.kind).toBe("no-change-needed");
    }
  });

  it("escalate (müfettiş çözemedi) kanıt DEĞİLDİR — 'bilmiyoruz' demektir", () => {
    const d = decideTaskCompletion({ ...base, events: [ev("mahkeme-escalate-accept-continue")] });
    expect(d.verdict).toBe("requeue");
  });

  it("gerçek uygulama kapısı bu işe uygulanamadıysa (nötr) → tamamlandı", () => {
    const ok = decideTaskCompletion({
      ...base,
      events: [ev("realapp-verify-skipped", "not_applicable_not_found")],
    });
    expect(ok.verdict).toBe("done");
    // Ama çıplak "koşulamadı" (araç yok) kanıt değildir.
    const no = decideTaskCompletion({ ...base, events: [ev("realapp-verify-skipped", "codegen_failed")] });
    expect(no.verdict).toBe("requeue");
  });

  it("BUGÜNKÜ davranış korunur: boş build → kuyruğa döner, mesaj metni aynı", () => {
    const d = decideTaskCompletion({ ...base, deliverableExists: false, events: [ev("code-edit")] });
    expect(d.verdict).toBe("requeue");
    if (d.verdict === "requeue") {
      expect(d.userMessage).toContain("boş build");
      expect(d.reason).toContain("sahte tamamlanma kilidi");
    }
  });

  it("audit okunamadı / iterasyon penceresi yok → eski davranış (tamamlandı) AMA görünür not", () => {
    const a = decideTaskCompletion({ ...base, auditReadable: false, events: [] });
    expect(a.verdict).toBe("done");
    if (a.verdict === "done") {
      expect(a.evidence.kind).toBe("window-unknown");
      expect(a.note).toBeTruthy(); // sessiz kalmaz (KATI #4)
    }
    const b = decideTaskCompletion({ ...base, iterationWindowKnown: false, events: [] });
    expect(b.verdict).toBe("done");
  });

  it("MAHKEME: gate döngüsündeki mahkeme false-positive kararı KANITTIR (detaydan)", () => {
    const d = decideTaskCompletion({
      ...base,
      events: [ev("phase-13-complete", "mahkeme_false_positive_suppressed")],
    });
    expect(d.verdict).toBe("done");
  });

  it("MAHKEME: gate kendi içinde oto-düzeltildiyse KANITTIR (codegen gözlemcisi bağlı değil)", () => {
    const d = decideTaskCompletion({ ...base, events: [ev("phase-13-complete", "gate_autofix_resolved")] });
    expect(d.verdict).toBe("done");
  });

  it("çıplak phase-N-complete kanıt DEĞİLDİR (her fazda yazılır, iş yapılmasa da)", () => {
    const d = decideTaskCompletion({
      ...base,
      events: [ev("phase-13-complete", "security_accepted_by_user"), ev("phase-17-complete")],
    });
    expect(d.verdict).toBe("requeue");
  });

  it("audit boş ama ajan kaynaklı değişen dosya varsa → tamamlandı (git yolu yedek kanıt)", () => {
    const d = decideTaskCompletion({ ...base, events: [], agentAuthoredFiles: ["src/app.ts"] });
    expect(d.verdict).toBe("done");
  });
});

describe("filterAgentAuthored", () => {
  it("MyCL'in kendi çıktılarını eler, gerçek kaynak dosyalarını bırakır", () => {
    const out = filterAgentAuthored([
      ".mycl/features.md",
      "devs/2026-07-30/meta.json",
      "public/docs/guide-shots/home.png",
      "README.md",
      "src/routes/login.ts",
      "views/profile.ejs",
    ]);
    expect(out).toEqual(["src/routes/login.ts", "views/profile.ejs"]);
  });

  it("Windows tarzı ters bölü yollarında da eler (çapraz platform)", () => {
    expect(filterAgentAuthored([".mycl\\audit.log", "src\\a.ts"])).toEqual(["src\\a.ts"]);
  });
});
