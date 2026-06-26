import { afterEach, describe, expect, it } from "vitest";
import {
  autoBackendPair,
  autoFallbackBackend,
  cliCurrentlyLimited,
  computeLimitedUntilMs,
  getCliLimitedUntilMs,
  isBlockedStatus,
  isLimited,
  noteRateLimitEvent,
  finalizeCliRateLimit,
  resetCliRateLimitState,
  resolveAuto,
} from "../src/cli-rate-limit.js";

interface Outcome { kind: string; }
function fakeBackend(outcome: Outcome) {
  const calls = { run: 0, submit: 0, abort: 0 };
  const backend = {
    run: async (): Promise<Outcome> => {
      calls.run++;
      return outcome;
    },
    submitAskqAnswer: (_id: string, _sel: string) => { calls.submit++; },
    abort: () => { calls.abort++; },
  };
  return { backend, calls };
}

// Saf çekirdek + global state geçişleri. State testleri sonrası resetlenir.

afterEach(() => resetCliRateLimitState());

describe("cli-rate-limit · isBlockedStatus (saf)", () => {
  it("'allowed' → servis edildi, bloklu DEĞİL (case-insensitive)", () => {
    expect(isBlockedStatus("allowed")).toBe(false);
    expect(isBlockedStatus("ALLOWED")).toBe(false);
  });
  it("'allowed_warning' → SERVİS EDİLDİ, bloklu DEĞİL (BU bug'ın regresyon guard'ı)", () => {
    expect(isBlockedStatus("allowed_warning")).toBe(false);
    expect(isBlockedStatus("ALLOWED_WARNING")).toBe(false);
  });
  it("YALNIZ 'rejected' → bloklu (case-insensitive)", () => {
    expect(isBlockedStatus("rejected")).toBe(true);
    expect(isBlockedStatus("REJECTED")).toBe(true);
  });
  it("bilinmeyen status ('blocked'/'exceeded'/'foo') → bloklu DEĞİL (yanlış-pozitif önlenir)", () => {
    expect(isBlockedStatus("blocked")).toBe(false);
    expect(isBlockedStatus("exceeded")).toBe(false);
    expect(isBlockedStatus("foo")).toBe(false);
  });
  it("boş/undefined → bloklu değil (sinyal yok)", () => {
    expect(isBlockedStatus(undefined)).toBe(false);
    expect(isBlockedStatus("")).toBe(false);
  });
});

describe("cli-rate-limit · computeLimitedUntilMs (saf)", () => {
  it("gelecekteki resetsAt (sn) → ms", () => {
    expect(computeLimitedUntilMs(1000, 500_000)).toBe(1_000_000);
  });
  it("geçmiş resetsAt → undefined (limit zaten açılmış)", () => {
    expect(computeLimitedUntilMs(100, 500_000)).toBeUndefined();
  });
  it("geçersiz/yok → undefined", () => {
    expect(computeLimitedUntilMs(undefined, 0)).toBeUndefined();
    expect(computeLimitedUntilMs(NaN, 0)).toBeUndefined();
  });
});

describe("cli-rate-limit · isLimited (saf)", () => {
  it("now < until → limitli", () => {
    expect(isLimited(1000, 500)).toBe(true);
  });
  it("now >= until → limitli değil (reset geçti)", () => {
    expect(isLimited(1000, 1000)).toBe(false);
    expect(isLimited(1000, 2000)).toBe(false);
  });
  it("until yok → limitli değil", () => {
    expect(isLimited(undefined, 999)).toBe(false);
  });
});

describe("cli-rate-limit · resolveAuto (saf)", () => {
  it("auto + limitli → api; auto + serbest → cli", () => {
    expect(resolveAuto("auto", true)).toBe("api");
    expect(resolveAuto("auto", false)).toBe("cli");
  });
  it("explicit cli → her zaman cli (sessiz API fallback YOK)", () => {
    expect(resolveAuto("cli", true)).toBe("cli");
    expect(resolveAuto("cli", false)).toBe("cli");
  });
  it("explicit api → her zaman api", () => {
    expect(resolveAuto("api", true)).toBe("api");
    expect(resolveAuto("api", false)).toBe("api");
  });
  it("bilinmeyen → api (güvenli default)", () => {
    expect(resolveAuto("x", false)).toBe("api");
  });
});

describe("cli-rate-limit · noteRateLimitEvent + cliCurrentlyLimited (state)", () => {
  it("status=allowed → limit set EDİLMEZ", () => {
    noteRateLimitEvent({ status: "allowed", resetsAt: Math.floor(Date.now() / 1000) + 9999 });
    expect(getCliLimitedUntilMs()).toBeUndefined();
    expect(cliCurrentlyLimited()).toBe(false);
  });

  it("status=allowed_warning (seven_day) → limit set EDİLMEZ — servis edildi (ANA bug senaryosu)", () => {
    noteRateLimitEvent({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      resetsAt: Math.floor(Date.now() / 1000) + 9999,
    });
    expect(getCliLimitedUntilMs()).toBeUndefined();
    expect(cliCurrentlyLimited()).toBe(false);
  });

  it("bilinmeyen status → limit set EDİLMEZ (yanlış-pozitif önlenir, yalnız loglanır)", () => {
    noteRateLimitEvent({ status: "weird_new_status", resetsAt: Math.floor(Date.now() / 1000) + 9999 });
    expect(getCliLimitedUntilMs()).toBeUndefined();
    expect(cliCurrentlyLimited()).toBe(false);
  });

  // YZLLM 2026-06-11 "denesin zaten çalışacak": rejected event ARTIK ANINDA limitlemez — çağrı SONUCUNU bekler.
  it("rejected event TEK BAŞINA limitlemez (pending); finalize(false) → ŞİMDİ limitli", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    noteRateLimitEvent({ status: "rejected", resetsAt, rateLimitType: "five_hour" });
    expect(cliCurrentlyLimited()).toBe(false); // çağrı henüz bitmedi — preemptive switch YOK
    finalizeCliRateLimit(false); // çağrı GERÇEKTEN başarısız → şimdi limitle
    expect(getCliLimitedUntilMs()).toBe(resetsAt * 1000);
    expect(cliCurrentlyLimited()).toBe(true);
  });

  it("rejected event + çağrı BAŞARDI (overage) → finalize(true) → limit YOK", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    noteRateLimitEvent({ status: "rejected", resetsAt, rateLimitType: "five_hour" });
    finalizeCliRateLimit(true); // overage karşıladı, çağrı başardı
    expect(getCliLimitedUntilMs()).toBeUndefined();
    expect(cliCurrentlyLimited()).toBe(false);
  });

  it("geçmiş resetsAt'li rejected + finalize(false) → kısa backoff (gelecekte)", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    noteRateLimitEvent({ status: "rejected", resetsAt: past });
    finalizeCliRateLimit(false);
    const until = getCliLimitedUntilMs();
    expect(until).toBeDefined();
    expect(until!).toBeGreaterThan(Date.now());
  });
});

const LBL = { from: "Birincil", to: "İkincil" };

describe("cli-rate-limit · autoFallbackBackend (simetrik + döngüsel faz-içi retry)", () => {
  it("birincil başarılı → birincil sonucu, ikincil ÇAĞRILMAZ", async () => {
    const p = fakeBackend({ kind: "approved" });
    const s = fakeBackend({ kind: "approved" });
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL);
    const r = await wrapped.run();
    expect(r.kind).toBe("approved");
    expect(p.calls.run).toBe(1);
    expect(s.calls.run).toBe(0);
  });

  it("birincil 'failed' → ikincile KESİNTİSİZ geçer (simetrik; limit gerekmez)", async () => {
    const p = fakeBackend({ kind: "failed" });
    const s = fakeBackend({ kind: "approved" });
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL);
    const r = await wrapped.run();
    expect(p.calls.run).toBe(1);
    expect(s.calls.run).toBe(1);
    expect(r.kind).toBe("approved"); // ikincil sonucu
  });

  it("birincil 'aborted' → geçiş YOK (kullanıcı iptali)", async () => {
    const p = fakeBackend({ kind: "aborted" });
    const s = fakeBackend({ kind: "approved" });
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL);
    const r = await wrapped.run();
    expect(r.kind).toBe("aborted");
    expect(s.calls.run).toBe(0);
  });

  it("ikisi de 'failed' → DÖNGÜSEL: dönüşümlü tekrar dener, üst sınırda (6) son failed döner", async () => {
    const p = fakeBackend({ kind: "failed" });
    const s = fakeBackend({ kind: "failed" });
    // backoffMs=0 enjekte: test yavaşlamasın (prod artan backoff)
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL, { backoffMs: () => 0 });
    const r = await wrapped.run();
    expect(p.calls.run).toBe(3); // 6 deneme dönüşümlü: p,s,p,s,p,s
    expect(s.calls.run).toBe(3);
    expect(r.kind).toBe("failed"); // ikisi de kalıcı down → dürüst hata
  });

  it("birincil 2 kez failed sonra başarır → döngü o noktada biter", async () => {
    let pRuns = 0;
    const pBackend = {
      run: async (): Promise<Outcome> => ({ kind: pRuns++ < 2 ? "failed" : "approved" }),
      submitAskqAnswer: (_id: string, _sel: string) => {},
      abort: () => {},
    };
    const s = fakeBackend({ kind: "failed" });
    // p:fail, s:fail, p:fail, s:fail, p:approved(3.) → 5. denemede biter
    const wrapped = autoFallbackBackend(() => pBackend, () => s.backend, LBL, { backoffMs: () => 0 });
    const r = await wrapped.run();
    expect(r.kind).toBe("approved");
    expect(pRuns).toBe(3); // p 3 kez koştu (3.'sü başardı)
  });

  // Canlı kanıt (2026-06-17): API "credit balance too low" → SDK THROW → eski döngü
  // try-catch'siz çöküyordu (CLI'ye geri dönemiyordu). Fix: exception = "bu kanal
  // çalışmıyor", diğerine geç.
  it("bir kanal run() EXCEPTION fırlatırsa döngü kırılmaz — diğerine ısrar eder", async () => {
    let pRuns = 0;
    const pBackend = {
      run: async (): Promise<Outcome> => {
        pRuns++;
        if (pRuns < 3) throw new Error("transient down");
        return { kind: "approved" };
      },
      submitAskqAnswer: (_id: string, _sel: string) => {},
      abort: () => {},
    };
    const sBackend = {
      run: async (): Promise<Outcome> => {
        throw new Error("credit balance too low");
      },
      submitAskqAnswer: (_id: string, _sel: string) => {},
      abort: () => {},
    };
    const wrapped = autoFallbackBackend(() => pBackend, () => sBackend, LBL, { backoffMs: () => 0 });
    const r = await wrapped.run();
    expect(r.kind).toBe("approved"); // s HEP throw etse de döngü dönüp p'yi tekrar denedi
    expect(pRuns).toBe(3); // p attempt 0,2,4 → 3. koşuda başardı
  });

  it("ikisi de hep EXCEPTION → üst sınırda son exception yukarı fırlatılır (sessiz yutma yok)", async () => {
    const boom = {
      run: async (): Promise<Outcome> => {
        throw new Error("kanal down");
      },
      submitAskqAnswer: (_id: string, _sel: string) => {},
      abort: () => {},
    };
    const wrapped = autoFallbackBackend(() => boom, () => boom, LBL, { backoffMs: () => 0 });
    await expect(wrapped.run()).rejects.toThrow("kanal down");
  });

  it("submitAskqAnswer/abort aktif backend'e yönlenir", async () => {
    const p = fakeBackend({ kind: "approved" });
    const s = fakeBackend({ kind: "approved" });
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL);
    wrapped.submitAskqAnswer?.("id", "ans");
    wrapped.abort?.();
    expect(p.calls.submit).toBe(1);
    expect(p.calls.abort).toBe(1);
  });
});

describe("cli-rate-limit · autoBackendPair (yön seçimi)", () => {
  it("effective='cli' → CLI birincil (limit yok senaryosu: CLI→API)", async () => {
    const cli = fakeBackend({ kind: "failed" });
    const api = fakeBackend({ kind: "approved" });
    const wrapped = autoBackendPair("cli", () => cli.backend, () => api.backend);
    await wrapped.run();
    expect(cli.calls.run).toBe(1); // CLI önce
    expect(api.calls.run).toBe(1); // sonra API
  });

  it("effective='api' → API birincil (limit penceresi: API→CLI)", async () => {
    const cli = fakeBackend({ kind: "approved" });
    const api = fakeBackend({ kind: "failed" });
    const wrapped = autoBackendPair("api", () => cli.backend, () => api.backend);
    await wrapped.run();
    expect(api.calls.run).toBe(1); // API önce
    expect(cli.calls.run).toBe(1); // sonra CLI
  });
});

describe("cli-rate-limit · autoFallbackBackend (kalıcı hata → döngü kırma; YZLLM kredi-bitti bug'ı)", () => {
  const isPermanent = (s: string) => /credit balance/i.test(s);

  it("birinci kanal KALICI hata (throw) → döngü 1 denemede KIRILIR (6 değil); ikinci kanala bile gitmez", async () => {
    let primaryRuns = 0;
    let secondaryRuns = 0;
    const makePrimary = () => ({
      run: async (): Promise<Outcome> => {
        primaryRuns++;
        throw new Error("Your credit balance is too low");
      },
    });
    const makeSecondary = () => ({
      run: async (): Promise<Outcome> => {
        secondaryRuns++;
        throw new Error("Your credit balance is too low");
      },
    });
    const wrapped = autoFallbackBackend(makePrimary, makeSecondary, LBL, { isPermanent, backoffMs: () => 0 });
    await expect(wrapped.run()).rejects.toThrow(/credit balance/);
    expect(primaryRuns + secondaryRuns).toBe(1); // kalıcı → tek deneme, boş döngü yok
  });

  it("isPermanent YOK (eski davranış) → aynı throw 6 deneme döner (regresyon guard)", async () => {
    let runs = 0;
    const make = () => ({
      run: async (): Promise<Outcome> => {
        runs++;
        throw new Error("boom");
      },
    });
    const wrapped = autoFallbackBackend(make, make, LBL, { backoffMs: () => 0 });
    await expect(wrapped.run()).rejects.toThrow(/boom/);
    expect(runs).toBe(6); // MAX_FALLBACK_ATTEMPTS — kalıcı işaretlenmeyen hata gidip gelir
  });

  it("KALICI 'failed' outcome → döngü kırılır, ikinci kanal denenmez", async () => {
    let primaryRuns = 0;
    let secondaryRuns = 0;
    const makePrimary = () => ({
      run: async (): Promise<Outcome> =>
        ((primaryRuns++, { kind: "failed", reason: "credit balance too low" }) as Outcome),
    });
    const makeSecondary = () => ({
      run: async (): Promise<Outcome> => ((secondaryRuns++, { kind: "approved" }) as Outcome),
    });
    const wrapped = autoFallbackBackend(makePrimary, makeSecondary, LBL, { isPermanent, backoffMs: () => 0 });
    const r = await wrapped.run();
    expect(r.kind).toBe("failed");
    expect(primaryRuns).toBe(1);
    expect(secondaryRuns).toBe(0);
  });
});
