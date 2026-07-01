import { describe, expect, it } from "vitest";
import {
  scanTechDebt,
  acceptedFindingKey,
  updateLastTechDebtFindings,
  getLastTechDebtFindings,
  resetLastTechDebtFindings,
} from "../src/tech-debt-scanner.js";

describe("tech-debt-scanner (v15.2.4 sıfır-teknik-borç ilkesi)", () => {
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

  // YZLLM canlı-test 0620: i18n UI etiketi (`password: "Password"`) hardcoded_credential SANILDI →
  // Faz 8 sahte gate → error-analysis 344K token boğuldu → 8 saatlik iş düştü.
  it("i18n/messages dosyasında UI etiketini credential SAYMAZ (sahte gate önlenir)", () => {
    const i18nCode = `
      export const messages = {
        password: "Password",
        invalidCredentials: "Invalid email or password.",
        sifre: "Şifre",
      };
    `;
    // path verilmezse (geriye-uyumlu) eski davranış: bayraklar
    expect(
      scanTechDebt(i18nCode).filter((f) => f.category === "hardcoded_credential").length,
    ).toBeGreaterThanOrEqual(1);
    // i18n path verilince credential MUAF (TODO vb. yine taranır)
    for (const p of ["lib/i18n/messages.ts", "src/locales/en.ts", "app/lang/messages.ts"]) {
      expect(
        scanTechDebt(i18nCode, p).filter((f) => f.category === "hardcoded_credential"),
        `${p} i18n → credential muaf`,
      ).toHaveLength(0);
    }
  });

  it("i18n MUAFİYETİ gerçek credential'ı non-i18n dosyada hâlâ yakalar", () => {
    const realCred = `const password = "supersecret123";`;
    expect(
      scanTechDebt(realCred, "lib/auth/login.ts").filter((f) => f.category === "hardcoded_credential")
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("i18n dosyasında TODO gibi gerçek borç YİNE yakalanır (yalnız credential muaf)", () => {
    const findings = scanTechDebt(`// TODO: çevrilecek\nexport const m = { ok: "OK" };`, "src/i18n/tr.ts");
    expect(findings.some((f) => f.category === "todo_comment")).toBe(true);
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

// FIX D (YZLLM 2026-07-01: "kabul edilen bulgu bir daha sorulmasın"): kabul-anahtarı + acceptedKeys ile atlama.
describe("acceptedFindingKey — normalize + eşleşme", () => {
  it("path ayracı + boşluk + büyük/küçük harf normalize edilir (idempotent)", () => {
    const a = acceptedFindingKey("routes\\ui.js", "empty_catch", "  Catch  (E) {}  ");
    const b = acceptedFindingKey("routes/ui.js", "empty_catch", "catch (e) {}");
    expect(a).toBe(b);
  });
  it("farklı kategori / farklı snippet → farklı anahtar (güvenlik korunur)", () => {
    const base = acceptedFindingKey("f.js", "hardcoded_credential", "password: \"abc12345\"");
    expect(base).not.toBe(acceptedFindingKey("f.js", "empty_catch", "password: \"abc12345\""));
    expect(base).not.toBe(acceptedFindingKey("f.js", "hardcoded_credential", "password: \"yeni99999\""));
  });
});

describe("scanTechDebt — acceptedKeys ile KALICI kabul atlaması", () => {
  const code = `
    const password = "supersecret123";
    // TODO: refactor
  `;
  it("acceptedKeys yok → tüm bulgular döner (geriye uyumlu)", () => {
    const findings = scanTechDebt(code, "src/db.js");
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
  it("kabul edilen (dosya+kategori+snippet) atlanır; diğerleri kalır", () => {
    const all = scanTechDebt(code, "src/db.js");
    const cred = all.find((f) => f.category === "hardcoded_credential")!;
    const accepted = new Set([acceptedFindingKey("src/db.js", cred.category, cred.excerpt)]);
    const filtered = scanTechDebt(code, "src/db.js", accepted);
    expect(filtered.find((f) => f.category === "hardcoded_credential")).toBeUndefined();
    expect(filtered.find((f) => f.category === "todo_comment")).toBeDefined(); // TODO hâlâ işaretli
  });
  it("FARKLI dosyada aynı snippet atlanmaz (anahtar dosyaya özgü)", () => {
    const all = scanTechDebt(code, "src/db.js");
    const cred = all.find((f) => f.category === "hardcoded_credential")!;
    const accepted = new Set([acceptedFindingKey("src/db.js", cred.category, cred.excerpt)]);
    const other = scanTechDebt(code, "src/other.js", accepted);
    expect(other.find((f) => f.category === "hardcoded_credential")).toBeDefined();
  });
});

describe("updateLastTechDebtFindings / getLastTechDebtFindings (accept snippet erişimi)", () => {
  it("dosya bazlı per-path replace; boş findings dosyayı temizler", () => {
    const root = "/tmp/mycl-test-proj-fixd";
    updateLastTechDebtFindings(root, "a.js", [
      { category: "empty_catch", line: 3, excerpt: "catch {}", reason: "r" },
    ]);
    updateLastTechDebtFindings(root, "b.js", [
      { category: "todo_comment", line: 1, excerpt: "// TODO", reason: "r" },
    ]);
    expect(getLastTechDebtFindings(root)).toHaveLength(2);
    // a.js yeniden temiz taranınca a girdileri düşer, b kalır
    updateLastTechDebtFindings(root, "a.js", []);
    const after = getLastTechDebtFindings(root);
    expect(after).toHaveLength(1);
    expect(after[0].file).toBe("b.js");
  });

  it("resetLastTechDebtFindings depoyu tamamen temizler (proje-değişim hijyeni)", () => {
    const root = "/tmp/mycl-test-proj-reset";
    updateLastTechDebtFindings(root, "x.js", [
      { category: "todo_comment", line: 1, excerpt: "// TODO", reason: "r" },
    ]);
    expect(getLastTechDebtFindings(root)).toHaveLength(1);
    resetLastTechDebtFindings(root);
    expect(getLastTechDebtFindings(root)).toEqual([]);
  });
});
