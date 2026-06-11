import { describe, expect, it, afterEach } from "vitest";
import { safeEnv } from "../src/safe-env.js";

describe("safeEnv sır-deseni dışlaması (Ümit tehlike-taraması: npm_config auth token sızıntısı)", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it("npm_config auth token (prefix eşleşse de) ajana GEÇMEZ", () => {
    process.env["npm_config_//registry.npmjs.org/:_authToken"] = "npm_SECRET";
    process.env["npm_config_registry"] = "https://registry.npmjs.org/"; // meşru — geçmeli
    const e = safeEnv();
    expect(e["npm_config_//registry.npmjs.org/:_authToken"]).toBeUndefined();
    expect(e["npm_config_registry"]).toBe("https://registry.npmjs.org/");
  });
  it("AWS/ANTHROPIC/genel sır anahtarları geçmez", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "x";
    process.env.ANTHROPIC_API_KEY = "y";
    process.env.GITHUB_TOKEN = "z";
    process.env.DB_PASSWORD = "p";
    const e = safeEnv();
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.GITHUB_TOKEN).toBeUndefined();
    expect(e.DB_PASSWORD).toBeUndefined();
  });
  it("meşru allowlist anahtarları (PATH/HOME/LANG) korunur", () => {
    const e = safeEnv();
    expect(e.PATH).toBeDefined();
  });
});
