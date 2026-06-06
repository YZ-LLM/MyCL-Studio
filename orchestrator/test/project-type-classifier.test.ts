import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyclConfig } from "../src/config.js";
import {
  classifyProjectType,
  shouldSkipUiPhases,
} from "../src/project-type-classifier.js";
import type { ProjectType } from "../src/types.js";

// v15.10: abonelik modu text-JSON CLI sınıflandırma yolu için mock'lar.
const cliMock = vi.fn();
vi.mock("../src/cli-run.js", () => ({
  runClaudeCli: (...a: unknown[]) => cliMock(...a),
}));
let subscription = false;
vi.mock("../src/subscription-mode.js", () => ({
  isSubscriptionMode: () => subscription,
  noteSubscriptionSkipOnce: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("project-type-classifier", () => {
  it("classifyProjectType returns {project_type:'unknown'} for empty summary", async () => {
    // API çağrısı yapılmaz, kısa summary kısa-circuit.
    const fakeConfig = {
      api_keys: { main: "fake", translator: "fake" },
      selected_models: { translator: "claude-haiku-4-5" },
    } as unknown as MyclConfig;
    const r = await classifyProjectType(fakeConfig, "");
    expect(r.project_type).toBe("unknown");
    expect(r.has_database).toBeUndefined();
  });

  it("classifyProjectType returns 'unknown' for tiny summary (<5 chars)", async () => {
    const fakeConfig = {
      api_keys: { main: "fake", translator: "fake" },
      selected_models: { translator: "claude-haiku-4-5" },
    } as unknown as MyclConfig;
    const r = await classifyProjectType(fakeConfig, "ab");
    expect(r.project_type).toBe("unknown");
  });
});

// v15.10: abonelik modunda artık "unknown"a sessizce düşülmez — text-JSON CLI.
describe("classifyProjectType (abonelik / CLI text-JSON)", () => {
  const cfg = {
    api_keys: { main: "fake", translator: "fake" },
    selected_models: { translator: "claude-haiku-4-5" },
  } as unknown as MyclConfig;
  const SUMMARY = "Single-page product admin panel, vanilla TypeScript, localStorage.";

  beforeEach(() => {
    cliMock.mockReset();
    subscription = true;
  });

  it("geçerli JSON blok → sınıflandırma (CLI çağrıldı, skip YOK)", async () => {
    cliMock.mockResolvedValueOnce({
      ok: true,
      text: `Buyrun:\n{"kind":"project_type","project_type":"web","has_database":false}`,
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.project_type).toBe("web");
    expect(r.has_database).toBe(false);
    expect(cliMock).toHaveBeenCalledTimes(1);
  });

  it("CLI fail → unknown (fail-soft)", async () => {
    cliMock.mockResolvedValueOnce({ ok: false, text: "", toolUses: [], turns: 0, error: "x" });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.project_type).toBe("unknown");
  });

  it("blok yok → unknown (fail-soft)", async () => {
    cliMock.mockResolvedValueOnce({ ok: true, text: "düz metin, json yok", toolUses: [], turns: 1 });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.project_type).toBe("unknown");
  });

  it("geçersiz project_type değeri → unknown ama has_database korunur", async () => {
    cliMock.mockResolvedValueOnce({
      ok: true,
      text: `{"kind":"project_type","project_type":"banana","has_database":true}`,
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.project_type).toBe("unknown");
    expect(r.has_database).toBe(true);
  });

  it("ui_complexity geçerli → çıkarılır", async () => {
    cliMock.mockResolvedValueOnce({
      ok: true,
      text: `{"kind":"project_type","project_type":"web","has_database":false,"ui_complexity":"complex"}`,
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.ui_complexity).toBe("complex");
  });

  it("ui_complexity geçersiz değer → undefined (fail-soft; fan-out KOŞAR)", async () => {
    cliMock.mockResolvedValueOnce({
      ok: true,
      text: `{"kind":"project_type","project_type":"web","has_database":false,"ui_complexity":"super-hard"}`,
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.project_type).toBe("web");
    expect(r.ui_complexity).toBeUndefined();
  });

  it("ui_complexity eksik → undefined (geriye uyum)", async () => {
    cliMock.mockResolvedValueOnce({
      ok: true,
      text: `{"kind":"project_type","project_type":"web","has_database":false}`,
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(cfg, SUMMARY);
    expect(r.ui_complexity).toBeUndefined();
  });
});

describe("shouldSkipUiPhases", () => {
  it("returns true for library/cli/api/ml/game", () => {
    expect(shouldSkipUiPhases("library")).toBe(true);
    expect(shouldSkipUiPhases("cli")).toBe(true);
    expect(shouldSkipUiPhases("api")).toBe(true);
    expect(shouldSkipUiPhases("ml")).toBe(true);
    expect(shouldSkipUiPhases("game")).toBe(true);
  });

  it("returns false for web/mobile/desktop", () => {
    expect(shouldSkipUiPhases("web")).toBe(false);
    expect(shouldSkipUiPhases("mobile")).toBe(false);
    expect(shouldSkipUiPhases("desktop")).toBe(false);
  });

  it("returns false for unknown (pipeline default: don't skip)", () => {
    // unknown durumunda UI fazlarını çalıştır — kullanıcı override edebilir.
    expect(shouldSkipUiPhases("unknown")).toBe(false);
  });

  it("exhaustive — all ProjectType values handled", () => {
    const allTypes: ProjectType[] = [
      "web",
      "api",
      "cli",
      "library",
      "mobile",
      "desktop",
      "ml",
      "game",
      "unknown",
    ];
    // Her tip için fonksiyon çalışmalı (no throw)
    for (const t of allTypes) {
      expect(typeof shouldSkipUiPhases(t)).toBe("boolean");
    }
  });
});
