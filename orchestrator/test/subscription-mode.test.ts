// subscription-mode — saf abonelik tespiti + yan-çağrı atlama (API'ye sokmadan).

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MyclConfig } from "../src/config.js";

// vi.hoisted: spy'lar, hoisted vi.mock factory'sinden ÖNCE init edilmeli.
const { createSpy, runCliSpy } = vi.hoisted(() => ({ createSpy: vi.fn(), runCliSpy: vi.fn() }));

vi.mock("../src/ipc.js", () => ({ emitChatMessage: vi.fn() }));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createSpy };
    constructor(_o: unknown) {}
  },
}));
// v15.10: abonelik modu CLI ile sınıflandırır (runClaudeCli). Birim testte GERÇEK
// `claude` spawn'ı YAPMA — mock'la (yoksa 5sn timeout → flaky).
vi.mock("../src/cli-run.js", () => ({ runClaudeCli: runCliSpy }));

import { isSubscriptionMode } from "../src/subscription-mode.js";
import { classifyProjectType } from "../src/project-type-classifier.js";

function cfg(o: string, t: string, m: string): MyclConfig {
  return {
    selected_models: { translator: "x", main: "x" },
    api_keys: { translator: "k", main: "k" },
    agent_backends: { orchestrator: o, translator: t, main: m },
  } as unknown as MyclConfig;
}

beforeEach(() => {
  createSpy.mockReset();
  runCliSpy.mockReset();
});

describe("isSubscriptionMode", () => {
  it("üç rol de cli → true", () => {
    expect(isSubscriptionMode(cfg("cli", "cli", "cli"))).toBe(true);
  });
  it("biri bile api → false", () => {
    expect(isSubscriptionMode(cfg("cli", "api", "cli"))).toBe(false);
    expect(isSubscriptionMode(cfg("api", "api", "api"))).toBe(false);
  });
});

describe("classifyProjectType — abonelik modu", () => {
  it("abonelik modunda CLI (text-JSON) ile sınıflandırır — SDK'ya SOKMADAN", async () => {
    runCliSpy.mockResolvedValue({
      ok: true,
      text: `{"kind":"project_type","project_type":"web","has_database":true}`,
      toolUses: [],
      turns: 1,
    });
    const res = await classifyProjectType(
      cfg("cli", "cli", "cli"),
      "A reasonably long summary about a web app with users.",
    );
    expect(res.project_type).toBe("web"); // CLI sonucu kullanıldı
    expect(runCliSpy).toHaveBeenCalledTimes(1); // CLI yolu (abonelik)
    expect(createSpy).not.toHaveBeenCalled(); // SDK'ya SOKULMADI
  });

  it("abonelik: CLI fail-soft → unknown (takılma/throw YOK)", async () => {
    runCliSpy.mockResolvedValue({ ok: false, error: "boom", text: "", toolUses: [], turns: 0 });
    const res = await classifyProjectType(cfg("cli", "cli", "cli"), "summary");
    expect(res.project_type).toBe("unknown");
    expect(createSpy).not.toHaveBeenCalled();
  });
});
