// ipc — withClaudeStreamBanner testi (YZLLM 2026-07-13; canlı cave5 bug: EDD init yayıp stop yaymadan bitince
// "🤖 Model çalışıyor" banner'ı 17dk BAYAT kaldı — model gerçekte boştaydı). Helper init→stop yaşam döngüsünü
// TEK primitifte sahiplenir → finally'de stop GARANTİ → sızıntı yapısal imkansız.

import { afterEach, describe, expect, it, vi } from "vitest";
import { withClaudeStreamBanner } from "./ipc.js";

/** process.stdout.write'ı yakalayıp emit edilen claude_stream event'lerini toplar. */
function captureStream(): { events: Array<{ sub: string; [k: string]: unknown }> } {
  const events: Array<{ sub: string; [k: string]: unknown }> = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    try {
      const obj = JSON.parse(String(chunk).trim()) as { kind?: string; data?: { sub: string } };
      if (obj.kind === "claude_stream" && obj.data) events.push(obj.data);
    } catch {
      // JSON olmayan (log) satırları atla
    }
    return true;
  }) as typeof process.stdout.write);
  return { events };
}

describe("withClaudeStreamBanner — init→stop yaşam döngüsü (banner sızıntısı fix)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("başarıda: init yayılır, sonuç döner, stop SONRA yayılır (finally)", async () => {
    const { events } = captureStream();
    const order: string[] = [];
    const result = await withClaudeStreamBanner({ text: "test", model: "m" }, async () => {
      order.push("fn");
      return 42;
    });
    expect(result).toBe(42);
    const subs = events.map((e) => e.sub);
    expect(subs).toContain("init");
    expect(subs).toContain("stop");
    expect(subs.indexOf("init")).toBeLessThan(subs.indexOf("stop")); // init ÖNCE, stop SONRA
    expect(order).toEqual(["fn"]);
  });

  it("THROW'da: stop YİNE yayılır (finally) + hata propagate → banner ASLA bayat kalmaz", async () => {
    const { events } = captureStream();
    await expect(
      withClaudeStreamBanner({ text: "test", model: "m" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const subs = events.map((e) => e.sub);
    expect(subs).toContain("init");
    expect(subs).toContain("stop"); // KRİTİK: throw'da bile stop → temizlenir (canlı bug'ın panzehiri)
  });

  it("init doğru text/model/cwd taşır (UI banner + Ajan Takımı korunur)", async () => {
    const { events } = captureStream();
    await withClaudeStreamBanner({ text: "edd-analyze", model: "glm-x", cwd: "/p" }, async () => 1);
    const init = events.find((e) => e.sub === "init");
    expect(init?.text).toBe("edd-analyze");
    expect(init?.model).toBe("glm-x");
    expect(init?.cwd).toBe("/p");
  });
});
