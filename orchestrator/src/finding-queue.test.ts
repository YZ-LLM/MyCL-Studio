// finding-queue — saf mantık testleri (YZLLM 2026-07-03 teker teker sor): findingKey kararlılığı,
// perFindingSig tekilliği, advanceDecision geçişleri. Yan etki yok (answer-memory.test deseni).

import { describe, expect, it } from "vitest";
import { findingKey, perFindingSig, advanceDecision, findingQueueAutoApply, type FindingQueue } from "./finding-queue.js";
import type { ErrorFinding } from "./error-analysis.js";

function finding(over: Partial<ErrorFinding> = {}): ErrorFinding {
  return { summary_tr: "sorun", solutions_tr: ["a"], best_index: 0, ...over };
}

function queue(findings: ErrorFinding[], index = 0): FindingQueue {
  return { phase: 13, project_root: "/tmp/p", findings, index, sig_base: "phase-13", awaitingRerun: false, anyFixed: false, converging: true };
}

describe("findingQueueAutoApply (mahkeme blocker+parite fix — döngü koruması TÜM bulgulara, non-foreign birebir)", () => {
  // FOREIGN: autoAnswerSuggested=false (entegre bastırma), autoAnswerEnabled=ham toggle.
  const foreign = (enabled: boolean) => ({ autoAnswerEnabled: enabled, autoAnswerSuggested: false });
  // NON-FOREIGN: bastırma yok → autoAnswerSuggested = autoAnswerEnabled.
  const nonForeign = (enabled: boolean) => ({ autoAnswerEnabled: enabled, autoAnswerSuggested: enabled });

  it("FOREIGN Faz 13 + toggle açık + YAKINSIYOR → otomatik (true)", () => {
    expect(findingQueueAutoApply({ phase: 13, converging: true }, foreign(true))).toBe(true);
  });
  it("FOREIGN Faz 13 + toggle açık + YAKINSAMIYOR → OTOMATİK DEĞİL (kullanıcı) — kritik: finding[1+] de korunur (blocker)", () => {
    expect(findingQueueAutoApply({ phase: 13, converging: false }, foreign(true))).toBe(false);
  });
  it("FOREIGN Faz 13 + toggle KAPALI → otomatik değil", () => {
    expect(findingQueueAutoApply({ phase: 13, converging: true }, foreign(false))).toBe(false);
  });
  it("NON-FOREIGN Faz 13 parite: toggle açık → converging'DEN BAĞIMSIZ otomatik (eski davranış birebir)", () => {
    expect(findingQueueAutoApply({ phase: 13, converging: false }, nonForeign(true))).toBe(true); // yakınsamasa bile
    expect(findingQueueAutoApply({ phase: 13, converging: true }, nonForeign(true))).toBe(true);
    expect(findingQueueAutoApply({ phase: 13, converging: false }, nonForeign(false))).toBe(false);
  });
  it("Faz 13 dışı → autoAnswerSuggested (kategori-bastırmalı), converging'e bakmaz", () => {
    expect(findingQueueAutoApply({ phase: 10, converging: false }, { autoAnswerEnabled: false, autoAnswerSuggested: true })).toBe(true);
    expect(findingQueueAutoApply({ phase: 8, converging: true }, { autoAnswerEnabled: true, autoAnswerSuggested: false })).toBe(false);
  });
});

describe("findingKey", () => {
  it("code_ref varsa file:startLine tercih edilir (kararlı)", () => {
    expect(findingKey(finding({ code_ref: { file: "src/a.ts", startLine: 42, endLine: 45, snippet: "" } }), 0)).toBe("src/a.ts:42");
  });

  it("code_ref yoksa summary_tr normalize (rakam→#, küçük harf, kısaltılmış)", () => {
    const k = findingKey(finding({ summary_tr: "SQL injection satır 42'de" }), 3);
    expect(k).toBe("sql injection satır #'de");
  });

  it("summary_tr boşsa → #index (son çare)", () => {
    expect(findingKey(finding({ summary_tr: "" }), 2)).toBe("#2");
  });

  it("aynı code_ref → aynı key (re-triage kararlılığı)", () => {
    const f1 = finding({ summary_tr: "farklı ifade A", code_ref: { file: "x.ts", startLine: 7, endLine: 7, snippet: "" } });
    const f2 = finding({ summary_tr: "farklı ifade B", code_ref: { file: "x.ts", startLine: 7, endLine: 7, snippet: "" } });
    expect(findingKey(f1, 0)).toBe(findingKey(f2, 1));
  });
});

describe("perFindingSig", () => {
  it("sig_base + key → benzersiz per-finding imza", () => {
    expect(perFindingSig("phase-13", "src/a.ts:42")).toBe("phase-13#src/a.ts:42");
  });

  it("farklı finding'ler farklı sig (izolasyon)", () => {
    const a = perFindingSig("phase-13", "src/a.ts:1");
    const b = perFindingSig("phase-13", "src/b.ts:2");
    expect(a).not.toBe(b);
  });
});

describe("advanceDecision", () => {
  it("sonraki finding varsa 'asked'", () => {
    expect(advanceDecision(queue([finding(), finding(), finding()], 0))).toBe("asked");
    expect(advanceDecision(queue([finding(), finding(), finding()], 1))).toBe("asked");
  });

  it("son finding'deyken 'exhausted'", () => {
    expect(advanceDecision(queue([finding(), finding(), finding()], 2))).toBe("exhausted");
  });

  it("tek finding → 'exhausted' (kuyruk zaten kurulmaz ama savunmacı)", () => {
    expect(advanceDecision(queue([finding()], 0))).toBe("exhausted");
  });
});
