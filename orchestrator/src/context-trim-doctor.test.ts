// context-trim-doctor — SAF testleri (ölçüm + LLM-çıktı parse + rapor render; yan etki yok, dosya/LLM'e dokunmaz).

import { describe, expect, it } from "vitest";
import {
  approxTokens,
  measureContextPieces,
  parseTrimCandidates,
  renderTrimReport,
  renderTrimChatSummary,
  buildTrimReviewPrompt,
  type TrimCandidate,
} from "./context-trim-doctor.js";

describe("approxTokens", () => {
  it("byte/4 yuvarlar", () => {
    expect(approxTokens(0)).toBe(0);
    expect(approxTokens(400)).toBe(100);
    expect(approxTokens(402)).toBe(101); // 100.5 → 101
  });
});

describe("measureContextPieces", () => {
  it("üç parça; statik prompt gömülü (editable=false), diğerleri düzenlenebilir", () => {
    const sizes = measureContextPieces({ staticPrompt: "abcd", commGuide: "ab", directives: "" });
    expect(sizes).toHaveLength(3);
    expect(sizes[0]!.editable).toBe(false); // statik prompt
    expect(sizes[1]!.editable).toBe(true); // müfettiş.md
    expect(sizes[2]!.editable).toBe(true); // directives
    expect(sizes[0]!.bytes).toBe(4);
    expect(sizes[0]!.approxTokens).toBe(1);
  });
  it("UTF-8 byte sayar (çok-baytlı karakter)", () => {
    const sizes = measureContextPieces({ staticPrompt: "ç", commGuide: "", directives: "" });
    expect(sizes[0]!.bytes).toBe(2); // 'ç' = 2 byte UTF-8
  });
});

describe("parseTrimCandidates", () => {
  it("```json bloğundan diziyi çıkarır + normalize eder", () => {
    const raw =
      'Öneriler:\n```json\n[{"piece":"§3 State Model","reason":"canlı state ile tekrar","est_tokens_saved":300,"confidence":"high"}]\n```';
    const c = parseTrimCandidates(raw);
    expect(c).toHaveLength(1);
    expect(c[0]!.piece).toBe("§3 State Model");
    expect(c[0]!.estTokensSaved).toBe(300);
    expect(c[0]!.confidence).toBe("high");
  });
  it("fence yoksa ham JSON dizisini bulur; piece/reason boş olanı atar", () => {
    const raw = '[{"piece":"A","reason":"r","est_tokens_saved":10,"confidence":"medium"},{"piece":"","reason":"x"}]';
    const c = parseTrimCandidates(raw);
    expect(c).toHaveLength(1);
    expect(c[0]!.piece).toBe("A");
  });
  it("geçersiz confidence → low; negatif/eksik token → 0", () => {
    const c = parseTrimCandidates('[{"piece":"A","reason":"r","est_tokens_saved":-5,"confidence":"garip"}]');
    expect(c[0]!.confidence).toBe("low");
    expect(c[0]!.estTokensSaved).toBe(0);
  });
  it("JSON yok / parse hatası → boş dizi (fail-safe)", () => {
    expect(parseTrimCandidates("hiç öneri yok")).toEqual([]);
    expect(parseTrimCandidates("```json\n{bozuk}\n```")).toEqual([]);
    expect(parseTrimCandidates("[]")).toEqual([]);
  });
});

describe("renderTrimReport / renderTrimChatSummary", () => {
  const sizes = measureContextPieces({ staticPrompt: "x".repeat(400), commGuide: "y".repeat(40), directives: "" });
  const cands: TrimCandidate[] = [
    { piece: "§3 State Model", reason: "tekrar", estTokensSaved: 300, confidence: "high" },
    { piece: "§13 Examples", reason: "türetilebilir", estTokensSaved: 700, confidence: "medium" },
  ];
  it("rapor NON-DESTRUCTIVE dilini + tasarruf toplamını + tokene-göre-sıralamayı içerir", () => {
    const r = renderTrimReport(sizes, cands);
    expect(r).toContain("otomatik uygulanmaz");
    expect(r).toContain("otomatik silinmedi");
    // §13 (700) §3'ten (300) önce (token azalan)
    expect(r.indexOf("§13 Examples")).toBeLessThan(r.indexOf("§3 State Model"));
  });
  it("aday yoksa rapor 'kesim önerisi bulunamadı' der", () => {
    const r = renderTrimReport(sizes, []);
    expect(r).toContain("bulunamadı");
  });
  it("chat özeti aday varken potansiyel tasarrufu, yokken 'çıkmadı'ı belirtir", () => {
    expect(renderTrimChatSummary(sizes, cands, ".mycl/x.md")).toContain("kesilebilir");
    expect(renderTrimChatSummary(sizes, [], ".mycl/x.md")).toContain("çıkmadı");
  });
  it("rapor yazılamadıysa (reportPath=null) chat özeti rapora YÖNLENDİRMEZ (KATI #4)", () => {
    const s = renderTrimChatSummary(sizes, cands, null);
    expect(s).not.toContain(".md");
    expect(s).not.toContain("Tam liste");
    expect(s).toContain("kesilebilir"); // öneri yine gösterilir
  });
});

describe("buildTrimReviewPrompt", () => {
  it("statik prompt'u içerir + canlı-enjekte tekrar-avı talimatı verir; yönerge boşsa o başlık atlanır", () => {
    const p = buildTrimReviewPrompt("STATIK-ICERIK", "");
    expect(p).toContain("STATIK-ICERIK");
    expect(p).toContain("CANLI");
    expect(p).not.toContain("KULLANICI YÖNERGELERİ");
    const p2 = buildTrimReviewPrompt("S", "yönerge var");
    expect(p2).toContain("KULLANICI YÖNERGELERİ");
  });
});
