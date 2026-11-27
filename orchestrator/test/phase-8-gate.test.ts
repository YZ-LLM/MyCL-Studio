// phase-8-gate — Faz 8 kapısının son kararı (decideTddGate), ölçüt adı kesmesi (testResultAuditDetail) ve
// "kırmızı önce" kararı + izi (evaluateReproFirst).
//
// CANLI KANIT (ekransız deneme koşusu 18, 2026-11-27; arayüzsüz Node.js CLI, 6 kabul ölçütü): ajan bütün ölçütleri
// tek satırda bildirdi (`tdd-green | green: AC1,…,AC6`), MyCL'in kendi son koşusu yeşildi (`final suite … pass`);
// kapı `greens=2 < minGreens=3` diye "AC coverage yetersiz: 2/3 green" ile düştü. Düzeltme kipindeki ikinci denemede
// "kırmızı önce" kuralının neden uygulandığı (hangi dosyalar değişti, liste okundu mu) hiçbir kayıtta yoktu.
//
// Gerçek git/dosya sistemi kullanılmaz: değişen dosya listesi ve denetim yazımı taklit edilir.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { changedVsSnapshotMock, getChangedFilesMock, appendAuditMock, logInfoMock } = vi.hoisted(() => ({
  changedVsSnapshotMock: vi.fn(),
  getChangedFilesMock: vi.fn(),
  appendAuditMock: vi.fn(async () => {}),
  logInfoMock: vi.fn(),
}));

vi.mock("../src/fix-snapshot.js", async (orig) => ({
  ...(await orig<typeof import("../src/fix-snapshot.js")>()),
  changedFilesVsSnapshot: changedVsSnapshotMock,
}));
vi.mock("../src/git.js", async (orig) => ({
  ...(await orig<typeof import("../src/git.js")>()),
  getChangedFiles: getChangedFilesMock,
}));
vi.mock("../src/audit.js", async (orig) => ({
  ...(await orig<typeof import("../src/audit.js")>()),
  appendAudit: appendAuditMock,
}));
vi.mock("../src/logger.js", () => ({
  log: { info: logInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  acCoverage,
  decideTddGate,
  evaluateReproFirst,
  testResultAuditDetail,
  type TddGateInput,
} from "../src/phase-8.js";

const ALTI = ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6"];
const SAYIM_ILETISI = /yeşil sonuç bildirimi yetersiz/;
const REPRO_ILETISI = "repro-first ihlali: bug'ı yeniden üreten failing test (kırmızı→yeşil) yok";

/** Koşu 18'in ilk denemesi: iki yeşil olay — ajanın tek satırı ve MyCL'in son koşusu. */
function kosu18(over: Partial<TddGateInput> = {}, ajanSatiri = "green: AC1,AC2,AC3,AC4,AC5,AC6"): TddGateInput {
  const details = [ajanSatiri, "final suite (MyCL anchor, ajanın son test komutu): pass"];
  return {
    isFixMode: false,
    acIds: ALTI,
    acCov: acCoverage(ALTI, details),
    greens: 2,
    minGreens: 3,
    reds: 0,
    lastEvent: "tdd-green",
    finalSuiteRun: true,
    techDebtCount: 0,
    techDebtPaths: [],
    techDebtFindings: [],
    reproOk: true,
    ...over,
  };
}

describe("decideTddGate — yeşil ölçüsü", () => {
  it("düzeltme kipi dışı, 6 ölçüt, TAM iki yeşil olay (biri altı adı taşıyor), eşik 3 → geçer, puan 100", () => {
    const d = decideTddGate(kosu18());
    expect(d.pass).toBe(true);
    expect(d.measure).toBe("ac-kapsama");
    expect(d.score).toBe(100);
    expect(d.measureText).toBe("ölçü=ac-kapsama 6/6");
    expect(d.reasons).toEqual([]);
  });

  it("aynı durum, bir ölçüt adı eksik → düşer; sayım iletisi YOK, testsiz kabul kriterleri VAR; eskalasyon yok, suite yeşil", () => {
    const d = decideTddGate(kosu18({}, "green: AC1,AC2,AC3,AC4,AC5"));
    expect(d.pass).toBe(false);
    expect(d.reasons.some((r) => SAYIM_ILETISI.test(r))).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("testsiz kabul kriterleri (AC→test): AC6"))).toBe(true);
    // Controller: lastFailEscalatable = codeQualityFail && !regressionRepeated; lastFailSuiteGreen = suiteGreen.
    expect(d.codeQualityFail).toBe(false);
    expect(d.suiteGreen).toBe(true);
  });

  it("ölçüt adı yok, iki yeşil olay, eşik 3 → düşer; ileti yeni sayım metnini taşıyor (eski 'AC coverage' değil)", () => {
    const d = decideTddGate(kosu18({}, "green: bütün testler geçti"));
    expect(d.pass).toBe(false);
    expect(d.measure).toBe("yeşil-sayısı");
    expect(d.reasons).toContain("yeşil sonuç bildirimi yetersiz: 2/3");
    expect(d.reasons.join(";")).not.toMatch(/AC coverage/);
    expect(d.codeQualityFail).toBe(true); // eskisi gibi: yetersiz yeşil kod hatası sayılır
    expect(d.suiteGreen).toBe(false);
  });

  it("düzeltme kipi, bütün ölçüt adları var, yeşil olay eşiğin altında → yine sayımdan düşer", () => {
    const d = decideTddGate(kosu18({ isFixMode: true }));
    expect(d.pass).toBe(false);
    expect(d.measure).toBe("yeşil-sayısı");
    expect(d.reasons).toContain("yeşil sonuç bildirimi yetersiz: 2/3");
  });

  it("ölçüt listesi boş (spec okunamadı) → sayım eşiği aynen", () => {
    const d = decideTddGate(kosu18({ acIds: [], acCov: acCoverage([], ["green: AC1"]) }));
    expect(d.measure).toBe("yeşil-sayısı");
    expect(d.pass).toBe(false);
  });

  // Kural 14 (c): öteki koşullar ölçüt kapsaması tamken de kapıyı düşürür.
  it("REGRESYON: son tam koşu kırmızı / teknik borç / son olay yeşil değil → kapsama tam olsa da düşer", () => {
    const kirmizi = decideTddGate(kosu18({ lastEvent: "tdd-red", reds: 1 }));
    expect(kirmizi.pass).toBe(false);
    expect(kirmizi.reasons).toContain("final tam-suite KIRMIZI — son doğrulama (npm test) geçmedi");
    expect(kirmizi.codeQualityFail).toBe(true);
    const borc = decideTddGate(
      kosu18({
        techDebtCount: 1,
        techDebtPaths: ["src/a.js"],
        techDebtFindings: [1, 2, 3, 4].map((line) => ({ path: "src/a.js", line, category: "todo_comment", excerpt: `// TODO ${line}` })),
      }),
    );
    expect(borc.pass).toBe(false);
    // 2026-11-28: ileti her bulgu için yol, satır, kural ve satır metnini veriyor (en çok üç, gerisi sayıyla).
    expect(borc.reasons).toContain(
      "1 dosyada tech debt: src/a.js:1 [todo_comment] `// TODO 1`; src/a.js:2 [todo_comment] `// TODO 2`; src/a.js:3 [todo_comment] `// TODO 3` (+1 bulgu daha)",
    );
    const kosmadi = decideTddGate(kosu18({ lastEvent: "tdd-unverified", finalSuiteRun: false }));
    expect(kosmadi.pass).toBe(false);
    expect(kosmadi.reasons).toContain("final tam-suite doğrulaması yapılamadı (yeşil sonuç yok)");
  });

  it("REGRESYON: ölçüt adı taşımayan akışta eşik ve puan eskisi gibi (greens/minGreens)", () => {
    const d = decideTddGate(kosu18({ greens: 3 }, "green: bütün testler geçti"));
    expect(d.pass).toBe(true);
    expect(d.score).toBe(100);
    expect(d.measureText).toBe("ölçü=yeşil-sayısı 3/3");
  });
});

describe("testResultAuditDetail — ölçüt adları kesilmez", () => {
  it("25 ölçüt tek satırda bildirildi → 25'i de kapsanmış sayılır", () => {
    const ids = Array.from({ length: 25 }, (_, k) => `AC${k + 1}`);
    const satir = `${ids.join(",")} — bütünsel test takımı geçti`;
    expect(satir.length).toBeGreaterThan(100); // eski kesme (100 karakter) sondaki adları kaybederdi
    const cov = acCoverage(ids, [testResultAuditDetail(satir)]);
    expect(cov.uncovered).toEqual([]);
    expect(cov.covered).toHaveLength(25);
  });

  it("kesme sözcük ortasına düşerse yarım ad başka ölçütü kapsanmış göstermez (`… AC12` → `AC1` değil)", () => {
    const satir = `${"x".repeat(96)} AC12`;
    const cov = acCoverage(["AC1", "AC12"], [testResultAuditDetail(satir)]);
    expect(cov.covered).toEqual(["AC12"]);
    expect(cov.uncovered).toEqual(["AC1"]);
  });

  it("REGRESYON: 100 karakteri aşmayan bildirim birebir aynı yazılır", () => {
    expect(testResultAuditDetail("AC1,AC2 testleri geçti")).toBe("AC1,AC2 testleri geçti");
  });
});

describe("evaluateReproFirst — düzeltme kipi, kopya yedek yolu", () => {
  beforeEach(() => {
    changedVsSnapshotMock.mockReset();
    getChangedFilesMock.mockReset();
    appendAuditMock.mockClear();
    logInfoMock.mockClear();
  });
  const girdi = {
    projectRoot: "/tmp/mycl-repro-testi",
    isFixMode: true,
    pendingBackendFix: true,
    checkpointRef: null,
    fixSnapshot: { method: "copy" as const, dir: "/tmp/mycl-repro-yedek" },
    events: [{ event: "tdd-green" }, { event: "tdd-green" }],
  };
  /** `gate repro` iz satırının alanları. */
  function reproIzi(): Record<string, unknown> {
    const call = logInfoMock.mock.calls.find((c) => c[1] === "gate repro");
    expect(call, "gate repro iz satırı yazılmadı").toBeDefined();
    return call![2] as Record<string, unknown>;
  }

  it("pending_backend_fix dolu, yalnız test dosyası değişmiş → muaf, repro-exempt denetimi, izde liste ve kategori", async () => {
    changedVsSnapshotMock.mockResolvedValue(["tests/cli.test.js"]);
    const r = await evaluateReproFirst(girdi);
    expect(r.reproRequired).toBe(false);
    expect(r.reproOk).toBe(true);
    expect(appendAuditMock).toHaveBeenCalledWith(
      "/tmp/mycl-repro-testi",
      expect.objectContaining({ event: "repro-exempt", detail: expect.stringContaining("kategori=runtime-prod-değişikliği-yok") }),
    );
    const iz = reproIzi();
    expect(iz.fix_mode).toBe(true);
    expect(iz.repro_required).toBe(false);
    expect(iz.exempt_category).toBe("runtime-prod-değişikliği-yok");
    expect(iz.list_state).toBe("liste-güvenilir");
    expect(iz.changed).toEqual(["tests/cli.test.js"]);
    expect(iz.runtime_prod_count).toBe(0);
  });

  it("liste null (kopya karşılaştırması okunamadı) → kırmızı önce zorunlu kalır; iz bunu söyler; kapı iletisi aynı", async () => {
    changedVsSnapshotMock.mockResolvedValue(null);
    const r = await evaluateReproFirst(girdi);
    expect(r.reproRequired).toBe(true);
    expect(r.reproOk).toBe(false); // yeşiller var ama önce kırmızı yok
    expect(appendAuditMock).not.toHaveBeenCalled();
    const iz = reproIzi();
    expect(iz.list_state).toBe("kopya-okunamadı");
    expect(iz.changed_count).toBeNull();
    // lastFailReason = `gate fail: ${reasons.join("; ")}` — "kırmızı önce" metni eskisiyle birebir aynı.
    const d = decideTddGate(kosu18({ isFixMode: true, greens: 4, reproOk: r.reproOk }));
    expect(`gate fail: ${d.reasons.join("; ")}`).toBe(`gate fail: ${REPRO_ILETISI}`);
  });

  it("REGRESYON: düzeltme kipi dışında hiçbir liste okunmaz, kırmızı önce istenmez", async () => {
    const r = await evaluateReproFirst({ ...girdi, isFixMode: false });
    expect(r.reproRequired).toBe(false);
    expect(changedVsSnapshotMock).not.toHaveBeenCalled();
    expect(reproIzi().list_state).toBe("kipte-değil");
  });

  it("izde değişen dosya listesi 20 yolla sınırlı, fazlası sayıyla", async () => {
    changedVsSnapshotMock.mockResolvedValue(Array.from({ length: 23 }, (_, k) => `tests/t${k}.test.js`));
    await evaluateReproFirst(girdi);
    const iz = reproIzi();
    expect(iz.changed_count).toBe(23);
    expect(iz.changed).toHaveLength(21);
    expect((iz.changed as string[])[20]).toBe("… +3 dosya daha");
  });
});
