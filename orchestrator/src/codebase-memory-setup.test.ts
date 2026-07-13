// codebase-memory-setup — flag gate + fallback testi (YZLLM 2026-07-13, Phase A). Opt-in dış bağımlılık:
// flag KAPALI → hiç bağlanmaz; flag AÇIK ama binary yok → null (grep fallback, KATI #4 sessiz-fallback değil).

import { describe, expect, it } from "vitest";
import {
  CODEBASE_MEMORY_PINNED_VERSION,
  resolveCodebaseMemoryBinary,
  resolveCodebaseMemoryMcpConfig,
} from "./codebase-memory-setup.js";
import { applyMcpServerArgs } from "./codegen/cli-backend.js";
import type { MyclConfig } from "./config.js";

function cfg(on: boolean): MyclConfig {
  return { features: { codebase_memory_mcp: on } } as unknown as MyclConfig;
}

describe("codebase-memory-setup — flag gate + fallback (opt-in)", () => {
  it("flag KAPALI → null (--mcp-config EKLENMEZ; binary'ye bile bakmaz)", () => {
    expect(resolveCodebaseMemoryMcpConfig(cfg(false))).toBeNull();
  });

  it("flag AÇIK ama binary kurulu DEĞİLSE → null (grep fallback; görünür uyarı ensure'da verilir)", () => {
    // Kurulu olsa/olmasa ROBUST: yalnız 'binary yoksa config de null' değişmezini doğrula.
    const bin = resolveCodebaseMemoryBinary();
    const resolved = resolveCodebaseMemoryMcpConfig(cfg(true));
    if (!bin) expect(resolved).toBeNull();
    else expect(typeof resolved === "string" || resolved === null).toBe(true); // config yazılıysa yol, değilse null
  });

  it("pinli versiyon sabit + semver (supply-chain: denetlenebilir/tekrarlanabilir)", () => {
    expect(CODEBASE_MEMORY_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("applyMcpServerArgs — hint MERGE + TEK --mcp-config (mahkeme CRITICAL 2026-07-13)", () => {
  it("servers boş → faz systemPrompt DEĞİŞMEZ, mcpArgs boş (grep/hafıza fallback)", () => {
    const r = applyMcpServerArgs("PHASE_RULES", []);
    expect(r.systemPrompt).toBe("PHASE_RULES");
    expect(r.mcpArgs).toEqual([]);
  });

  it("tek server: hint faz-prompt'una KATILIR (faz talimatı KORUNUR) + mcpArgs tek --mcp-config+--strict", () => {
    const r = applyMcpServerArgs("PHASE_RULES", [{ configPath: "/p/cbm.json", hint: "HINT_CBM" }]);
    expect(r.systemPrompt).toContain("PHASE_RULES");
    expect(r.systemPrompt).toContain("HINT_CBM");
    expect(r.mcpArgs).toEqual(["--mcp-config", "/p/cbm.json", "--strict-mcp-config"]);
  });

  it("İKİ server (codebase-memory+cognee): HER İKİ config TEK --mcp-config altında (variadic, çift-bayrak YOK) + iki hint", () => {
    const r = applyMcpServerArgs("PHASE_RULES", [
      { configPath: "/p/cbm.json", hint: "HINT_CBM" },
      { configPath: "/p/cognee.json", hint: "HINT_COGNEE" },
    ]);
    expect(r.systemPrompt).toContain("HINT_CBM");
    expect(r.systemPrompt).toContain("HINT_COGNEE");
    expect(r.mcpArgs).toEqual(["--mcp-config", "/p/cbm.json", "/p/cognee.json", "--strict-mcp-config"]);
    expect(r.mcpArgs.filter((a) => a === "--mcp-config")).toHaveLength(1); // TEK bayrak (son-kazanır tuzağı yok)
  });

  it("KRİTİK REGRESYON: mcpArgs ASLA --append-system-prompt İÇERMEZ (Claude Code son-kazanır → faz talimatını ezerdi)", () => {
    const r = applyMcpServerArgs("PHASE_RULES", [{ configPath: "/p/a.json", hint: "H" }]);
    expect(r.mcpArgs).not.toContain("--append-system-prompt");
  });
});
