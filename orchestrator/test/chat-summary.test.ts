// chat-summary — 🧾 Özet butonu saf testleri (YZLLM 2026-07-19: "konuşmaları özetlesin,
// önemli yerleri atlamadan"). LLM koşumu CI'da yok — saf seçim/prompt fonksiyonları.
import { describe, expect, it } from "vitest";
import {
  buildChatSummaryPrompt,
  extractChatEntries,
  selectEntriesForSummary,
} from "../src/chat-summary.js";

describe("extractChatEntries", () => {
  it("yalnız chat_message + dolu metin; diğer event türleri elenir", () => {
    const out = extractChatEntries([
      { ts: 1, kind: "chat_message", data: { role: "user", text: "merhaba" } },
      { ts: 2, kind: "phase_changed", data: { phase: 3 } },
      { ts: 3, kind: "chat_message", data: { role: "system", text: "  " } },
      { ts: 4, kind: "chat_message", data: { role: "assistant", text: "selam" } },
      { ts: 5, kind: "chat_message", data: { text: "role yok" } },
    ]);
    expect(out).toEqual([
      { role: "user", text: "merhaba", ts: 1 },
      { role: "assistant", text: "selam", ts: 4 },
    ]);
  });
});

describe("selectEntriesForSummary", () => {
  it("bütçe yeterliyse hepsi seçilir, truncated=false", () => {
    const entries = [
      { role: "user", text: "a".repeat(50), ts: 1 },
      { role: "system", text: "b".repeat(50), ts: 2 },
    ];
    const r = selectEntriesForSummary(entries, 1000);
    expect(r.selected).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it("bütçe aşılınca EN YENİ mesajlar korunur + truncated=true (eskiler kırpılır)", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      role: "system",
      text: `mesaj-${i}-` + "x".repeat(100),
      ts: i,
    }));
    const r = selectEntriesForSummary(entries, 400);
    expect(r.truncated).toBe(true);
    expect(r.selected.length).toBeGreaterThan(0);
    expect(r.selected[r.selected.length - 1]!.text).toContain("mesaj-9"); // en yeni korunur
    expect(r.selected[0]!.text).not.toContain("mesaj-0"); // en eski kırpıldı
  });
});

describe("buildChatSummaryPrompt", () => {
  const entries = [
    { role: "user", text: "hatayı düzelt", ts: 1_700_000_000_000 },
    { role: "assistant", text: "düzeltildi", ts: 1_700_000_060_000 },
  ];

  it("sistem prompt'u başlıkları ve 'atlama' kuralını içerir; kullanıcı dökümü satır satır", () => {
    const { system, user } = buildChatSummaryPrompt(entries, false);
    expect(system).toContain("ÖNEMLİ HİÇBİR ŞEYİ ATLAMA");
    expect(system).toContain("## Yapılan işler");
    expect(system).toContain("## Bekleyen işler ve açık sorular");
    expect(user).toContain("user] hatayı düzelt");
    expect(user).toContain("assistant] düzeltildi");
    expect(user).not.toContain("EN YENİ kısım");
  });

  it("kırpılmışsa dökümün başına görünür not düşülür", () => {
    const { user } = buildChatSummaryPrompt(entries, true);
    expect(user).toContain("EN YENİ kısım");
  });
});
