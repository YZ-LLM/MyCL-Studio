// edd/engine reconcileEddStaleness — Faz 4 bayatlama uzlaşması (+ mahkeme fix'leri). Bayat sözleşme sessizce
// kullanılmasın (KATI#4): değişmiş → pending, silinmiş/dev → unanalyzable, doğrulanamaz done → pending, geri gelen → revive.
// İzolasyon: her test geçici dizinde; bittiğinde silinir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEddUnit, patchEddUnit, readEddProgress } from "../src/edd/progress.js";
import { reconcileEddStaleness } from "../src/edd/engine.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edd-stale-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function hashOf(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex").slice(0, 16);
}

/** done kayıt (+gerçek dosya). hash verilmezse content'ten türetilir; noHash:true → hash undefined (doğrulanamaz done). */
async function addDone(unit: string, content: string, opts: { noHash?: boolean } = {}) {
  const abs = join(root, ...unit.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
  await appendEddUnit(root, { unit, status: "pending", ts: 1 });
  await patchEddUnit(root, unit, {
    status: "done",
    hash: opts.noHash ? undefined : hashOf(content),
    behavior: { what_it_does: `does ${unit}`, invariants: [], side_effects: [] },
  });
  return abs;
}

const ZERO = { invalidated: 0, deleted: 0, tooLarge: 0, revived: 0 };

describe("edd/engine · reconcileEddStaleness (Faz 4)", () => {
  it("değişmemiş birim (hash uyuşur) done kalır; sayaç 0", async () => {
    await addDone("src/a.ts", "content a\n");
    expect(await reconcileEddStaleness(root)).toEqual(ZERO);
    expect((await readEddProgress(root)).get("src/a.ts")?.status).toBe("done");
  });

  it("değişmiş birim (dosya mutasyona uğradı → hash uyuşmaz) → pending", async () => {
    const abs = await addDone("src/a.ts", "content a\n");
    await writeFile(abs, "content a MUTATED\n", "utf-8");
    const rc = await reconcileEddStaleness(root);
    expect(rc.invalidated).toBe(1);
    expect((await readEddProgress(root)).get("src/a.ts")?.status).toBe("pending");
  });

  it("silinmiş birim → unanalyzable('deleted-after-analysis')", async () => {
    const abs = await addDone("src/gone.ts", "content\n");
    await rm(abs, { force: true });
    const rc = await reconcileEddStaleness(root);
    expect(rc.deleted).toBe(1);
    const r = (await readEddProgress(root)).get("src/gone.ts");
    expect(r?.status).toBe("unanalyzable");
    expect(r?.reason).toBe("deleted-after-analysis");
  });

  it("KATI#4 (mahkeme Major): doğrulanamaz done (hash yok) + dosya VAR → pending (yeniden analiz)", async () => {
    await addDone("src/nohash.ts", "content\n", { noHash: true });
    const rc = await reconcileEddStaleness(root);
    expect(rc.invalidated).toBe(1);
    expect((await readEddProgress(root)).get("src/nohash.ts")?.status).toBe("pending");
  });

  it("mahkeme regression (HAYALET pending yok): doğrulanamaz done (hash yok) + dosya SİLİNMİŞ → pending DEĞİL, unanalyzable(deleted)", async () => {
    // markDone analiz-sırasında-silinme senaryosunu simüle et: done + hash yok + dosya artık yok.
    const abs = await addDone("src/ghost.ts", "content\n", { noHash: true });
    await rm(abs, { force: true });
    const rc = await reconcileEddStaleness(root);
    expect(rc.invalidated).toBe(0); // pending'e DÖNMEZ (enumerate silineni listelemez → hayalet olurdu)
    expect(rc.deleted).toBe(1);
    const r = (await readEddProgress(root)).get("src/ghost.ts");
    expect(r?.status).toBe("unanalyzable");
    expect(r?.reason).toBe("deleted-after-analysis");
  });

  it("mahkeme Major (kaynak): analiz sonrası dev dosya (>256KB) → OKUNMADAN unanalyzable('too-large-after-analysis')", async () => {
    const abs = await addDone("src/big.ts", "small\n");
    await writeFile(abs, "x".repeat(300 * 1024), "utf-8"); // 256KB üstü
    const rc = await reconcileEddStaleness(root);
    expect(rc.tooLarge).toBe(1);
    const r = (await readEddProgress(root)).get("src/big.ts");
    expect(r?.status).toBe("unanalyzable");
    expect(r?.reason).toBe("too-large-after-analysis");
  });

  it("mahkeme Minor (revive): silinip GERİ gelen birim → pending (yeniden analiz)", async () => {
    const abs = await addDone("src/back.ts", "content\n");
    await rm(abs, { force: true });
    await reconcileEddStaleness(root); // → unanalyzable(deleted)
    expect((await readEddProgress(root)).get("src/back.ts")?.status).toBe("unanalyzable");
    await writeFile(abs, "content again\n", "utf-8"); // dosya geri geldi
    const rc = await reconcileEddStaleness(root);
    expect(rc.revived).toBe(1);
    expect((await readEddProgress(root)).get("src/back.ts")?.status).toBe("pending");
  });

  it("analiz-dışı (ilk-enumerate binary) birim REVIVE edilmez (kalıcı) — yalnız reconcile-kaynaklı sebepler", async () => {
    await appendEddUnit(root, { unit: "logo.png", status: "unanalyzable", reason: "binary", ts: 1 });
    // gerçek dosya var olsa bile 'binary' sebebi reconcile-kaynaklı değil → dokunma
    await writeFile(join(root, "logo.png"), "not really binary\n", "utf-8");
    const rc = await reconcileEddStaleness(root);
    expect(rc.revived).toBe(0);
    expect((await readEddProgress(root)).get("logo.png")?.status).toBe("unanalyzable");
  });

  it("pending birime dokunmaz (yalnız done + reconcile-unanalyzable işlenir)", async () => {
    await appendEddUnit(root, { unit: "src/p.ts", status: "pending", ts: 1 });
    expect(await reconcileEddStaleness(root)).toEqual(ZERO);
    expect((await readEddProgress(root)).get("src/p.ts")?.status).toBe("pending");
  });

  it("karışık: 1 değişmiş + 1 silinmiş + 1 değişmemiş → doğru sayar + doğru durumlar", async () => {
    const aAbs = await addDone("src/changed.ts", "v1\n");
    const gAbs = await addDone("src/deleted.ts", "x\n");
    await addDone("src/same.ts", "stable\n");
    await writeFile(aAbs, "v2\n", "utf-8");
    await rm(gAbs, { force: true });
    const rc = await reconcileEddStaleness(root);
    expect(rc).toEqual({ invalidated: 1, deleted: 1, tooLarge: 0, revived: 0 });
    const m = await readEddProgress(root);
    expect(m.get("src/changed.ts")?.status).toBe("pending");
    expect(m.get("src/deleted.ts")?.status).toBe("unanalyzable");
    expect(m.get("src/same.ts")?.status).toBe("done");
  });
});
