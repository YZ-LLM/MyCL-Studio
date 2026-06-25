// onboard-existing — gap-raporu saf mantık testleri (heuristik + yapı).
// Tam runOnboarding (anlama + .mycl iskele + LLM living-docs) saha/canlı-koşuda doğrulanır
// (living-docs.test.ts deseni: saf mantık unit, IO/LLM yolu canlı).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { buildGapReport, onboardingSucceeded } from "../src/onboarding/onboard-existing.js";

describe("onboard-existing · buildGapReport", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-onboard-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("MyCL standartlarını listeler (6 eksen) + her birinde faz/dokunuş bilgisi", async () => {
    const gaps = await buildGapReport(root);
    expect(gaps.length).toBe(6);
    const standards = gaps.map((g) => g.standard);
    expect(standards.some((s) => s.includes("Test"))).toBe(true);
    expect(standards.some((s) => s.includes("Responsive"))).toBe(true);
    expect(standards.some((s) => s.includes("Güvenlik"))).toBe(true);
    // Her gap "hangi faz çözer" + "neye dokunur" alanı dolu olmalı (kullanıcı bilgilensin).
    for (const g of gaps) {
      expect(g.phase.length).toBeGreaterThan(0);
      expect(g.touches.length).toBeGreaterThan(0);
      expect(g.status.length).toBeGreaterThan(0);
    }
  });

  it("test altyapısı YOKSA → 'görünmüyor' ön-değerlendirmesi", async () => {
    const gaps = await buildGapReport(root);
    const test = gaps.find((g) => g.standard.includes("Test"))!;
    expect(test.status).toContain("görünmüyor");
  });

  it("test dizini VARSA → 'VAR' ön-değerlendirmesi (heuristik)", async () => {
    await mkdir(join(root, "test"), { recursive: true });
    const gaps = await buildGapReport(root);
    const test = gaps.find((g) => g.standard.includes("Test"))!;
    expect(test.status).toContain("VAR");
  });

  it("vitest.config.ts VARSA → test altyapısı 'VAR'", async () => {
    await writeFile(join(root, "vitest.config.ts"), "export default {}", "utf-8");
    const gaps = await buildGapReport(root);
    const test = gaps.find((g) => g.standard.includes("Test"))!;
    expect(test.status).toContain("VAR");
  });
});

describe("onboard-existing · onboardingSucceeded (BAŞARI işareti — cave5 fix)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-marker-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("işaret yokken → false (apology/no-access koşusu işaret bırakmaz → re-open yeniden dener)", async () => {
    expect(await onboardingSucceeded(root)).toBe(false);
    // Eski apology artefaktları (rapor/features.md) VAR olsa bile işaret yoksa false (yanlış kapı düzeltildi).
    await mkdir(join(root, ".mycl"), { recursive: true });
    await writeFile(join(root, ".mycl", "onboarding-report.md"), "# rapor", "utf-8");
    await writeFile(join(root, ".mycl", "features.md"), "# Features\n_No features could be documented_", "utf-8");
    expect(await onboardingSucceeded(root)).toBe(false);
  });

  it("başarı işareti (.mycl/onboarded.json) varken → true", async () => {
    await mkdir(join(root, ".mycl"), { recursive: true });
    await writeFile(join(root, ".mycl", "onboarded.json"), JSON.stringify({ at: 1, docs: "written" }), "utf-8");
    expect(await onboardingSucceeded(root)).toBe(true);
  });
});
