// visual-regression — saf yardımcılar + taban terfi testleri (sentetik PNG, tarayıcı açılmaz) ve en
// sonda boş ekranın nedenini yakalayan GERÇEK açılış (Playwright chromium + yerel http sunucusu;
// tarayıcı kurulu değilse o testler görünür biçimde atlanır).
import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import {
  blankScreenDetail,
  captureAndCompare,
  clipPageError,
  comparePngBuffers,
  formatVisualReport,
  isNearlyBlank,
  promoteVisualBaseline,
  routesFromHelpPages,
  type VisualRegressionResult,
} from "../src/visual-regression.js";

/** Sentetik PNG: her piksele (x,y)→[r,g,b] veren fonksiyonla üret. */
function makePng(width: number, height: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = px(x, y);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

const white = () => [255, 255, 255] as [number, number, number];
const black = () => [0, 0, 0] as [number, number, number];

describe("comparePngBuffers", () => {
  it("aynı görüntü → unchanged, oran 0", () => {
    const a = makePng(50, 50, white);
    expect(comparePngBuffers(a, makePng(50, 50, white))).toEqual({ status: "unchanged", diffRatio: 0 });
  });

  it("yarısı değişmiş → changed, oran ~0.5", () => {
    const a = makePng(50, 50, white);
    const b = makePng(50, 50, (x) => (x < 25 ? white() : black()));
    const r = comparePngBuffers(a, b);
    expect(r.status).toBe("changed");
    expect(r.diffRatio).toBeGreaterThan(0.4);
    expect(r.diffRatio).toBeLessThan(0.6);
  });

  it("boyut farkı → dim-changed (piksel kıyası anlamsız)", () => {
    expect(comparePngBuffers(makePng(50, 50, white), makePng(60, 50, white)).status).toBe("dim-changed");
  });
});

describe("isNearlyBlank", () => {
  it("tek renk (beyaz/boş sayfa) → true", () => {
    expect(isNearlyBlank(makePng(40, 40, white))).toBe(true);
  });
  it("içerikli (damalı) görüntü → false", () => {
    const checker = makePng(40, 40, (x, y) => ((x + y) % 2 === 0 ? white() : black()));
    expect(isNearlyBlank(checker)).toBe(false);
  });
});

describe("routesFromHelpPages", () => {
  it("[{route}] biçimini okur, tekrarı eler, / ile başlamayanı atar", () => {
    expect(
      routesFromHelpPages([{ route: "/" }, { route: "/admin" }, { route: "/admin" }, { route: "oops" }, { x: 1 }]),
    ).toEqual(["/", "/admin"]);
  });
  it("geçersiz girdi → boş", () => {
    expect(routesFromHelpPages(null)).toEqual([]);
    expect(routesFromHelpPages({ route: "/" })).toEqual([]);
  });
});

describe("formatVisualReport — SALT-RAPOR dili", () => {
  const base: VisualRegressionResult = { ran: true, url: "http://localhost:5173", baselineExisted: true, diffs: [] };

  it("koşamadı → görünür neden (sessiz 'temiz' yok)", () => {
    const msg = formatVisualReport({ ...base, ran: false, skippedReason: "Playwright bulunamadı" });
    expect(msg).toContain("yapılamadı");
    expect(msg).toContain("Playwright bulunamadı");
  });

  it("ilk koşu (taban yok) → 'ilk görüntüler kaydedildi'", () => {
    const msg = formatVisualReport({
      ...base,
      baselineExisted: false,
      diffs: [{ route: "/", status: "new" }],
    });
    expect(msg).toContain("ilk görüntüler kaydedildi");
    expect(msg).toContain("sonraki iterasyonda");
  });

  it("kayda değer değişim + yeni rota + hata tek tek; önemsizler özet", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [
        { route: "/", status: "changed", diffRatio: 0.42 },
        { route: "/about", status: "changed", diffRatio: 0.001 },
        { route: "/admin", status: "new" },
        { route: "/broken", status: "error", errorReason: "timeout" },
        { route: "/same", status: "unchanged", diffRatio: 0 },
      ],
    });
    expect(msg).toContain("%42.0 değişim");
    expect(msg).toContain("yeni rota");
    expect(msg).toContain("çekilemedi: timeout");
    expect(msg).toContain("(2 rota değişmedi/önemsiz düzeyde)");
    expect(msg).not.toContain("/about` — %"); // önemsiz değişim tek tek listelenmez
  });

  it("hiç kayda değer değişim yok → ✅ özet", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [{ route: "/", status: "unchanged", diffRatio: 0 }],
    });
    expect(msg).toContain("✅ kayda değer görsel değişim yok");
  });

  it("boş görünen sayfa → ⚠️ uyarı satırı (never-ask emniyet ağı)", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [{ route: "/", status: "unchanged", diffRatio: 0, nearlyBlank: true }],
    });
    expect(msg).toContain("⚠️");
    expect(msg).toContain("Boş görünen sayfa");
    // REGRESYON KİLİDİ: hata dinlenmemiş sonuçta (alan yok) hata satırı uydurulmaz.
    expect(msg).not.toContain("tarayıcı");
  });

  it("boş sayfanın açılışında görülen ilk birkaç hata mesaja girer, fazlası sayılır", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [
        {
          route: "/",
          status: "new",
          nearlyBlank: true,
          pageErrors: ["sayfa: a is not defined", "konsol: b", "konsol: c", "konsol: d"],
          pageErrorCount: 6,
        },
      ],
    });
    expect(msg).toContain("tarayıcının bildirdiği hatalar (6)");
    expect(msg).toContain("sayfa: a is not defined");
    expect(msg).toContain("konsol: c");
    expect(msg).not.toContain("konsol: d"); // yalnız ilk üçü
    expect(msg).toContain("+3 daha");
  });

  it("boş sayfa ama tarayıcı hata bildirmediyse bu da açıkça yazılır", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [{ route: "/", status: "new", nearlyBlank: true, pageErrors: [], pageErrorCount: 0 }],
    });
    expect(msg).toContain("konsol ya da sayfa hatası bildirmedi");
  });

  it("boş OLMAYAN sayfanın hataları boş ekran satırına karışmaz", () => {
    const msg = formatVisualReport({
      ...base,
      diffs: [{ route: "/", status: "unchanged", diffRatio: 0, nearlyBlank: false, pageErrors: ["konsol: x"], pageErrorCount: 1 }],
    });
    expect(msg).not.toContain("konsol: x");
    expect(msg).not.toContain("Boş görünen sayfa");
  });
});

describe("clipPageError — tek satır, sınırlı uzunluk", () => {
  it("satır sonlarını ve fazla boşluğu tek boşluğa indirir", () => {
    expect(clipPageError("sayfa", "a\n   b\t c")).toBe("sayfa: a b c");
  });
  it("konum metinde yoksa sona eklenir, varsa yinelenmez", () => {
    expect(clipPageError("konsol", "Failed to load resource", "http://x/src/main.jsx")).toBe(
      "konsol: Failed to load resource @ http://x/src/main.jsx",
    );
    expect(clipPageError("konsol", "hata http://x/a.js içinde", "http://x/a.js")).toBe("konsol: hata http://x/a.js içinde");
  });
  it("çok uzun ileti kırpılır", () => {
    const out = clipPageError("sayfa", "x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("blankScreenDetail — Faz 6 kaydının ayrıntısı", () => {
  it("ekran boş değilse boş dizgi (eski davranış)", () => {
    expect(blankScreenDetail([{ route: "/", status: "new", nearlyBlank: false, pageErrors: ["konsol: x"], pageErrorCount: 1 }])).toBe("");
    expect(blankScreenDetail([])).toBe("");
  });

  it("boş ama hata dinlenmemişse yalnız eski sözcük (sayı iddia edilmez)", () => {
    expect(blankScreenDetail([{ route: "/", status: "new", nearlyBlank: true }])).toBe("blank_screen");
  });

  it("boş ve tarayıcı hata bildirmediyse errors=0 yazar", () => {
    expect(blankScreenDetail([{ route: "/", status: "new", nearlyBlank: true, pageErrors: [], pageErrorCount: 0 }])).toBe(
      "blank_screen routes=/ errors=0",
    );
  });

  it("boş ve hata varsa `blank_screen` ile başlar, hatanın metnini taşır (ilk üçü)", () => {
    const d = blankScreenDetail([
      {
        route: "/",
        status: "new",
        nearlyBlank: true,
        pageErrors: ["sayfa: main is not defined", "konsol: b", "konsol: c", "konsol: d"],
        pageErrorCount: 4,
      },
      { route: "/dolu", status: "new", nearlyBlank: false, pageErrors: ["konsol: başka rota"], pageErrorCount: 1 },
    ]);
    expect(d.startsWith("blank_screen routes=/ errors=4 | ")).toBe(true);
    expect(d).toContain("sayfa: main is not defined");
    expect(d).toContain("konsol: c");
    expect(d).not.toContain("konsol: d");
    expect(d).not.toContain("başka rota"); // boş olmayan rotanın hatası karışmaz
  });

  it("kayıt uzunluğu sınırlıdır", () => {
    const uzun = Array.from({ length: 5 }, (_, i) => `konsol: ${String(i).repeat(239)}`);
    const d = blankScreenDetail([{ route: "/", status: "new", nearlyBlank: true, pageErrors: uzun, pageErrorCount: 5 }]);
    expect(d.length).toBeLessThanOrEqual(700);
    expect(d.startsWith("blank_screen")).toBe(true);
  });
});

describe("promoteVisualBaseline — taban terfi yaşam döngüsü", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-visual-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("pending → baseline terfi eder; eski taban silinir", async () => {
    const pending = join(root, ".mycl", "visual-pending");
    const baseline = join(root, ".mycl", "visual-baseline");
    await fs.mkdir(pending, { recursive: true });
    await fs.mkdir(baseline, { recursive: true });
    await fs.writeFile(join(pending, "anasayfa.png"), makePng(4, 4, white));
    await fs.writeFile(join(baseline, "eski.png"), makePng(4, 4, black));
    await promoteVisualBaseline(root);
    const files = await fs.readdir(baseline);
    expect(files).toEqual(["anasayfa.png"]);
    await expect(fs.readdir(pending)).rejects.toThrow(); // pending taşındı
  });

  it("pending yok → no-op (eski taban korunur)", async () => {
    const baseline = join(root, ".mycl", "visual-baseline");
    await fs.mkdir(baseline, { recursive: true });
    await fs.writeFile(join(baseline, "eski.png"), makePng(4, 4, black));
    await promoteVisualBaseline(root);
    expect(await fs.readdir(baseline)).toEqual(["eski.png"]);
  });

  it("pending boş (png yok) → no-op", async () => {
    const pending = join(root, ".mycl", "visual-pending");
    await fs.mkdir(pending, { recursive: true });
    await promoteVisualBaseline(root);
    // baseline oluşmadı
    await expect(fs.readdir(join(root, ".mycl", "visual-baseline"))).rejects.toThrow();
  });
});

// CANLI KANIT (ekransız deneme koşusu, 2026-11-27): Faz 6 `blank_screen` yazdı ama neden yoktu —
// sayfayı açan kod tarayıcının konsolunu ve sayfa hatalarını hiç dinlemiyordu.
describe("captureAndCompare — boş ekranın nedenini aynı açılışta yakalar (gerçek tarayıcı)", () => {
  // STRICT_CSP'nin yerel kopyası (2026-11-27'den beri `frame-ancestors` yok).
  const KATI_POLITIKA =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'";
  let server: Server;
  let url = "";
  let root: string;
  let tarayiciVar = false;

  beforeAll(async () => {
    try {
      const b = await chromium.launch({ headless: true });
      await b.close();
      tarayiciVar = true;
    } catch {
      tarayiciVar = false;
    }
    const html = (body: string, head = ""): string =>
      `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Deneme</title>${head}</head><body>${body}</body></html>`;
    server = createServer((req, res) => {
      const sayfa = (icerik: string): void => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": KATI_POLITIKA });
        res.end(icerik);
      };
      if (req.url === "/") {
        // Satır içi betik politikaya takılır (konsol hatası); dış betik yüklenir ve hata fırlatır
        // (sayfa hatası). Gövde boş kalır → ekran tek renk.
        return sayfa(html("", `<script>window.__satirIci = 1;</script><script src="/patla.js"></script>`));
      }
      if (req.url === "/dolu") {
        return sayfa(html(`<div class="yarim"></div>`, `<link rel="stylesheet" href="/stil.css">`));
      }
      if (req.url === "/patla.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(`throw new Error("mycl-deneme-hatasi");`);
        return;
      }
      if (req.url === "/stil.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        res.end("body{margin:0}.yarim{width:50vw;height:100vh;background:#000}");
        return;
      }
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), "mycl-visual-gercek-"));
    await fs.mkdir(join(root, ".mycl"), { recursive: true });
    await fs.writeFile(join(root, ".mycl", "help-pages.json"), JSON.stringify([{ route: "/" }, { route: "/dolu" }]));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("sayfa hata verip boş kaldığında kayıt ve mesaj hatanın metnini içerir; öteki rotaya karışmaz", async (ctx) => {
    if (!tarayiciVar) return ctx.skip("Playwright chromium kurulu değil");
    const r = await captureAndCompare(url, root);
    expect(r.ran).toBe(true);
    const kok = r.diffs.find((d) => d.route === "/");
    const dolu = r.diffs.find((d) => d.route === "/dolu");

    expect(kok?.nearlyBlank).toBe(true);
    const gorulen = (kok?.pageErrors ?? []).join("\n");
    expect(gorulen).toContain("mycl-deneme-hatasi"); // yakalanmamış sayfa hatası
    expect(gorulen).toContain("Content Security Policy"); // politikanın engellediği satır içi betik

    // Politika atlatılmadı: satır içi betik gerçekten çalışmadıysa hata konsola düşmüştür (üstte) ve
    // dolu sayfa boş sayılmaz, hata da taşımaz (rotalar birbirine karışmaz).
    expect(dolu?.nearlyBlank).toBe(false);
    expect(dolu?.pageErrors).toEqual([]);

    const kayit = blankScreenDetail(r.diffs);
    expect(kayit.startsWith("blank_screen routes=/ ")).toBe(true);
    expect(kayit).toContain("mycl-deneme-hatasi");
    expect(formatVisualReport(r)).toContain("mycl-deneme-hatasi");
  }, 90_000);
});
