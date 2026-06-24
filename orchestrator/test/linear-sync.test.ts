// linear-sync — gating + saf markdown testleri. Ağ çağrısı (mirrorVerdictToLinear) saha-doğrulamada.
// EN KRİTİK: default KAPALI — flag yokken VEYA key yokken asla aktif olmamalı.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVerdictMarkdown, buildVerdictTitle, isLinearSyncEnabled } from "../src/linear-sync.js";
import type { MyclConfig } from "../src/config.js";
import type { HarnessVerdict } from "../src/harness-verdict.js";
import type { State } from "../src/types.js";

const cfg = (over: Record<string, unknown> = {}): MyclConfig =>
  ({ features: { ...over } } as unknown as MyclConfig);

const state = { intent_summary: "add login", project_root: "/x" } as unknown as State;
const verdict: HarnessVerdict = {
  verdict: "PARTIAL",
  completed: true,
  gateFailures: [{ phase: 11, event: "simplify-fail" }],
  securitySkipped: ["semgrep-skipped"],
  exitCode: 2,
  summary: "1 gate failed",
};

describe("isLinearSyncEnabled (default KAPALI)", () => {
  const orig = process.env.LINEAR_API_KEY;
  beforeEach(() => { delete process.env.LINEAR_API_KEY; });
  afterEach(() => { if (orig === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = orig; });

  it("flag yok → kapalı (key olsa bile)", () => {
    process.env.LINEAR_API_KEY = "lin_abc";
    expect(isLinearSyncEnabled(cfg())).toBe(false);
    expect(isLinearSyncEnabled(cfg({ linear_sync_enabled: false }))).toBe(false);
  });

  it("flag açık ama key yok → kapalı (sessiz, gürültüsüz)", () => {
    expect(isLinearSyncEnabled(cfg({ linear_sync_enabled: true }))).toBe(false);
  });

  it("flag açık ama key boş string → kapalı", () => {
    process.env.LINEAR_API_KEY = "   ";
    expect(isLinearSyncEnabled(cfg({ linear_sync_enabled: true }))).toBe(false);
  });

  it("flag açık + key dolu → AÇIK", () => {
    process.env.LINEAR_API_KEY = "lin_abc";
    expect(isLinearSyncEnabled(cfg({ linear_sync_enabled: true }))).toBe(true);
  });
});

describe("buildVerdictMarkdown / Title", () => {
  it("verdict + gate fail + güvenlik-skip + 'yerel kaynak' notu içerir", () => {
    const md = buildVerdictMarkdown(state, verdict);
    expect(md).toContain("verdict: PARTIAL");
    expect(md).toContain("Phase 11 (simplify-fail)");
    expect(md).toContain("semgrep-skipped");
    expect(md).toContain("Source of record: local"); // Linear ayna, kaynak DEĞİL
  });

  it("başlık verdict + intent taşır", () => {
    expect(buildVerdictTitle(state, verdict)).toBe("MyCL PARTIAL: add login");
  });

  it("intent yoksa 'iteration' fallback", () => {
    const t = buildVerdictTitle({ project_root: "/x" } as unknown as State, verdict);
    expect(t).toBe("MyCL PARTIAL: iteration");
  });
});
