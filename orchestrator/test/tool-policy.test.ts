// tool-policy — tehlikeli-Bash deny baseline'ının HER ZAMAN korunduğu güvenlik garantisi.
// YZLLM canlı-test 0620: CLI çağrıları bypassPermissions'a geçti (Bash izin-prompt hang'i);
// bu test rm/sudo/git-push'ın deny-list'ten DÜŞMEDİĞİNİ kanıtlar (bypassPermissions güvenli).

import { describe, expect, it } from "vitest";
import {
  DANGEROUS_BASH_DENY,
  withDangerousBashDeny,
  READ_ONLY_DISALLOWED_TOOLS,
  PURE_REASONING_DISALLOWED_TOOLS,
  ZERO_TOOLS_DISALLOWED,
  effectiveDisallowedTools,
} from "../src/tool-policy.js";

describe("withDangerousBashDeny (bypassPermissions güvenlik baseline'ı)", () => {
  it("undefined deny-list → yalnız tehlikeli-Bash baseline", () => {
    expect(withDangerousBashDeny(undefined)).toEqual(DANGEROUS_BASH_DENY);
  });

  it("READ_ONLY (rm-deny YOK) + baseline → rm/sudo/git-push artık bloklu", () => {
    const merged = withDangerousBashDeny(READ_ONLY_DISALLOWED_TOOLS);
    expect(merged).toContain("Bash(rm *)");
    expect(merged).toContain("Bash(sudo *)");
    expect(merged).toContain("Bash(git push *)");
    // salt-okunur yazma yasağı da korunur
    expect(merged).toContain("Write");
    expect(merged).toContain("Edit");
  });

  it("dedup: baseline zaten varsa tekrar etmez", () => {
    const merged = withDangerousBashDeny(["Bash(rm *)", "Write"]);
    expect(merged.filter((t) => t === "Bash(rm *)").length).toBe(1);
  });

  it("saf-akıl (Bash tümden yasak) + baseline → Bash hâlâ var, baseline zararsız-fazlalık", () => {
    const merged = withDangerousBashDeny(PURE_REASONING_DISALLOWED_TOOLS);
    expect(merged).toContain("Bash");
    expect(merged).toContain("Bash(rm *)");
  });
});

// 2026-11-27 (ekransız deneme koşusu 6): politika vermeyen yardımcı çağrı tam yetkiyle koşup
// MyCL'in başlatıldığı klasöre dosya yazdı. Verilmeyen politika artık "araçsız" demektir.
describe("effectiveDisallowedTools (verilmeyen politika = araçsız)", () => {
  it("undefined → sıfır araç listesi + tehlikeli Bash tabanı", () => {
    const eff = effectiveDisallowedTools(undefined);
    expect(eff).toEqual(withDangerousBashDeny(ZERO_TOOLS_DISALLOWED));
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "Task", "Read", "Grep", "Glob"]) {
      expect(eff).toContain(tool);
    }
  });

  it("verilen liste aynen uygulanır (genişlemez): eski davranışla birebir", () => {
    for (const policy of [READ_ONLY_DISALLOWED_TOOLS, PURE_REASONING_DISALLOWED_TOOLS, ["Bash", "Agent", "Task"]]) {
      expect(effectiveDisallowedTools(policy)).toEqual(withDangerousBashDeny(policy));
    }
    expect(effectiveDisallowedTools(READ_ONLY_DISALLOWED_TOOLS)).not.toContain("Bash");
  });

  it("açıkça verilen boş liste çağıranın kararıdır: yalnız taban", () => {
    expect(effectiveDisallowedTools([])).toEqual(DANGEROUS_BASH_DENY);
  });

  it("kod üretim yolunun sabiti değişmedi: withDangerousBashDeny(undefined) yalnız tabandır", () => {
    expect(withDangerousBashDeny(undefined)).toEqual(DANGEROUS_BASH_DENY);
  });
});
