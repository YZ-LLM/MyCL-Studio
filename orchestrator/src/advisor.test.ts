// advisor — SAF karar mantığı testleri (yan etki yok; version probe/config'e dokunmaz).
// ODAK: (1) parseClaudeVersion regex, (2) semverGte sürüm gate, (3) decideAdvisorModel gate doğruluk tablosu.

import { describe, expect, it } from "vitest";
import {
  parseClaudeVersion,
  semverGte,
  decideAdvisorModel,
  claudeStrongModelId,
  ADVISOR_MIN_VERSION,
  type AdvisorDecisionInput,
} from "./advisor.js";

describe("parseClaudeVersion", () => {
  it("çıktıdan ilk semver'i çeker", () => {
    expect(parseClaudeVersion("2.1.206 (Claude Code)")).toBe("2.1.206");
    expect(parseClaudeVersion("claude 2.1.98")).toBe("2.1.98");
    expect(parseClaudeVersion("v10.0.3\n")).toBe("10.0.3");
  });
  it("semver yoksa null", () => {
    expect(parseClaudeVersion("no version here")).toBeNull();
    expect(parseClaudeVersion("2.1")).toBeNull(); // major.minor yetmez
    expect(parseClaudeVersion("")).toBeNull();
  });
});

describe("semverGte", () => {
  it("büyük/eşit → true", () => {
    expect(semverGte("2.1.206", "2.1.98")).toBe(true); // patch büyük
    expect(semverGte("2.1.98", "2.1.98")).toBe(true); // eşit
    expect(semverGte("2.2.0", "2.1.98")).toBe(true); // minor büyük
    expect(semverGte("3.0.0", "2.1.98")).toBe(true); // major büyük
  });
  it("küçük → false", () => {
    expect(semverGte("2.1.97", "2.1.98")).toBe(false); // patch küçük
    expect(semverGte("2.0.999", "2.1.98")).toBe(false); // minor küçük
    expect(semverGte("1.9.9", "2.1.98")).toBe(false); // major küçük
  });
  it("geçersiz → false (fail-safe)", () => {
    expect(semverGte("2.1", "2.1.98")).toBe(false);
    expect(semverGte("abc", "2.1.98")).toBe(false);
  });
});

describe("decideAdvisorModel — gate doğruluk tablosu", () => {
  const OK: AdvisorDecisionInput = {
    enabled: true,
    backend: "cli",
    isZai: false,
    claudeVersionOk: true,
    executorTier: "balanced",
    strongModelId: "claude-opus-4-8",
    executorModelId: "claude-sonnet-4-6",
  };

  it("tüm gate'ler geçince → strong danışman model id'si", () => {
    expect(decideAdvisorModel(OK)).toBe("claude-opus-4-8");
    // cheap executor de geçer
    expect(decideAdvisorModel({ ...OK, executorTier: "cheap" })).toBe("claude-opus-4-8");
  });

  it("her bir gate ihlali → null (danışman eklenmez)", () => {
    expect(decideAdvisorModel({ ...OK, enabled: false })).toBeNull(); // opt-in kapalı
    expect(decideAdvisorModel({ ...OK, backend: "api" })).toBeNull(); // --advisor CLI-only
    expect(decideAdvisorModel({ ...OK, isZai: true })).toBeNull(); // z.ai desteklemez
    expect(decideAdvisorModel({ ...OK, claudeVersionOk: false })).toBeNull(); // claude < 2.1.98
    expect(decideAdvisorModel({ ...OK, executorTier: "strong" })).toBeNull(); // strong executor
    expect(
      decideAdvisorModel({ ...OK, executorModelId: "claude-opus-4-8" }),
    ).toBeNull(); // danışman == executor → no-op
  });

  it("ADVISOR_MIN_VERSION sabiti 2.1.98", () => {
    expect(ADVISOR_MIN_VERSION).toBe("2.1.98");
    expect(semverGte(ADVISOR_MIN_VERSION, ADVISOR_MIN_VERSION)).toBe(true);
  });
});

describe("claudeStrongModelId — danışman DAİMA Claude (GLM'i --advisor'a geçirme; mahkeme 2026-07-11)", () => {
  it("konfigüre strong Claude ise onu döndürür", () => {
    expect(claudeStrongModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(claudeStrongModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
  it("konfigüre strong GLM/bilinmeyen ise Claude katalog varsayılanına düşer (asla glm-* döndürmez)", () => {
    const fromGlm = claudeStrongModelId("glm-5.2");
    expect(fromGlm.startsWith("claude")).toBe(true);
    expect(fromGlm).not.toBe("glm-5.2");
    expect(claudeStrongModelId("bilinmeyen-model")).toBe(fromGlm);
    expect(claudeStrongModelId(undefined)).toBe(fromGlm); // undefined de Claude varsayılanı
  });
});
