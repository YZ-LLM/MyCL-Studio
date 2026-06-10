import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeEnv } from "../src/safe-env.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  // Mevcut env'i temizle, sadece testin set ettikleri kalsın.
  for (const k of Object.keys(process.env)) delete process.env[k];
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe("safeEnv", () => {
  it("forwards PATH, HOME, USER", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/Users/x";
    process.env.USER = "x";
    const env = safeEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.USER).toBe("x");
  });

  it("forwards LC_* via prefix allowlist", () => {
    process.env.LC_ALL = "C";
    process.env.LC_CTYPE = "UTF-8";
    const env = safeEnv();
    expect(env.LC_ALL).toBe("C");
    expect(env.LC_CTYPE).toBe("UTF-8");
  });

  it("forwards npm_* via prefix allowlist", () => {
    process.env.npm_config_loglevel = "warn";
    expect(safeEnv().npm_config_loglevel).toBe("warn");
  });

  it("BLOCKS ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    expect(safeEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("BLOCKS OPENAI_API_KEY, AWS_*, GH_TOKEN, GITHUB_TOKEN", () => {
    process.env.OPENAI_API_KEY = "sk-x";
    process.env.AWS_ACCESS_KEY_ID = "AKIA";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.GH_TOKEN = "ghp_x";
    process.env.GITHUB_TOKEN = "gh_x";
    const env = safeEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("forwards Node version manager env (NVM_DIR, FNM_DIR, etc.)", () => {
    process.env.NVM_DIR = "/Users/x/.nvm";
    process.env.NVM_BIN = "/Users/x/.nvm/versions/node/v20/bin";
    process.env.FNM_DIR = "/Users/x/.fnm";
    process.env.NODENV_ROOT = "/Users/x/.nodenv";
    process.env.ASDF_DIR = "/Users/x/.asdf";
    process.env.VOLTA_HOME = "/Users/x/.volta";
    const env = safeEnv();
    expect(env.NVM_DIR).toBe("/Users/x/.nvm");
    expect(env.NVM_BIN).toBe("/Users/x/.nvm/versions/node/v20/bin");
    expect(env.FNM_DIR).toBe("/Users/x/.fnm");
    expect(env.NODENV_ROOT).toBe("/Users/x/.nodenv");
    expect(env.ASDF_DIR).toBe("/Users/x/.asdf");
    expect(env.VOLTA_HOME).toBe("/Users/x/.volta");
  });

  it("BLOCKS unknown custom keys (e.g., MY_SECRET)", () => {
    process.env.MY_SECRET = "x";
    process.env.SOME_TOKEN = "y";
    const env = safeEnv();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  it("does not pass empty/undefined values", () => {
    process.env.PATH = "";
    const env = safeEnv();
    // PATH boş string ama bilinen anahtar — geçer (caller'ın işi)
    expect(env.PATH).toBe("");
  });
});

// E2BIG öz-iyileştirme (2026-06-10): şişmiş PATH dedupe + devasa değişken düşürme.
describe("E2BIG öz-iyileştirme (dedupePathValue + trimOversizedEnv)", () => {
  it("PATH'teki tekrar eden segmentler kayıpsız atılır (sıra korunur)", async () => {
    const { dedupePathValue } = await import("../src/safe-env.js");
    expect(dedupePathValue("/a:/b:/a:/c:/b:/a")).toBe("/a:/b:/c");
    expect(dedupePathValue("")).toBe("");
  });

  it("birikmiş (şişmiş) PATH safeEnv'den küçülerek çıkar — E2BIG önlenir", () => {
    // Her oturumda uzayan PATH senaryosu: aynı 3 dizin binlerce kez.
    process.env.PATH = Array(5000).fill("/usr/bin:/opt/x:/Users/u/.local/bin").join(":");
    const out = safeEnv();
    expect(out.PATH).toBe("/usr/bin:/opt/x:/Users/u/.local/bin");
  });

  it("dedupe'a rağmen devasa kalan değişken alt sürece AKTARILMAZ", async () => {
    const { MAX_ENV_VAR_BYTES } = await import("../src/safe-env.js");
    process.env.PATH = "/usr/bin";
    process.env.NODE_OPTIONS = "x".repeat(MAX_ENV_VAR_BYTES + 1); // allowlist'te ama devasa
    const out = safeEnv();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.NODE_OPTIONS).toBeUndefined();
  });
});
