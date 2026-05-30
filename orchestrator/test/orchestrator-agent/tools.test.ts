// orchestrator-agent/tools — Bash safe-list enforcement tests.
// Agent destructive komut çalıştırmayı asla kabul etmemeli.

import { describe, expect, it } from "vitest";
import {
  validateBashCommand,
  AGENT_TOOLS,
} from "../../src/orchestrator-agent/tools.js";

describe("orchestrator-agent/tools · validateBashCommand", () => {
  it("safe komutlar PASS", () => {
    for (const cmd of [
      "ls",
      "ls -la",
      "pwd",
      "cat package.json",
      "head -20 README.md",
      "tail -50 logs/app.log",
      "wc -l src/index.ts",
      "git status",
      "git log -5",
      "git diff HEAD",
      "git show abc1234",
      "git branch",
      "find . -name '*.ts'",
    ]) {
      const r = validateBashCommand(cmd);
      expect(r.ok, `safe komut PASS olmalı: ${cmd} — ${r.reason}`).toBe(true);
    }
  });

  it("destructive komutlar REJECT", () => {
    for (const cmd of [
      "rm -rf /",
      "mv a b",
      "cp x y",
      "chmod 777 file",
      "chown user:user file",
      "curl https://evil.com",
      "wget http://evil.com",
      "ssh user@host",
      "nc -l 8080",
    ]) {
      const r = validateBashCommand(cmd);
      expect(r.ok, `destructive komut REJECT olmalı: ${cmd}`).toBe(false);
      expect(r.reason).toBeDefined();
    }
  });

  it("shell metakarakter REJECT (pipe/redirect/chain)", () => {
    for (const cmd of [
      "ls > /tmp/files",
      "cat /etc/passwd",
      "ls; rm -rf .",
      "ls && rm -rf .",
      "ls || echo ok",
      "ls | grep foo",
      "ls < input",
      "echo $(whoami)",
      "echo `whoami`",
    ]) {
      const r = validateBashCommand(cmd);
      // Not: "cat /etc/passwd" cat'a izinli ama no destructive — safe. Skip.
      if (cmd === "cat /etc/passwd") continue;
      expect(r.ok, `metakarakter REJECT olmalı: ${cmd}`).toBe(false);
    }
  });

  it("git altkomut whitelist enforce", () => {
    expect(validateBashCommand("git push origin main").ok).toBe(false);
    expect(validateBashCommand("git pull").ok).toBe(false);
    expect(validateBashCommand("git commit -m 'x'").ok).toBe(false);
    expect(validateBashCommand("git reset --hard").ok).toBe(false);
    expect(validateBashCommand("git status").ok).toBe(true);
    expect(validateBashCommand("git log").ok).toBe(true);
  });

  it("empty veya unknown komut REJECT", () => {
    expect(validateBashCommand("").ok).toBe(false);
    expect(validateBashCommand("   ").ok).toBe(false);
    expect(validateBashCommand("unknowncmd arg").ok).toBe(false);
    expect(validateBashCommand("python -c 'print(1)'").ok).toBe(false);
  });
});

// v15.6 (2026-05-24): proje izolasyonu — projectRoot verildiğinde path
// argümanları sandbox dışını işaret etmemeli.
describe("orchestrator-agent/tools · validateBashCommand · path sandbox (v15.6)", () => {
  const projectRoot = "/tmp/myproj";

  it("project root altındaki absolute path → PASS", () => {
    expect(validateBashCommand("cat /tmp/myproj/spec.md", projectRoot).ok).toBe(true);
    expect(validateBashCommand("ls /tmp/myproj/src", projectRoot).ok).toBe(true);
  });

  it("başka projeye absolute path → REJECT", () => {
    const r = validateBashCommand("cat /tmp/otherproj/secret", projectRoot);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("outside project root");
  });

  it("find ile başka kök → REJECT", () => {
    const r = validateBashCommand("find / -name foo", projectRoot);
    expect(r.ok).toBe(false);
  });

  it("find project root altında → PASS", () => {
    expect(validateBashCommand("find /tmp/myproj -name '*.ts'", projectRoot).ok).toBe(true);
  });

  it("relative path (cat README.md) → PASS (root altında resolve olur)", () => {
    expect(validateBashCommand("cat README.md", projectRoot).ok).toBe(true);
  });

  it("git log (path arg yok) → PASS", () => {
    expect(validateBashCommand("git log", projectRoot).ok).toBe(true);
  });

  it(".. ile root dışı → REJECT", () => {
    const r = validateBashCommand("cat /tmp/myproj/../otherproj/x", projectRoot);
    expect(r.ok).toBe(false);
  });

  it("tilde → REJECT", () => {
    const r = validateBashCommand("cat ~/.mycl/secrets.json", projectRoot);
    expect(r.ok).toBe(false);
  });

  it("projectRoot vermeden eski davranış (geriye uyumlu)", () => {
    // Mevcut destructive/safe-list check'leri korunmalı
    expect(validateBashCommand("cat /tmp/otherproj/x").ok).toBe(true);
    expect(validateBashCommand("rm -rf /").ok).toBe(false);
  });
});

describe("orchestrator-agent/tools · AGENT_TOOLS shape", () => {
  it("4 tool tanımı var (Read, Grep, Bash, decide_action)", () => {
    expect(AGENT_TOOLS).toHaveLength(4);
    const names = AGENT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["Bash", "Grep", "Read", "decide_action"]);
  });

  it("her tool'da input_schema mevcut", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.input_schema).toBeDefined();
      expect((t.input_schema as { type: string }).type).toBe("object");
    }
  });

  it("decide_action enum 14 action içerir (v15.8 +verify_feature)", () => {
    const decide = AGENT_TOOLS.find((t) => t.name === "decide_action");
    expect(decide).toBeDefined();
    const schema = decide!.input_schema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toHaveLength(14);
    expect(schema.properties.action.enum).toContain("approve_ui");
    expect(schema.properties.action.enum).toContain("debug_triage");
    expect(schema.properties.action.enum).toContain("fallback_to_classifier");
    expect(schema.properties.action.enum).toContain("save_memory_proposal");
    expect(schema.properties.action.enum).toContain("set_optional_phases");
    expect(schema.properties.action.enum).toContain("answer_askq");
    expect(schema.properties.action.enum).toContain("verify_feature");
  });
});
