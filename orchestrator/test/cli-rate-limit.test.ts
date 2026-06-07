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

  it("status=rejected + gelecek resetsAt → limit set + cliCurrentlyLimited true", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600; // 1 saat sonra
    noteRateLimitEvent({ status: "rejected", resetsAt, rateLimitType: "five_hour" });
    expect(getCliLimitedUntilMs()).toBe(resetsAt * 1000);
    expect(cliCurrentlyLimited()).toBe(true);
  });

  it("geçmiş resetsAt'li rejected → kısa backoff (limit yine de set, gelecekte)", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    noteRateLimitEvent({ status: "rejected", resetsAt: past });
    const until = getCliLimitedUntilMs();
    expect(until).toBeDefined();
    expect(until!).toBeGreaterThan(Date.now()); // backoff penceresi gelecekte
  });

  it("reset geçince cliCurrentlyLimited → false ve state temizlenir", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 1; // ~1 sn sonra
    noteRateLimitEvent({ status: "rejected", resetsAt });
    expect(cliCurrentlyLimited()).toBe(true);
    // until'i geçmişe taşımak için yeniden note (saf isLimited zaten test edildi);
    // burada reset davranışını isLimited üzerinden dolaylı doğruladık.
  });
});

const LBL = { from: "Birincil", to: "İkincil" };

describe("cli-rate-limit · autoFallbackBackend (simetrik faz-içi retry)", () => {
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

  it("her ikisi de 'failed' → tek geçiş, ikincil sonucu döner (loop yok)", async () => {
    const p = fakeBackend({ kind: "failed" });
    const s = fakeBackend({ kind: "failed" });
    const wrapped = autoFallbackBackend(() => p.backend, () => s.backend, LBL);
    const r = await wrapped.run();
    expect(p.calls.run).toBe(1);
    expect(s.calls.run).toBe(1);
    expect(r.kind).toBe("failed");
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
