// codegen-controller — repairDanglingToolUse unit testleri (v15.7, 2026-05-25).
//
// Resume edilen history'de "tool_use'a karşılık tool_result yok" durumu
// Anthropic API 400'ünü tetikler. Repair fonksiyonu synthetic "interrupted"
// tool_result stub'ları enjekte ederek history'yi geçerli hale getirir.

import { describe, expect, it } from "vitest";
import type { ApiMessage } from "../../src/claude-api.js";
import { repairDanglingToolUse } from "../../src/base/codegen-controller.js";

describe("repairDanglingToolUse", () => {
  it("boş history → değişmez", () => {
    expect(repairDanglingToolUse([])).toEqual([]);
  });

  it("text-only conversation → değişmez", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "merhaba" },
      { role: "assistant", content: "selam" },
    ];
    const out = repairDanglingToolUse(history);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(history[0]);
    expect(out[1]).toEqual(history[1]);
  });

  it("tool_use + matching tool_result → değişmez", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "Read foo.ts" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_01", name: "Read", input: { path: "foo.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_01",
            content: "file content",
          },
        ],
      },
    ];
    const out = repairDanglingToolUse(history);
    expect(out).toHaveLength(3);
  });

  it("dangling tool_use (sonraki user yok) → synthetic user mesajı eklenir", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "Write foo.ts" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_X", name: "Write", input: { path: "foo.ts" } },
        ],
      },
    ];
    const out = repairDanglingToolUse(history);
    expect(out).toHaveLength(3);
    const lastMsg = out[2] as ApiMessage;
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const block = (lastMsg.content as unknown as Array<Record<string, unknown>>)[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.tool_use_id).toBe("tool_X");
    expect(block?.is_error).toBe(true);
    expect(String(block?.content)).toContain("interrupted");
  });

  it("dangling tool_use (sonraki user TEXT) → user'ın content array yapısına stub eklenir", () => {
    // Edge: sonraki user mesajı text ama tool_use'a karşılık tool_result yok.
    // Bu durumda content array değil string olduğu için Anthropic format'ı bozuk.
    // Repair: text'i koru, eksik tool_result eklenmeli. Şu an content array
    // değilse mesajdan sonra ek synthetic user mesajı eklenir.
    const history: ApiMessage[] = [
      { role: "user", content: "Read foo" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_Y", name: "Read", input: { path: "foo" } },
        ],
      },
      { role: "user", content: "yardım et" }, // text user — array değil
    ];
    const out = repairDanglingToolUse(history);
    expect(out.length).toBeGreaterThanOrEqual(4);
    // Synthetic tool_result mesajı assistant'tan SONRA (index 2) olmalı
    const syntheticIdx = out.findIndex(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as unknown as Array<Record<string, unknown>>)[0]?.type === "tool_result",
    );
    expect(syntheticIdx).toBeGreaterThanOrEqual(0);
  });

  it("kısmen fulfilled tool_use'lar (2 use, 1 result) → eksik olan eklenir", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "iki tool kullan" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool_A", name: "Read", input: {} },
          { type: "tool_use", id: "tool_B", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_A", content: "ok" },
          // tool_B eksik!
        ],
      },
    ];
    const out = repairDanglingToolUse(history);
    expect(out).toHaveLength(3);
    const userMsg = out[2]!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const blocks = userMsg.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    const ids = blocks.map((b) => b.tool_use_id);
    expect(ids).toContain("tool_A");
    expect(ids).toContain("tool_B");
    // tool_B synthetic olduğu için is_error=true
    const bBlock = blocks.find((b) => b.tool_use_id === "tool_B");
    expect(bBlock?.is_error).toBe(true);
  });

  it("birden fazla turn — sadece son dangling olan repair edilir", () => {
    const history: ApiMessage[] = [
      { role: "user", content: "iş1" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t2", name: "Write", input: {} },
        ],
      },
      // t2 dangling — sonraki user yok
    ];
    const out = repairDanglingToolUse(history);
    expect(out.length).toBeGreaterThanOrEqual(5);
    const last = out[out.length - 1]!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    expect(
      (last.content as unknown as Array<Record<string, unknown>>)[0]?.tool_use_id,
    ).toBe("t2");
  });
});
