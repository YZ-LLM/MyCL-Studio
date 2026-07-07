// edd/progress — resumable ilerleme ledger'ı (append-only + patch + fold). Resume doğruluğu kritik → izole test.
// İzolasyon (YZLLM "sahte cevaplar sistemde kalmasın"): her test geçici dizinde; bittiğinde silinir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEddUnit,
  patchEddUnit,
  readEddProgress,
  summarizeProgress,
} from "../src/edd/progress.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edd-prog-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("edd/progress · resumable ledger", () => {
  it("append (pending) → read → pending; boş projede boş map", async () => {
    expect((await readEddProgress(root)).size).toBe(0);
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    const m = await readEddProgress(root);
    expect(m.get("src/a.ts")?.status).toBe("pending");
  });

  it("patch done + davranış + hash → read en son durumu döner (fold)", async () => {
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    await patchEddUnit(root, "src/a.ts", {
      status: "done",
      hash: "abc123",
      behavior: { what_it_does: "auth guard", invariants: ["401 on no token"], side_effects: [] },
    });
    const r = (await readEddProgress(root)).get("src/a.ts");
    expect(r?.status).toBe("done");
    expect(r?.hash).toBe("abc123");
    expect(r?.behavior?.what_it_does).toBe("auth guard");
    expect(r?.behavior?.invariants).toEqual(["401 on no token"]);
  });

  it("unanalyzable birim sebebiyle kaydolur (sessiz atlanmaz)", async () => {
    await appendEddUnit(root, { unit: "logo.png", status: "unanalyzable", reason: "binary", ts: 1 });
    const r = (await readEddProgress(root)).get("logo.png");
    expect(r?.status).toBe("unanalyzable");
    expect(r?.reason).toBe("binary");
  });

  it("aynı birime birden çok patch → SON kazanır (resume: yeniden analiz)", async () => {
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    await patchEddUnit(root, "src/a.ts", { status: "done", hash: "v1" });
    await patchEddUnit(root, "src/a.ts", { status: "pending" }); // bayat → yeniden pending (Faz 4)
    expect((await readEddProgress(root)).get("src/a.ts")?.status).toBe("pending");
  });

  it("summarize: done/unanalyzable/pending doğru sayar (N/N kapsam kanıtı)", async () => {
    await appendEddUnit(root, { unit: "a", status: "pending", ts: 1 });
    await appendEddUnit(root, { unit: "b", status: "pending", ts: 1 });
    await appendEddUnit(root, { unit: "c.bin", status: "unanalyzable", reason: "binary", ts: 1 });
    await patchEddUnit(root, "a", { status: "done", behavior: { what_it_does: "x", invariants: [], side_effects: [] } });
    const s = summarizeProgress(await readEddProgress(root));
    expect(s).toEqual({ total: 3, done: 1, unanalyzable: 1, pending: 1 });
  });

  it("bozuk/kısmi satır (çökme yarım-yazım) atlanır — resume dayanıklı", async () => {
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    // Elle bozuk satır ekle (yarım-yazım simülasyonu)
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, ".mycl", "edd-progress.jsonl"), '{"unit":"src/b.ts","stat', "utf-8");
    const m = await readEddProgress(root);
    expect(m.get("src/a.ts")?.status).toBe("pending"); // sağlam kayıt okundu
    expect(m.has("src/b.ts")).toBe(false); // bozuk satır atlandı
  });
});
