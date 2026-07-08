// edd/codegen-note — EDD davranış haritasını Faz 8 codegen notuna çevirme (EDD Faz 2). Enjeksiyon doğruluğu kritik:
// yanlış/eksik/bayat not codegen'i yanıltır → izole test. İzolasyon: her test geçici dizinde; bittiğinde silinir.
// Not: buildEddCodegenNote artık GERÇEK dosya okur (bayat-hash koruması) → test birimleri gerçek dosya oluşturur.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEddUnit, patchEddUnit } from "../src/edd/progress.js";
import { buildEddCodegenNote, attachEddCodegenNote } from "../src/edd/codegen-note.js";
import type { State } from "../src/types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edd-note-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Behavior = { what_it_does: string; invariants: string[]; side_effects: string[] };

/** engine.ts markDone/fileHash ile AYNI: sha256 ilk-16 hex — bayat karşılaştırması tutarlı. */
function hashOf(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex").slice(0, 16);
}

/** Gerçek dosya + done kaydı (analiz-anı hash'iyle). mutateAfter → dosya sonradan değişir (bayat). deleteAfter → silinir. */
async function addDone(unit: string, behavior: Behavior, opts: { mutateAfter?: boolean; deleteAfter?: boolean } = {}) {
  const abs = join(root, ...unit.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  const content = `content of ${unit}\n`;
  await writeFile(abs, content, "utf-8");
  await appendEddUnit(root, { unit, status: "pending", ts: 1 });
  await patchEddUnit(root, unit, { status: "done", hash: hashOf(content), behavior });
  if (opts.mutateAfter) await writeFile(abs, content + "MUTATED\n", "utf-8"); // hash uyuşmaz → bayat
  if (opts.deleteAfter) await rm(abs, { force: true }); // ENOENT → inline'dan çıkar
}

/** edd-analysis.md'yi (render çıktısı) simüle et — on-demand işaret yolunu test etmek için. */
async function writeAnalysisMd() {
  await mkdir(join(root, ".mycl"), { recursive: true });
  await writeFile(join(root, ".mycl", "edd-analysis.md"), "# EDD Analiz\n", "utf-8");
}

describe("edd/codegen-note · Faz 8 enjeksiyon notu", () => {
  it("belgelenmiş birim yoksa undefined (no-op — yoksa yok)", async () => {
    expect(await buildEddCodegenNote(root)).toBeUndefined();
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    expect(await buildEddCodegenNote(root)).toBeUndefined(); // sadece pending → not basma
  });

  it("done birim + edd-analysis.md → not: kapsam + on-demand işaret + spec-kazanır çerçevesi + sözleşme", async () => {
    await addDone("src/auth.ts", {
      what_it_does: "auth guard for /api",
      invariants: ["401 when no token"],
      side_effects: ["reads process.env.JWT_SECRET"],
    });
    await writeAnalysisMd();
    const note = await buildEddCodegenNote(root);
    expect(note).toBeDefined();
    expect(note!).toContain("1/1 unit documented");
    expect(note!).toContain(".mycl/edd-analysis.md"); // on-demand tam harita işareti (dosya VAR)
    expect(note!).toContain("SPEC WINS"); // öncelik çerçevesi (bağlam-kısıt değil)
    expect(note!).toContain("src/auth.ts");
    expect(note!).toContain("401 when no token"); // invariant inline
    expect(note!).toContain("reads process.env.JWT_SECRET"); // side-effect inline
  });

  it("KATI#1: not 'blast-radius/most central' iddiası basmaz (yalnız JS/TS/Python'da doğru) — 'Key units' der", async () => {
    await addDone("src/a.ts", { what_it_does: "x", invariants: ["inv"], side_effects: [] });
    await writeAnalysisMd();
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("Key units");
    expect(note!.toLowerCase()).not.toContain("blast-radius");
    expect(note!.toLowerCase()).not.toContain("most central");
  });

  it("KATI#4 bayat koruması: dosya analizden sonra değişmişse '⚠️ CHANGED' işareti (sessiz bayat kullanım yok)", async () => {
    await addDone("src/fresh.ts", { what_it_does: "fresh unit", invariants: ["keep A"], side_effects: [] });
    await addDone("src/stale.ts", { what_it_does: "stale unit", invariants: ["maybe-old B"], side_effects: [] }, { mutateAfter: true });
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("src/stale.ts");
    expect(note!).toContain("⚠️ CHANGED"); // bayat birim görünür işaretli
    // Taze birimde işaret yok (⚠️ yalnız stale bloğunda).
    const freshIdx = note!.indexOf("### src/fresh.ts");
    const staleIdx = note!.indexOf("### src/stale.ts");
    const freshBlock = note!.slice(freshIdx, staleIdx > freshIdx ? staleIdx : undefined);
    expect(freshBlock).not.toContain("⚠️ CHANGED");
  });

  it("silinmiş birim (ENOENT) inline edilmez — var olmayan davranış basılmaz", async () => {
    await addDone("src/kept.ts", { what_it_does: "kept", invariants: ["k"], side_effects: [] });
    await addDone("src/gone.ts", { what_it_does: "gone", invariants: ["g"], side_effects: [] }, { deleteAfter: true });
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("### src/kept.ts");
    expect(note!).not.toContain("### src/gone.ts");
  });

  it("KATI#4: MAX_ITEMS üstü invariant GÖRÜNÜR '+N more' ile kırpılır (sessiz kırpma yok)", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `inv-${i}`);
    await addDone("src/big.ts", { what_it_does: "many invariants", invariants: many, side_effects: [] });
    await writeAnalysisMd();
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("inv-0");
    expect(note!).toContain("inv-5"); // ilk 6 gösterilir
    expect(note!).not.toContain("inv-7"); // 7. kırpıldı
    expect(note!).toContain("and 2 more"); // kırpma görünür işaretli
  });

  it("kısmi kapsam dürüst: done + pending → 'still pending' görünür (sessiz tam-sanma yok)", async () => {
    await addDone("src/a.ts", { what_it_does: "x", invariants: [], side_effects: [] });
    await appendEddUnit(root, { unit: "src/b.ts", status: "pending", ts: 1 });
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("1/2 unit documented");
    expect(note!).toContain("still pending");
  });

  it("edd-analysis.md YOKKEN (render throttle) → sarkan on-demand işaret YOK; inline yine bağlam sağlar", async () => {
    await addDone("src/a.ts", { what_it_does: "does x", invariants: ["inv A"], side_effects: [] });
    const note = await buildEddCodegenNote(root); // edd-analysis.md yazılmadı
    expect(note).toBeDefined();
    expect(note!).not.toContain("The full map is in"); // on-demand talimatı yok (dosya yok)
    expect(note!).not.toContain("read its entry");
    expect(note!).toContain("inv A"); // ama inline sözleşme yine bağlam sağlar
    expect(note!).toContain("SPEC WINS"); // çerçeve yine burada
  });

  it("en fazla 8 birim inline (bounded); kapsam yine TAM sayı", async () => {
    for (let i = 0; i < 10; i++) {
      await addDone(`src/u${i}.ts`, { what_it_does: `unit ${i}`, invariants: [`inv ${i}`], side_effects: [] });
    }
    const note = await buildEddCodegenNote(root);
    expect(note!).toContain("### src/u0.ts");
    expect(note!).toContain("### src/u7.ts");
    expect(note!).not.toContain("### src/u8.ts"); // bounded: ilk 8
    expect(note!).not.toContain("### src/u9.ts");
    expect(note!).toContain("10/10 unit documented"); // inline bounded ama coverage gerçek
  });

  it("attachEddCodegenNote: MyCL kökeninde no-op; foreign'de not kurulur", async () => {
    await addDone("src/a.ts", { what_it_does: "x", invariants: ["keep me"], side_effects: [] });

    const mycl = { project_root: root, origin: "mycl" } as unknown as State;
    await attachEddCodegenNote(mycl);
    expect(mycl.pending_edd_context_note).toBeUndefined(); // EDD yalnız foreign

    const foreign = { project_root: root, origin: "foreign" } as unknown as State;
    await attachEddCodegenNote(foreign);
    expect(foreign.pending_edd_context_note).toBeDefined();
    expect(foreign.pending_edd_context_note!).toContain("keep me");
  });

  it("attach her koşuda taze: önceki iterasyon notu (done birim yokken) sızmaz", async () => {
    const st = { project_root: root, origin: "foreign", pending_edd_context_note: "ESKİ NOT" } as unknown as State;
    await attachEddCodegenNote(st); // bu root'ta done birim yok → undefined'e sıfırlanmalı
    expect(st.pending_edd_context_note).toBeUndefined();
  });
});
