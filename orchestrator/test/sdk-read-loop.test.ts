// sdk-read-loop — ortak salt okunur araç döngüsü (API/SDK yolu).
//
// NEDEN (2026-08-03): kullanım kılavuzu API modunda HİÇ üretilmiyordu ("yalnız CLI/abonelik" deyip
// dönüyordu) → kullanıcı API modundaysa "kılavuz her zaman güncel" sözü sessizce tutulmuyordu.
// Müfettişin zaten çalışan SDK döngüsü ortak modüle çıkarıldı; bu testler hem yeni yolu hem de
// müfettişin davranışının BİREBİR korunduğunu kilitler.

import { describe, expect, it, vi, beforeEach } from "vitest";

const runTurnMock = vi.fn();
const executeToolMock = vi.fn();

vi.mock("../src/claude-api.js", () => ({
  runTurn: (...a: unknown[]) => runTurnMock(...a),
}));
vi.mock("../src/tool-handlers.js", () => ({
  executeTool: (...a: unknown[]) => executeToolMock(...a),
  TOOLS_CODEGEN: [
    { name: "Read", description: "", input_schema: {} },
    { name: "Grep", description: "", input_schema: {} },
    { name: "Glob", description: "", input_schema: {} },
    { name: "Bash", description: "", input_schema: {} },
    { name: "Write", description: "", input_schema: {} },
  ],
}));

const { runReadOnlySdkLoop, selectTools, extractSdkText } = await import("../src/sdk-read-loop.js");

const cfg = {} as never;
const base = {
  systemPrompt: "sys",
  userMessage: "user",
  projectRoot: "/proj",
  modelId: "m",
  maxTurns: 5,
  toolResultCap: 100,
  tag: "test",
};

beforeEach(() => {
  runTurnMock.mockReset();
  executeToolMock.mockReset();
});

describe("selectTools", () => {
  it("yalnız istenen araçları verir — istenmeyen (Write) SIZMAZ", () => {
    const { tools, unknown } = selectTools(["Read", "Grep", "Glob"]);
    expect(tools.map((t) => (t as { name: string }).name)).toEqual(["Read", "Grep", "Glob"]);
    expect(unknown).toEqual([]);
  });
  it("bilinmeyen araç adı sessizce yutulmaz (görünür şekilde bildirilir)", () => {
    const { tools, unknown } = selectTools(["Read", "Uydurma"]);
    expect(tools).toHaveLength(1);
    expect(unknown).toEqual(["Uydurma"]);
  });
});

describe("extractSdkText", () => {
  it("yalnız metin bloklarını birleştirir", () => {
    expect(
      extractSdkText([
        { type: "text", text: "a" },
        { type: "tool_use", id: "1", name: "Read", input: {} },
        { type: "text", text: "b" },
      ] as never),
    ).toBe("ab");
  });
});

describe("runReadOnlySdkLoop", () => {
  it("model araç istemezse metni döndürür", async () => {
    runTurnMock.mockResolvedValue({
      assistantContent: [{ type: "text", text: "sonuç" }],
      toolUses: [],
      stop_reason: "end_turn",
    });
    const r = await runReadOnlySdkLoop(cfg, "key", { ...base, toolNames: ["Read"] });
    expect(r).toEqual({ ok: true, text: "sonuç" });
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("araç çağrısını çalıştırıp sonucu modele geri verir; çıktı kırpılır", async () => {
    runTurnMock
      .mockResolvedValueOnce({
        assistantContent: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }],
        toolUses: [{ id: "t1", name: "Read", input: { file_path: "a.ts" } }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        assistantContent: [{ type: "text", text: "bitti" }],
        toolUses: [],
        stop_reason: "end_turn",
      });
    executeToolMock.mockResolvedValue({ content: "x".repeat(500), is_error: false });
    const seen: string[] = [];
    const r = await runReadOnlySdkLoop(cfg, "key", {
      ...base,
      toolNames: ["Read"],
      observer: (tu) => seen.push(tu.name),
      onText: () => {},
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["Read"]);
    // NOT: messages dizisi yerinde büyütülüyor → "son mesaj" yerine tool_result taşıyan mesajı ara.
    const call = runTurnMock.mock.calls[1]?.[2] as { messages: { role: string; content: unknown }[] };
    const blocks = call.messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string; content?: string }>) : []))
      .filter((b) => b.type === "tool_result");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toHaveLength(base.toolResultCap); // kırpma uygulandı
  });

  it("araç hatası döngüyü ÇÖKERTMEZ, hata sonucu modele bildirilir", async () => {
    runTurnMock
      .mockResolvedValueOnce({
        assistantContent: [],
        toolUses: [{ id: "t1", name: "Read", input: {} }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({ assistantContent: [{ type: "text", text: "ok" }], toolUses: [], stop_reason: "end_turn" });
    executeToolMock.mockRejectedValue(new Error("izin yok"));
    const r = await runReadOnlySdkLoop(cfg, "key", { ...base, toolNames: ["Read"] });
    expect(r.ok).toBe(true);
  });

  it("FAIL-CLOSED: sağlayıcı hatası → ok:false (sessiz 'başarılı' yok)", async () => {
    runTurnMock.mockRejectedValue(new Error("429"));
    const r = await runReadOnlySdkLoop(cfg, "key", { ...base, toolNames: ["Read"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("429");
  });

  it("FAIL-CLOSED: tur tavanı aşılır ve hiç metin yoksa → ok:false", async () => {
    runTurnMock.mockResolvedValue({
      assistantContent: [],
      toolUses: [{ id: "t", name: "Read", input: {} }],
      stop_reason: "tool_use",
    });
    executeToolMock.mockResolvedValue({ content: "c", is_error: false });
    const r = await runReadOnlySdkLoop(cfg, "key", { ...base, toolNames: ["Read"], maxTurns: 2 });
    expect(r.ok).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });

  it("MÜFETTİŞ PARİTESİ: verilen araç seti runTurn'e aynen geçer (Write asla eklenmez)", async () => {
    runTurnMock.mockResolvedValue({ assistantContent: [{ type: "text", text: "v" }], toolUses: [], stop_reason: "end_turn" });
    await runReadOnlySdkLoop(cfg, "key", { ...base, toolNames: ["Read", "Grep", "Glob", "Bash"] });
    const arg = runTurnMock.mock.calls[0]?.[2] as { tools: { name: string }[]; max_tokens: number };
    expect(arg.tools.map((t) => t.name)).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(arg.tools.some((t) => t.name === "Write")).toBe(false);
  });
});
