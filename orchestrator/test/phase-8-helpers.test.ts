import { describe, expect, it } from "vitest";
import {
  countAcceptanceCriteria,
  hasReproRedThenGreen,
  isCosmeticFile,
  isTestCommand,
} from "../src/phase-8.js";

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
