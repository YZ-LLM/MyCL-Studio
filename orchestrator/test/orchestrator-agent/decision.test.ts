// orchestrator-agent/decision — parseAgentDecision validation tests.

import { describe, expect, it } from "vitest";
import {
  parseAgentDecision,
  AgentDecisionError,
  DECIDE_ACTION_TOOL_SCHEMA,
} from "../../src/orchestrator-agent/decision.js";

describe("orchestrator-agent/decision · parseAgentDecision", () => {
  it("valid chat decision parse", () => {
    const r = parseAgentDecision({
      action: "chat",
      reason: "Kullanıcı selam verdi, kısa yanıt yeterli.",
      message_to_user: "Merhaba! Bugün ne yapıyoruz?",
    });
    expect(r.action).toBe("chat");
    expect(r.reason).toContain("selam");
    expect(r.message_to_user).toBe("Merhaba! Bugün ne yapıyoruz?");
    expect(r.target_phase).toBeUndefined();
  });

  it("valid approve_ui (Phase 6) parse", () => {
    const r = parseAgentDecision({
      action: "approve_ui",
      reason: "Phase 6 deferred mode, kullanıcı 'onayla' yazdı.",
    });
    expect(r.action).toBe("approve_ui");
  });

  it("valid run_phase + target_phase parse", () => {
    const r = parseAgentDecision({
      action: "run_phase",
      reason: "Kullanıcı testleri çalıştır dedi → Faz 14",
      target_phase: 14,
    });
    expect(r.action).toBe("run_phase");
    expect(r.target_phase).toBe(14);
  });

  it("run_phase target_phase eksikse THROW", () => {
    expect(() =>
      parseAgentDecision({ action: "run_phase", reason: "x" }),
    ).toThrow(AgentDecisionError);
  });

  it("run_phase target_phase invalid (>17) THROW", () => {
    expect(() =>
      parseAgentDecision({
        action: "run_phase",
        reason: "x",
        target_phase: 20,
      }),
    ).toThrow(AgentDecisionError);
  });

  it("valid verify_feature + target_feature parse", () => {
    const r = parseAgentDecision({
      action: "verify_feature",
      reason: "Kullanıcı anket oluşturma özelliğini test etmek istiyor.",
      target_feature: "anket oluşturma sayfası",
    });
    expect(r.action).toBe("verify_feature");
    expect(r.target_feature).toBe("anket oluşturma sayfası");
  });

  it("verify_feature target_feature eksikse THROW", () => {
    expect(() =>
      parseAgentDecision({ action: "verify_feature", reason: "x" }),
    ).toThrow(AgentDecisionError);
  });

  it("verify_feature target_feature boş string THROW", () => {
    expect(() =>
      parseAgentDecision({
        action: "verify_feature",
        reason: "x",
        target_feature: "   ",
      }),
    ).toThrow(AgentDecisionError);
  });

  it("invalid action enum THROW", () => {
    expect(() =>
      parseAgentDecision({ action: "yolo", reason: "x" }),
    ).toThrow(AgentDecisionError);
  });

  it("reason eksik veya boş THROW", () => {
    expect(() =>
      parseAgentDecision({ action: "chat", reason: "" }),
    ).toThrow(AgentDecisionError);
    expect(() =>
      parseAgentDecision({ action: "chat" }),
    ).toThrow(AgentDecisionError);
  });

  it("input object değilse THROW", () => {
    expect(() => parseAgentDecision(null)).toThrow(AgentDecisionError);
    expect(() => parseAgentDecision("string")).toThrow(AgentDecisionError);
    expect(() => parseAgentDecision(42)).toThrow(AgentDecisionError);
  });

  it("message_to_user opsiyonel; verilmezse undefined kalır", () => {
    const r = parseAgentDecision({
      action: "develop_new_or_iter",
      reason: "Yeni feature isteği.",
    });
    expect(r.message_to_user).toBeUndefined();
  });
});

describe("orchestrator-agent/decision · DECIDE_ACTION_TOOL_SCHEMA", () => {
  it("type: object + required fields", () => {
    expect(DECIDE_ACTION_TOOL_SCHEMA.type).toBe("object");
    expect(DECIDE_ACTION_TOOL_SCHEMA.required).toEqual(["action", "reason"]);
  });

  it("action enum exactly 14 değer (v15.8 +verify_feature)", () => {
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.action.enum).toHaveLength(14);
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.action.enum).toContain(
      "save_memory_proposal",
    );
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.action.enum).toContain(
      "set_optional_phases",
    );
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.action.enum).toContain(
      "answer_askq",
    );
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.action.enum).toContain(
      "verify_feature",
    );
  });

  it("target_phase 0-17 arası 18 değer", () => {
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.target_phase.enum).toHaveLength(18);
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.target_phase.enum).toContain(0);
    expect(DECIDE_ACTION_TOOL_SCHEMA.properties.target_phase.enum).toContain(17);
  });
});
