// phase-5-ui-tweak — arayüz rötuş isteği TEK SEFERLİKTİR ve yalnız Faz 5'te anlam taşır.
//
// CANLI KANIT (ekransız deneme koşuları 6 ve 7, 2026-11-27): rötuş ajanı hiçbir şey yazmadan bitince
// Faz 5 `fail` döndü ve `pending_ui_tweak` silinmedi. Mahkeme "devam" deyince akış Faz 6'ya geçti, istek
// durumda kaldı; uygulama yeniden açılınca iş Faz 1'den başladı ve dört faz sonra gelen ilgisiz Faz 5
// koşusu aynı cümleyle ("Kaldığın yerden devam et.") yine rötuş kipine girdi.
//
// Kural: istek, akış Faz 5'ten ÇIKTIĞI anda düşer (Faz 6'ya giriş, yeni Faz 1 başlangıcı). Faz 5'in
// içinde (aynı rötuşun yeniden denenmesi, kesintiden dönüş) bilerek durur.
//
// Bu dosya iki saf işlevi kilitler. Kuralın index.ts içindeki üç çağrı noktası (Faz 6'ya giriş, Faz 1
// başlangıcı, arayüz onayı) burada KOŞTURULMAZ; o bağlantı kod okumasıyla incelendi.

import { describe, expect, it } from "vitest";
import { isUiTweakRun, uiTweakStaleOnEnter } from "../src/phase-5.js";
import type { State } from "../src/types.js";

const AFTER_NO_WRITE_TWEAK = {
  current_phase: 5,
  pending_ui_tweak: "Kaldığın yerden devam et.",
} as unknown as State;

/** index.ts'in bayat isteği düşürürken duruma yaptığı tek değişiklik. */
function dropped(state: State): State {
  return { ...state, pending_ui_tweak: undefined };
}

describe("uiTweakStaleOnEnter + isUiTweakRun", () => {
  it("yazmasız biten rötuştan sonra akış Faz 6'ya geçerse istek düşer; sonraki Faz 5 koşusu rötuş kipine girmez", () => {
    expect(isUiTweakRun(AFTER_NO_WRITE_TWEAK)).toBe(true); // istek hâlâ durumda (koşu 6'daki an)
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 6)).toBe(true);
    expect(isUiTweakRun(dropped(AFTER_NO_WRITE_TWEAK))).toBe(false);
  });

  it("iş Faz 1'den yeniden başlarsa istek düşer; dört faz sonraki Faz 5 koşusu rötuş kipine girmez", () => {
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 1)).toBe(true);
    expect(isUiTweakRun(dropped(AFTER_NO_WRITE_TWEAK))).toBe(false);
  });

  it("Faz 5'e giriş isteği düşürmez: aynı rötuşun yeniden denenmesi ve kesintiden dönüş rötuş kipinde kalır", () => {
    expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, 5)).toBe(false);
  });

  it("öteki fazlara giriş isteğe dokunmaz (kapı fazındaki düzeltme planı dahil)", () => {
    for (const phase of [2, 3, 4, 7, 8, 9, 10, 13, 16, 17]) {
      expect(uiTweakStaleOnEnter(AFTER_NO_WRITE_TWEAK, phase)).toBe(false);
    }
  });

  it("istek yoksa hiçbir fazda bayat sayılacak bir şey yoktur", () => {
    for (const tweak of [undefined, ""]) {
      const st = { pending_ui_tweak: tweak };
      expect(isUiTweakRun(st)).toBe(false);
      expect(uiTweakStaleOnEnter(st, 1)).toBe(false);
      expect(uiTweakStaleOnEnter(st, 6)).toBe(false);
    }
  });
});
