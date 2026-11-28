import { describe, expect, it } from "vitest";
import { classifyCompletionDetail, collectRunEvidence, computeVerdict, eventsSince } from "../src/harness-verdict.js";
import type { AuditEvent } from "../src/types.js";

function ev(phase: number, event: string, detail?: string): AuditEvent {
  return { ts: 1, phase, event, caller: "mycl-orchestrator", detail } as AuditEvent;
}
function evAt(ts: number, phase: number, event: string): AuditEvent {
  return { ts, phase, event, caller: "mycl-orchestrator" } as AuditEvent;
}

describe("eventsSince — çapraz-iterasyon sarı-gate kök fix (YZLLM 2026-06-20)", () => {
  it("önceki iterasyonun gate-fail'i (ts<iterStart) verdict'e TAŞINMAZ; bu iterasyon temiz → PASS", () => {
    const events: AuditEvent[] = [
      evAt(100, 11, "simplify-fail"),
      evAt(100, 12, "perf-fail"),
      evAt(100, 16, "e2e-fail"),
      // Bu iterasyon 11/12/16'yı henüz yeniden koşmadı (2026-11-28: sonradan temiz tamamlanan faz artık çözülmüş sayılır;
      // eski düşüşün taşınmasını sınamak için o fazların bu iterasyonda tamamlanması OLMAMALI).
      ...Array.from({ length: 16 }, (_, i) => i + 2)
        .filter((n) => n !== 11 && n !== 12 && n !== 16)
        .map((n) => evAt(200, n, `phase-${n}-complete`)),
    ];
    expect(computeVerdict(events).gateFailures.length).toBe(3); // süzülmemiş = eski hatalı davranış
    const scoped = eventsSince(events, 150);
    expect(computeVerdict(scoped).gateFailures).toEqual([]);
    expect(computeVerdict(scoped).verdict).toBe("PASS");
  });
  it("BU iterasyonun gerçek fail'i (ts>=iterStart) KORUNUR → doğru sarı", () => {
    const events: AuditEvent[] = [
      ...Array.from({ length: 16 }, (_, i) => evAt(200, i + 2, `phase-${i + 2}-complete`)),
      evAt(201, 11, "simplify-fail"), // son sonuç düşüş (sonrasında temiz tamamlanma yok)
    ];
    expect(computeVerdict(eventsSince(events, 150)).gateFailures.map((g) => g.phase)).toContain(11);
  });
  it("iterStart=0/yok → tümü (ilk-ever, geriye-uyumlu)", () => {
    const events = [evAt(100, 11, "simplify-fail")];
    expect(eventsSince(events, 0)).toEqual(events);
  });
});

// Faz 2-17 hepsi complete (gate'ler yeşil) — referans "temiz" koşu.
function cleanRun(): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let n = 2; n <= 17; n++) out.push(ev(n, `phase-${n}-complete`));
  return out;
}

describe("harness-verdict · computeVerdict", () => {
  it("tüm gate'ler yeşil + 17-complete → PASS (exit 0)", () => {
    const r = computeVerdict(cleanRun());
    expect(r.verdict).toBe("PASS");
    expect(r.completed).toBe(true);
    expect(r.gateFailures).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("17-complete VAR ama gate-fail VAR → PARTIAL (sessiz 'tamamlandı' değil, exit 2)", () => {
    // Ekrandaki senaryo: Faz 13/14/15/16 fail, ama pipeline 17'ye ulaştı.
    const events = [
      ...cleanRun(),
      ev(13, "phase-13-fail", "npm audit ..."),
      ev(13, "phase-13-complete", "soft_complete_after_fail"),
      ev(14, "phase-14-fail"),
      ev(14, "phase-14-complete", "soft_complete_after_fail"),
    ];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(2);
    expect(r.gateFailures.map((g) => g.phase)).toEqual([13, 14]);
    // Faz başına tek kayıt; açıklayıcı -fail event'i tercih edilir (soft-complete değil).
    expect(r.gateFailures[0].event).toBe("phase-13-fail");
    expect(r.summary).toMatch(/AMA 2 gate başarısız/);
  });

  it("soft_complete_after_fail tek başına (yalnız complete) da PARTIAL sayılır", () => {
    const events = [...cleanRun(), ev(13, "phase-13-complete", "soft_complete_after_fail")];
    // Not: cleanRun zaten phase-13-complete (detailsiz) içeriyor; soft'lu olan eklenince fail sayılır.
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(13);
  });

  it("custom gate-fail event'i (örn. lint-fail) de yakalanır", () => {
    const events = [...cleanRun(), ev(10, "lint-fail", "eslint errors")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(10);
  });

  it("17-complete YOK (controller fail / hard hata) → FAIL (exit 1)", () => {
    const events: AuditEvent[] = [];
    for (let n = 2; n <= 12; n++) events.push(ev(n, `phase-${n}-complete`)); // 13'te durdu
    const r = computeVerdict(events);
    expect(r.verdict).toBe("FAIL");
    expect(r.completed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("skipped (scope/missing-command) başarısızlık SAYILMAZ → PASS", () => {
    const events = [
      ...cleanRun(),
      ev(5, "phase-5-skipped-by-scope"),
      ev(11, "phase-11-skipped", "missing_command"),
    ];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PASS");
    expect(r.gateFailures).toEqual([]);
    expect(r.securitySkipped).toEqual([]);
  });

  it("güvenlik tarayıcısı ATLANDI (csp-evaluator-skipped) → false-green değil, PARTIAL", () => {
    // Gate patlamadı ama CSP taranamadı (tool eksik) → "tam tarandı" denemez.
    const events = [...cleanRun(), ev(13, "csp-evaluator-skipped", "missing_command")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.exitCode).toBe(2);
    expect(r.gateFailures).toEqual([]);
    expect(r.securitySkipped).toContain("csp-evaluator-skipped");
    expect(r.summary).toMatch(/güvenlik taraması atlandı/);
  });

  it("güvenlik-DIŞI skip (lint/test) PARTIAL yapMAZ → PASS", () => {
    // Yalnız güvenlik scan skip'i PARTIAL'a katar; faz 10/14 skip'i değil.
    const events = [...cleanRun(), ev(10, "phase-10-skipped", "missing_command")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PASS");
    expect(r.securitySkipped).toEqual([]);
  });

  it("kullanıcı güvenlik bulgusunu kabul etti (security_accepted_by_user) → security-fail durduğu için PARTIAL", () => {
    // Unit 2: "Kabul et, devam et" → phase-13-complete(security_accepted_by_user) yazılır
    // (soft_complete_after_fail DEĞİL) ama runner'ın security-fail'i durur → PARTIAL.
    const events = [
      ...cleanRun(),
      ev(13, "security-fail", "csp HIGH bulgusu"),
      ev(13, "phase-13-complete", "security_accepted_by_user"),
    ];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(13);
    expect(r.gateFailures[0]!.event).toBe("security-fail");
  });

  it("gerçek-app doğrulama KOŞAMADI (realapp-verify-skipped) → false-green değil, PARTIAL (KATI #4)", () => {
    // Gate patlamadı ama Playwright/dev-server yok → fix yalnız birim-doğrulandı, çalışan app kanıtlanmadı.
    const events = [...cleanRun(), ev(16, "realapp-verify-skipped", "no_playwright")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.exitCode).toBe(2);
    expect(r.gateFailures).toEqual([]);
    expect(r.securitySkipped).toEqual([]);
    expect(r.realAppSkipped).toContain("realapp-verify-skipped");
    expect(r.summary).toMatch(/gerçek uygulama doğrulaması koşamadı/);
  });

  it("YZLLM onayı 2026-07-24: not_applicable_* detaylı realapp-skip NÖTR → PASS (PARTIAL değil)", () => {
    // Sentezlenmiş kapı UI senaryosuna çevrilemeyen işe (güvenlik/test-altyapı) uygulanamadı — sarı yanlış.
    const events = [...cleanRun(), ev(16, "realapp-verify-skipped", "not_applicable_codegen_failed")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PASS");
    expect(r.realAppSkipped).toEqual([]);
  });

  it("gerçek-app doğrulama BAŞARISIZ (realapp-verify-fail) → gate-fail yolundan PARTIAL (realAppSkipped değil)", () => {
    // -fail zaten -fail→PARTIAL yolundan geçer; realAppSkipped'a DÜŞMEZ (o yalnız -skipped).
    const events = [...cleanRun(), ev(16, "realapp-verify-fail", "bug sürüyor")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(16);
    expect(r.realAppSkipped).toEqual([]);
  });

  it("temiz koşuda realAppSkipped boş → PASS (regresyon: yeni alan eski davranışı bozmaz)", () => {
    const r = computeVerdict(cleanRun());
    expect(r.verdict).toBe("PASS");
    expect(r.realAppSkipped).toEqual([]);
  });

  it("BOŞ-BUILD: tamamlandı + tüm gate yeşil AMA deliverable yok → FAIL (sahte-yeşil koruması, 2026-06-24)", () => {
    // Canlı kanıt: Faz 5 yanlış atlandı → app HİÇ kurulmadı → gate'ler yoklukta sahte-geçti → PASS/PARTIAL.
    expect(computeVerdict(cleanRun(), { deliverableExists: false }).verdict).toBe("FAIL");
    expect(computeVerdict(cleanRun(), { deliverableExists: false }).exitCode).toBe(1);
    // deliverable VAR → eski davranış korunur (PASS)
    expect(computeVerdict(cleanRun(), { deliverableExists: true }).verdict).toBe("PASS");
    // opts verilmedi (caller kontrol etmedi) → geriye-uyumlu (PASS)
    expect(computeVerdict(cleanRun()).verdict).toBe("PASS");
  });
});

// 2026-08-03: Faz 17 (sızma testi) de güvenlik boyutudur. Eskiden koşulsuz "complete" yazıp hükme hiç
// yansımıyordu → hiç tarama yapılmadan PASS mümkündü.
describe("computeVerdict · Faz 17 sızma testi atlaması", () => {
  const base = (extra: AuditEvent[]): AuditEvent[] => [
    { ts: 1, phase: 17, event: "phase-17-complete" },
    ...extra,
  ];
  it("tarama aracı eksik / tarama çöktü → KISMİ (MyCL'in düzeltebileceği gerçek eksik)", () => {
    for (const detail of ['missing_command cmd="nuclei"', "scan_failed timeout"]) {
      const v = computeVerdict(base([{ ts: 2, phase: 17, event: "phase-17-skipped", detail }]), {
        deliverableExists: true,
      });
      expect(v.verdict).not.toBe("PASS");
    }
  });
  it("ortam/kapsam kaynaklı atlama → PASS korunur (çifte sayım ve kalıcı KISMİ yok)", () => {
    // Bunlar doğrulama özetinde "DOĞRULANMADI" olarak zaten GÖRÜNÜR; hükmü de düşürmek hem aynı
    // eksiği iki kez sayar (çalışan uygulama yokluğunu gerçek-app kapısı zaten düşürüyor) hem de
    // her koşuyu kalıcı KISMİ yapıp prototip kaydını öldürürdü.
    for (const detail of [
      "skip_unless=has_web_target",
      "no_dev_server",
      "unsupported_platform",
      "unchanged_since_last_scan",
    ]) {
      const v = computeVerdict(base([{ ts: 2, phase: 17, event: "phase-17-skipped", detail }]), {
        deliverableExists: true,
      });
      expect(v.verdict, detail).toBe("PASS");
    }
  });
});

// ADLİ ÖZ DENETİM (2026-09-10): hüküm canlı ölçümlerden değil, diskten GERİ OKUNAN denetim
// satırlarından hesaplanıyor. Mahkeme geçici dizinde kanıtladı: yedi satır değiştirilince
// (`-fail` → `-complete`) hüküm KISMİ'den GEÇTİ'ye döndü — kapıyı geçmek değil, kapının KAYDINI
// geçmek yetiyordu. Kayıt kurcalanmışsa buradaki hiçbir hesap anlamlı değil.
describe("kayıt bütünlüğü — kurcalanmış kayıt asla yeşil olamaz", () => {
  const yesilKosu = [
    { ts: 1, phase: 13, event: "phase-13-complete", caller: "mycl-orchestrator" },
    { ts: 2, phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" },
  ] as never[];

  it("kurcalanmışsa en yüksek öncelikli FAIL (gate'ler temiz görünse bile)", () => {
    const v = computeVerdict(yesilKosu, { deliverableExists: true, auditTampered: true });
    expect(v.verdict).toBe("FAIL");
    expect(v.exitCode).toBe(1);
    expect(v.summary).toContain("bütünlüğü");
  });

  it("GERİYE UYUM: bayrak verilmezse eski davranış birebir (çapası olmayan projeler kırmızıya dönmez)", () => {
    const eski = computeVerdict(yesilKosu, { deliverableExists: true });
    const acikFalse = computeVerdict(yesilKosu, { deliverableExists: true, auditTampered: false });
    expect(eski.verdict).toBe(acikFalse.verdict);
    expect(eski.verdict).not.toBe("FAIL");
  });

  it("bütünlük, boş build kontrolünden ÖNCE gelir (kayda güvenilmiyorsa gerisi konuşulmaz)", () => {
    const v = computeVerdict(yesilKosu, { deliverableExists: false, auditTampered: true });
    expect(v.summary).toContain("bütünlüğü");
  });
});

// KARAKTERİZASYON (2026-09-18, S5 ön koşulu): Faz 16 atlamasını hükme bağlamadan ÖNCE bugünkü
// semantiği donduruyorum. Hükmü sertleştiren her kenar iki tüketiciyi sessizce öldürebilir:
// prototip kaydı (PASS değilse yalnız baseline snapshot) ve modül stoklaması (listeler doluysa
// hiç stoklamaz). Bu regresyon daha önce yaşandı ve kodun kendi yorumuna yazıldı. Aşağıdaki
// testler "bugün ne oluyor"u sabitler; yeni dal bunları KIRMAMALI.
describe("KARAKTERİZASYON: bugünkü hüküm semantiği", () => {
  const iter = 1_000;
  const tamam = (extra: AuditEvent[] = []): AuditEvent[] => [
    { ts: iter + 1, phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" },
    ...extra,
  ];

  it("temiz koşu → PASS", () => {
    const v = computeVerdict(tamam(), { deliverableExists: true });
    expect(v.verdict).toBe("PASS");
  });

  it("playwright KULLANICI AYARIYLA kapalı → bugün PASS (kalıcı ayar kalıcı sarı yapmamalı)", () => {
    const v = computeVerdict(
      tamam([
        { ts: iter + 2, phase: 16, event: "phase-16-skipped", caller: "x", detail: "playwright_disabled (Settings)" },
        { ts: iter + 3, phase: 16, event: "phase-16-complete", caller: "x" },
      ]),
      { deliverableExists: true },
    );
    expect(v.verdict).toBe("PASS");
  });

  it("proje UI sunmuyor (skip_unless) → bugün PASS", () => {
    const v = computeVerdict(
      tamam([
        { ts: iter + 2, phase: 16, event: "phase-16-skipped", caller: "x", detail: "skip_unless=has_ui" },
        { ts: iter + 3, phase: 16, event: "phase-16-complete", caller: "x" },
      ]),
      { deliverableExists: true },
    );
    expect(v.verdict).toBe("PASS");
  });

  it("Faz 17 ortam kaynaklı atlama → PASS (nötr taksonomi korunur)", () => {
    const v = computeVerdict(
      tamam([{ ts: iter + 2, phase: 17, event: "phase-17-skipped", caller: "x", detail: "no_dev_server" }]),
      { deliverableExists: true },
    );
    expect(v.verdict).toBe("PASS");
  });

  it("Faz 17 araç eksik → PARTIAL (gerçek boşluk taksonomisi korunur)", () => {
    const v = computeVerdict(
      tamam([{ ts: iter + 2, phase: 17, event: "phase-17-skipped", caller: "x", detail: "missing_command" }]),
      { deliverableExists: true },
    );
    expect(v.verdict).toBe("PARTIAL");
  });
});

// S5 (2026-09-18): Faz 16 atlaması artık hükme yansıyor — AMA yalnız MyCL'in kapatabileceği boşluk.
// Üç atlama yolu da `phase-16-skipped` + düz `phase-16-complete` yazıyordu; computeVerdict yalnız
// `*-fail` aradığı için E2E hiç koşmasa bile hüküm temizdi.
describe("Faz 16 atlaması hükme yansır (yalnız gerçek boşlukta)", () => {
  const iter = 1_000;
  const kos = (detail: string) =>
    computeVerdict(
      [
        { ts: iter + 1, phase: 17, event: "phase-17-complete", caller: "x" },
        { ts: iter + 2, phase: 16, event: "phase-16-skipped", caller: "x", detail },
        { ts: iter + 3, phase: 16, event: "phase-16-complete", caller: "x" },
      ] as AuditEvent[],
      { deliverableExists: true },
    );

  it("araç kurulamadı → PARTIAL (MyCL'in kapatabileceği boşluk)", () => {
    const v = kos("install_failed");
    expect(v.verdict).toBe("PARTIAL");
    expect(v.e2eSkipped).toContain("install_failed");
    expect(v.summary).toContain("uçtan uca");
  });

  it("iskelet kurulamadı → PARTIAL", () => {
    expect(kos("scaffold_failed").verdict).toBe("PARTIAL");
  });

  it("YENİ DAMGA FORMATI da tanınır (via=skipped reason=...)", () => {
    expect(kos("via=skipped reason=install_failed").verdict).toBe("PARTIAL");
    expect(kos("via=skipped reason=playwright_disabled (Settings)").verdict).toBe("PASS");
    expect(kos("via=skipped reason=skip_unless=has_ui").verdict).toBe("PASS");
  });

  it("NÖTR kalanlar: kullanıcı ayarı, proje UI sunmuyor, stack desteklemiyor, controller yok", () => {
    expect(kos("playwright_disabled (Settings)").verdict).toBe("PASS");
    expect(kos("skip_unless=has_ui").verdict).toBe("PASS");
    expect(kos("precheck_fail reason=unsupported_stack").verdict).toBe("PASS");
    expect(kos("no_controller").verdict).toBe("PASS");
  });

  it("REGRESYON KİLİDİ: Faz 16 hiç atlanmadıysa e2eSkipped boş ve hüküm PASS", () => {
    const v = computeVerdict(
      [{ ts: iter + 1, phase: 17, event: "phase-17-complete", caller: "x" }] as AuditEvent[],
      { deliverableExists: true },
    );
    expect(v.e2eSkipped).toEqual([]);
    expect(v.verdict).toBe("PASS");
  });

  it("öncelik: gate hatası varsa o kazanır (E2E atlaması onu gölgelemez)", () => {
    const v = computeVerdict(
      [
        { ts: iter + 1, phase: 17, event: "phase-17-complete", caller: "x" },
        { ts: iter + 2, phase: 14, event: "phase-14-fail", caller: "x" },
        { ts: iter + 3, phase: 16, event: "phase-16-skipped", caller: "x", detail: "install_failed" },
      ] as AuditEvent[],
      { deliverableExists: true },
    );
    expect(v.summary).toContain("gate başarısız");
  });
});

// S8: kanıt toplayıcı — hepsi ZATEN üretilen sinyaller, yeni ölçüm yok.
describe("collectRunEvidence", () => {
  const e = (event: string, detail?: string): AuditEvent =>
    ({ ts: 1, phase: 0, event, caller: "x", detail }) as AuditEvent;

  it("E2E koştu ve atlanmadıysa kanıt sayılır", () => {
    expect(collectRunEvidence([e("phase-16-complete")]).e2ePassed).toBe(true);
  });

  it("E2E ATLANDIYSA kanıt sayılmaz (complete damgası olsa bile)", () => {
    const r = collectRunEvidence([e("phase-16-skipped", "install_failed"), e("phase-16-complete")]);
    expect(r.e2ePassed).toBe(false);
  });

  it("görsel tarama koşmadıysa 'ekran boş değil' kanıtı YOK (iddia da yok)", () => {
    expect(collectRunEvidence([]).screenNotBlank).toBe(false);
  });

  it("görsel tarama koştu ve boş bulmadıysa kanıt var", () => {
    expect(collectRunEvidence([e("visual-diff", "routes=1")]).screenNotBlank).toBe(true);
  });

  it("boş ekran işaretlendiyse kanıt YOK", () => {
    const r = collectRunEvidence([e("visual-diff"), e("phase-6-deferred", "blank_screen")]);
    expect(r.screenNotBlank).toBe(false);
  });

  it("boş ekran kaydı hata ayrıntısı taşısa da kanıt YOK (kayıt `blank_screen` ile başlar)", () => {
    const r = collectRunEvidence([
      e("visual-diff", "baseline=false routes=1 changed=1 page_errors=2"),
      e("phase-6-deferred", "blank_screen routes=/ errors=2 | sayfa: x is not defined | konsol: y"),
    ]);
    expect(r.screenNotBlank).toBe(false);
  });

  it("görsel tarama kaydındaki hata sayısı tek başına 'boş' sayılmaz", () => {
    const r = collectRunEvidence([e("visual-diff", "baseline=true routes=1 changed=0 page_errors=3"), e("phase-6-deferred", "")]);
    expect(r.screenNotBlank).toBe(true);
  });

  it("giriş zinciri taraması geçtiyse kanıt var", () => {
    expect(collectRunEvidence([e("entry-graph-pass")]).entryGraphOk).toBe(true);
  });

  it("çalışma zamanı hatası kaydı varsa o kanıt düşer", () => {
    expect(collectRunEvidence([e("runtime-error-recorded", "RUNTIME_VITE x")]).noRuntimeErrors).toBe(false);
    expect(collectRunEvidence([]).noRuntimeErrors).toBe(true);
  });
});

describe("son sonuç kuralı (2026-11-28, prompt 28)", () => {
  const phases = (v: ReturnType<typeof computeVerdict>) => v.gateFailures.map((g) => g.phase);
  const resolved = (v: ReturnType<typeof computeVerdict>) => v.resolvedFailures.map((g) => g.phase);
  it("düşüp sonra temiz tamamlanan faz başarısız sayılmaz; 'düştü, düzeltildi' listesine girer", () => {
    const v = computeVerdict([
      ev(8, "adversarial-test-fail", "AC2"),
      ev(8, "phase-8-complete", "green=48/3 debt=0 tdd=true suite=true"),
      ev(10, "lint-fail", "eslint"),
      ev(10, "phase-10-complete", "gate_autofix_resolved"),
      ev(10, "lint-pass"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(v)).toEqual([]);
    expect(resolved(v)).toEqual([8, 10]);
    expect(v.verdict).toBe("PASS");
  });
  it("yapilacaklar-sunucu-28 biçimi → yalnız Faz 13 (kullanıcı kabulü)", () => {
    const v = computeVerdict([
      ev(8, "adversarial-test-fail"),
      ev(8, "phase-8-complete", "green=48/3 debt=0 tdd=true suite=true"),
      ev(10, "lint-fail"),
      ev(10, "phase-10-complete", "gate_autofix_resolved"),
      ev(10, "lint-pass"),
      ev(10, "regression-guard-pass"),
      ev(13, "security-fail", "semgrep"),
      ev(13, "phase-13-complete", "security_accepted_by_user"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(v)).toEqual([13]);
    expect(v.verdict).toBe("PARTIAL");
  });
  it("alisveris-sunucu-33 biçimi → Faz 10 (mahkeme kabulü, tamamlanma yok) ve Faz 13", () => {
    const v = computeVerdict([
      ev(8, "adversarial-test-fail"),
      ev(8, "phase-8-complete", "green=49/3 debt=0 tdd=true suite=true"),
      ev(10, "lint-fail"),
      ev(10, "mahkeme-escalate-accept-continue", "kuşkulu"),
      ev(13, "security-fail"),
      ev(13, "phase-13-complete", "security_accepted_by_user"),
      ev(14, "unit-fail"),
      ev(14, "unit-pass"),
      ev(14, "phase-14-complete"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(v)).toEqual([10, 13]);
    expect(resolved(v)).toEqual([8, 14]);
  });
  it("kabul edilerek geçilen tamamlanmalar temiz DEĞİL", () => {
    for (const d of [
      "soft_complete_after_fail",
      "security_accepted_by_user",
      "mahkeme_false_positive_suppressed",
      "finding_accepted_permanently count=2",
    ]) {
      const v = computeVerdict([ev(10, "lint-fail"), ev(10, "phase-10-complete", d), ev(17, "phase-17-complete")]);
      expect(phases(v)).toEqual([10]);
    }
  });
  it("sınıflanmamış yeni bir ayrıntı güvenli tarafa düşer (düşüş sayılır)", () => {
    expect(classifyCompletionDetail(10, "yeni_bir_ayrinti")).toBe("unknown");
    const v = computeVerdict([ev(10, "phase-10-complete", "yeni_bir_ayrinti"), ev(17, "phase-17-complete")]);
    expect(phases(v)).toEqual([10]);
  });
  it("atlamadan sonra gelen tamamlanma düşüşü çözmez; sonraki gerçek koşu çözer", () => {
    const atlandi = computeVerdict([
      ev(11, "simplify-fail"),
      ev(11, "phase-11-skipped", "missing_command"),
      ev(11, "phase-11-complete", "gate_autofix_resolved"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(atlandi)).toEqual([11]);
    const sonraGecti = computeVerdict([
      ev(11, "simplify-fail"),
      ev(11, "phase-11-skipped", "missing_command"),
      ev(11, "phase-11-complete"),
      ev(11, "simplify-pass"),
      ev(11, "phase-11-complete"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(sonraGecti)).toEqual([]);
  });
  it("düzelen faz yeniden düşerse yine başarısız (düzeltildi listesinde görünmez)", () => {
    const v = computeVerdict([
      ev(14, "unit-fail"),
      ev(14, "phase-14-complete"),
      ev(14, "regression-guard-fail", "yeni kırık"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(v)).toEqual([14]);
    expect(resolved(v)).toEqual([]);
  });
  it("serbest metinli onay fazları ve denetleyici ölçüleri temiz sayılır", () => {
    expect(classifyCompletionDetail(6, "tamam güzel olmuş")).toBe("clean");
    expect(classifyCompletionDetail(9, "fix[8]=XSS riski")).toBe("clean");
    expect(classifyCompletionDetail(4, "sha256=abc")).toBe("clean");
    expect(classifyCompletionDetail(16, "via=skipped reason=install_failed")).toBe("skipped");
    expect(classifyCompletionDetail(13, "")).toBe("clean");
  });
  it("adı farklı atlama olayları da atlama sayılır; dışarıdaki sunucu Faz 5 düşüşünü çözmez", () => {
    const kapsam = computeVerdict([
      ev(7, "phase-7-fail"),
      ev(7, "phase-7-skipped-by-scope", "needed_phases=1,2"),
      ev(7, "phase-7-complete"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(kapsam)).toEqual([7]);
    const dis = computeVerdict([
      ev(5, "phase-5-install-fail"),
      ev(5, "phase-5-complete", "external dev server detected on port 3000 (not spawned)"),
      ev(17, "phase-17-complete"),
    ]);
    expect(phases(dis)).toEqual([5]);
    expect(classifyCompletionDetail(5, "external dev server detected on port 3000 (not spawned)")).toBe("skipped");
  });
});

describe("çalışan uygulama gereken adım açılamadı (2026-11-28, prompt 30)", () => {
  const tamam = (extra: AuditEvent[]) => [...extra, ev(17, "phase-17-complete")];
  it("app-open-unavailable hükmü düşürür (nötr değil)", () => {
    const v = computeVerdict(tamam([ev(12, "app-open-unavailable", "npm install: ERESOLVE")]));
    expect(v.verdict).toBe("PARTIAL");
    expect(v.realAppSkipped).toContain("app-open-unavailable");
    expect(v.summary).toContain("uygulama açılamadı");
  });
  it("app-open-ready hükmü düşürmez", () => {
    expect(computeVerdict(tamam([ev(12, "app-open-ready", "already_alive")])).verdict).toBe("PASS");
  });
  it("Faz 17 açılamadı bir kez sayılır (uygulama açılamadı), 'araç eksik' güvenlik atlaması olarak değil; eski no_dev_server nötr", () => {
    const v = computeVerdict(
      tamam([ev(17, "app-open-unavailable", "ERESOLVE"), ev(17, "phase-17-skipped", "dev_server_start_failed ERESOLVE")]),
    );
    expect(v.verdict).toBe("PARTIAL");
    expect(v.securitySkipped).toEqual([]);
    expect(v.realAppSkipped).toEqual(["app-open-unavailable"]);
    expect(computeVerdict(tamam([ev(17, "phase-17-skipped", "no_dev_server")])).verdict).toBe("PASS");
  });
});

