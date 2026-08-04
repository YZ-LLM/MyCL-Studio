// config — backend çözümü + anahtar-validasyon testleri.
// MAHKEME (2026-07-16, z.ai sökümü): silinen zai test dosyaları hasUsableKeys ve
// resolveAgentBackends'in zai-DIŞI çekirdek davranışlarını da taşıyordu → kapsam kaybını
// geri kur. Ayrıca sökümün kendi geriye-uyum iddiası ("zai"→"api" göçü) burada pinli.
import { describe, expect, it } from "vitest";
import {
  hasUsableKeys,
  resolveAgentBackends,
  resolveProvider,
  resolveSelectedModels,
  type ConfigFile,
  type MyclConfig,
} from "../src/config.js";

describe("resolveAgentBackends — varsayılanlar + göçler", () => {
  it("boş config → hepsi 'auto' (YZLLM: her zaman auto)", () => {
    expect(resolveAgentBackends({})).toEqual({
      orchestrator: "auto",
      translator: "auto",
      main: "auto",
    });
  });

  it("eski claude_code_cli_enabled:true + main açıkça set DEĞİL → main:'cli' göçü", () => {
    const b = resolveAgentBackends({ features: { playwright_enabled: true, claude_code_cli_enabled: true } });
    expect(b.main).toBe("cli");
    expect(b.translator).toBe("auto");
  });

  it("açık per-rol seçim korunur (kullanıcı ayarı kral)", () => {
    const b = resolveAgentBackends({ agent_backends: { orchestrator: "api", translator: "cli", main: "auto" } });
    expect(b).toEqual({ orchestrator: "api", translator: "cli", main: "auto" });
  });

  it("z.ai GÖÇÜ (söküm 2026-07-16): eski config'te kalan 'zai' → 'api' (her rol için)", () => {
    const b = resolveAgentBackends({
      agent_backends: {
        orchestrator: "zai",
        translator: "auto",
        main: "zai",
      } as never, // eski diskte kalmış değer — tip artık izin vermiyor, runtime normalize eder
    });
    expect(b.orchestrator).toBe("api");
    expect(b.main).toBe("api");
    expect(b.translator).toBe("auto");
  });
});

describe("hasUsableKeys — save_api_keys merge validasyonu (PATCH semantiği)", () => {
  it("patch claude translator+main → true", () => {
    expect(hasUsableKeys({}, { translator: "sk-t", main: "sk-m" })).toBe(true);
  });

  it("mevcut secrets claude anahtarlarını taşıyor + boş patch → true (boş alan mevcut key'i silmez)", () => {
    expect(hasUsableKeys({ translator: "sk-t", main: "sk-m" }, {})).toBe(true);
  });

  it("karışık: translator mevcutta, main patch'te → true", () => {
    expect(hasUsableKeys({ translator: "sk-t" }, { main: "sk-m" })).toBe(true);
  });

  it("ikisi de yoksa → false (tamamen boş kayıt reddedilir)", () => {
    expect(hasUsableKeys({}, {})).toBe(false);
    expect(hasUsableKeys({}, { orchestrator: "sk-o" })).toBe(false); // orchestrator tek başına yetmez
  });

  it("boşluk/boş string dolu sayılmaz", () => {
    expect(hasUsableKeys({ translator: "  " }, { main: "sk-m" })).toBe(false);
  });
});

describe("resolveProvider — Claude-only hedef (z.ai söküm sonrası)", () => {
  const cfg = {
    api_keys: { translator: "sk-t", main: "sk-m", orchestrator: "sk-o" },
    agent_backends: { orchestrator: "api", translator: "api", main: "api" },
  } as unknown as MyclConfig;

  it("rolün backend'i + Claude anahtarı döner; z.ai alanları yok", () => {
    const t = resolveProvider(cfg, "main");
    expect(t.backend).toBe("api");
    expect(t.apiKey).toBe("sk-m");
    expect("isZai" in t).toBe(false);
    expect("baseURL" in t).toBe(false);
  });

  it("orchestrator rolü kendi anahtarını (yoksa main fallback) alır", () => {
    expect(resolveProvider(cfg, "orchestrator").apiKey).toBe("sk-o");
    const noOrch = { ...cfg, api_keys: { translator: "sk-t", main: "sk-m" } } as unknown as MyclConfig;
    expect(resolveProvider(noOrch, "orchestrator").apiKey).toBe("sk-m");
  });
});

// YZLLM 2026-08-04 (plan modeli): resolveSelectedModels bir AÇIK İZİN LİSTESİ — burada sayılmayan
// alan diskte dursa bile runtime'a hiç ulaşmaz. En kolay unutulan adım bu; test onu kilitliyor.
describe("resolveSelectedModels — opsiyonel alanlar runtime'a ULAŞIYOR mu", () => {
  const base = { translator: "claude-haiku-4-5", main: "claude-opus-5" };

  it("plan_model diskteyse runtime'a taşınır", () => {
    const sel = resolveSelectedModels({
      selected_models: { ...base, plan_model: "claude-fable-5" },
    } as ConfigFile);
    expect(sel.plan_model).toBe("claude-fable-5");
  });

  it("plan_model yoksa alan da yok (varsayılan davranış: plan-mode kendi çözümüne düşer)", () => {
    const sel = resolveSelectedModels({ selected_models: base } as ConfigFile);
    expect(sel.plan_model).toBeUndefined();
  });

  it("diğer opsiyonel alanlar da taşınmaya devam ediyor (regresyon yok)", () => {
    const sel = resolveSelectedModels({
      selected_models: {
        ...base,
        relevance: "claude-haiku-4-5",
        orchestrator: "claude-opus-5",
        model_tiers: { strong: "claude-opus-5" },
      },
    } as ConfigFile);
    expect(sel.relevance).toBe("claude-haiku-4-5");
    expect(sel.orchestrator).toBe("claude-opus-5");
    expect(sel.model_tiers?.strong).toBe("claude-opus-5");
  });
});
