import { beforeEach, describe, expect, it, vi } from "vitest";

// runReasoningTurn'ü mock'la (gerçek claude/SDK spawn etme) — hypothesis-investigation testi deseni.
const turnMock = vi.fn();
vi.mock("../src/design-fanout.js", () => ({
  runReasoningTurn: (...a: unknown[]) => turnMock(...a),
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  lensActions,
  lensTaskText,
  parseBlindspots,
  isLensClean,
  formatLensFindings,
  runBlindspotLens,
  type LensResult,
} from "../src/pre-commit-lens.js";
import type { MyclConfig } from "../src/config.js";

const cfg = {} as unknown as MyclConfig;

describe("parseBlindspots (SAF)", () => {
  it("geçerli dizi → tüm alanlar", () => {
    const out = parseBlindspots({
      kind: "blindspot_review",
      blindspots: [{ severity: "high", note: "varsayım X", recommendation: "AC ekle" }],
    });
    expect(out).toEqual([{ severity: "high", note: "varsayım X", recommendation: "AC ekle" }]);
  });
  it("dizi değil → []", () => {
    expect(parseBlindspots({ blindspots: "nope" })).toEqual([]);
    expect(parseBlindspots(null)).toEqual([]);
    expect(parseBlindspots({})).toEqual([]);
  });
  it("bozuk item atlanır + boş note atlanır + severity whitelist dışı → 'medium'", () => {
    const out = parseBlindspots({
      blindspots: [
        { severity: "bogus", note: "geçerli" },
        { severity: "high", note: "" }, // boş note → atla
        "string", // → atla
        null, // → atla
      ],
    });
    expect(out).toEqual([{ severity: "medium", note: "geçerli", recommendation: "" }]);
  });
});

describe("isLensClean (SAF)", () => {
  it("clean=true + boş blindspots → true", () => {
    expect(isLensClean({ clean: true }, [])).toBe(true);
  });
  it("clean=true ama blindspots var → false", () => {
    expect(isLensClean({ clean: true }, [{ severity: "low", note: "x", recommendation: "" }])).toBe(false);
  });
  it("clean eksik/false → false", () => {
    expect(isLensClean({}, [])).toBe(false);
    expect(isLensClean({ clean: false }, [])).toBe(false);
  });
});

describe("formatLensFindings (SAF)", () => {
  const mk = (p: Partial<LensResult>): LensResult => ({ ran: true, clean: false, blindspots: [], ...p });

  it("ran=false → null", () => {
    expect(formatLensFindings(mk({ ran: false }))).toBeNull();
  });
  it("error → görünür 'çalışmadı' notu (sessiz değil)", () => {
    expect(formatLensFindings(mk({ error: "timeout" }))).toContain("çalışmadı");
  });
  it("clean → 'kör nokta bulunmadı'", () => {
    expect(formatLensFindings(mk({ clean: true }))).toContain("kör nokta bulunmadı");
  });
  it("bulgu → madde liste (severity TR + note)", () => {
    const msg = formatLensFindings(
      mk({ blindspots: [{ severity: "medium", note: "auth süresi belirsiz", recommendation: "AC ekle" }] }),
    );
    expect(msg).toContain("[orta]");
    expect(msg).toContain("auth süresi belirsiz");
    expect(msg).toContain("AC ekle");
  });
});

describe("runBlindspotLens (fail-safe; mock turn)", () => {
  beforeEach(() => turnMock.mockReset());

  it("turn anormal/çözümlenemez sonuç → fail-safe (ran:true, clean:false, error) — komit bloklanmaz", async () => {
    // string-olmayan çözüm → runBlindspotLens'in iç işleme/parse'ı patlar → try/catch fail-safe.
    // (mock REJECT/THROW etmez; vitest v4 caught-rejection'ı bile global flag'lediği için resolve ile test.)
    turnMock.mockResolvedValue(undefined as unknown as string);
    const r = await runBlindspotLens(cfg, "/tmp/p", "spec", "spec body");
    expect(r).toMatchObject({ ran: true, clean: false, blindspots: [] });
    expect(r.error).toBeTruthy();
  });

  it("blindspot_review bloğu yok → görünür error (parse edilemedi)", async () => {
    turnMock.mockResolvedValue("blah blah no json");
    const r = await runBlindspotLens(cfg, "/tmp/p", "decision", "Action: cancel");
    expect(r.ran).toBe(true);
    expect(r.error).toContain("çözümlenemedi");
  });

  it("geçerli temiz blok → clean:true, boş bulgu", async () => {
    turnMock.mockResolvedValue(`{"kind":"blindspot_review","clean":true,"blindspots":[]}`);
    const r = await runBlindspotLens(cfg, "/tmp/p", "spec", "spec body");
    expect(r.clean).toBe(true);
    expect(r.blindspots).toEqual([]);
  });

  it("geçerli bulgulu blok → clean:false + parse edilmiş bulgular", async () => {
    turnMock.mockResolvedValue(
      `{"kind":"blindspot_review","clean":false,"blindspots":[{"severity":"high","note":"n","recommendation":"r"}]}`,
    );
    const r = await runBlindspotLens(cfg, "/tmp/p", "spec", "spec body");
    expect(r.clean).toBe(false);
    expect(r.blindspots).toHaveLength(1);
    expect(r.blindspots[0].severity).toBe("high");
  });
});

// S7 (2026-09-18): merceğin çıktısı bugüne kadar YALNIZ sohbete basılıyordu. `severity: "high"`
// bulgular bile hiçbir yere yazılmıyor, hiçbir karara girmiyordu — mercek koştu mu, ne buldu,
// bulduğuna ne oldu, sonradan ÖLÇÜLEMİYORDU. Canlı kanıt: mercek "hiç çalışmamış bir faz
// tamamlanmış sayılır ve final rapor sahte yeşil çıkar" diye tam isabet uyardı; hiçbir etkisi olmadı.
describe("lensActions — mercek iz bırakır ve 'high' görüş araştırmaya döner", () => {
  const bs = (severity: "low" | "medium" | "high", note = "not") => ({
    severity,
    note,
    recommendation: "öneri",
  });

  it("temiz koşuda iş açılmaz ama ÖLÇÜM yazılır (mercek koştu, bir şey bulmadı)", () => {
    const a = lensActions({ ran: true, clean: true, blindspots: [] });
    expect(a.queue).toEqual([]);
    expect(a.auditDetail).toContain("clean=true");
  });

  it("yalnız 'high' görüşler iş açar; orta/düşük sohbette kalır", () => {
    const a = lensActions({
      ran: true,
      clean: false,
      blindspots: [bs("high", "A"), bs("medium", "B"), bs("low", "C")],
    });
    expect(a.queue).toHaveLength(1);
    expect(a.queue[0]!.note).toBe("A");
    expect(a.auditDetail).toContain("high=1");
    expect(a.auditDetail).toContain("med=1");
  });

  it("mercek hiç koşmadıysa ölçüm de iş de yok", () => {
    const a = lensActions({ ran: false, clean: false, blindspots: [] });
    expect(a.auditDetail).toBeNull();
    expect(a.queue).toEqual([]);
  });

  it("mercek hata verdiyse iş açılmaz ama hata ÖLÇÜLÜR (sessiz kaybolmaz)", () => {
    const a = lensActions({ ran: true, clean: false, blindspots: [bs("high")], error: "zaman aşımı" });
    expect(a.queue).toEqual([]);
    expect(a.auditDetail).toContain("error=");
  });

  it("YANLIŞ ALARM YASAĞI: iş metni İDDİA değil, doğrulama talebidir", () => {
    const t = lensTaskText(bs("high", "X varsayımı doğrulanmamış"));
    expect(t).toContain('"X varsayımı doğrulanmamış"'); // merceğin cümlesi TIRNAK içinde
    expect(t).toContain("LLM görüşüdür");
    expect(t).toContain("doğrulanmış bir bulgu DEĞİLDİR");
    expect(t).toContain("kontrol et");
  });
});
