// simplify-rules — sadeleştirme boyutunun STACK BAĞIMSIZ çekirdeği.
//
// NEDEN (YZLLM 2026-09-12: "aracın tek dile bağlı olma ihtimalini ortadan kaldır"): `simplify` komutu
// 19 stack profilinin yalnız 4'ünde tanımlıydı ve o dördünde de araç `ts-prune` — TypeScript'e bağlı.
// Adli denetim cave'in 94 iterasyonunda Faz 11'in BİR KEZ bile koşmadığını gösterdi.
//
// Bu testlerin asıl işi iki yanlışı birden engellemek: (1) boyutun yine bir dile kaymasını,
// (2) yanlış alarmı. Bu yüzden aşağıda hem "farklı dillerde aynı sonucu verir" hem de
// "çıkarım kapıyı düşürmez" kilitleri var.

import { describe, expect, it } from "vitest";
import {
  GROWTH_MIN_LINES,
  MIN_DUPLICATE_LINES,
  countDuplicateLines,
  decideSimplify,
  findDuplicateBlocks,
  findOrphanCandidates,
  nextSimplifyBaseline,
  type SimplifyMeasurement,
  type SourceFile,
} from "../src/simplify-rules.js";

/** N anlamlı satırlık gövde üretir (her satır benzersiz, blok imzası rastgele çakışmasın). */
function body(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `  ${prefix}_satir_${i} = hesapla(${i});`).join("\n");
}

const measurement = (over: Partial<SimplifyMeasurement> = {}): SimplifyMeasurement => ({
  filesScanned: 10,
  totalLines: 1000,
  duplicateLines: 0,
  duplicates: [],
  orphanCandidates: [],
  ...over,
});

describe("findDuplicateBlocks — kopya kod bir OLGU, dile bağlı değil", () => {
  it("iki dosyada birebir aynı uzun blok bulunur", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES);
    const files: SourceFile[] = [
      { path: "a.py", content: `def a():\n${shared}\n` },
      { path: "b.py", content: `def b():\n${shared}\n` },
    ];
    const blocks = findDuplicateBlocks(files);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]!.places.some((p) => p.startsWith("a.py:"))).toBe(true);
    expect(blocks[0]!.places.some((p) => p.startsWith("b.py:"))).toBe(true);
  });

  it("AYNI kod farklı dil uzantılarıyla AYNI sonucu verir (tek dile bağlılık yok)", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES);
    const say = (ext: string) =>
      countDuplicateLines(
        findDuplicateBlocks([
          { path: `a.${ext}`, content: shared },
          { path: `b.${ext}`, content: shared },
        ]),
      );
    const ts = say("ts");
    for (const ext of ["py", "go", "rb", "rs", "java", "php", "dart", "swift", "kt", "ex"]) {
      expect(say(ext)).toBe(ts);
    }
    expect(ts).toBeGreaterThan(0);
  });

  it("kısa tekrar kopya SAYILMAZ (import listesi / tip tanımı gürültüsü yanlış alarm üretmesin)", () => {
    const kisa = body("kisa", MIN_DUPLICATE_LINES - 1);
    expect(findDuplicateBlocks([{ path: "a.ts", content: kisa }, { path: "b.ts", content: kisa }])).toEqual([]);
  });

  it("yalnız boşluk farkı olan blok yine kopyadır (girinti değişikliği kaçış yolu değil)", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES);
    const girintili = shared.split("\n").map((l) => `      ${l.trim()}`).join("\n");
    expect(findDuplicateBlocks([{ path: "a.go", content: shared }, { path: "b.go", content: girintili }]).length)
      .toBeGreaterThan(0);
  });

  it("boş satır ve tek başına ayraç blok kimliğini şişirmez", () => {
    // İki dosyada YALNIZ kapanış ayraçları ortak — bu kopya değildir.
    const ayrac = Array.from({ length: MIN_DUPLICATE_LINES + 5 }, () => "}").join("\n");
    expect(findDuplicateBlocks([{ path: "a.js", content: ayrac }, { path: "b.js", content: ayrac }])).toEqual([]);
  });

  it("kopya YOKSA hiçbir bulgu üretmez (temiz projede sessiz)", () => {
    const files: SourceFile[] = [
      { path: "a.rs", content: body("bir", 60) },
      { path: "b.rs", content: body("iki", 60) },
    ];
    expect(findDuplicateBlocks(files)).toEqual([]);
  });

  it("kayan pencereler TEK bloğa katlanır (30 satırlık kopya 6 bulgu gibi görünmesin)", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES + 5);
    const blocks = findDuplicateBlocks([
      { path: "a.py", content: shared },
      { path: "b.py", content: shared },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toBe(MIN_DUPLICATE_LINES + 5);
    expect(blocks[0]!.places).toEqual(["a.py:1", "b.py:1"]);
  });

  it("determinizm: aynı girdi → aynı sıra ve aynı içerik", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES);
    const files: SourceFile[] = [
      { path: "z.ts", content: shared },
      { path: "a.ts", content: shared },
      { path: "m.ts", content: shared },
    ];
    expect(findDuplicateBlocks(files)).toEqual(findDuplicateBlocks(files));
    expect(findDuplicateBlocks(files)[0]!.places).toEqual([...findDuplicateBlocks(files)[0]!.places].sort());
  });
});

describe("countDuplicateLines — örtüşen pencereler satırı iki kez saymaz", () => {
  it("ölçü taranan toplam satırı AŞAMAZ (şişme olsaydı temel karşılaştırması anlamsızlaşırdı)", () => {
    const shared = body("ortak", MIN_DUPLICATE_LINES * 3);
    const files: SourceFile[] = [
      { path: "a.ts", content: shared },
      { path: "b.ts", content: shared },
    ];
    const toplam = files.reduce((n, f) => n + f.content.split("\n").length, 0);
    expect(countDuplicateLines(findDuplicateBlocks(files))).toBeLessThanOrEqual(toplam);
  });

  it("bulgu yoksa sıfır", () => {
    expect(countDuplicateLines([])).toBe(0);
  });
});

describe("findOrphanCandidates — ÇIKARIM, olgu değil: yalnız rapor", () => {
  it("hiçbir yerden adı geçmeyen dosyayı aday gösterir", () => {
    const files: SourceFile[] = [
      { path: "src/kullanilan.ts", content: "export const x = 1;" },
      { path: "src/index.ts", content: "import { x } from './kullanilan';" },
      { path: "src/kimsesiz.ts", content: "export const y = 2;" },
    ];
    expect(findOrphanCandidates(files)).toEqual(["src/kimsesiz.ts"]);
  });

  it("dosyanın KENDİ içinde adının geçmesi referans sayılmaz", () => {
    const files: SourceFile[] = [
      { path: "src/kimsesiz.ts", content: "// kimsesiz modulu\nexport const y = 2;" },
      { path: "src/baska.ts", content: "export const z = 3;" },
    ];
    expect(findOrphanCandidates(files)).toContain("src/kimsesiz.ts");
  });

  it("çok kısa dosya adı aday OLMAZ (rastgele eşleşme riski)", () => {
    expect(findOrphanCandidates([{ path: "a.ts", content: "1" }, { path: "b.ts", content: "2" }])).toEqual([]);
  });

  it("giriş noktası aday OLMAZ — onu kod değil çalıştırıcı başlatır", () => {
    // Bu test önce KIRMIZIYDI: giriş dosyası hiçbir yerden çağrılmadığı için her koşuda
    // "referanssız" listeleniyordu. Rapor kendi giriş dosyanı sürekli şüpheli gösterirse okunmaz olur.
    const files: SourceFile[] = [
      { path: "src/index.ts", content: "import './yardim';" },
      { path: "cmd/main.go", content: "package main" },
      { path: "app/__init__.py", content: "" },
      { path: "src/yardim.ts", content: "export const h = 1;" },
    ];
    expect(findOrphanCandidates(files)).toEqual([]);
  });

  it("KAPIYI DÜŞÜRMEZ: yalnız referanssız dosya varken hüküm geçer", () => {
    const out = decideSimplify(
      measurement({ orphanCandidates: ["src/kimsesiz.ts", "src/digeri.ts"] }),
      { duplicateLines: 0, totalLines: 1000 },
    );
    expect(out.kind).toBe("pass");
  });
});

describe("decideSimplify — eski kod cezalandırılmaz, büyüme yakalanır", () => {
  it("ilk koşu ASLA düşmez: temel kaydedilir", () => {
    const out = decideSimplify(measurement({ duplicateLines: 5000 }), undefined);
    expect(out.kind).toBe("baseline");
  });

  it("temelin altında/eşitinde kalmak geçer", () => {
    expect(decideSimplify(measurement({ duplicateLines: 400 }), { duplicateLines: 400, totalLines: 1000 }).kind)
      .toBe("pass");
    expect(decideSimplify(measurement({ duplicateLines: 100 }), { duplicateLines: 400, totalLines: 1000 }).kind)
      .toBe("pass");
  });

  it("dar dalgalanma cezalandırılmaz (yanlış alarm yasağı)", () => {
    // %25 tolerans içinde ve mutlak tabanın altında.
    expect(decideSimplify(measurement({ duplicateLines: 410 }), { duplicateLines: 400, totalLines: 1000 }).kind)
      .toBe("pass");
  });

  it("BELİRGİN büyüme düşürür ve nedeni sayıyla söyler", () => {
    const out = decideSimplify(measurement({ duplicateLines: 900 }), { duplicateLines: 400, totalLines: 1000 });
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") throw new Error("beklenmedik");
    expect(out.reasons.join(" ")).toContain("400");
    expect(out.reasons.join(" ")).toContain("900");
  });

  it("küçük projede oransal eşik TEK BAŞINA düşürmez (mutlak taban da aşılmalı)", () => {
    // Temel 4 satır; %25 = 1 satır. 20 satırlık artış oransal olarak devasa ama mutlak taban 50'nin altında.
    const out = decideSimplify(measurement({ duplicateLines: 24 }), { duplicateLines: 4, totalLines: 100 });
    expect(out.kind).toBe("pass");
    // Mutlak taban aşılınca düşer.
    expect(decideSimplify(measurement({ duplicateLines: 4 + GROWTH_MIN_LINES + 1 }), {
      duplicateLines: 4,
      totalLines: 100,
    }).kind).toBe("fail");
  });

  it("SESSİZ GEÇME YOK: hiç dosya taranmadıysa 'temiz' demez", () => {
    const out = decideSimplify(measurement({ filesScanned: 0 }), { duplicateLines: 0, totalLines: 0 });
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") throw new Error("beklenmedik");
    expect(out.reasons.join(" ")).toContain("ÖLÇÜLEMEDİ");
  });

  it("ölçüm her koşuda GÖRÜNÜR kalır (geçse de sayı raporlanır)", () => {
    const out = decideSimplify(measurement({ filesScanned: 7, duplicateLines: 12 }), {
      duplicateLines: 12,
      totalLines: 1000,
    });
    if (out.kind !== "pass") throw new Error("beklenmedik");
    expect(out.note).toContain("7");
    expect(out.note).toContain("12");
  });
});

describe("nextSimplifyBaseline — iyileşme kalıcı, gerileme temele işlenmez", () => {
  it("ilk koşuda ölçüm temel olur", () => {
    expect(nextSimplifyBaseline(measurement({ duplicateLines: 300, totalLines: 900 }), undefined)).toEqual({
      duplicateLines: 300,
      totalLines: 900,
    });
  });

  it("azalma HEMEN temele işlenir (mandal geri kaymaz)", () => {
    expect(
      nextSimplifyBaseline(measurement({ duplicateLines: 120 }), { duplicateLines: 300, totalLines: 900 })
        .duplicateLines,
    ).toBe(120);
  });

  it("tolerans içindeki artış temeli YÜKSELTMEZ (yoksa kopya kod sürünerek büyürdü)", () => {
    expect(
      nextSimplifyBaseline(measurement({ duplicateLines: 310 }), { duplicateLines: 300, totalLines: 900 })
        .duplicateLines,
    ).toBe(300);
  });
});
