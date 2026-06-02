// fix/evidence — extractSourceLocations saf-fonksiyon testleri (regex'siz
// token-temelli file:line çıkarımı). git/errors.db entegrasyonu canlı/manuel.

import { describe, expect, it } from "vitest";
import { extractSourceLocations, extractFilePaths } from "../../src/fix/evidence.js";

describe("fix/evidence · extractSourceLocations", () => {
  it("relative path:line çıkarır", () => {
    expect(extractSourceLocations("hata src/foo.ts:42 satırında")).toEqual([
      { file: "src/foo.ts", line: 42 },
    ]);
  });

  it("path:line:col → ilk sayı (line) alınır", () => {
    expect(extractSourceLocations("at fn (src/bar.tsx:10:5)")).toEqual([
      { file: "src/bar.tsx", line: 10 },
    ]);
  });

  it("absolute path stack frame", () => {
    const txt = "    at handler (/Users/x/proj/src/api.ts:128:14)";
    expect(extractSourceLocations(txt)).toEqual([
      { file: "/Users/x/proj/src/api.ts", line: 128 },
    ]);
  });

  it("route / endpoint (sayısal kuyruk yok) → eşleşmez", () => {
    expect(extractSourceLocations("POST /api/log-error 500")).toEqual([]);
    expect(extractSourceLocations("/hata-kodlari sayfası")).toEqual([]);
  });

  it("uzantısız token → dosya sayılmaz", () => {
    // "localhost:5173" — uzantı yok → route gibi, dışlanır.
    expect(extractSourceLocations("http //localhost:5173 açıldı")).toEqual([]);
  });

  it("dosya başına ilk satırı tutar, sırayı korur", () => {
    const txt = "src/a.ts:5 ... src/b.ts:9 ... src/a.ts:99";
    expect(extractSourceLocations(txt)).toEqual([
      { file: "src/a.ts", line: 5 },
      { file: "src/b.ts", line: 9 },
    ]);
  });

  it("boş/whitespace → boş", () => {
    expect(extractSourceLocations("")).toEqual([]);
    expect(extractSourceLocations("hiç konum yok burada")).toEqual([]);
  });

  it("python stack frame (File \"x.py\", line N) — token çıkarımı", () => {
    // Python formatı "x.py", line 12 → "x.py" token'ı sayısal kuyruk taşımaz;
    // ama "x.py:12" gibi normalize edilmiş girdilerde yakalanır.
    expect(extractSourceLocations("app/main.py:12")).toEqual([
      { file: "app/main.py", line: 12 },
    ]);
  });
});

describe("fix/evidence · extractFilePaths", () => {
  it("satır numarası OLMADAN dosya yollarını çıkarır (plan metni)", () => {
    const plan = "Edit src/foo.ts and app/models.py, then update lib/util.go.";
    expect(extractFilePaths(plan).sort()).toEqual([
      "app/models.py",
      "lib/util.go",
      "src/foo.ts",
    ]);
  });

  it("satır:sütun soyulur (src/a.ts:42:3 → src/a.ts)", () => {
    expect(extractFilePaths("hata src/a.ts:42:3 burada")).toEqual(["src/a.ts"]);
  });

  it("kaynak uzantısı olmayan token'ları atar", () => {
    expect(extractFilePaths("README.md ve config.yaml ve /api/route")).toEqual([]);
  });

  it("tekrarları tekiller", () => {
    expect(extractFilePaths("src/a.ts ... src/a.ts tekrar")).toEqual(["src/a.ts"]);
  });

  it("boş → boş", () => {
    expect(extractFilePaths("")).toEqual([]);
  });
});
