// realapp-gate-signal — gerçek-app doğrulama kapısı SAF karar matrisi (YZLLM 2026-07-21).
import { describe, expect, it } from "vitest";
import {
  realAppGateDecision,
  buildRealAppVerifyMarker,
  decideFullDevelopGate,
  type RealAppGateSignals,
  type FullDevelopGateSignals,
} from "../src/realapp-gate-signal.js";

const base: RealAppGateSignals = {
  isFixIteration: true,
  projectType: "web",
  hasUiSpecSignal: false,
  changedFiles: ["routes/profile.js"],
  playwrightEnabled: true,
};

describe("realAppGateDecision", () => {
  it("CANLI VAKA: fix + web + backend runtime dosya (buildCustomerSearchQuery) → KOŞ", () => {
    // routes/profile.js frontend değil ama runtime-prod → UI üzerinden gözlenir → koşmalı
    expect(realAppGateDecision({ ...base, changedFiles: ["routes/profile.js"] }).run).toBe(true);
  });

  it("fix değil (greenfield) → koşma", () => {
    expect(realAppGateDecision({ ...base, isFixIteration: false }).run).toBe(false);
  });

  it("Playwright kapalı → koşma (mevcut toggle korunur)", () => {
    expect(realAppGateDecision({ ...base, playwrightEnabled: false }).run).toBe(false);
  });

  it("api/cli/library → koşma (tarayıcıdan sürülemez)", () => {
    for (const pt of ["api", "cli", "library", "ml", "game", "mobile"] as const) {
      expect(realAppGateDecision({ ...base, projectType: pt }).run).toBe(false);
    }
  });

  it("desktop → koş", () => {
    expect(realAppGateDecision({ ...base, projectType: "desktop" }).run).toBe(true);
  });

  it("unknown + UI spec sinyali → koş; UI sinyali yok → koşma", () => {
    expect(realAppGateDecision({ ...base, projectType: "unknown", hasUiSpecSignal: true }).run).toBe(true);
    expect(realAppGateDecision({ ...base, projectType: "unknown", hasUiSpecSignal: false }).run).toBe(false);
  });

  it("changedFiles null (non-git) → FAIL-OPEN koş", () => {
    expect(realAppGateDecision({ ...base, changedFiles: null }).run).toBe(true);
  });

  it("MAHKEME BULGU 1: changedFiles boş (git-hatası olabilir) → FAIL-OPEN koş (sessiz atlama YOK)", () => {
    // getChangedFiles git-komut başarısızlığında da [] döner → boş dizi 'gerçekten yok' ile 'güvenilmez'i ayırt
    // edemez → ikisi de koşulmalı (eski 'boş→koşma' sessiz false-green üretiyordu).
    expect(realAppGateDecision({ ...base, changedFiles: [] }).run).toBe(true);
  });

  it("MAHKEME BULGU 4: salt-CSS/HTML görsel değişiklik (web) → KOŞ (E2E görsel bug'ı doğrular)", () => {
    expect(realAppGateDecision({ ...base, changedFiles: ["styles/profile.css"] }).run).toBe(true);
    expect(realAppGateDecision({ ...base, changedFiles: ["public/index.html"] }).run).toBe(true);
  });

  it("yalnız test/config/doküman değişti → koşma (çalışma-zamanı/UI etkilenmez)", () => {
    expect(realAppGateDecision({ ...base, changedFiles: ["README.md", "tsconfig.json", "tests/x.spec.ts"] }).run).toBe(false);
    expect(realAppGateDecision({ ...base, changedFiles: ["docs/guide.txt"] }).run).toBe(false);
  });

  it("doküman/test + runtime karışık → runtime var → koş", () => {
    expect(realAppGateDecision({ ...base, changedFiles: ["README.md", "src/handler.js"] }).run).toBe(true);
  });

  it("doküman/test + CSS karışık → UI-görsel var → koş", () => {
    expect(realAppGateDecision({ ...base, changedFiles: ["tests/x.spec.ts", "app.css"] }).run).toBe(true);
  });
});

describe("buildRealAppVerifyMarker (MAHKEME v2 — regresyon-guard)", () => {
  const baseIn = {
    fromErrorAnalysis: false,
    bugReportTr: "profil aramasında sonuç gelmiyor",
    rootCauseTr: "buildCustomerSearchQuery aralığı fazla kısıtlıyor",
    fixLabel: "aralık sınırını genişlet",
    checkpointRef: "abc123",
    iteration: 3,
  };

  it("normal fix → marker kurulur, bug_intent kullanıcı-şikayeti + root_cause teşhis", () => {
    const m = buildRealAppVerifyMarker(baseIn);
    expect(m.pending_realapp_verify).toBeDefined();
    expect(m.pending_realapp_verify!.bug_intent_tr).toBe("profil aramasında sonuç gelmiyor");
    expect(m.pending_realapp_verify!.root_cause_tr).toBe("buildCustomerSearchQuery aralığı fazla kısıtlıyor");
    expect(m.pending_realapp_verify!.created_iter).toBe(3);
  });

  it("error-analysis gate-fix → marker KURULMAZ (boş → nested'de orijinal marker EZİLMEZ)", () => {
    const m = buildRealAppVerifyMarker({ ...baseIn, fromErrorAnalysis: true });
    expect(m).toEqual({});
    expect("pending_realapp_verify" in m).toBe(false); // anahtar HİÇ yok → spread eski marker'ı korur
  });

  it("bug_report_tr yok (eski state.json) → rootCauseTr fallback (undefined bug_intent OLMAZ)", () => {
    const m = buildRealAppVerifyMarker({ ...baseIn, bugReportTr: undefined });
    expect(m.pending_realapp_verify!.bug_intent_tr).toBe("buildCustomerSearchQuery aralığı fazla kısıtlıyor");
  });

  it("bugIntentEn verilirse marker'a bug_intent_en yazılır (tam-develop sentezi → çeviri atlanır)", () => {
    const m = buildRealAppVerifyMarker({ ...baseIn, bugIntentEn: "the /wellcome page renders empty" });
    expect(m.pending_realapp_verify!.bug_intent_en).toBe("the /wellcome page renders empty");
  });
  it("bugIntentEn yoksa bug_intent_en alanı HİÇ yazılmaz (Faz 0 marker → çeviri yolu korunur)", () => {
    const m = buildRealAppVerifyMarker(baseIn);
    expect("bug_intent_en" in m.pending_realapp_verify!).toBe(false);
  });
});

describe("decideFullDevelopGate (tam-develop gerçek-app sentezi — MAHKEME BULGU 3 canlı fix)", () => {
  const baseFd: FullDevelopGateSignals = {
    hasPhase0Marker: false,
    projectType: "web",
    hasUiFiles: false,
    phase6HumanReviewed: false,
    hasIntent: true,
    playwrightEnabled: true,
  };

  it("CANLI VAKA: tam-develop + web + Faz 6 insan-incelemesi YOK + niyet var → SENTEZLE (koş)", () => {
    expect(decideFullDevelopGate(baseFd).run).toBe(true);
  });
  it("Faz 0 marker'ı zaten var → sentezleme (o kapı halleder)", () => {
    expect(decideFullDevelopGate({ ...baseFd, hasPhase0Marker: true }).run).toBe(false);
  });
  it("Faz 6 insan tarafından incelendi (varsayılan mod / greenfield) → sentezleme (insan doğruladı)", () => {
    expect(decideFullDevelopGate({ ...baseFd, phase6HumanReviewed: true }).run).toBe(false);
  });
  it("niyet yok → sentezleme (doğrulama hedefi yok)", () => {
    expect(decideFullDevelopGate({ ...baseFd, hasIntent: false }).run).toBe(false);
  });
  it("Playwright kapalı → sentezleme", () => {
    expect(decideFullDevelopGate({ ...baseFd, playwrightEnabled: false }).run).toBe(false);
  });
  it("api/cli/library (tarayıcıdan sürülemez) → sentezleme (UI-dosya olsa bile)", () => {
    for (const pt of ["api", "cli", "library"] as const) {
      expect(decideFullDevelopGate({ ...baseFd, projectType: pt, hasUiFiles: true }).run).toBe(false);
    }
  });
  it("MAHKEME MEDIUM: unknown → GERÇEK UI-dosyası şart (spec-regex değil); cave (ejs views) → koş, backend (dosya yok) → koşma", () => {
    // cave: project_type=unknown ama views/*.ejs var → hasUiFiles=true → sentezle
    expect(decideFullDevelopGate({ ...baseFd, projectType: "unknown", hasUiFiles: true }).run).toBe(true);
    // yanlış-sınıflı backend (unknown, UI dosyası yok, spec'te "html" geçse de) → sentezleme (yanlış blok önlenir)
    expect(decideFullDevelopGate({ ...baseFd, projectType: "unknown", hasUiFiles: false }).run).toBe(false);
  });
});
