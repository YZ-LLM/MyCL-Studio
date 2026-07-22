// full-test — saf sınıflandırma/rapor/fix-işi testleri + deps-enjekteli koşum (tarayıcı/LLM YOK).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  classifySuiteResult,
  formatFullTestReport,
  fixTasksFromReport,
  runFullTest,
  sweepOneRoute,
  collectFeatureIntents,
  verifyDocumentedFeatures,
  type FullTestReport,
} from "../src/full-test.js";
import type { State } from "../src/types.js";
import type { RealAppGateOutcome } from "../src/verify-feature.js";
import { PNG } from "pngjs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

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
    for (const id of ["e2e", "route-sweep"] as const) {
      expect(byId.get(id)?.status).toBe("skipped");
      expect(byId.get(id)?.detail_tr).toContain("dev server");
    }
    // functional: verifyIntent enjekte edilmedi → görünür atlandı (API-modu davranışı; verdict düşmez)
    expect(byId.get("functional")?.status).toBe("skipped");
    expect(byId.get("functional")?.detail_tr).toContain("kapalı");
    // hiçbir çekirdek fail yok → ok (atlanmışlar rapor içinde görünür)
    expect(r.ok).toBe(true);
    expect(r.sections).toHaveLength(5); // birim/entegrasyon/E2E/rota/işlevsel (a11y+görsel çıkarıldı 2026-07-22)
  });

  it("ensureDevServer throw etse bile rapor döner (bölüm izolasyonu)", async () => {
    const r = await runFullTest(fakeState, {
      ensureDevServer: async () => {
        throw new Error("patladı");
      },
      ensureE2E: async () => ({ proceed: true }),
    });
    expect(r.sections).toHaveLength(5);
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
    expect(tasks).toHaveLength(2); // unit + route-sweep; skipped/pass üretmez
    expect(tasks[0]).toContain("Birim testleri");
    expect(tasks[1]).toContain("Rota taraması");
  });

  it("skipped/pass bölümler fix işi üretmez (yalnız fail)", () => {
    const r2: FullTestReport = {
      ...report,
      ok: true,
      sections: report.sections.map((s) => ({ ...s, status: s.id === "integration" ? ("skipped" as const) : ("pass" as const) })),
    };
    expect(fixTasksFromReport(r2)).toHaveLength(0);
  });
});

describe("sweepOneRoute — rota-yerel dinleyiciler (mahkeme bulgusu: geç olay yanlış rotaya yazılmasın)", () => {
  // Sahte SweepPage: dinleyici kayıt defteri görünür → tak/sök davranışı doğrulanabilir.
  function makeFakePage(opts?: { shot?: Buffer; gotoImpl?: (page: FakePage) => Promise<void> }) {
    return new FakePage(opts?.shot ?? pngBuffer(true), opts?.gotoImpl);
  }
  class FakePage {
    consoleHandlers = new Set<(m: { type(): string; text(): string }) => void>();
    responseHandlers = new Set<(r: { status(): number; url(): string }) => void>();
    constructor(
      private shot: Buffer,
      private gotoImpl?: (page: FakePage) => Promise<void>,
    ) {}
    on(event: "console" | "response", h: never): void {
      if (event === "console") this.consoleHandlers.add(h);
      else this.responseHandlers.add(h);
    }
    off(event: "console" | "response", h: never): void {
      if (event === "console") this.consoleHandlers.delete(h);
      else this.responseHandlers.delete(h);
    }
    async goto(): Promise<void> {
      await this.gotoImpl?.(this);
    }
    async waitForTimeout(): Promise<void> {}
    async screenshot(): Promise<Buffer> {
      return this.shot;
    }
    emitConsoleError(text: string): void {
      for (const h of this.consoleHandlers) h({ type: () => "error", text: () => text });
    }
    emitResponse(status: number, url: string): void {
      for (const h of this.responseHandlers) h({ status: () => status, url: () => url });
    }
  }
  function pngBuffer(noise: boolean): Buffer {
    const img = new PNG({ width: 20, height: 20 });
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = noise ? (i * 37) % 256 : 200;
      img.data[i + 1] = noise ? (i * 53) % 256 : 200;
      img.data[i + 2] = noise ? (i * 11) % 256 : 200;
      img.data[i + 3] = 255;
    }
    return PNG.sync.write(img);
  }
  const BASE = "http://localhost:3000";

  it("rota sırasında gelen konsol hatası O rotaya yazılır", async () => {
    const page = makeFakePage({ gotoImpl: async (p) => p.emitConsoleError("boom") });
    const r = await sweepOneRoute(page, BASE, "/a");
    expect(r.opened).toBe(true);
    expect(r.issues.map((i) => i.problem).join()).toContain("konsol hatası: boom");
  });

  it("rota bitince dinleyiciler sökülür → geç olay SONRAKİ rotaya sızmaz", async () => {
    const page = makeFakePage();
    const a = await sweepOneRoute(page, BASE, "/a");
    expect(a.issues).toHaveLength(0);
    // /a'dan GEÇ gelen olaylar (dinleyici yok artık) — hiçbir yere yazılMAMALI.
    expect(page.consoleHandlers.size).toBe(0);
    expect(page.responseHandlers.size).toBe(0);
    page.emitConsoleError("geç olay");
    page.emitResponse(500, `${BASE}/a/api`);
    const b = await sweepOneRoute(page, BASE, "/b");
    expect(b.issues).toHaveLength(0);
  });

  it("goto patlarsa: açılamadı + opened:false + dinleyiciler yine sökülür (finally)", async () => {
    const page = makeFakePage({
      gotoImpl: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
    });
    const r = await sweepOneRoute(page, BASE, "/kirik");
    expect(r.opened).toBe(false);
    expect(r.issues[0]?.problem).toContain("açılamadı");
    expect(page.consoleHandlers.size).toBe(0);
    expect(page.responseHandlers.size).toBe(0);
  });

  it("≥400 yanıt → başarısız istek bulgusu", async () => {
    const page = makeFakePage({ gotoImpl: async (p) => p.emitResponse(503, `${BASE}/api/x`) });
    const r = await sweepOneRoute(page, BASE, "/a");
    expect(r.issues.map((i) => i.problem).join()).toContain("başarısız istek: 503");
  });

  it("tek renk ekran görüntüsü → neredeyse boş sayfa bulgusu", async () => {
    const page = makeFakePage({ shot: pngBuffer(false) });
    const r = await sweepOneRoute(page, BASE, "/bos");
    expect(r.issues.map((i) => i.problem).join()).toContain("neredeyse boş");
  });
});

describe("collectFeatureIntents — SAF davranış-kaynağı çıkarımı (help-pages birincil, features fallback)", () => {
  it("help-pages.json birincil: her sayfa → route + beklenen davranış içeren niyet", () => {
    const raw = [
      { route: "/kullanicilar", title_tr: "Kullanıcılar", title_en: "Users", body_tr: "liste", body_en: "shows a searchable user list" },
      { route: "/profil", title_tr: "Profil", title_en: "Profile", body_tr: "düzenle", body_en: "edit and save profile fields" },
    ];
    const r = collectFeatureIntents(raw, "");
    expect(r.source).toBe("help-pages");
    expect(r.intents).toHaveLength(2);
    expect(r.intents[0].label_tr).toBe("Kullanıcılar");
    expect(r.intents[0].intentEn).toContain("/kullanicilar");
    expect(r.intents[0].intentEn).toContain("searchable user list");
    // "yalnız açıldığını değil, GERÇEKTEN çalıştığını" niyeti gömülü (sahte-yeşil önleme)
    expect(r.intents[0].intentEn.toLowerCase()).toContain("actually works");
  });

  it("route veya davranış eksik sayfa atlanır (yalnız açılış rota-taramasının işi)", () => {
    const raw = [
      { route: "/ok", title_en: "OK", body_en: "does a thing" },
      { route: "", title_en: "no route", body_en: "x" }, // route yok
      { route: "/y", title_en: "no body" }, // body yok
      { title_en: "hiç route yok", body_en: "y" }, // route alanı yok
    ];
    const r = collectFeatureIntents(raw, "");
    expect(r.source).toBe("help-pages");
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0].intentEn).toContain("/ok");
  });

  it("aynı route iki kez → tekilleştirilir", () => {
    const raw = [
      { route: "/a", title_en: "A", body_en: "first" },
      { route: "/a", title_en: "A yine", body_en: "second" },
    ];
    expect(collectFeatureIntents(raw, "").intents).toHaveLength(1);
  });

  it("eski şema toleransı: yalnız _tr alanları varsa TR kullanılır", () => {
    const raw = [{ route: "/eski", title_tr: "Eski", body_tr: "eski davranış açıklaması" }];
    const r = collectFeatureIntents(raw, "");
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0].label_tr).toBe("Eski");
    expect(r.intents[0].intentEn).toContain("eski davranış açıklaması");
  });

  it("help-pages boş → features.md'ye düşer (## başlıklar; # önsöz atlanır)", () => {
    const md = [
      "# Uygulama Adı",
      "Giriş metni — özellik değil.",
      "",
      "## Arama",
      "Kullanıcı arar, sonuç anında filtrelenir.",
      "",
      "## Dışa aktarma",
      "CSV indirir.",
    ].join("\n");
    const r = collectFeatureIntents([], md);
    expect(r.source).toBe("features");
    expect(r.intents).toHaveLength(2); // önsöz (# ...) atlandı
    expect(r.intents[0].label_tr).toBe("Arama");
    expect(r.intents[0].intentEn).toContain("anında filtrelenir");
    expect(r.intents[1].label_tr).toBe("Dışa aktarma");
  });

  it("features.md önsözü '#' ile BAŞLAMASA bile özellik sayılmaz (ilk ## öncesi koşulsuz atlanır)", () => {
    // Müfettiş hipotezi: önsöz '#' başlıksız çok satırlı metinse eski sezgisel onu 'özellik' sanabilirdi.
    const md = ["Bu uygulama şunu yapar (başlıksız giriş).", "İkinci satır.", "", "## Giriş yap", "Kullanıcı e-posta+parola ile giriş yapar."].join("\n");
    const r = collectFeatureIntents([], md);
    expect(r.source).toBe("features");
    expect(r.intents).toHaveLength(1); // önsöz atlandı, yalnız gerçek ## özellik kaldı
    expect(r.intents[0].label_tr).toBe("Giriş yap");
  });

  it("features.md doğrudan ## ile başlarsa (önsöz yok) ilk özellik kaybolmaz", () => {
    const md = ["## Arama", "Anında filtreler.", "", "## Silme", "Kaydı siler."].join("\n");
    const r = collectFeatureIntents([], md);
    expect(r.intents.map((i) => i.label_tr)).toEqual(["Arama", "Silme"]);
  });

  it("ikisi de boş → source 'none' (çağıran görünür atlar — KATI #4)", () => {
    expect(collectFeatureIntents(null, "").source).toBe("none");
    expect(collectFeatureIntents([], "   ").source).toBe("none");
    expect(collectFeatureIntents("bozuk" as unknown, "").source).toBe("none");
    expect(collectFeatureIntents([], "").intents).toHaveLength(0);
  });
});

describe("verifyDocumentedFeatures — aggregate + iptal + no-source (sahte verifyIntent; Playwright/LLM YOK)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-functional-"));
    await fs.mkdir(join(root, ".mycl"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const st = (r: string) => ({ project_root: r, stack: "node-npm", project_type: "web" }) as unknown as State;

  async function writePages(pages: Array<{ route: string; title_en: string; body_en: string }>): Promise<void> {
    await fs.writeFile(join(root, ".mycl", "help-pages.json"), JSON.stringify(pages), "utf-8");
  }
  // route → sahte outcome eşlemesi ile deterministik verifyIntent
  function fakeVerify(byRoute: Record<string, RealAppGateOutcome>, calls?: string[]): (i: string) => Promise<RealAppGateOutcome> {
    return async (intentEn: string) => {
      const route = intentEn.match(/route (\/[^\s.]+)/)?.[1] ?? "";
      calls?.push(route);
      return byRoute[route] ?? { outcome: "cannot_run", reason: "not_found" };
    };
  }

  it("verifyIntent enjekte edilmedi → görünür atlanır (API-modu)", async () => {
    await writePages([{ route: "/a", title_en: "A", body_en: "x" }]);
    const s = await verifyDocumentedFeatures(st(root), { ensureDevServer: async () => ({ ok: true }), ensureE2E: async () => ({ proceed: true }) });
    expect(s.status).toBe("skipped");
    expect(s.detail_tr).toContain("kapalı");
  });

  it("davranış kaynağı yok → görünür atlanır (KATI #4)", async () => {
    // .mycl var ama help-pages.json/features.md yok
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      verifyIntent: fakeVerify({}),
    });
    expect(s.status).toBe("skipped");
    expect(s.detail_tr).toContain("davranış kaynağı yok");
  });

  it("hepsi pass → pass (N doğrulandı)", async () => {
    await writePages([
      { route: "/a", title_en: "A", body_en: "x" },
      { route: "/b", title_en: "B", body_en: "y" },
    ]);
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      verifyIntent: fakeVerify({ "/a": { outcome: "pass" }, "/b": { outcome: "pass" } }),
    });
    expect(s.status).toBe("pass");
    expect(s.detail_tr).toContain("2/2");
  });

  it("karışık: bir fail → fail + YALNIZ düşen özellik failures'ta; cannot_run verdict'i DÜŞÜRMEZ", async () => {
    await writePages([
      { route: "/ok", title_en: "OK", body_en: "works" },
      { route: "/kirik", title_en: "Kirik", body_en: "broken search" },
      { route: "/belirsiz", title_en: "Belirsiz", body_en: "cant verify" },
    ]);
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      verifyIntent: fakeVerify({
        "/ok": { outcome: "pass" },
        "/kirik": { outcome: "fail", failSnippet: "Expected 3 results, got 0\nat search.spec.ts:12" },
        "/belirsiz": { outcome: "cannot_run", reason: "codegen_failed" },
      }),
    });
    expect(s.status).toBe("fail");
    expect(s.failures).toHaveLength(1); // yalnız gerçek fail
    expect(s.failures?.[0]).toContain("Kirik");
    expect(s.failures?.[0]).toContain("Expected 3 results");
    expect(s.detail_tr).toContain("1 kanıtlanamadı"); // cannot_run görünür ama fail değil
  });

  it("hepsi cannot_run → skipped (görünür; sahte-kırmızı DEĞİL — API-modu koruması)", async () => {
    await writePages([
      { route: "/a", title_en: "A", body_en: "x" },
      { route: "/b", title_en: "B", body_en: "y" },
    ]);
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      verifyIntent: fakeVerify({ "/a": { outcome: "cannot_run", reason: "not_found" }, "/b": { outcome: "cannot_run", reason: "codegen_failed" } }),
    });
    expect(s.status).toBe("skipped");
    expect(s.detail_tr).toContain("hiçbir özellik doğrulanamadı");
  });

  it("iptal: signal k'dan sonra abort → kalanlar atlanır, verifyIntent yalnız k kez çağrılır", async () => {
    await writePages([
      { route: "/a", title_en: "A", body_en: "x" },
      { route: "/b", title_en: "B", body_en: "y" },
      { route: "/c", title_en: "C", body_en: "z" },
      { route: "/d", title_en: "D", body_en: "w" },
    ]);
    const ac = new AbortController();
    const calls: string[] = [];
    const base = fakeVerify({ "/a": { outcome: "pass" }, "/b": { outcome: "pass" }, "/c": { outcome: "pass" }, "/d": { outcome: "pass" } }, calls);
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      signal: ac.signal,
      verifyIntent: async (i) => {
        const out = await base(i);
        if (calls.length >= 2) ac.abort(); // 2. özellikten sonra iptal
        return out;
      },
    });
    expect(calls).toHaveLength(2); // 3. tur öncesi signal.aborted → döngü kırılır
    expect(s.detail_tr).toContain("iptalle atlandı");
    // 2 pass var → verdict pass (iptal sahte-kırmızı yapmaz)
    expect(s.status).toBe("pass");
  });

  it("onProgress her özellikte i/N ile çağrılır", async () => {
    await writePages([
      { route: "/a", title_en: "A", body_en: "x" },
      { route: "/b", title_en: "B", body_en: "y" },
    ]);
    const progress: string[] = [];
    await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      onProgress: (m) => progress.push(m),
      verifyIntent: fakeVerify({ "/a": { outcome: "pass" }, "/b": { outcome: "pass" } }),
    });
    expect(progress).toHaveLength(2);
    expect(progress[0]).toContain("1/2");
    expect(progress[1]).toContain("2/2");
  });

  it("seam istisna verirse: kanıtlanamadı sayılır (bölüm izolasyonu — throw etmez)", async () => {
    await writePages([{ route: "/patlar", title_en: "P", body_en: "x" }]);
    const s = await verifyDocumentedFeatures(st(root), {
      ensureDevServer: async () => ({ ok: true }),
      ensureE2E: async () => ({ proceed: true }),
      verifyIntent: async () => {
        throw new Error("seam patladı");
      },
    });
    expect(s.status).toBe("skipped"); // hiç pass/fail yok → görünür atlama
    expect(s.detail_tr).toContain("hiçbir özellik doğrulanamadı");
  });
});

describe("fixTasksFromReport — işlevsel bölüm çekirdek (düşünce → fix işi)", () => {
  it("functional fail → 1 fix işi (kanıt: düşen özellikler)", () => {
    const r: FullTestReport = {
      ok: false,
      durationMs: 1000,
      sections: [
        {
          id: "functional",
          label_tr: "İşlevsel doğrulama",
          status: "fail",
          detail_tr: "1 özellik çalışmıyor",
          failures: ["Arama — Expected 3 results, got 0"],
        },
      ],
    };
    const tasks = fixTasksFromReport(r);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toContain("İşlevsel doğrulama");
    expect(tasks[0]).toContain("Arama");
  });
});
