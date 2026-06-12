// serial-queue — busy iken kuyruğa al, boşa çıkınca SIRAYLA işle; düşürme yok.

import { describe, expect, it } from "vitest";
import { SerialWorkQueue } from "../src/serial-queue.js";

// Mikro-deferred: sıralamayı deterministik kontrol etmek için elle çözülen promise.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("serial-queue · SerialWorkQueue", () => {
  it("dış meşgul değilse hemen çalışır (submit → true)", async () => {
    const ran: string[] = [];
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => false,
      exec: async (x) => {
        ran.push(x);
      },
    });
    const immediate = await q.submit("a");
    expect(immediate).toBe(true);
    expect(ran).toEqual(["a"]);
  });

  it("dış meşgulse kuyruğa alınır (submit → false), drain ile boşa çıkınca çalışır", async () => {
    const ran: string[] = [];
    let busy = true;
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => busy,
      exec: async (x) => {
        ran.push(x);
      },
    });
    const queued = await q.submit("a");
    expect(queued).toBe(false);
    expect(ran).toEqual([]); // henüz çalışmadı
    expect(q.size).toBe(1);
    // Dış iş bitti → boşa çık → drain
    busy = false;
    await q.drain();
    expect(ran).toEqual(["a"]);
    expect(q.size).toBe(0);
  });

  it("birden fazla kuyruğa alınan iş FIFO sırada zincirlenir (tek drain hepsini boşaltır)", async () => {
    const ran: string[] = [];
    let busy = true;
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => busy,
      exec: async (x) => {
        ran.push(x);
      },
    });
    await q.submit("a");
    await q.submit("b");
    await q.submit("c");
    expect(q.size).toBe(3);
    busy = false;
    await q.drain(); // runExclusive finally → drain zinciri → hepsi
    expect(ran).toEqual(["a", "b", "c"]);
    expect(q.size).toBe(0);
  });

  it("çalışan iş varken gelen yeni iş kuyruğa girer (running = meşgul), bitince çalışır", async () => {
    const ran: string[] = [];
    const gate = deferred();
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => false,
      exec: async (x) => {
        ran.push(`start:${x}`);
        if (x === "a") await gate.promise; // a'yı askıda tut
        ran.push(`end:${x}`);
      },
    });
    const p = q.submit("a"); // çalışmaya başlar, gate'te bekler
    // a çalışırken b gelir → running=true → kuyruğa
    const queued = await q.submit("b");
    expect(queued).toBe(false);
    expect(ran).toEqual(["start:a"]);
    gate.resolve(); // a biter → finally → drain → b
    await p;
    // b'nin tamamlanmasını bekle (zincir mikro-task)
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ran).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("exec throw etse bile running temizlenir + sonraki iş çalışır (kalıcı kilit yok)", async () => {
    const ran: string[] = [];
    let busy = true;
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => busy,
      exec: async (x) => {
        if (x === "a") throw new Error("boom");
        ran.push(x);
      },
    });
    await q.submit("a");
    await q.submit("b");
    busy = false;
    await q.drain().catch(() => undefined); // a throw eder ama finally→drain→b
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(q.isRunning).toBe(false);
    expect(ran).toEqual(["b"]);
  });

  it("clear bekleyenleri atar", async () => {
    let busy = true;
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => busy,
      exec: async () => undefined,
    });
    await q.submit("a");
    await q.submit("b");
    expect(q.size).toBe(2);
    q.clear();
    expect(q.size).toBe(0);
    busy = false;
    await q.drain();
    expect(q.size).toBe(0);
  });

  it("onEnqueue/onResume bildirimleri doğru pozisyon/kalan ile çağrılır", async () => {
    const enq: Array<[string, number]> = [];
    const res: Array<[string, number]> = [];
    let busy = true;
    const q = new SerialWorkQueue<string>({
      isExternallyBusy: () => busy,
      exec: async () => undefined,
      onEnqueue: (x, pos) => enq.push([x, pos]),
      onResume: (x, rem) => res.push([x, rem]),
    });
    await q.submit("a");
    await q.submit("b");
    expect(enq).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    busy = false;
    await q.drain();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(res).toEqual([
      ["a", 1], // a alınırken kuyrukta b kaldı
      ["b", 0],
    ]);
  });
});
