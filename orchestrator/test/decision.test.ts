// orchestrator-agent/decision · parseAgentDecision — özellikle clarify_options
// (doğru-karar/proaktif-risk, 2026-06-04) + temel validation kapsamı.

import { describe, expect, it } from "vitest";
import { parseAgentDecision, AgentDecisionError } from "../src/orchestrator-agent/decision.js";

describe("parseAgentDecision · temel", () => {
  it("geçerli minimal karar (chat) → parse", () => {
    const d = parseAgentDecision({ action: "chat", reason: "selam" });
    expect(d.action).toBe("chat");
    expect(d.reason).toBe("selam");
  });

  it("geçersiz action → hata", () => {
    expect(() => parseAgentDecision({ action: "nope", reason: "x" })).toThrow(AgentDecisionError);
  });

  it("reason eksik → hata", () => {
    expect(() => parseAgentDecision({ action: "chat" })).toThrow(AgentDecisionError);
  });
});

describe("parseAgentDecision · clarify_options (proaktif risk)", () => {
  it("ask_clarify + clarify_options → somut seçenekler parse", () => {
    const d = parseAgentDecision({
      action: "ask_clarify",
      reason: "Auth yöntemi belirsiz, riskli seçim.",
      clarify_options: ["JWT token", "session-cookie"],
    });
    expect(d.clarify_options).toEqual(["JWT token", "session-cookie"]);
  });

  it("clarify_options trim + boş eleme + dedup", () => {
    const d = parseAgentDecision({
      action: "ask_clarify",
      reason: "r",
      clarify_options: ["  A  ", "", "A", "B", "   "],
    });
    expect(d.clarify_options).toEqual(["A", "B"]);
  });

  it("clarify_options cap 6", () => {
    const d = parseAgentDecision({
      action: "ask_clarify",
      reason: "r",
      clarify_options: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });
    expect(d.clarify_options).toHaveLength(6);
  });

  it("ask_clarify-DIŞI action'da clarify_options sessizce ignore", () => {
    const d = parseAgentDecision({
      action: "chat",
      reason: "r",
      clarify_options: ["A", "B"],
    });
    expect(d.clarify_options).toBeUndefined();
  });

  it("ask_clarify ama clarify_options yok → undefined (eski Evet/Hayır davranışı)", () => {
    const d = parseAgentDecision({ action: "ask_clarify", reason: "r" });
    expect(d.clarify_options).toBeUndefined();
  });

  it("clarify_options tümü boş/whitespace → undefined (set edilmez)", () => {
    const d = parseAgentDecision({ action: "ask_clarify", reason: "r", clarify_options: ["", "  "] });
    expect(d.clarify_options).toBeUndefined();
  });
});
