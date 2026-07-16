// visual-regression — saf yardımcılar + taban terfi testleri (tarayıcı AÇILMAZ; sentetik PNG).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { PNG } from "pngjs";
import {
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
