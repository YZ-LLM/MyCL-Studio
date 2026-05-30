import { describe, expect, it } from "vitest";
import type { MyclConfig } from "../src/config.js";
import {
  classifyProjectType,
  shouldSkipUiPhases,
} from "../src/project-type-classifier.js";
import type { ProjectType } from "../src/types.js";

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
