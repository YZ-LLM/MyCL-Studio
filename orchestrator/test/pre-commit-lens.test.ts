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
  parseBlindspots,
  isLensClean,
  formatLensFindings,
  lensHasHighSeverity,
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

describe("formatLensFindings + lensHasHighSeverity (SAF)", () => {
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
  it("lensHasHighSeverity: high varsa true, yoksa false", () => {
    expect(lensHasHighSeverity(mk({ blindspots: [{ severity: "high", note: "x", recommendation: "" }] }))).toBe(true);
    expect(lensHasHighSeverity(mk({ blindspots: [{ severity: "low", note: "x", recommendation: "" }] }))).toBe(false);
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
