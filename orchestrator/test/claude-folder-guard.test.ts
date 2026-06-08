import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  shouldFolderGuard,
  wrapReadOnlyClaude,
} from "../src/claude-folder-guard.js";

describe("buildSeatbeltProfile", () => {
  it("allow default + korumalı konumları read-deny eder (kişisel + diğer-uygulama-verisi)", () => {
    const p = buildSeatbeltProfile("/Users/x");
    expect(p).toContain("(allow default)");
    expect(p).toContain("(deny file-read*");
    for (const d of [
      "Downloads",
      "Documents",
      "Desktop",
      "Music",
      "Pictures",
      "Movies",
      "Library/Containers",
      "Library/Group Containers",
      "Library/Application Support",
      "Library/Mail",
      "Library/Calendars",
      "Library/Mobile Documents",
    ]) {
      expect(p).toContain(`(subpath "/Users/x/${d}")`);
    }
  });

  it("auth/config yollarını (~/.claude, ~/.mycl) REDDETMEZ", () => {
    const p = buildSeatbeltProfile("/Users/x");
    expect(p).not.toContain("/Users/x/.claude");
    expect(p).not.toContain("/Users/x/.mycl");
  });

  it("tccd mach-lookup'ı reddeder (framework-tabanlı TCC: Media/Photos pencereleri)", () => {
    const p = buildSeatbeltProfile("/Users/x");
    expect(p).toContain("deny mach-lookup");
    expect(p).toContain("tccd");
  });
});

describe("wrapReadOnlyClaude", () => {
  const bin = "/bin/claude";
  const args = ["-p", "hi"];

  it("darwin + enabled → sandbox-exec ile sarar, orijinal argümanlar sonda", () => {
    const r = wrapReadOnlyClaude(bin, args, {
      platform: "darwin",
      enabled: true,
      home: "/Users/x",
    });
    expect(r.cmd).toBe("/usr/bin/sandbox-exec");
    expect(r.args[0]).toBe("-p"); // sandbox-exec -p <profile>
    expect(r.args).toContain(bin);
    expect(r.args.slice(-2)).toEqual(args);
  });

  it("linux → no-op (TCC yok, sorun yok)", () => {
    const r = wrapReadOnlyClaude(bin, args, { platform: "linux", enabled: true });
    expect(r).toEqual({ cmd: bin, args });
  });

  it("disabled (flag=0) → no-op", () => {
    const r = wrapReadOnlyClaude(bin, args, { platform: "darwin", enabled: false });
    expect(r).toEqual({ cmd: bin, args });
  });
});

describe("shouldFolderGuard (hangi çağrı sarılır)", () => {
  it("tool yok → sar (read-only varsayılan)", () => {
    expect(shouldFolderGuard({})).toBe(true);
  });
  it("Bash'siz tool'lar (Read/Grep/Glob) → sar", () => {
    expect(shouldFolderGuard({ allowedTools: ["Read", "Grep", "Glob"] })).toBe(true);
  });
  it("Bash var → SARMA (nesting riski)", () => {
    expect(shouldFolderGuard({ allowedTools: ["Read", "Bash", "Edit"] })).toBe(false);
    expect(shouldFolderGuard({ allowedTools: ["Bash(rm *)"] })).toBe(false);
  });
  it("açık override her zaman kazanır", () => {
    expect(shouldFolderGuard({ allowedTools: ["Bash"], folderGuard: true })).toBe(true);
    expect(shouldFolderGuard({ folderGuard: false })).toBe(false);
  });
});
