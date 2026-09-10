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

  // BİLİNÇLİ DAVRANIŞ DEĞİŞİKLİĞİ (adli denetim, 2026-09-10): boş `{}` eskiden dolu bir sıfır
  // nesnesi döndürüyordu; "kullanım bildirilmedi" ile "kullanım gerçekten sıfırdı" ayrımı
  // kayboluyordu. Canlı kayıtta 88 maliyet kaydı bu yüzden model + tur + süre taşırken jeton
  // sıfır görünüyordu — jeton çapası adli olarak güvenilmez hale gelmişti. Blokta beklenen
  // alanlardan EN AZ BİRİ varsa sözleşme aynen sürer (aşağıdaki ilk iddia); hiçbiri yoksa
  // artık `undefined` (çağıran no-op yapar, sahte sıfır üretilmez).
  it("bildirilen blokta eksik alanlar → 0; HİÇ alan yoksa undefined", () => {
    expect(extractTokenUsage({ input_tokens: 5 })).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(extractTokenUsage({})).toBeUndefined();
  });

  it("eski sözleşmenin korunan yanı: gerçekten sıfır BİLDİRİLDİYSE sıfır döner", () => {
    expect(extractTokenUsage({ input_tokens: 0 })).toEqual({
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
