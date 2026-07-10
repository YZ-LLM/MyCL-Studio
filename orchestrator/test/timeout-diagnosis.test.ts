// timeout-diagnosis — SAF karar mantığı testleri (decideAutoAnswer/finding-queue deseni: yan etki yok, run-loop'tan ayrı).
// decideTimeoutDivert: gate-timeout'ta "atlama YOK → gerçek çözüm → çok-açılı orkestra → dürüst dur" (YZLLM 2026-07-09).

import { describe, expect, it } from "vitest";
import { decideTimeoutDivert, TIMEOUT_DIVERT_MAX } from "../src/timeout-diagnosis.js";

describe("decideTimeoutDivert", () => {
  it("saf-timeout DEĞİL (gerçek errno/port env) → stop — her modda (parite: kullanıcı elle inceler)", () => {
    expect(decideTimeoutDivert({ isTimeoutHangOnly: false, modeOn: true, divertCount: 0 })).toBe("stop");
    expect(decideTimeoutDivert({ isTimeoutHangOnly: false, modeOn: false, divertCount: 0 })).toBe("stop");
    expect(decideTimeoutDivert({ isTimeoutHangOnly: false, modeOn: true, divertCount: 99 })).toBe("stop");
  });

  it("mod KAPALI → stop (PARİTE: mevcut STOP byte-aynı; manuel modda kullanıcı devrede)", () => {
    expect(decideTimeoutDivert({ isTimeoutHangOnly: true, modeOn: false, divertCount: 0 })).toBe("stop");
  });

  it("saf-timeout + mod AÇIK + deneme hakkı var → divert (gerçek-çözüm + çok-açılı orkestra)", () => {
    expect(decideTimeoutDivert({ isTimeoutHangOnly: true, modeOn: true, divertCount: 0 })).toBe("divert");
    expect(decideTimeoutDivert({ isTimeoutHangOnly: true, modeOn: true, divertCount: TIMEOUT_DIVERT_MAX - 1 })).toBe("divert");
  });

  it("saf-timeout + mod AÇIK + deneme TÜKENDİ → escalate (dürüst görünür-dur/kuyruk; ATLAMA/sahte-yeşil DEĞİL)", () => {
    expect(decideTimeoutDivert({ isTimeoutHangOnly: true, modeOn: true, divertCount: TIMEOUT_DIVERT_MAX })).toBe("escalate");
    expect(decideTimeoutDivert({ isTimeoutHangOnly: true, modeOn: true, divertCount: TIMEOUT_DIVERT_MAX + 3 })).toBe("escalate");
  });

  it("TIMEOUT_DIVERT_MAX makul sınır (sonsuz-döngü emniyeti)", () => {
    expect(TIMEOUT_DIVERT_MAX).toBeGreaterThanOrEqual(1);
    expect(TIMEOUT_DIVERT_MAX).toBeLessThanOrEqual(5);
  });
});
