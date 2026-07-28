// agent-acl.test — Merkezi ACL registry kontrolü.
//
// Amaç: registry'nin kendi iç tutarlılığı — id benzersizliği, beklenen tool
// listeleri, risk/slot alanlarının uyumu. Test phase controller'ları import
// etmez; registry'nin sabit değerlerini burada yazılı beklentilerle karşılaştırır.

import { describe, it, expect } from "vitest";
import { AGENT_ACL_REGISTRY, getAgentACL } from "../src/agent-acl.js";

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

  it("model_slot consistency: api_key_slot ile eşleşmeli", () => {
    for (const acl of AGENT_ACL_REGISTRY) {
      // "none" ↔ "none" eşleşmesi veya aynı slot adı
      expect(acl.model_slot).toBe(acl.api_key_slot);
    }
  });
});
