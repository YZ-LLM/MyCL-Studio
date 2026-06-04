// pipeline-end-summary — DÜRÜST akış-sonu özet (saf). Ümit'in #1 endişesi:
// gate soft-fail olsa bile "TAMAMLANDI" DEME. Bu testler tam o davranışı kilitler.

import { describe, expect, it } from "vitest";
import {
  buildPipelineEndLines,
  type PipelineEndInput,
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

  it("verdict null (audit okunamadı) → smoke/auth temizse yine '✅ Tamamlandı'", () => {
    const out = lines({ verdict: null });
    expect(out).toContain("✅ Tamamlandı");
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
