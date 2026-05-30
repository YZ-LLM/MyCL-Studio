import { describe, expect, it } from "vitest";
import { scanTechDebt } from "../src/tech-debt-scanner.js";

describe("tech-debt-scanner (v15.2.4 MyCL_Pseudocode.md:203 ASLA TEKNİK BORÇ BIRAKMA)", () => {
  it("returns empty for clean code", () => {
    const code = `
      function add(a, b) {
        return a + b;
      }
      const PORT = process.env.PORT || 3000;
    `;
    expect(scanTechDebt(code)).toHaveLength(0);
  });

  it("detects TODO/FIXME/HACK/XXX/WIP comments", () => {
    const code = `
      // TODO: refactor this later
      function foo() {
        // FIXME: edge case
        return 1; // HACK
      }
      // XXX hardcoded
      // WIP
    `;
    const findings = scanTechDebt(code);
    expect(findings.length).toBeGreaterThanOrEqual(5);
    expect(findings.every((f) => f.category === "todo_comment")).toBe(true);
  });

  it("detects mock/stub call in production", () => {
    const code = `
      import { vi } from "vitest";
      vi.mock("./db");
      jest.mock("axios");
      sinon.stub(api, "fetch");
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "mock_in_prod").length).toBeGreaterThanOrEqual(3);
  });

  it("detects hardcoded credentials", () => {
    const code = `
      const password = "supersecret123";
      const api_key = "sk-abcdefghijk";
      const accessToken = "Bearer xyz12345";
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "hardcoded_credential").length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag env-var credential access", () => {
    const code = `
      const password = process.env.DB_PASS;
      const apiKey = config.get("api_key");
      const secret = readFileSync("secret.txt");
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "hardcoded_credential")).toHaveLength(0);
  });

  it("detects empty catch blocks", () => {
    const code = `
      try { foo(); } catch {}
      try { bar(); } catch (e) {}
      try { baz(); } catch(err) {  }
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "empty_catch").length).toBeGreaterThanOrEqual(2);
  });

  it("detects skipped tests", () => {
    const code = `
      it.skip("pending", () => {});
      describe.only("focus", () => {});
      xit("legacy", () => {});
      xdescribe("legacy suite", () => {});
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "skipped_test").length).toBeGreaterThanOrEqual(4);
  });

  it("returns line numbers (1-indexed) and excerpts", () => {
    const code = `line 1\nline 2 // TODO: fix\nline 3`;
    const findings = scanTechDebt(code);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
    expect(findings[0].excerpt).toContain("TODO");
  });

  it("does not flag legitimate identifiers containing 'mock' (variable naming)", () => {
    // Test path'lerinde mock kelimesi OK; production path'larında **mock CALL**
    // (vi.mock, jest.mock) tespit edilir, ama `mockData` gibi naming flag'lenmez.
    const code = `
      const mockData = { foo: 1 };
      function processStub(input) { return input; }
    `;
    const findings = scanTechDebt(code);
    expect(findings.filter((f) => f.category === "mock_in_prod")).toHaveLength(0);
  });
});
