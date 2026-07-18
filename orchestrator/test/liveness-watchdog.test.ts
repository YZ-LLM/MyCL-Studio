// liveness-watchdog — canlılık garantisi karar matrisi (YZLLM 2026-07-18:
// "hiç bir zaman durmayacağını ve döngüye girmeyeceğini garanti etmeliyiz").
import { describe, expect, it } from "vitest";
import { shouldKickQueue } from "../src/liveness-watchdog.js";

const idle = { busy: false, askqOpen: false, outageWaiting: false, hasPending: true };

describe("shouldKickQueue", () => {
  it("tamamen boşta + bekleyen iş var + meşru bekleme yok → SÜR (donma kırılır)", () => {
    expect(shouldKickQueue(idle)).toBe(true);
  });
  it("sistem meşgul → sürme (çift koşum yok)", () => {
    expect(shouldKickQueue({ ...idle, busy: true })).toBe(false);
  });
  it("açık askq/park var → sürme (kullanıcı bekleniyor, meşru durak)", () => {
    expect(shouldKickQueue({ ...idle, askqOpen: true })).toBe(false);
  });
  it("kesinti bekle-ve-devam kurulu → sürme (o sürdürecek; çifte tetik yok)", () => {
    expect(shouldKickQueue({ ...idle, outageWaiting: true })).toBe(false);
  });
  it("seçilebilir bekleyen iş yok (tavanlılar hariç) → sürme (döngü üretme)", () => {
    expect(shouldKickQueue({ ...idle, hasPending: false })).toBe(false);
  });
});
