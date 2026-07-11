// cli-json — extractTokenUsage golden testleri (mahkeme denetimi 2026-07-11: 4 runner'daki birebir kopya tek
// saf helper'a indirildi; bu test 4 kopyanın ortak davranış sözleşmesini kilitler).

import { describe, expect, it } from "vitest";
import { extractTokenUsage } from "./cli-json.js";

describe("extractTokenUsage — 4 CLI runner'ın ortak usage sözleşmesi", () => {
  it("tam payload → birebir sayılar", () => {
    expect(
      extractTokenUsage({
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 150,
      }),
    ).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 150,
    });
  });

  it("eksik alanlar → 0 (Number(x ?? 0) sözleşmesi)", () => {
    expect(extractTokenUsage({ input_tokens: 5 })).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(extractTokenUsage({})).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("nesne değil / null / undefined → undefined (çağıran no-op — usage kaydı atlanır)", () => {
    expect(extractTokenUsage(undefined)).toBeUndefined();
    expect(extractTokenUsage(null)).toBeUndefined();
    expect(extractTokenUsage("42")).toBeUndefined();
    expect(extractTokenUsage(42)).toBeUndefined();
  });

  it("string sayılar Number ile çevrilir (stream-json toleransı — eski kopyalarla aynı)", () => {
    expect(extractTokenUsage({ input_tokens: "7", output_tokens: "3" })).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});
