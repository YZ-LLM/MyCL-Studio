// inspector — verdict parse'ı (müfettiş ajan-çıktısı). error-analysis "bloğu üretilemedi"
// sınıfının panzehiri: robust parse + parse edilemezse caller fail-closed (escalate) yapar.

import { describe, expect, it } from "vitest";
import {
  parseVerdict,
  parseClarifyVerdict,
  runInspectorCheckpoint,
  mahkemeRuling,
  buildMahkemeLesson,
  lessonContradictsRuling,
  inspectorClaudeEnv,
  extractText,
  type InspectorContext,
  type CheckpointResult,
  type DebateResolution,
} from "../src/inspector.js";
import type { Lesson } from "../src/experience-layer.js";
import type { MyclConfig } from "../src/config.js";
import type { InterventionSignals } from "../src/inspector-trigger.js";

describe("inspector · parseVerdict (robust ajan-çıktısı parse)", () => {
  it("fenced ```json bloğu → parse", () => {
    const v = parseVerdict('Bence sorun yok.\n```json\n{"stance":"agree","reason":"kanıt temiz"}\n```');
    expect(v?.stance).toBe("agree");
    expect(v?.reason).toBe("kanıt temiz");
  });

  it("flag + kanıt alanı → parse", () => {
    const v = parseVerdict('```json\n{"stance":"flag","reason":"false-positive","evidence":"ts-prune Next-export"}\n```');
    expect(v?.stance).toBe("flag");
    expect(v?.evidence).toBe("ts-prune Next-export");
  });

  it("çıplak (fence'siz) JSON → parse", () => {
    const v = parseVerdict('Sonuç: {"stance":"escalate","reason":"emin değilim"}');
    expect(v?.stance).toBe("escalate");
  });

  it("birden çok blok → SON geçerli olanı al", () => {
    const v = parseVerdict(
      '```json\n{"stance":"flag","reason":"ilk"}\n```\nyeniden değerlendirdim\n```json\n{"stance":"agree","reason":"son"}\n```',
    );
    expect(v?.stance).toBe("agree");
    expect(v?.reason).toBe("son");
  });

  it("blok yok → null (caller escalate eder, sessiz-agree DEĞİL)", () => {
    expect(parseVerdict("Hiç JSON yok, sadece düz metin.")).toBeNull();
  });

  it("geçersiz stance → null", () => {
    expect(parseVerdict('```json\n{"stance":"maybe","reason":"x"}\n```')).toBeNull();
  });
});

describe("inspector · parseClarifyVerdict (netleştirme gerekli mi; fail-closed)", () => {
  const opts = ["✅ Önerilen seti onayla", "⚙️ Tüm fazlar"];
  it("ask=true → insana sor (gerçek belirsizlik)", () => {
    const r = parseClarifyVerdict('```json\n{"ask":true,"reason":"zevk/tercih"}\n```', opts);
    expect(r?.ask).toBe(true);
  });
  it("ask=false + GEÇERLİ seçenek → ilerle", () => {
    const r = parseClarifyVerdict('```json\n{"ask":false,"answer":"⚙️ Tüm fazlar","reason":"çıkarılabilir"}\n```', opts);
    expect(r?.ask).toBe(false);
    expect(r?.answer).toBe("⚙️ Tüm fazlar");
  });
  it("ask=false + GEÇERSİZ/uydurma seçenek → fail-closed (ask=true, kör-ilerle YOK)", () => {
    const r = parseClarifyVerdict('```json\n{"ask":false,"answer":"uydurma secenek","reason":"x"}\n```', opts);
    expect(r?.ask).toBe(true);
  });
  it("ask=false + answer YOK → fail-closed (ask=true)", () => {
    const r = parseClarifyVerdict('```json\n{"ask":false,"reason":"x"}\n```', opts);
    expect(r?.ask).toBe(true);
  });
  it("blok yok → null (caller fail-closed sor)", () => {
    expect(parseClarifyVerdict("hiç JSON yok", opts)).toBeNull();
  });
});

describe("inspector · runInspectorCheckpoint (köprü; 'none' → müfettiş KOŞMAZ)", () => {
  const dummyCfg = {} as MyclConfig;
  const dummyCtx = {} as InspectorContext;
  const quiet: InterventionSignals = {
    isStuck: false,
    isLoop: false,
    noProgress: false,
    highStakesAction: false,
    severity: "low",
  };

  it("sinyal yok / düşük-risk → acted=false (müfettiş spawn EDİLMEZ, maliyet tasarrufu)", async () => {
    const r = await runInspectorCheckpoint(dummyCfg, dummyCtx, quiet);
    expect(r.acted).toBe(false);
    expect(r.decision.level).toBe("none");
    expect(r.outcome).toBeUndefined();
  });
});

describe("inspector · mahkemeRuling (BAĞLAYICI hüküm → eylem; güvenli eşleme)", () => {
  const debateCp = (resolution: DebateResolution): CheckpointResult => ({
    acted: true,
    decision: { level: "debate", reason: "test" },
    outcome: { resolution, rounds: 2, summary: `özet:${resolution}`, finalVerdict: { stance: "flag", reason: "x" } },
  });
  const flagCp = (stance: "agree" | "flag" | "escalate"): CheckpointResult => ({
    acted: true,
    decision: { level: "flag", reason: "test" },
    outcome: { stance, reason: `r:${stance}` },
  });

  it("toplanmadı (none) → proceed + convened=false (varsayılan akış, müdahale yok)", () => {
    const r = mahkemeRuling({ acted: false, decision: { level: "none", reason: "sinyal yok" } });
    expect(r.action).toBe("proceed");
    expect(r.convened).toBe(false);
  });

  it("tam-tartışma orkestratör-teslim → SUPPRESS (en güçlü false-positive sinyali)", () => {
    const r = mahkemeRuling(debateCp("orchestrator-conceded"));
    expect(r.action).toBe("suppress");
    expect(r.convened).toBe(true);
  });

  it("YÜKSEK-RİSK + orkestratör-teslim → suppress DEĞİL, escalate (güvenlik asla oto-suppress)", () => {
    const r = mahkemeRuling({ ...debateCp("orchestrator-conceded"), highStakes: true });
    expect(r.action).toBe("escalate");
  });

  it("tartışma escalate → escalate (insana)", () => {
    expect(mahkemeRuling(debateCp("escalate")).action).toBe("escalate");
  });

  it("tartışma agree / inspector-conceded → proceed (karar doğru)", () => {
    expect(mahkemeRuling(debateCp("agree")).action).toBe("proceed");
    expect(mahkemeRuling(debateCp("inspector-conceded")).action).toBe("proceed");
  });

  it("tek-geçiş flag (tartışma YOK) → SUPPRESS DEĞİL, escalate (tartışmasız bastırma yok)", () => {
    expect(mahkemeRuling(flagCp("flag")).action).toBe("escalate");
    expect(mahkemeRuling(flagCp("escalate")).action).toBe("escalate");
  });

  it("tek-geçiş agree → proceed", () => {
    expect(mahkemeRuling(flagCp("agree")).action).toBe("proceed");
  });
});

describe("inspector · buildMahkemeLesson (tecrübe RECORD — mahkeme→ders)", () => {
  const debateRes = (resolution: DebateResolution): CheckpointResult => ({
    acted: true,
    decision: { level: "debate", reason: "x" },
    outcome: { resolution, rounds: 2, summary: "özet", finalVerdict: { stance: "flag", reason: "r" } },
  });
  const flagRes = (stance: "agree" | "flag" | "escalate"): CheckpointResult => ({
    acted: true,
    decision: { level: "flag", reason: "x" },
    outcome: { stance, reason: "r" },
  });

  it("escalate → null (çözülmedi → ders DEĞİL)", () => {
    expect(
      buildMahkemeLesson({ signature: "s", problem: "p", result: debateRes("escalate"), ruling: { action: "escalate", convened: true, summary: "x" }, ts: 1 }),
    ).toBeNull();
  });
  it("toplanmadı (convened=false) → null", () => {
    expect(
      buildMahkemeLesson({ signature: "s", problem: "p", result: flagRes("agree"), ruling: { action: "proceed", convened: false, summary: "x" }, ts: 1 }),
    ).toBeNull();
  });
  it("tam-tartışma suppress → lesson, verified=TRUE, false-positive ilkesi", () => {
    const l = buildMahkemeLesson({ signature: "sig", problem: "p", result: debateRes("orchestrator-conceded"), ruling: { action: "suppress", convened: true, summary: "özet" }, ts: 9 });
    expect(l?.verified).toBe(true);
    expect(l?.principle).toMatch(/FALSE-POSITIVE/);
    expect(l?.ts).toBe(9);
  });
  it("tek-geçiş agree→proceed → lesson, verified=FALSE (zayıf), gerçek-sorun ilkesi", () => {
    const l = buildMahkemeLesson({ signature: "sig", problem: "p", result: flagRes("agree"), ruling: { action: "proceed", convened: true, summary: "s" }, ts: 1 });
    expect(l?.verified).toBe(false);
    expect(l?.principle).toMatch(/GERÇEK/);
  });
});

describe("inspector · lessonContradictsRuling (tecrübe RETRACT — yanlış-ders sinyali)", () => {
  const fp: Lesson = { signature: "s", problem: "p", resolution: "r", principle: "Bu bulgu-deseni FALSE-POSITIVE — ...", verified: true, ts: 1 };
  const real: Lesson = { signature: "s", problem: "p", resolution: "r", principle: "Bu bulgu-deseni GERÇEK kod sorunu — ...", verified: true, ts: 1 };
  it("ders=false-positive AMA hüküm=proceed(gerçek) → ZIT (retract)", () => {
    expect(lessonContradictsRuling(fp, { action: "proceed", convened: true, summary: "x" })).toBe(true);
  });
  it("ders=gerçek AMA hüküm=suppress(false-positive) → ZIT (retract)", () => {
    expect(lessonContradictsRuling(real, { action: "suppress", convened: true, summary: "x" })).toBe(true);
  });
  it("ders=false-positive + hüküm=suppress → uyumlu (retract YOK)", () => {
    expect(lessonContradictsRuling(fp, { action: "suppress", convened: true, summary: "x" })).toBe(false);
  });
  it("hüküm escalate / toplanmadı → asla retract (false)", () => {
    expect(lessonContradictsRuling(real, { action: "escalate", convened: true, summary: "x" })).toBe(false);
    expect(lessonContradictsRuling(fp, { action: "proceed", convened: false, summary: "x" })).toBe(false);
  });
});

describe("inspector · inspectorClaudeEnv (API-paritesi — müfettişe Claude auth)", () => {
  const cfg = (backend: string, mainKey: string) =>
    ({ agent_backends: { main: backend }, api_keys: { main: mainKey, translator: "t" } } as unknown as Parameters<typeof inspectorClaudeEnv>[0]);
  it("CLI/abonelik → undefined (sürpriz API faturası yok, claudeSpawnEnv yeterli)", () => {
    expect(inspectorClaudeEnv(cfg("cli", "claude-key"))).toBeUndefined();
  });
  it("API-modu + Claude anahtarı → ANTHROPIC_API_KEY (müfettiş auth olur)", () => {
    expect(inspectorClaudeEnv(cfg("api", "claude-key"))).toEqual({ ANTHROPIC_API_KEY: "claude-key" });
  });
  it("API-modu ama Claude anahtarı yok → undefined (fail-closed; çapraz-aile sınırı)", () => {
    expect(inspectorClaudeEnv(cfg("api", ""))).toBeUndefined();
  });
});

describe("inspector · extractText (SDK araç-döngüsü verdict-çıkarımı)", () => {
  it("string content → aynen", () => {
    expect(extractText("verdict metni")).toBe("verdict metni");
  });
  it("text-block'lar → birleştir + trim", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }] as never)).toBe("ab");
  });
  it("yalnız tool_use blokları → '' (henüz verdict yok)", () => {
    expect(extractText([{ type: "tool_use", id: "1", name: "Read", input: {} }] as never)).toBe("");
  });
  it("karışık (tool_use + text) → yalnız text", () => {
    expect(extractText([{ type: "tool_use", id: "1", name: "Read", input: {} }, { type: "text", text: '{"stance":"agree"}' }] as never)).toBe('{"stance":"agree"}');
  });
});

// DENETİM YAPILAMADI ≠ KUŞKULU BULGU (YZLLM kararı 2026-07-30). Canlı cave: "Müfettiş değerlendirmesi
// üretilemedi" 129 kez → hepsi "kabul-devam" ile geçti. Artık sağlayıcı kaynaklı escalate ayırt ediliyor:
// caller onu kabul-devam yoluna SOKMAZ, gerçek çözüme yönlendirir.
describe("mahkemeRuling · providerUnavailable taşınması", () => {
  const verdict = (extra: Record<string, unknown> = {}) => ({
    stance: "escalate" as const,
    reason: "Müfettiş değerlendirmesi üretilemedi → güvenli taraf: insana.",
    ...extra,
  });

  it("tek geçiş: sağlayıcıya ulaşılamadı → ruling.providerUnavailable=true", () => {
    const r = mahkemeRuling({
      acted: true,
      decision: { level: "flag", reason: "x" },
      outcome: verdict({ providerUnavailable: true }),
    });
    expect(r.action).toBe("escalate");
    expect(r.providerUnavailable).toBe(true);
  });

  it("model KOŞTU ama blok bozuk (gerçek kalite sorunu) → providerUnavailable YOK", () => {
    const r = mahkemeRuling({
      acted: true,
      decision: { level: "flag", reason: "x" },
      outcome: { stance: "escalate", reason: "Müfettiş verdict bloğu üretmedi → insana." },
    });
    expect(r.action).toBe("escalate");
    expect(r.providerUnavailable).toBeUndefined();
  });

  it("tartışma yolu: finalVerdict sağlayıcı hatasıysa bayrak taşınır", () => {
    const r = mahkemeRuling({
      acted: true,
      decision: { level: "debate", reason: "x" },
      outcome: {
        resolution: "escalate",
        rounds: 2,
        summary: "çözülmedi",
        finalVerdict: verdict({ providerUnavailable: true }),
      },
    });
    expect(r.action).toBe("escalate");
    expect(r.providerUnavailable).toBe(true);
  });

  it("agree/suppress bayrak TAŞIMAZ (yalnız escalate'e takılı)", () => {
    const agree = mahkemeRuling({
      acted: true,
      decision: { level: "flag", reason: "x" },
      outcome: { stance: "agree", reason: "ok", providerUnavailable: true } as never,
    });
    expect(agree.action).toBe("proceed");
    expect(agree.providerUnavailable).toBeUndefined();
  });
});
