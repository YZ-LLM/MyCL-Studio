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
  buildErrorAnalysisPrompt,
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

// 2026-06-10 (YZLLM: "hata çözümünü sorma, kendisi çözsün"): best_index parse + sınır.
describe("parseErrorAnalysisBlock — best_index (oto-çözüm)", () => {
  it("geçerli best_index aynen alınır", () => {
    const a = parseErrorAnalysisBlock(
      '{"kind":"error_analysis","blocking":true,"summary_tr":"özet","solutions_tr":["a","b","c"],"best_index":2}',
    );
    expect(a?.best_index).toBe(2);
  });
  it("eksik/aralık-dışı best_index → 0 (güvenli varsayılan)", () => {
    const missing = parseErrorAnalysisBlock(
      '{"kind":"error_analysis","blocking":false,"summary_tr":"özet","solutions_tr":["a","b"]}',
    );
    expect(missing?.best_index).toBe(0);
    const out = parseErrorAnalysisBlock(
      '{"kind":"error_analysis","blocking":false,"summary_tr":"özet","solutions_tr":["a","b"],"best_index":9}',
    );
    expect(out?.best_index).toBe(0);
  });
});

// 2026-06-10 (YZLLM: "bunu çözmüştük" — API modunda da analiz): prompt no-tools varyantı.
describe("buildErrorAnalysisPrompt — backend varyantı", () => {
  const ctx = { phase: 5 as const, message: "dev server chain exhausted", detail: "port_timeout" };
  it("canInvestigate=true → araç (Read/Grep) ima eder", () => {
    expect(buildErrorAnalysisPrompt(ctx, true)).toContain("Read/Grep");
  });
  it("canInvestigate=false → araç YOK, kanıttan akıl yürüt", () => {
    const p = buildErrorAnalysisPrompt(ctx, false);
    expect(p).not.toContain("Read/Grep");
    expect(p).toContain("no tools available");
    expect(p).toContain("dev server chain exhausted"); // mesaj + detail prompt'ta
  });
});

// 2026-06-10 (YZLLM: "kolay bişeyi çözemedi, node_modules silmeyi düşündü"): prompt gerçek-hatayı
// teşhise + yıkıcı-fix-sona yönlendiriyor mu (genel ders).
describe("buildErrorAnalysisPrompt — kör-teşhis + yıkıcı-fix önlemi", () => {
  const ctx = { phase: 5 as const, message: "x", detail: "argument list too long" };
  it("E2BIG/ortam sınıfını projeden ayırmayı öğütler", () => {
    const p = buildErrorAnalysisPrompt(ctx, false);
    expect(p).toContain("argument list too long");
    expect(p.toLowerCase()).toContain("environment");
  });
  it("yıkıcı/yavaş fix (node_modules sil) SONA + en ucuz reversible ÖNCE der", () => {
    const p = buildErrorAnalysisPrompt(ctx, true);
    expect(p).toContain("node_modules");
    expect(p.toLowerCase()).toContain("reversible");
  });
});

describe("buildErrorAnalysisAskq — kalıcı sağlayıcı-yok (permanentNoProvider) → döngü kırma", () => {
  it("permanentNoProvider → YALNIZ OPT_QUEUE; OPT_REANALYZE/OPT_SOLVE YOK (sonsuz döngü önlenir)", () => {
    const { options } = buildErrorAnalysisAskq(["Şunu dene"], false, { permanentNoProvider: true });
    expect(labels(options)).toEqual([OPT_QUEUE]);
    expect(labels(options)).not.toContain(OPT_REANALYZE);
    expect(labels(options)).not.toContain(OPT_SOLVE);
  });

  it("permanentNoProvider + allowAcceptContinue (blocking gate) → OPT_QUEUE + OPT_ACCEPT_CONTINUE; reanalyze YOK", () => {
    const { options } = buildErrorAnalysisAskq([], true, {
      permanentNoProvider: true,
      allowAcceptContinue: true,
    });
    expect(labels(options)).toEqual([OPT_QUEUE, OPT_ACCEPT_CONTINUE]);
    expect(labels(options)).not.toContain(OPT_REANALYZE);
  });
});

describe("buildErrorAnalysisPrompt — z.ai fallback farkındalığı (YZLLM: ajan 'fallback yok' demesin)", () => {
  const pctx = { phase: 3, message: "Faz 3 hatası", detail: "credit balance too low" };
  it("prompt z.ai (GLM) fallback'in VAR olduğunu söyler", () => {
    const p = buildErrorAnalysisPrompt(pctx, true);
    expect(p).toContain("z.ai");
    expect(p.toLowerCase()).toContain("fallback");
  });
});

// YZLLM 2026-06-30: "sorular+cevaplar çok teknik, bu kadarı fazla; sade + istenirse Detay".
describe("buildErrorAnalysisPrompt — sadelik (USER_FACING_CLARITY)", () => {
  const ctx = { phase: 8 as const, message: "gate fail", detail: "SEED_DEV_CREDENTIAL at line 37" };
  const p = buildErrorAnalysisPrompt(ctx, true);
  it("kullanıcı-görünür sadelik kuralını içerir (plain-language, teknik uzman değil)", () => {
    expect(p).toContain("USER-FACING CLARITY");
    expect(p.toLowerCase()).toContain("plain");
  });
  it("summary_tr SADE (dosya/satır/kod YOK) + solutions_tr KISA YÖN talimatı", () => {
    expect(p).toContain("NO file paths, line numbers, or code"); // summary_tr sade
    expect(p).toContain("SHORT plain-language DIRECTION"); // solutions kısa yön, tam yama değil
  });
  it("ayrı detail_tr alanı (teknik açıklama 'Detay'da) şemada var", () => {
    expect(p).toContain("detail_tr");
  });
});

describe("parseErrorAnalysisBlock — detail_tr (YZLLM 2026-06-30, opsiyonel + geriye uyumlu)", () => {
  it("detail_tr varsa parse edilir + trim edilir", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":true,"summary_tr":"Sade özet.","detail_tr":"  routes/ui-api.js:37 gömülü parola  ","solutions_tr":["Parolayı ayarlara taşı"]}`,
    );
    expect(r).not.toBeNull();
    expect(r!.summary_tr).toBe("Sade özet.");
    expect(r!.detail_tr).toBe("routes/ui-api.js:37 gömülü parola");
  });
  it("detail_tr YOKSA → undefined (eski blok geriye uyumlu; toggle çıkmaz)", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":true,"summary_tr":"Özet.","solutions_tr":["A"]}`,
    );
    expect(r!.detail_tr).toBeUndefined();
  });
  it("detail_tr BOŞ string → undefined (gereksiz boş 'Detay' toggle'ı önlenir)", () => {
    const r = parseErrorAnalysisBlock(
      `{"kind":"error_analysis","blocking":false,"summary_tr":"Özet.","detail_tr":"   ","solutions_tr":["A"]}`,
    );
    expect(r!.detail_tr).toBeUndefined();
  });
});
