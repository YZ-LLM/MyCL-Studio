// agent-acl.test — Merkezi ACL registry kontrolü.
//
// Amaç:
//   1. Her ajan id'sinin allowed_tools listesi, gerçek phase controller
//      tool listesiyle eşleşmeli. Yeni tool eklenip registry güncellenmezse
//      bu test fail eder → discipline koruma.
//   2. Yardımcı fonksiyonlar (isToolAllowed, getHighRiskAgents) doğru çalışır.

import { describe, it, expect } from "vitest";
import {
  AGENT_ACL_REGISTRY,
  getAgentACL,
  getHighRiskAgents,
  isToolAllowed,
} from "../src/agent-acl.js";

describe("agent-acl registry", () => {
  it("her ajan id'si unique", () => {
    const ids = AGENT_ACL_REGISTRY.map((a) => a.agent_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orchestrator: Read/Grep/Bash/decide_action", () => {
    const acl = getAgentACL("orchestrator");
    expect(acl).toBeDefined();
    expect(acl!.allowed_tools).toEqual(["Read", "Grep", "Bash", "decide_action"]);
    expect(acl!.risk_level).toBe("low");
    expect(acl!.model_slot).toBe("orchestrator");
  });

  it("translator: tool yok, stateless", () => {
    const acl = getAgentACL("translator");
    expect(acl).toBeDefined();
    expect(acl!.allowed_tools).toEqual([]);
    expect(acl!.api_key_slot).toBe("translator");
  });

  it("phase-1: sadece askq tool'ları, Read/Write yok", () => {
    const acl = getAgentACL("phase-1");
    expect(acl).toBeDefined();
    expect(acl!.allowed_tools).toContain("ask_clarifying");
    expect(acl!.allowed_tools).toContain("request_intent_approval");
    expect(acl!.allowed_tools).not.toContain("Read");
    expect(acl!.allowed_tools).not.toContain("Write");
    expect(acl!.allowed_tools).not.toContain("Bash");
  });

  it("phase-5 (UI codegen): Write + Edit + Bash high-risk", () => {
    const acl = getAgentACL("phase-5");
    expect(acl).toBeDefined();
    expect(acl!.risk_level).toBe("high");
    expect(acl!.allowed_tools).toContain("Write");
    expect(acl!.allowed_tools).toContain("Edit");
    expect(acl!.allowed_tools).toContain("Bash");
  });

  it("phase-6 ve mechanical: LLM yok", () => {
    const p6 = getAgentACL("phase-6");
    const mech = getAgentACL("mechanical");
    expect(p6!.api_key_slot).toBe("none");
    expect(p6!.allowed_tools).toEqual([]);
    expect(mech!.api_key_slot).toBe("none");
    expect(mech!.allowed_tools).toEqual([]);
  });

  it("isToolAllowed: allowlist check", () => {
    expect(isToolAllowed("orchestrator", "Read")).toBe(true);
    expect(isToolAllowed("orchestrator", "Write")).toBe(false); // orchestrator write yapamaz
    expect(isToolAllowed("phase-1", "Bash")).toBe(false); // phase-1 read-only domain
    expect(isToolAllowed("phase-5", "Write")).toBe(true);
    // Bilinmeyen agent_id
    expect(isToolAllowed("unknown" as never, "Read")).toBe(false);
  });

  it("getHighRiskAgents: phase-5, phase-5-tweak, phase-8 (v15.7 phase-0-d3 kaldırıldı)", () => {
    const high = getHighRiskAgents();
    expect(high).toContain("phase-5");
    expect(high).toContain("phase-5-tweak");
    expect(high).toContain("phase-8");
    // v15.7: phase-0-d3 silindi
    expect(high).not.toContain("phase-0-d3");
    // Düşük riskli olanlar listede olmamalı
    expect(high).not.toContain("orchestrator");
    expect(high).not.toContain("translator");
    expect(high).not.toContain("phase-1");
  });

  it("model_slot consistency: api_key_slot ile eşleşmeli", () => {
    for (const acl of AGENT_ACL_REGISTRY) {
      // "none" ↔ "none" eşleşmesi veya aynı slot adı
      expect(acl.model_slot).toBe(acl.api_key_slot);
    }
  });
});
