import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  wrapReadOnlyClaude,
} from "../src/claude-folder-guard.js";

describe("buildSeatbeltProfile", () => {
  it("allow default + korumalı klasörleri read-deny eder (home dahil)", () => {
    const p = buildSeatbeltProfile("/Users/x");
    expect(p).toContain("(allow default)");
    expect(p).toContain("(deny file-read*");
    for (const d of ["Downloads", "Documents", "Desktop", "Music", "Pictures", "Movies"]) {
      expect(p).toContain(`(subpath "/Users/x/${d}")`);
    }
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
