// isMissingCommand — "komut/araç yok" (skip) vs "gerçek fail" ayrımı.
// v15.10: `npx --no-install <tool>` aracı kurulu değilse skip (örn. Faz 11 ts-prune).

import { describe, expect, it } from "vitest";
import { isMissingCommand } from "../../src/base/mechanical-runner.js";

describe("isMissingCommand", () => {
  const r = (o: Partial<{ code: number; stdout: string; stderr: string }>) => ({
    code: 0,
    stdout: "",
    stderr: "",
    ...o,
  });

  it("code 127 → true (komut yok)", () => {
    expect(isMissingCommand(r({ code: 127 }))).toBe(true);
  });
  it("Missing script → true", () => {
    expect(isMissingCommand(r({ code: 1, stderr: 'npm error Missing script: "lint"' }))).toBe(true);
    expect(isMissingCommand(r({ code: 1, stderr: 'npm ERR! Missing script: "lint"' }))).toBe(true);
    // pnpm hata satırını stdout'a da yazabiliyor.
    expect(isMissingCommand(r({ code: 1, stdout: " ERR_PNPM_NO_SCRIPT  Missing script: lint" }))).toBe(true);
  });
  it("kabuk 'command not found' → çıkış kodu 127 ile gelir → true", () => {
    expect(isMissingCommand(r({ code: 127, stderr: "sh: ts-prune: command not found" }))).toBe(true);
  });
  it("could not determine executable → true", () => {
    expect(isMissingCommand(r({ code: 1, stderr: "npm error could not determine executable to run" }))).toBe(true);
  });
  it("v15.10: npx --no-install eksik paket → true (ts-prune kurulu değil = skip)", () => {
    expect(
      isMissingCommand(
        r({
          code: 1,
          stderr: 'npm error npx canceled due to missing packages and no YES option: ["ts-prune@0.10.3"]',
        }),
      ),
    ).toBe(true);
  });
  it("gerçek test/lint fail (araç VAR, çıktı fail) → false (skip DEĞİL)", () => {
    expect(
      isMissingCommand(r({ code: 1, stdout: "2 problems (2 errors)", stderr: "ESLint found errors" })),
    ).toBe(false);
  });
  it("code 0 → false", () => {
    expect(isMissingCommand(r({ code: 0, stdout: "All passed" }))).toBe(false);
    // Araç başarıyla koştuysa çıktısında ne yazarsa yazsın "komut yok" değildir.
    expect(isMissingCommand(r({ code: 0, stderr: 'npm error Missing script: "lint"' }))).toBe(false);
  });

  // KAÇIŞ YOLU AVI (2026-11-26, YÜKSEK): "atlandı" = araç HİÇ çalışmadı. Çalışan bir test koşusunun serbest
  // çıktısı bunun kanıtı olamaz. Eski sınıflandırıcı çıktının tamamında sözcük arıyordu → kırmızı test koşusu
  // "atlandı" sayılıp faz tamamlanıyor, hüküm GEÇTİ çıkıyordu.
  it("BAŞARISIZ test koşusu, çıktısında 'command not found' geçse de atlanmış SAYILMAZ", () => {
    const vitestFail = [
      " FAIL  cli.test.js > komut bulunamayınca hata verir",
      "AssertionError: expected 'sh: mytool: command not found' to be 'ok'",
      "    - Expected: ok",
      "    + Received: sh: mytool: command not found",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
    ].join("\n");
    expect(isMissingCommand(r({ code: 1, stdout: vitestFail }))).toBe(false);
    expect(isMissingCommand(r({ code: 1, stderr: vitestFail }))).toBe(false);
  });
  it("iddia iletisine GÖMÜLÜ 'Missing script:' / 'could not determine executable' atlama sebebi değil", () => {
    expect(
      isMissingCommand(r({ code: 1, stdout: "Error: expected 'npm error Missing script: \"x\"' to equal ''" })),
    ).toBe(false);
    expect(
      isMissingCommand(r({ code: 1, stderr: "  × çıktı 'could not determine executable to run' içermeli" })),
    ).toBe(false);
    expect(isMissingCommand(r({ code: 1, stdout: "Docs: if you see Missing script: run npm install" }))).toBe(false);
  });
});
