// codebase-memory-setup — flag gate + fallback testi (YZLLM 2026-07-13, Phase A). Opt-in dış bağımlılık:
// flag KAPALI → hiç bağlanmaz; flag AÇIK ama binary yok → null (grep fallback, KATI #4 sessiz-fallback değil).

import { describe, expect, it } from "vitest";
import {
  CODEBASE_MEMORY_PINNED_VERSION,
  resolveCodebaseMemoryBinary,
  resolveCodebaseMemoryMcpConfig,
} from "./codebase-memory-setup.js";
import { applyCodebaseMemoryArgs } from "./codegen/cli-backend.js";
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

describe("applyCodebaseMemoryArgs — hint MERGE, ayrı --append-system-prompt YOK (mahkeme CRITICAL 2026-07-13)", () => {
  it("cbmCfg null → faz systemPrompt DEĞİŞMEZ, mcpArgs boş (flag kapalı/binary yok → grep fallback)", () => {
    const r = applyCodebaseMemoryArgs("PHASE_RULES", null);
    expect(r.systemPrompt).toBe("PHASE_RULES");
    expect(r.mcpArgs).toEqual([]);
  });

  it("cbmCfg varsa: hint faz-prompt'una KATILIR (ikisi de KORUNUR) + mcpArgs --mcp-config+--strict", () => {
    const r = applyCodebaseMemoryArgs("PHASE_RULES", "/p/cfg.json");
    expect(r.systemPrompt).toContain("PHASE_RULES"); // faz talimatı KAYBOLMAZ
    expect(r.systemPrompt).toContain("codebase-memory MCP server"); // hint eklendi
    expect(r.mcpArgs).toEqual(["--mcp-config", "/p/cfg.json", "--strict-mcp-config"]);
  });

  it("KRİTİK REGRESYON: mcpArgs ASLA --append-system-prompt İÇERMEZ (Claude Code son-kazanır → faz talimatını ezerdi)", () => {
    const r = applyCodebaseMemoryArgs("PHASE_RULES", "/p/cfg.json");
    expect(r.mcpArgs).not.toContain("--append-system-prompt");
  });
});
