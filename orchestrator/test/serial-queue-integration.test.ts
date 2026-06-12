// serial-queue ENTEGRASYON — index.ts'teki gerçek kabloyu (pipeline-derinlik sayacı + drain hook'u)
// simüle eder. index.ts test-edilemez (modül-seviyesi IPC/spawn) → kritik DEĞİŞMEZİ izole doğrularız:
//
//   "command_direct kuyruğu, pipeline derinliği >0 İKEN asla çalışmaz; tam 0'a inince çalışır;
//    özyinelemeli faz (failPhase→advance) erken drain ETMEZ."
//
// Bu, basit boolean yerine SAYAÇ kullanma kararını kanıtlar: boolean olsaydı iç-içe pipeline'ın
// dönüşü bayrağı false yapıp komutu fazlar ARASINDA çalıştırırdı (race). Sayaç bunu engeller.

import { describe, expect, it } from "vitest";
import { SerialWorkQueue } from "../src/serial-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("serial-queue · pipeline-derinlik entegrasyonu", () => {
  it("pipeline koşarken kuyruğa alınır, derinlik 0'a inince çalışır, özyineleme erken drain etmez", async () => {
    const ran: string[] = [];
    const depth = { v: 0 }; // index.ts'teki _pipelineDepth'in birebir karşılığı

    const queue = new SerialWorkQueue<string>({
      // index.ts: runtime.controller !== null || _handlingUserMessage || _pipelineDepth > 0.
      // Burada kritik kısım derinlik-sayacı (fazlar arası controller=null boşluğunu kapatan).
      isExternallyBusy: () => depth.v > 0,
      exec: async (x) => {
        ran.push(x);
      },
    });

    const outerBoundary = deferred();

    // advanceToNextPhase'in sarmalayıcısını taklit: girişte ++, çıkışta (finally) --, derinlik 0'da drain.
    // `recurse=true` dış pipeline; içinde bir kez kendini çağırır = failPhase→advance özyinelemesi.
    async function pipeline(recurse: boolean): Promise<void> {
      depth.v++;
      try {
        await Promise.resolve(); // faz sınırı (controller geçici null olurdu — gerçek koddaki await boşluğu)
        if (recurse) {
          await pipeline(false); // iç-içe (nested) — döndüğünde derinlik 2→1, 0 DEĞİL
          await outerBoundary.promise; // dış pipeline bir faz sınırında bekler
        }
      } finally {
        depth.v--;
        if (depth.v === 0) void queue.drain();
      }
    }

    const p = pipeline(true); // başlat (await etme) → ilk await'te derinlik=1, kontrol teste döner

    // Pipeline koşuyor (derinlik>0) — şimdi bir command_direct gelir.
    const queued = await queue.submit("build");
    expect(queued).toBe(false); // DÜŞMEDİ, kuyruğa girdi
    expect(queue.size).toBe(1);
    expect(ran).toEqual([]); // pipeline ortasında ASLA çalışmadı

    // İç-içe pipeline bu ana kadar tamamlanmış olmalı (derinlik 2→1). Boolean olsaydı burada drain olurdu.
    await tick();
    expect(ran).toEqual([]); // KANIT: özyineleme dönüşü erken drain ETMEDİ (sayaç hâlâ 1)
    expect(depth.v).toBe(1);

    // Dış pipeline son faz sınırını geçer → derinlik 0 → drain → komut ŞİMDİ çalışır.
    outerBoundary.resolve();
    await p;
    await tick();
    expect(ran).toEqual(["build"]);
    expect(depth.v).toBe(0);
    expect(queue.size).toBe(0);
  });

  it("pipeline bitince kuyruktaki ÇOK iş FIFO sırayla işlenir (drain zinciri)", async () => {
    const ran: string[] = [];
    const depth = { v: 0 };
    const queue = new SerialWorkQueue<string>({
      isExternallyBusy: () => depth.v > 0,
      exec: async (x) => {
        ran.push(x);
      },
    });
    const boundary = deferred();
    async function pipeline(): Promise<void> {
      depth.v++;
      try {
        await boundary.promise;
      } finally {
        depth.v--;
        if (depth.v === 0) void queue.drain();
      }
    }
    const p = pipeline();
    await queue.submit("install");
    await queue.submit("build");
    await queue.submit("test");
    expect(ran).toEqual([]);
    boundary.resolve();
    await p;
    await tick();
    expect(ran).toEqual(["install", "build", "test"]); // FIFO, sırayla
  });
});
