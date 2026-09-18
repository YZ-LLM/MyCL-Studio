// pipeline-end-summary — DÜRÜST akış-sonu özet (saf). YZLLM'in #1 endişesi:
// gate soft-fail olsa bile "TAMAMLANDI" DEME. Bu testler tam o davranışı kilitler.

import { describe, expect, it } from "vitest";
import {
  buildPipelineEndLines,
  type PipelineEndInput,
  type RunEvidence,
} from "../src/pipeline-end-summary.js";
import type { HarnessVerdict } from "../src/harness-verdict.js";
import type { Phase16Verification } from "../src/playwright-setup.js";

const CLEAN_V16: Phase16Verification = {
  smokeKind: "real",
  authStatus: "configured",
};

function verdict(partial: Partial<HarnessVerdict>): HarnessVerdict {
  return {
    verdict: "PASS",
    completed: true,
    gateFailures: [],
    securitySkipped: [],
    e2eSkipped: [],
    realAppSkipped: [],
    exitCode: 0,
    summary: "",
    ...partial,
  };
}

function lines(over: Partial<PipelineEndInput>): string {
  return buildPipelineEndLines({
    intent: "todo app",
    v16: CLEAN_V16,
    verdict: verdict({}),
    costs: [],
    ...over,
  }).join("\n");
}

describe("pipeline-end-summary · buildPipelineEndLines", () => {
  it("her şey yeşil → '✅ Tamamlandı', uyarı YOK", () => {
    const out = lines({});
    expect(out).toContain("✅ Tamamlandı");
    expect(out).not.toContain("Dürüst uyarı");
    expect(out).not.toContain("doğrulandığını söyleyemem");
    expect(out).toContain("İstediğin: todo app");
  });

  it("gate-fail → fazları listeler + 'KISMÎ' + 'söyleyemem' (sessiz TAMAMLANDI YOK)", () => {
    const out = lines({
      verdict: verdict({
        verdict: "PARTIAL",
        gateFailures: [
          { phase: 11, event: "phase-11-fail" },
          { phase: 14, event: "phase-14-complete", detail: "soft_complete_after_fail" },
        ],
      }),
    });
    expect(out).toContain("Kalite-gate'leri geçemedi: Faz 11, Faz 14");
    expect(out).toContain("KISMÎ");
    expect(out).toContain("doğrulandığını söyleyemem");
    expect(out).not.toContain("✅ Tamamlandı");
  });

  it("güvenlik-skip → 'Güvenlik taraması atlandı' + KISMÎ (false-green koruması)", () => {
    const out = lines({
      verdict: verdict({
        verdict: "PARTIAL",
        securitySkipped: ["csp-evaluator-skipped", "semgrep-skipped"],
      }),
    });
    expect(out).toContain("Güvenlik taraması atlandı");
    expect(out).toContain("csp-evaluator-skipped");
    expect(out).toContain("KISMÎ");
  });

  it("verdict FAIL → 'BAŞARISIZ'", () => {
    const out = lines({
      verdict: verdict({
        verdict: "FAIL",
        completed: false,
        gateFailures: [{ phase: 16, event: "phase-16-fail" }],
      }),
    });
    expect(out).toContain("BAŞARISIZ");
    expect(out).not.toContain("✅ Tamamlandı");
  });

  it("Faz 16 yer-tutucu smoke + giriş yok → dürüst uyarılar", () => {
    const out = lines({
      v16: { smokeKind: "placeholder", authStatus: "placeholder" },
    });
    expect(out).toContain("özel olarak test edilmedi");
    expect(out).toContain("Giriş yapılmadı");
    expect(out).toContain("KISMÎ");
  });

  // BİLEREK DEĞİŞTİ (2026-09-15): eski test "hüküm hesaplanamadıysa yine ✅ Tamamlandı" davranışını
  // kilitliyordu. Denetim kaydı okunamamışken "tüm gate'ler yeşil" demek KANITSIZ bir iddiadır ve
  // tam da yasak olan sahte yeşildir. Yerine geçen mekanizma AYNI işte zaten kurulu: çağıran hem
  // görünür uyarı yazıyor (index.ts) hem pipeline_end'i PARTIAL emit ediyor; özet artık onlarla
  // çelişmiyor — üç kanal aynı gerçeği söylüyor.
  it("verdict null (audit okunamadı) → '✅ Tamamlandı' DEMEZ, dürüstçe doğrulanmadı der", () => {
    const out = lines({ verdict: null });
    expect(out).not.toContain("✅ Tamamlandı");
    expect(out).toContain("hesaplanamadı");
    expect(out).toContain("KISMÎ");
  });

  it("niyet boş → '(kayıtlı bir niyet özeti yok)'", () => {
    const out = lines({ intent: "" });
    expect(out).toContain("(kayıtlı bir niyet özeti yok)");
  });

  it("costs → token toplamı + per-faz döküm", () => {
    const out = lines({
      costs: [
        { phase: 5, turns: 3, input_tokens: 12000, output_tokens: 4000, cache_read_input_tokens: 8000 },
        { phase: 8, turns: 2, input_tokens: 6000, output_tokens: 2000, cache_read_input_tokens: 0 },
      ],
    });
    expect(out).toContain("🧮 Token:");
    expect(out).toContain("18k giriş");
    expect(out).toContain("6k çıkış");
    expect(out).toContain("Faz 5=16k");
    expect(out).toContain("Faz 8=8k");
  });

  it("gate-fail + güvenlik-skip + yer-tutucu birlikte → hepsi tek uyarı satırında", () => {
    const out = lines({
      v16: { smokeKind: "placeholder", authStatus: "configured" },
      verdict: verdict({
        verdict: "PARTIAL",
        gateFailures: [{ phase: 10, event: "phase-10-fail" }],
        securitySkipped: ["phase-13-skipped"],
      }),
    });
    expect(out).toContain("Kalite-gate'leri geçemedi: Faz 10");
    expect(out).toContain("Güvenlik taraması atlandı");
    expect(out).toContain("özel olarak test edilmedi");
    expect(out).toContain("KISMÎ");
  });
});

// SAHTE YEŞİL KİLİDİ (2026-09-15, canlı kanıt: cüzdan koşusu).
// "Sonuç" satırı hükme değil, uyarı listesinin doluluğuna bakıyordu. computeVerdict'in ÜÇ sert FAIL
// yolu da o listeleri BOŞ bırakır (kayıt kurcalandı / boş build sabit boş döner; "tamamlanmadı"
// yolunda koşu hiç gate'e ulaşmadığı için doğal olarak boştur) → en ağır başarısızlıklar en yeşil
// dalı tetikliyordu. Kullanıcı, Faz 2-17 hiç koşmadığı hâlde "tüm gate'ler yeşil" okudu.
// Hatanın aylarca saklanma sebebi tam olarak buydu: mevcut FAIL testi gateFailures'ı DOLU veriyor,
// yani "FAIL + üç dizi boş" kombinasyonu hiç test edilmemişti.
describe("sahte yeşil: FAIL ama uyarı listeleri boş", () => {
  const bosListeler = { gateFailures: [], securitySkipped: [], realAppSkipped: [] };

  it("pipeline TAMAMLANMADI (hiç gate koşmadı) → yeşil YAZILMAZ", () => {
    const out = lines({
      verdict: verdict({
        verdict: "FAIL",
        completed: false,
        summary: "Pipeline TAMAMLANMADI (phase-17-complete yok / hard hata).",
        exitCode: 1,
        ...bosListeler,
      }),
    });
    expect(out).not.toContain("✅ Tamamlandı");
    expect(out).toContain("BAŞARISIZ");
    expect(out).toContain("TAMAMLANMADI"); // hükmün KENDİ dürüst metni yüzeye çıkıyor
  });

  it("denetim kaydı kurcalanmış → yeşil YAZILMAZ (en güçlü güvenlik sinyali özete ulaşır)", () => {
    const out = lines({
      verdict: verdict({
        verdict: "FAIL",
        completed: true,
        summary: "Denetim kaydı kurcalanmış — sonuçlara güvenilemez.",
        exitCode: 1,
        ...bosListeler,
      }),
    });
    expect(out).not.toContain("✅ Tamamlandı");
    expect(out).toContain("kurcalanmış");
  });

  it("boş build (teslim edilebilir yok) → yeşil YAZILMAZ", () => {
    const out = lines({
      verdict: verdict({
        verdict: "FAIL",
        completed: true,
        summary: "Teslim edilebilir çıktı yok (boş build).",
        exitCode: 1,
        ...bosListeler,
      }),
    });
    expect(out).not.toContain("✅ Tamamlandı");
    expect(out).toContain("boş build");
  });

  it("PARTIAL + boş listeler → yeşil YAZILMAZ, KISMÎ der", () => {
    const out = lines({
      verdict: verdict({
        verdict: "PARTIAL",
        completed: true,
        summary: "Bazı boyutlar doğrulanmadı.",
        ...bosListeler,
      }),
    });
    expect(out).not.toContain("✅ Tamamlandı");
    expect(out).toContain("KISMÎ");
  });

  it("REGRESYON KİLİDİ: PASS + temiz → eskisi gibi '✅ Tamamlandı'", () => {
    const out = lines({ verdict: verdict({ verdict: "PASS", completed: true, ...bosListeler }) });
    expect(out).toContain("✅ Tamamlandı");
  });

  it("REGRESYON KİLİDİ: uyarı zaten varken hükmün metni İKİNCİ kez eklenmez", () => {
    const out = lines({
      verdict: verdict({
        verdict: "FAIL",
        completed: false,
        summary: "tekrarlanmamalı-imza",
        gateFailures: [{ phase: 16, event: "phase-16-fail" }],
      }),
    });
    expect(out).toContain("BAŞARISIZ");
    expect(out).not.toContain("tekrarlanmamalı-imza");
  });
});

// S5 (2026-09-18): E2E atlaması hükmü düşürüyorsa kullanıcı NEDENİNİ de görmeli — hükmü düşüren
// her sınıfın özette bir karşılığı olmalı, yoksa "neden kısmi?" sorusu cevapsız kalır.
describe("E2E atlaması özette görünür", () => {
  it("e2eSkipped doluysa uyarı satırı çıkar ve yeşil YAZILMAZ", () => {
    const out = lines({
      verdict: verdict({
        verdict: "PARTIAL",
        completed: true,
        e2eSkipped: ["install_failed"],
        summary: "E2E koşamadı",
      }),
    });
    expect(out).toContain("Uçtan uca");
    expect(out).toContain("install_failed");
    expect(out).not.toContain("✅ Tamamlandı");
  });

  it("REGRESYON KİLİDİ: e2eSkipped boşken metin değişmez", () => {
    expect(lines({ verdict: verdict({ e2eSkipped: [] }) })).toContain("✅ Tamamlandı");
  });
});

// S8 (2026-09-18): pipeline sonunda "uygulama gerçekten çalıştı mı?" diye soran hiçbir şey yoktu.
// Yerine geçen ölçüt "proje klasöründe görünür bir şey var mı"ydı — içeriğe, derlemeye, çalışmaya
// bakmıyor. CANLI KANIT: 27 dosyalık bir proje vardı, uygulama hiç açılmadı, ekran bomboştu ve akış
// bunu hiç sormadı. Aşağıdaki testler satırın hem VAR olduğunu hem de ASLA "çalışmıyor" demediğini
// kilitler — kanıt yokluğu, çalışmadığının kanıtı değildir.
describe("çalışma kanıtı satırı", () => {
  const ev = (over: Partial<RunEvidence> = {}): RunEvidence => ({
    e2ePassed: false,
    screenNotBlank: false,
    entryGraphOk: false,
    noRuntimeErrors: false,
    ...over,
  });

  it("kanıt varsa hangileri olduğu yazılır", () => {
    const out = lines({ evidence: ev({ e2ePassed: true, entryGraphOk: true }) });
    expect(out).toContain("Çalışma kanıtı");
    expect(out).toContain("E2E geçti");
    expect(out).toContain("giriş zinciri sağlam");
  });

  it("hiç kanıt yoksa DÜRÜST metin — 'çalışmıyor' DEMEZ", () => {
    const out = lines({ evidence: ev() });
    expect(out).toContain("kanıtlanmadı");
    expect(out).not.toContain("çalışmıyor");
  });

  it("dört kanıt da varsa dördü de listelenir", () => {
    const out = lines({
      evidence: ev({ e2ePassed: true, screenNotBlank: true, entryGraphOk: true, noRuntimeErrors: true }),
    });
    for (const s of ["E2E geçti", "ekran boş değil", "giriş zinciri sağlam", "çalışma zamanı hatası yok"]) {
      expect(out).toContain(s);
    }
  });

  it("REGRESYON KİLİDİ: kanıt verilmezse satır hiç basılmaz (eski çıktı birebir)", () => {
    expect(lines({})).not.toContain("Çalışma kanıtı");
  });
});
