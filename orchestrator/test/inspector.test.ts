// inspector — verdict parse'ı (müfettiş ajan-çıktısı). error-analysis "bloğu üretilemedi"
// sınıfının panzehiri: robust parse + parse edilemezse caller fail-closed (escalate) yapar.

import { describe, expect, it } from "vitest";
import {
  parseVerdict,
  parseClarifyVerdict,
  runInspectorCheckpoint,
  mahkemeRuling,
  type InspectorContext,
  type CheckpointResult,
  type DebateResolution,
} from "../src/inspector.js";
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
