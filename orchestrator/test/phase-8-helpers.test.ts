import { describe, expect, it } from "vitest";
import {
  countAcceptanceCriteria,
  hasReproRedThenGreen,
  isBuildConfigFile,
  isCosmeticFile,
  isFeatureFile,
  isProdPath,
  isStaticOnlyChange,
  isStaticSafeAddedLine,
  isTestCommand,
  isTestPath,
  nonRuntimeProdExempt,
} from "../src/phase-8.js";

describe("isStaticSafeAddedLine (Faz 8 repro gate-fix #1 — eklenen satır runtime mı)", () => {
  it("tip/yorum/boş/import-type/re-export/kapanış → static-safe", () => {
    for (const l of [
      "",
      "  // açıklama",
      "/* blok */",
      "type Foo = { a: number }",
      "export interface User { id: string }",
      "import type { X } from './x'",
      "export type { Y } from './y'",
      "export { A, B } from './mod'",
      "}",
      "  );",
    ]) {
      expect(isStaticSafeAddedLine(l)).toBe(true);
    }
  });
  it("runtime statement/JSX/atama → static-safe DEĞİL", () => {
    for (const l of [
      "const x = compute()",
      "doThing();",
      "return <div>hi</div>",
      "if (x) y();",
      "import { useState } from 'react'", // değer import (tip değil) → runtime
      "export function handler() {}",
    ]) {
      expect(isStaticSafeAddedLine(l)).toBe(false);
    }
  });
});

describe("isStaticOnlyChange (Faz 8 repro gate-fix #1 — diff static-only mı)", () => {
  it("sadece silme (ölü-kod removal) → static-only (eklenen satır yok)", () => {
    const diff = [
      "diff --git a/src/util.ts b/src/util.ts",
      "--- a/src/util.ts",
      "+++ b/src/util.ts",
      "@@ -3,2 +0,0 @@",
      "-export function unused() { return 1 }",
      "-const dead = 5;",
    ].join("\n");
    expect(isStaticOnlyChange(diff)).toBe(true);
  });
  it("tip-only ekleme/değişim → static-only", () => {
    const diff = [
      "--- a/src/types.ts",
      "+++ b/src/types.ts",
      "@@ -1 +1,2 @@",
      "-type Id = string",
      "+type Id = string | number",
      "+export type Name = string",
    ].join("\n");
    expect(isStaticOnlyChange(diff)).toBe(true);
  });
  it("runtime kod eklenince → static-only DEĞİL (repro şart)", () => {
    const diff = [
      "--- a/src/svc.ts",
      "+++ b/src/svc.ts",
      "@@ -5 +5,2 @@",
      "-  const total = 0;",
      "+  const total = items.reduce((a, b) => a + b.price, 0);",
      "+  return total;",
    ].join("\n");
    expect(isStaticOnlyChange(diff)).toBe(false);
  });
  it("boş diff → false (sınıflandırılamaz, güvenli taraf)", () => {
    expect(isStaticOnlyChange("")).toBe(false);
    expect(isStaticOnlyChange("diff --git a/x b/x\n")).toBe(false);
  });
});

describe("isCosmeticFile (repro-gate kapsamı — v15.10)", () => {
  it("stil/markup/görsel/doküman → kozmetik (repro muaf)", () => {
    for (const f of ["src/styles.css", "a/b.scss", "index.html", "logo.svg", "icon.png", "README.md"]) {
      expect(isCosmeticFile(f)).toBe(true);
    }
  });
  it("kod/config → mantık (repro zorunlu)", () => {
    for (const f of ["src/validation.ts", "main.js", "server.py", "go.mod", "package.json", "x.tsx"]) {
      expect(isCosmeticFile(f)).toBe(false);
    }
  });
  it("uzantısız → kozmetik değil (güvenli taraf: mantık)", () => {
    expect(isCosmeticFile("Makefile")).toBe(false);
    expect(isCosmeticFile("LICENSE")).toBe(false);
  });
});

describe("isFeatureFile (BDD dış döngü görünür artefakt — YZLLM 2026-07-03)", () => {
  it(".feature dosyaları → true", () => {
    for (const f of ["features/auth.feature", "features/giris.feature", "a/b/x.FEATURE"]) {
      expect(isFeatureFile(f)).toBe(true);
    }
  });
  it("kod/test/doküman/node_modules → false", () => {
    for (const f of ["src/app.ts", "tests/auth.test.ts", "README.md", "node_modules/x/y.feature"]) {
      expect(isFeatureFile(f)).toBe(false);
    }
  });
  // REGRESYON-KİLİDİ: `.feature` mevcut sınıflandırıcıların HİÇBİRİNE uymaz →
  // tech-debt taramasına girmez, tdd-*-write saymaz, repro-gate'i tetiklemez
  // (çift sayım YOK). Bu davranış BDD tasarımının temelidir; kırılmasın.
  it("konvansiyonel features/ yolu test/prod/kozmetik DEĞİL (çift sayım + repro muafiyeti kilidi)", () => {
    const f = "features/auth.feature";
    expect(isTestPath(f)).toBe(false);
    expect(isProdPath(f)).toBe(false);
    expect(isCosmeticFile(f)).toBe(false);
  });
  // Nüans (mahkeme M2): bir `.feature` tests/ (veya __tests__/) altına yazılırsa isTestPath
  // ÖNCE kazanır → observeTool else if zincirinde bdd-scenario-write ATLANIR, tdd-test-write
  // yazılır. Bu bilinçli tasarım; gate etkilenmez (ikisi de required değil). Davranışı sabitle.
  it("tests/ altındaki .feature'da isTestPath öncelikli (else if bdd-scenario-write'ı atlar)", () => {
    for (const f of ["src/tests/auth.feature", "a/__tests__/x.feature"]) {
      expect(isFeatureFile(f)).toBe(true);
      expect(isTestPath(f)).toBe(true); // else if zincirinde bu önce eşleşir
    }
  });
});

describe("isBuildConfigFile (Faz 8 repro gate-fix #3 — build/test-tooling config mı)", () => {
  it("repo-kökü build/test config → true (repro muaf sınıfı)", () => {
    for (const f of [
      "playwright.config.ts",
      "vitest.config.ts",
      "jest.config.js",
      "next.config.mjs",
      "vite.config.ts",
      "tailwind.config.cjs",
      "eslint.config.js",
      "tsconfig.json",
      "tsconfig.build.json",
      "jsconfig.json",
      ".eslintrc",
      ".eslintrc.json",
      ".prettierrc",
      ".babelrc",
      "pytest.ini",
      "tox.ini",
      "./playwright.config.ts", // lider "./" normalize edilir
    ]) {
      expect(isBuildConfigFile(f)).toBe(true);
    }
  });
  it("prod kod / paket-manifesti / iç içe app-config → false (güvenli taraf: repro şart)", () => {
    for (const f of [
      "app/page.tsx",
      "src/server.ts",
      "components/Button.tsx",
      "package.json", // manifest: deps prod'u etkiler → config sayma
      "Cargo.toml",
      "go.mod",
      "src/app/app.config.ts", // iç içe → runtime app-config olabilir → kök şartı keser
      "packages/web/vitest.config.ts", // monorepo alt-config → güvenli tarafta (kök değil)
      "README.md", // kozmetik ama config değil
      "tests/foo.test.ts", // test ama config değil
    ]) {
      expect(isBuildConfigFile(f)).toBe(false);
    }
  });
});

describe("hasReproRedThenGreen (fix modu repro-first)", () => {
  const ev = (...es: string[]) => es.map((event) => ({ event }));

  it("tdd-red sonra tdd-green → true (repro yapıldı)", () => {
    expect(hasReproRedThenGreen(ev("tdd-red", "tdd-green"))).toBe(true);
    expect(hasReproRedThenGreen(ev("tdd-test-write", "tdd-red", "tdd-green", "tdd-green"))).toBe(true);
  });

  it("sadece tdd-green (repro yok) → false", () => {
    expect(hasReproRedThenGreen(ev("tdd-green", "tdd-green"))).toBe(false);
  });

  it("yeşil sonra kırmızı (sıra yanlış) → false", () => {
    expect(hasReproRedThenGreen(ev("tdd-green", "tdd-red"))).toBe(false);
  });

  it("boş → false", () => {
    expect(hasReproRedThenGreen([])).toBe(false);
  });
});

describe("countAcceptanceCriteria", () => {
  it("returns 0 for empty section", () => {
    expect(countAcceptanceCriteria("")).toBe(0);
  });

  it("counts AC1..ACn lines", () => {
    const section = `- **AC1**: foo
- **AC2**: bar
- **AC3**: baz`;
    expect(countAcceptanceCriteria(section)).toBe(3);
  });

  it("ignores non-AC bullets", () => {
    const section = `- **AC1**: foo
- something else
- **AC2**: bar
- **NOT_AC**: x`;
    expect(countAcceptanceCriteria(section)).toBe(2);
  });

  it("handles double-digit AC numbers", () => {
    const section = `- **AC1**: a
- **AC10**: b
- **AC25**: c`;
    expect(countAcceptanceCriteria(section)).toBe(3);
  });
});

describe("isTestCommand", () => {
  it("matches npm/pnpm/yarn test", () => {
    expect(isTestCommand("npm test")).toBe(true);
    expect(isTestCommand("npm t")).toBe(true);
    expect(isTestCommand("pnpm test")).toBe(true);
    expect(isTestCommand("yarn test")).toBe(true);
  });

  it("matches go test, mocha, rspec, phpunit", () => {
    expect(isTestCommand("go test ./...")).toBe(true);
    expect(isTestCommand("mocha tests/")).toBe(true);
    expect(isTestCommand("rspec spec/")).toBe(true);
    expect(isTestCommand("phpunit --testdox")).toBe(true);
  });

  it("matches bun test, deno test", () => {
    expect(isTestCommand("bun test")).toBe(true);
    expect(isTestCommand("deno test --allow-net")).toBe(true);
  });

  it("matches pytest, cargo test, vitest, jest", () => {
    expect(isTestCommand("pytest -v")).toBe(true);
    expect(isTestCommand("cargo test")).toBe(true);
    expect(isTestCommand("vitest run")).toBe(true);
    expect(isTestCommand("jest --watch")).toBe(true);
  });

  it("does not match non-test commands", () => {
    expect(isTestCommand("npm install")).toBe(false);
    expect(isTestCommand("echo test")).toBe(false);
    expect(isTestCommand("ls -la")).toBe(false);
  });
});

describe("nonRuntimeProdExempt — TEK generic repro muafiyeti (eski üç görev-sınıfı bloğunun yerini aldı)", () => {
  // 2026-07-16: repro zorunlu ⇔ değişenlerde static olduğu kanıtlanamayan runtime prod dosyası var.
  // Eski pin'lerin HEPSİ aynı sonucu vermeli (davranış koruma matrisi).

  it("cave: yalnız package.json değişti → MUAF (imkansız-repro döngüsü kırılır)", () => {
    expect(nonRuntimeProdExempt(["package.json"])).toBe(true);
  });
  it("prod runtime (.ts/.js) değişikliği → muaf DEĞİL (repro AYNEN zorunlu — gate çıtası düşmez)", () => {
    expect(nonRuntimeProdExempt(["routes/db.js"])).toBe(false);
    expect(nonRuntimeProdExempt(["src/app.ts"])).toBe(false);
  });
  it("karışık (package.json + prod .ts) → muaf DEĞİL (prod dosyası varsa repro zorunlu)", () => {
    expect(nonRuntimeProdExempt(["package.json", "src/app.ts"])).toBe(false);
  });
  it("eski config-only vakası (Vestel): kök playwright.config.ts (+ test/kozmetik) → MUAF", () => {
    expect(nonRuntimeProdExempt(["playwright.config.ts"])).toBe(true);
    expect(nonRuntimeProdExempt(["vitest.config.ts", "src/app.test.ts", "style.css"])).toBe(true);
  });
  it("iç içe app-config RUNTIME olabilir → muaf DEĞİL (kök şartı korunur)", () => {
    expect(nonRuntimeProdExempt(["src/app/app.config.ts"])).toBe(false);
  });
  it("eski test-only vakası (samsung): yalnız test dosyaları → MUAF", () => {
    expect(nonRuntimeProdExempt(["src/foo.test.ts", "tests/bar.py"])).toBe(true);
  });
  it("feature + config karışımı → MUAF (ikisi de runtime değil; eski üç blok bunu kaçırıyordu)", () => {
    expect(nonRuntimeProdExempt(["features/auth.feature", "vitest.config.ts"])).toBe(true);
  });
  it("null / boş liste → muaf DEĞİL (tespit güvenilmez → fail-safe repro kalır)", () => {
    expect(nonRuntimeProdExempt(null)).toBe(false);
    expect(nonRuntimeProdExempt([])).toBe(false);
  });
  it("DELTA (gate güçlenir): .php/.dart/.cs prod dosyası → muaf DEĞİL (eskiden test-only'den sızıyordu)", () => {
    expect(nonRuntimeProdExempt(["app/Kernel.php"])).toBe(false);
    expect(nonRuntimeProdExempt(["lib/main.dart"])).toBe(false);
    expect(nonRuntimeProdExempt(["Services/Auth.cs"])).toBe(false);
  });
});
