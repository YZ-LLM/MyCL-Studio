import { beforeAll, describe, expect, it } from "vitest";
import { loadI18n, localizeOptionLabels, t, tFormat } from "../src/i18n.js";

describe("i18n", () => {
  beforeAll(async () => {
    await loadI18n();
  });

  it("resolves a TR key", () => {
    expect(t("askq.options.approve", "tr")).toBe("Onayla");
  });

  it("resolves an EN key", () => {
    expect(t("askq.options.approve", "en")).toBe("Approve");
  });

  it("falls back to EN when TR has the key but checks both branches", () => {
    expect(t("askq.options.cancel", "tr")).toBe("İptal");
    expect(t("askq.options.cancel", "en")).toBe("Cancel");
  });

  it("returns [?key] sentinel for missing keys", () => {
    expect(t("nope.not.here", "tr")).toBe("[?nope.not.here]");
  });

  it("resolves all 18 phase names in TR (Phase 0 + 1-17)", () => {
    for (let n = 0; n <= 17; n++) {
      const name = t(`phase.${n}.name`, "tr");
      expect(name).not.toMatch(/^\[\?/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("resolves all 18 phase names in EN (Phase 0 + 1-17)", () => {
    for (let n = 0; n <= 17; n++) {
      const name = t(`phase.${n}.name`, "en");
      expect(name).not.toMatch(/^\[\?/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("formats placeholders", () => {
    expect(
      tFormat("chat.system.phase_complete", "tr", { n: 4, name: "Spec Yazımı" }),
    ).toBe("Faz 4 tamamlandı — Spec Yazımı");
  });

  it("localizeOptionLabels maps Approve/Revise/Cancel to TR", () => {
    expect(localizeOptionLabels(["Approve", "Revise", "Cancel"], "tr")).toEqual([
      "Onayla",
      "Revize",
      "İptal",
    ]);
  });

  it("localizeOptionLabels falls back to original for unknown labels", () => {
    const result = localizeOptionLabels(["Approve", "Custom Option"], "tr");
    expect(result[0]).toBe("Onayla");
    expect(result[1]).toBe("Custom Option");
  });
});
