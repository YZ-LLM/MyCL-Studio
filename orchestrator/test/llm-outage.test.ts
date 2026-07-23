// llm-outage — iki Claude kanalı da kapalıyken bekle-ve-devam testleri (YZLLM 2026-07-17:
// "5 dakikada bir denesin. ya da aboneliğin ne zaman açılacağını biliyorsa o zaman devam etsin").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armLlmOutageWait,
  cancelLlmOutageWait,
  computeRetryAtMs,
  isLlmOutageWaiting,
  LONG_WAIT_PROBE_INTERVAL_MS,
  OUTAGE_RETRY_INTERVAL_MS,
} from "../src/llm-outage.js";
import { noteCliRateLimitError, noteRateLimitEvent, resetCliRateLimitState } from "../src/cli-rate-limit.js";

describe("computeRetryAtMs (saf)", () => {
  const NOW = 1_000_000_000_000;
  it("reset bilinmiyor → şimdi + 5 dk", () => {
    expect(computeRetryAtMs(undefined, NOW)).toBe(NOW + OUTAGE_RETRY_INTERVAL_MS);
  });
  it("reset yakında (<1 saat) → reset + 1 dk tampon (kullanıcı: 'o zaman devam etsin')", () => {
    const reset = NOW + 30 * 60_000;
    expect(computeRetryAtMs(reset, NOW)).toBe(reset + 60_000);
  });
  it("reset UZAKTA (>1 saat, örn. 7 günlük pencere) → saatlik ara yoklama (YZLLM 'evet ekle')", () => {
    const reset = NOW + 7 * 24 * 60 * 60_000;
    expect(computeRetryAtMs(reset, NOW)).toBe(NOW + LONG_WAIT_PROBE_INTERVAL_MS);
  });
  it("reset geçmişte kalmış → 5 dk aralığına düş", () => {
    expect(computeRetryAtMs(NOW - 1000, NOW)).toBe(NOW + OUTAGE_RETRY_INTERVAL_MS);
  });
});

describe("armLlmOutageWait / fire / cancel (sahte zamanlayıcı)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCliRateLimitState();
    cancelLlmOutageWait();
  });
  afterEach(() => {
    cancelLlmOutageWait();
    resetCliRateLimitState();
    vi.useRealTimers();
  });

  it("reset bilinmiyor → 5 dk sonra resume çağrılır; başarıda bekleme biter", async () => {
    const resume = vi.fn(async () => {});
    armLlmOutageWait("test kesintisi", resume);
    expect(isLlmOutageWaiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(isLlmOutageWaiting()).toBe(false);
  });

  it("AKTİF abonelik limiti + resetsAt yakında → deneme reset saatinde (5 dk'da değil)", async () => {
    const resetSec = Math.floor((Date.now() + 30 * 60_000) / 1000); // 30 dk sonra
    noteRateLimitEvent({ status: "allowed", resetsAt: resetSec });
    noteCliRateLimitError("usage-limit"); // aktif limit → _limitedUntilMs = resetsAt
    const resume = vi.fn(async () => {});
    armLlmOutageWait("abonelik limiti", resume);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000); // 5 dk'da ateşlenmemeli
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(27 * 60_000); // reset + tampon geçti
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("AKTİF limit + reset ÇOK uzakta (7 gün) → saatlik yoklama (7 gün körü körüne beklenmez)", async () => {
    const resetSec = Math.floor((Date.now() + 7 * 24 * 60 * 60_000) / 1000);
    noteRateLimitEvent({ status: "allowed", resetsAt: resetSec });
    noteCliRateLimitError("usage-limit");
    const resume = vi.fn(async () => {});
    armLlmOutageWait("abonelik limiti (7 gün)", resume);
    await vi.advanceTimersByTimeAsync(LONG_WAIT_PROBE_INTERVAL_MS + 1000); // 1 saat
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("MAHKEME: aktif limit YOK (yalnız servis edilmiş event'ten resetsAt görüldü) → 5 dk aralığı", async () => {
    const resetSec = Math.floor((Date.now() + 60 * 60_000) / 1000);
    noteRateLimitEvent({ status: "allowed", resetsAt: resetSec }); // blok DEĞİL — sadece gözlem
    const resume = vi.fn(async () => {});
    armLlmOutageWait("API 529", resume);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(resume).toHaveBeenCalledTimes(1); // ilgisiz pencere resetine kilitlenmedi
  });

  it("resume patlarsa deneme kaybolmaz → 5 dk sonra tekrar", async () => {
    let calls = 0;
    const resume = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("hâlâ kapalı");
    });
    armLlmOutageWait("test", resume);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(calls).toBe(1);
    expect(isLlmOutageWaiting()).toBe(true); // yeniden kuruldu
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(calls).toBe(2);
  });

  it("ikinci arm zamanlayıcıyı çiftlemez; SON resume kazanır (en son kesilen iş)", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    armLlmOutageWait("a", first);
    armLlmOutageWait("b", second);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancel → zamanlayıcı temizlenir, resume asla çağrılmaz", async () => {
    const resume = vi.fn(async () => {});
    armLlmOutageWait("test", resume);
    cancelLlmOutageWait();
    expect(isLlmOutageWaiting()).toBe(false);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS * 3);
    expect(resume).not.toHaveBeenCalled();
  });

  // MAHKEME CRITICAL (2026-07-23): "skipped" (meşgul/askq — gerçek deneme yok) beklemeyi SONLANDIRMAZ —
  // eski davranış sessizce sonlanıp kuyruksuz faz-vuruş köşesinde kalıcı durmaya yol açıyordu.
  it("resume 'skipped' dönerse bekleme SÜRER → 5 dk sonra yine denenir; 'resumed' olunca biter", async () => {
    const results: Array<"skipped" | "resumed"> = ["skipped", "skipped", "resumed"];
    const resume = vi.fn(async () => results.shift() ?? ("resumed" as const));
    armLlmOutageWait("test (askq asılı)", resume);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(isLlmOutageWaiting()).toBe(true); // skipped → sessiz yeniden kuruldu
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(isLlmOutageWaiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(resume).toHaveBeenCalledTimes(3); // resumed → bekleme bitti
    expect(isLlmOutageWaiting()).toBe(false);
  });

  it("void dönüş (eski imza) 'resumed' sayılır — geriye uyum", async () => {
    const resume = vi.fn(async () => {});
    armLlmOutageWait("test", resume);
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_INTERVAL_MS + 1000);
    expect(isLlmOutageWaiting()).toBe(false); // sonlandı (yeniden kurulmadı)
  });
});
