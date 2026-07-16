// file-classify — tek kaynak dosya sınıflandırma testleri.
// Eski üç kopyanın (phase-8 PROD_EXT, fix/evidence SOURCE_EXTS, tech-debt-scanner
// isTestPath) birleşiminin KASITLI deltalarını pinler + isRuntimeProdFile matrisi.
import { describe, expect, it } from "vitest";
import {
  hasSourceExt,
  isTestPath,
  isProdPath,
  isCosmeticFile,
  isFeatureFile,
  isBuildConfigFile,
  isRuntimeProdFile,
} from "../src/file-classify.js";

describe("hasSourceExt (birleşim)", () => {
  it("eski phase-8 kümesi korunur", () => {
    for (const p of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.py", "a.rs", "a.go", "a.java", "a.cpp", "a.c", "a.rb", "a.swift"]) {
      expect(hasSourceExt(p), p).toBe(true);
    }
  });

  it("eski evidence kümesi korunur (phase-8'de eksikti)", () => {
    for (const p of ["a.mts", "a.cts", "a.mjs", "a.cjs", "a.kt", "a.ex", "a.exs", "a.php", "a.vue", "a.svelte"]) {
      expect(hasSourceExt(p), p).toBe(true);
    }
  });

  it("YENİ: .dart ve .cs — desteklenen stack'ler ama hiçbir listede yoktu (fail-open delik)", () => {
    expect(hasSourceExt("lib/main.dart")).toBe(true);
    expect(hasSourceExt("Program.cs")).toBe(true);
  });

  it("kaynak olmayanlar false", () => {
    for (const p of ["a.json", "a.css", "a.md", "go.mod", "Makefile", "a.feature", "package.json"]) {
      expect(hasSourceExt(p), p).toBe(false);
    }
  });
});

describe("isTestPath (birleşim = tech-debt-scanner üst kümesi)", () => {
  it("JS/TS test desenleri", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
    expect(isTestPath("src/tests/foo.ts")).toBe(true);
  });

  it("DELTA: py/go/rs test desenleri artık Faz 8 sınıflandırmasında da test sayılır", () => {
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("src/util_test.py")).toBe(true);
    expect(isTestPath("src/mod_test.rs")).toBe(true);
    expect(isTestPath("src/test_helpers.py")).toBe(true);
    expect(isTestPath("src/spec/foo.rb")).toBe(true);
  });

  it("node_modules ve prod dosyalar false", () => {
    expect(isTestPath("node_modules/x/foo.test.ts")).toBe(false);
    expect(isTestPath("src/app.ts")).toBe(false);
  });

  it("ÇAPALAMA: kök seviye tests/ ve spec/ de test sayılır (git-göreli yolda baş eğik çizgi yok)", () => {
    expect(isTestPath("tests/foo.py")).toBe(true);
    expect(isTestPath("test/foo.ts")).toBe(true);
    expect(isTestPath("spec/foo.rb")).toBe(true);
    expect(isTestPath("__tests__/foo.ts")).toBe(true);
    // "protests/" gibi içeren-ama-eşit-olmayan dizin adları YANLIŞ eşleşmez
    expect(isTestPath("protests/foo.ts")).toBe(false);
    expect(isTestPath("contest/foo.ts")).toBe(false);
  });
});

describe("isProdPath (kaynak uzantı + !test)", () => {
  it("prod kaynak true; test/manifest/kozmetik false", () => {
    expect(isProdPath("src/app.ts")).toBe(true);
    expect(isProdPath("routes/db.js")).toBe(true);
    expect(isProdPath("src/app.test.ts")).toBe(false);
    expect(isProdPath("package.json")).toBe(false);
    expect(isProdPath("style.css")).toBe(false);
  });

  it("DELTA: .php/.vue/.dart/.cs prod dosyaları artık prod sayılır (repro istenir — gate güçlenir)", () => {
    expect(isProdPath("app/Http/Kernel.php")).toBe(true);
    expect(isProdPath("src/App.vue")).toBe(true);
    expect(isProdPath("lib/main.dart")).toBe(true);
    expect(isProdPath("Services/Auth.cs")).toBe(true);
  });
});

describe("isRuntimeProdFile (Faz 8 repro-gate'in tek sorusu)", () => {
  it("runtime prod: kaynak + !test + !kök-config", () => {
    expect(isRuntimeProdFile("src/app.ts")).toBe(true);
    expect(isRuntimeProdFile("routes/db.js")).toBe(true);
    // İç içe app-config RUNTIME olabilir → runtime prod kalır (güvenli taraf)
    expect(isRuntimeProdFile("src/app/app.config.ts")).toBe(true);
  });

  it("runtime DEĞİL: test / kök build-config / manifest / kozmetik / feature", () => {
    expect(isRuntimeProdFile("src/app.test.ts")).toBe(false);
    expect(isRuntimeProdFile("vitest.config.ts")).toBe(false);
    expect(isRuntimeProdFile("playwright.config.ts")).toBe(false);
    expect(isRuntimeProdFile("tsconfig.json")).toBe(false);
    expect(isRuntimeProdFile("package.json")).toBe(false);
    expect(isRuntimeProdFile("style.css")).toBe(false);
    expect(isRuntimeProdFile("features/auth.feature")).toBe(false);
  });
});

describe("mevcut kilitler (taşınan davranış)", () => {
  it(".feature üçlü kilit: ne test ne prod ne kozmetik", () => {
    const p = "features/auth.feature";
    expect(isFeatureFile(p)).toBe(true);
    expect(isTestPath(p)).toBe(false);
    expect(isProdPath(p)).toBe(false);
    expect(isCosmeticFile(p)).toBe(false);
  });

  it("manifest'ler build-config DEĞİL (bağımlılık taşır, prod'u etkiler)", () => {
    expect(isBuildConfigFile("package.json")).toBe(false);
    expect(isBuildConfigFile("Cargo.toml")).toBe(false);
    expect(isBuildConfigFile("go.mod")).toBe(false);
  });

  it("kök build/test-tooling config true; iç içe false", () => {
    expect(isBuildConfigFile("vitest.config.ts")).toBe(true);
    expect(isBuildConfigFile("./playwright.config.ts")).toBe(true);
    expect(isBuildConfigFile("tsconfig.build.json")).toBe(true);
    expect(isBuildConfigFile(".eslintrc.json")).toBe(true);
    expect(isBuildConfigFile("pytest.ini")).toBe(true);
    expect(isBuildConfigFile("src/app/app.config.ts")).toBe(false);
    expect(isBuildConfigFile("packages/web/vitest.config.ts")).toBe(false);
  });
});
