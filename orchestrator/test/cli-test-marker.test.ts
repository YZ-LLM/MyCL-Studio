// parseTestResultMarkers — Faz 8 CLI TDD self-report marker çıkarımı (saf fn).

import { describe, expect, it } from "vitest";
import { parseTestResultMarkers } from "../src/codegen/cli-backend.js";

describe("parseTestResultMarkers", () => {
  it("green marker'ı yakalar", () => {
    expect(parseTestResultMarkers("Tests pass.\nMYCL_TEST_RESULT: green")).toEqual([
      { green: true, detail: "green" },
    ]);
  });
  it("red marker'ı + neden", () => {
    expect(
      parseTestResultMarkers("MYCL_TEST_RESULT: red: 2 assertions failed"),
    ).toEqual([{ green: false, detail: "red: 2 assertions failed" }]);
  });
  it("metin içine gömülü marker (önce prose) — yine yakalanır", () => {
    expect(parseTestResultMarkers("özet... MYCL_TEST_RESULT: green  ")).toEqual([
      { green: true, detail: "green" },
    ]);
  });
  it("birden çok satır — her marker ayrı", () => {
    const t = "MYCL_TEST_RESULT: red: ilk\nara\nMYCL_TEST_RESULT: green";
    expect(parseTestResultMarkers(t)).toEqual([
      { green: false, detail: "red: ilk" },
      { green: true, detail: "green" },
    ]);
  });
  it("marker yoksa boş; geçersiz status (yellow) yok sayılır", () => {
    expect(parseTestResultMarkers("hiç marker yok")).toEqual([]);
    expect(parseTestResultMarkers("MYCL_TEST_RESULT: yellow")).toEqual([]);
  });
});
