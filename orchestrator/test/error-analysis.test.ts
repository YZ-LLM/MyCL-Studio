// error-analysis — saf seam testleri (buildErrorAnalysisAskq option setleri +
// parseErrorAnalysisBlock happy/malformed). LLM turu (analyzeAndAskError) +
// controller wiring (failPhase / handleAskqAnswer branch) saha-doğrulamada test
// edilir; burada yalnız saf, yan-etkisiz mantık (mock yok — cli-json.test deseni).

import { describe, expect, it } from "vitest";
import {
  buildErrorAnalysisAskq,
  OPT_ACCEPT_CONTINUE,
  OPT_QUEUE,
  OPT_REANALYZE,
  OPT_SOLVE,
  parseErrorAnalysisBlock,
} from "../src/error-analysis.js";

// Etiket sabitleri modülden import edilir — index.ts handleAskqAnswer eşlemesi de
// aynı kaynaktan import eder; tek kaynak → string drift'i imkânsız.

// AskqOption (string | {label,value}) → düz etiket (test karşılaştırması için).
const labels = (opts: ReturnType<typeof buildErrorAnalysisAskq>["options"]): string[] =>
  opts.map((o) => (typeof o === "string" ? o : o.label));

describe("buildErrorAnalysisAskq — bloklayıcı (blocking=true)", () => {
  it("çözümler + sonda 'Tekrar analiz et'; 'İş listesine kaydet' YOK", () => {
    const { options } = buildErrorAnalysisAskq(["Bağımlılığı kur", "Şemayı düzelt"], true);
    expect(labels(options)).toEqual(["Bağımlılığı kur", "Şemayı düzelt", OPT_REANALYZE]);
    // Çözmeden devam etme seçeneği bloklayıcıda olmamalı.
    expect(labels(options)).not.toContain(OPT_QUEUE);
  });

  it("son seçenek her zaman 'Tekrar analiz et'", () => {
    const { options } = buildErrorAnalysisAskq(["Tek çözüm"], true);
    expect(labels(options).at(-1)).toBe(OPT_REANALYZE);
  });

  it("çözüm yoksa (bloklayıcı) → yalnız 'Tekrar analiz et'", () => {
    const { options } = buildErrorAnalysisAskq([], true);
    // Bloklayıcıda jenerik "Çöz" eklenmez (yalnız non-blocking'de eklenir).
    expect(labels(options)).toEqual([OPT_REANALYZE]);
  });
});

describe("buildErrorAnalysisAskq — bloklayıcı değil (blocking=false)", () => {
  it("'İş listesine kaydet…' İLK + çözümler + sonda 'Tekrar analiz et'", () => {
    const { options } = buildErrorAnalysisAskq(["Çözüm A", "Çözüm B"], false);
    expect(labels(options)).toEqual([OPT_QUEUE, "Çözüm A", "Çözüm B", OPT_REANALYZE]);
    expect(labels(options)[0]).toBe(OPT_QUEUE);
    expect(labels(options).at(-1)).toBe(OPT_REANALYZE);
  });

  it("çözüm yoksa (non-blocking) → kuyruk + jenerik 'Çöz' + 'Tekrar analiz et'", () => {
    const { options } = buildErrorAnalysisAskq([], false);
    expect(labels(options)).toEqual([OPT_QUEUE, OPT_SOLVE, OPT_REANALYZE]);
  });

  it("kullanıcı örneği şekli: A) kaydet B) çöz C) tekrar analiz", () => {
    // "B) Çöz" tek çözüm öğesi olarak gelir.
    const { options } = buildErrorAnalysisAskq([OPT_SOLVE], false);
    expect(labels(options)).toEqual([OPT_QUEUE, OPT_SOLVE, OPT_REANALYZE]);
  });
});

describe("buildErrorAnalysisAskq — sanitizasyon", () => {
  it("boş/whitespace çözümleri eler", () => {
    const { options } = buildErrorAnalysisAskq(["", "   ", "Gerçek çözüm"], true);
    expect(labels(options)).toEqual(["Gerçek çözüm", OPT_REANALYZE]);
  });

  it("çözümleri trim eder", () => {
    const { options } = buildErrorAnalysisAskq(["  Boşluklu çözüm  "], true);
    expect(labels(options)).toEqual(["Boşluklu çözüm", OPT_REANALYZE]);
  });

  it("tekrar eden (trim sonrası eş) çözümleri dedup eder", () => {
    const { options } = buildErrorAnalysisAskq(["Aynı", "Aynı", " Aynı "], true);
    expect(labels(options)).toEqual(["Aynı", OPT_REANALYZE]);
  });

  it("string olmayan öğeleri eler (savunmacı)", () => {
    const dirty = ["İyi çözüm", 42, null, undefined] as unknown as string[];
    const { options } = buildErrorAnalysisAskq(dirty, true);
    expect(labels(options)).toEqual(["İyi çözüm", OPT_REANALYZE]);
  });
});

describe("parseErrorAnalysisBlock — happy", () => {
  it("geçerli {kind:error_analysis} bloğu → parse", () => {
    const text = `Analiz:\n{"kind":"error_analysis","blocking":true,"summary_tr":"Bağımlılık eksik.","solutions_tr":["Kur","Sürümü sabitle"]}`;
    const r = parseErrorAnalysisBlock(text);
    expect(r).not.toBeNull();
    expect(r!.blocking).toBe(true);
    expect(r!.summary_tr).toBe("Bağımlılık eksik.");
    expect(r!.solutions_tr).toEqual(["Kur", "Sürümü sabitle"]);
  });

  it("blocking=false bloğu da parse edilir", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":false,"summary_tr":"Küçük sorun.","solutions_tr":["Düzelt"]}`,
    );
    expect(r).not.toBeNull();
    expect(r!.blocking).toBe(false);
  });

  it("serbest metin + diğer JSON arasından doğru bloğu çıkarır (sonuncu kazanır)", () => {
    const text = `{"kind":"other","x":1}\nşunu buldum:\n{"kind":"error_analysis","blocking":true,"summary_tr":"Özet","solutions_tr":["A"]}`;
    const r = parseErrorAnalysisBlock(text);
    expect(r).not.toBeNull();
    expect(r!.summary_tr).toBe("Özet");
  });

  it("summary_tr baş/son boşlukları trim edilir", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":true,"summary_tr":"  Trim'lenmiş  ","solutions_tr":[]}`,
    );
    expect(r!.summary_tr).toBe("Trim'lenmiş");
  });
});

describe("parseErrorAnalysisBlock — malformed / savunmacı", () => {
  it("blok yok → null", () => {
    expect(parseErrorAnalysisBlock("düz metin, JSON yok")).toBeNull();
  });

  it("yanlış kind → null", () => {
    expect(
      parseErrorAnalysisBlock(`{"kind":"docs","summary_tr":"x","solutions_tr":[]}`),
    ).toBeNull();
  });

  it("summary_tr eksik → null", () => {
    expect(
      parseErrorAnalysisBlock(`{"kind":"error_analysis","blocking":true,"solutions_tr":["A"]}`),
    ).toBeNull();
  });

  it("summary_tr boş/whitespace → null", () => {
    expect(
      parseErrorAnalysisBlock(
        `{"kind":"error_analysis","blocking":true,"summary_tr":"   ","solutions_tr":["A"]}`,
      ),
    ).toBeNull();
  });

  it("bozuk JSON (trailing comma) → null", () => {
    expect(
      parseErrorAnalysisBlock(`{"kind":"error_analysis","blocking":true,"summary_tr":"x",}`),
    ).toBeNull();
  });

  it("solutions_tr eksik → [] (summary geçerliyse blok korunur)", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":false,"summary_tr":"Özet"}`,
    );
    expect(r).not.toBeNull();
    expect(r!.solutions_tr).toEqual([]);
  });

  it("solutions_tr dizi-değil (düzyazı) → [] coerce", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":true,"summary_tr":"Özet","solutions_tr":"1. Kur 2. Düzelt"}`,
    );
    expect(r).not.toBeNull();
    expect(r!.solutions_tr).toEqual([]);
  });

  it("solutions_tr içindeki string-olmayan öğeler elenir", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":true,"summary_tr":"Özet","solutions_tr":["A",1,"B",null]}`,
    );
    expect(r!.solutions_tr).toEqual(["A", "B"]);
  });

  it("blocking eksik/boolean değil → false (strict === true)", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","summary_tr":"Özet","solutions_tr":[]}`,
    );
    expect(r).not.toBeNull();
    expect(r!.blocking).toBe(false);
  });
});

describe("buildErrorAnalysisAskq — allowAcceptContinue (güvenlik gate, Unit 2)", () => {
  it("blocking + allowAcceptContinue → çözümler + 'Kabul et, devam et' + 'Tekrar analiz et' (OPT_QUEUE YOK)", () => {
    const { options } = buildErrorAnalysisAskq(["CSP ekle", "helmet kur"], true, {
      allowAcceptContinue: true,
    });
    expect(labels(options)).toEqual(["CSP ekle", "helmet kur", OPT_ACCEPT_CONTINUE, OPT_REANALYZE]);
    expect(labels(options)).not.toContain(OPT_QUEUE);
  });

  it("blocking + allowAcceptContinue + çözüm YOK → 'Çöz' + 'Kabul et, devam et' + 'Tekrar analiz et'", () => {
    // Solve yolu garanti (debug tetiklenebilsin) + kabul-et-devam override + reanaliz.
    const { options } = buildErrorAnalysisAskq([], true, { allowAcceptContinue: true });
    expect(labels(options)).toEqual([OPT_SOLVE, OPT_ACCEPT_CONTINUE, OPT_REANALYZE]);
  });

  it("allowAcceptContinue=false (varsayılan) → 'Kabul et, devam et' EKLENMEZ", () => {
    const { options } = buildErrorAnalysisAskq(["X"], true);
    expect(labels(options)).not.toContain(OPT_ACCEPT_CONTINUE);
  });
});

describe("buildErrorAnalysisAskq ↔ parse entegrasyonu (saf zincir)", () => {
  it("parse çıktısı doğrudan askq builder'a beslenebilir", () => {
    const parsed = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":false,"summary_tr":"Özet","solutions_tr":["Çözüm 1","Çözüm 2"]}`,
    );
    const { options } = buildErrorAnalysisAskq(parsed!.solutions_tr, parsed!.blocking);
    expect(labels(options)).toEqual([OPT_QUEUE, "Çözüm 1", "Çözüm 2", OPT_REANALYZE]);
  });
});
