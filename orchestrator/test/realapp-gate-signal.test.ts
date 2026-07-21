// realapp-gate-signal — gerçek-app doğrulama kapısı SAF karar matrisi (YZLLM 2026-07-21).
import { describe, expect, it } from "vitest";
import {
  realAppGateDecision,
  buildRealAppVerifyMarker,
  type RealAppGateSignals,
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
});
