// describeStep — heartbeat'in "şu anki adım" metni. Ümit 2026-06-12: basit "çalışıyor" değil, modelin
// SON YAPTIĞI/üzerinde çalıştığı somut adım (tool_use → "X yazılıyor / npm test çalıştırılıyor"). text=reasoning atlanır.

import { describe, expect, it } from "vitest";
import { describeStep } from "../src/ipc.js";

describe("ipc · describeStep (heartbeat adım metni)", () => {
  it("Bash → komut çalıştırılıyor (boşluk daraltılır, kırpılır)", () => {
    expect(describeStep({ sub: "tool_use", tool_name: "Bash", tool_input: { command: "npm test" } })).toBe(
      "`npm test` çalıştırılıyor",
    );
  });

  it("Write/Edit/Read → dosya adımı (yol kısaltılır)", () => {
    expect(
      describeStep({ sub: "tool_use", tool_name: "Write", tool_input: { file_path: "backend/src/utils/sanitize.js" } }),
    ).toBe("`…/utils/sanitize.js` yazılıyor");
    expect(
      describeStep({ sub: "tool_use", tool_name: "Edit", tool_input: { file_path: "backend/src/index.js" } }),
    ).toBe("`…/src/index.js` düzenleniyor");
    expect(describeStep({ sub: "tool_use", tool_name: "Read", tool_input: { file_path: "a.js" } })).toBe(
      "`a.js` okunuyor",
    );
  });

  it("Glob/Grep → arama; bilinmeyen tool → generic", () => {
    expect(describeStep({ sub: "tool_use", tool_name: "Grep", tool_input: { pattern: "TODO" } })).toBe(
      "`TODO` aranıyor",
    );
    expect(describeStep({ sub: "tool_use", tool_name: "WeirdTool" })).toBe("WeirdTool aracı kullanılıyor");
  });

  it("text/non-tool_use → null (reasoning gürültüsü adım sayılmaz)", () => {
    expect(describeStep({ sub: "text" })).toBeNull();
    expect(describeStep({ sub: "init" })).toBeNull();
    expect(describeStep({ sub: "tool_use" })).toBeNull(); // tool_name yok
  });
});
