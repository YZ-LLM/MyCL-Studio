// edd/grounding — Faz 1 (niyet) + Faz 9 (risk) kompakt davranış zemini (EDD Faz 3). İnline-only + foreign-gate +
// silinmiş-birim atlama doğruluğu kritik → izole test. İzolasyon: her test geçici dizinde; bittiğinde silinir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEddUnit, patchEddUnit } from "../src/edd/progress.js";
import { buildEddGroundingOverview, eddGroundingForState } from "../src/edd/grounding.js";
import type { State } from "../src/types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edd-ground-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function addDone(unit: string, what: string, opts: { deleteAfter?: boolean } = {}) {
  const abs = join(root, ...unit.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `content of ${unit}\n`, "utf-8");
  await appendEddUnit(root, { unit, status: "pending", ts: 1 });
  await patchEddUnit(root, unit, { status: "done", behavior: { what_it_does: what, invariants: [], side_effects: [] } });
  if (opts.deleteAfter) await rm(abs, { force: true });
}

/** edd-analysis.md'yi (render çıktısı) simüle et — koşullu on-demand pointer'ı test etmek için. */
async function writeAnalysisMd() {
  await mkdir(join(root, ".mycl"), { recursive: true });
  await writeFile(join(root, ".mycl", "edd-analysis.md"), "# EDD Analiz\n", "utf-8");
}

describe("edd/grounding · Faz 1/9 kompakt zemin", () => {
  it("belgelenmiş birim yoksa undefined (no-op)", async () => {
    expect(await buildEddGroundingOverview(root)).toBeUndefined();
    await appendEddUnit(root, { unit: "src/a.ts", status: "pending", ts: 1 });
    expect(await buildEddGroundingOverview(root)).toBeUndefined(); // sadece pending
  });

  it("done birimler → bir-satır özet + kapsam + BAĞLAM çerçevesi (kısıt değil)", async () => {
    await addDone("src/auth.ts", "guards /api routes with JWT");
    await addDone("src/pay.ts", "charges the customer via Stripe");
    const ov = await buildEddGroundingOverview(root);
    expect(ov).toBeDefined();
    expect(ov!).toContain("2/2 unit documented");
    expect(ov!).toContain("- src/auth.ts: guards /api routes with JWT");
    expect(ov!).toContain("- src/pay.ts: charges the customer via Stripe");
    expect(ov!).toContain("CONTEXT"); // bağlam, kısıt değil
    expect(ov!).toContain("spec still drives"); // spec sürer
  });

  it("edd-analysis.md YOKKEN koşullu pointer YOK (var olmayan dosyaya yollamaz — KATI#4)", async () => {
    await addDone("src/a.ts", "does a");
    const ov = await buildEddGroundingOverview(root); // analysis.md yazılmadı
    expect(ov!).not.toContain(".mycl/edd-analysis.md");
  });

  it("edd-analysis.md VARKEN koşullu pointer VAR (Read'li CLI ajanı derin sözleşmeyi okur — 'dosya erişimin varsa')", async () => {
    await addDone("src/a.ts", "does a");
    await writeAnalysisMd();
    const ov = await buildEddGroundingOverview(root);
    expect(ov!).toContain(".mycl/edd-analysis.md");
    expect(ov!).toContain("if you have file access"); // koşullu → Read'siz ajan zararsızca yok sayar
  });

  it("notShown: boş what_it_does'lu done birim mesajı ŞİŞİRMEZ (mahkeme minor)", async () => {
    await addDone("src/a.ts", "real unit");
    // Boş what_it_does'lu done birim (analyzer alanı atladı) — s.done'a sayılır ama listelenmez.
    await appendEddUnit(root, { unit: "src/empty.ts", status: "pending", ts: 1 });
    await patchEddUnit(root, "src/empty.ts", { status: "done", behavior: { what_it_does: "", invariants: [], side_effects: [] } });
    const ov = await buildEddGroundingOverview(root);
    expect(ov!).toContain("2/2 unit documented"); // kapsam gerçek
    expect(ov!).not.toContain("more unit(s) not shown"); // 1 gösterildi + 1 boş düşüldü → notShown=0 (şişmedi)
  });

  it("silinmiş birim listelenmez (var olmayan davranış basılmaz)", async () => {
    await addDone("src/kept.ts", "kept unit");
    await addDone("src/gone.ts", "gone unit", { deleteAfter: true });
    const ov = await buildEddGroundingOverview(root);
    expect(ov!).toContain("src/kept.ts");
    expect(ov!).not.toContain("src/gone.ts");
    expect(ov!).toContain("2/2 unit documented"); // kapsam gerçek sayı (silinme listeleme kararından bağımsız)
  });

  it("kısmi kapsam dürüst: done + pending → 'still pending' görünür", async () => {
    await addDone("src/a.ts", "does a");
    await appendEddUnit(root, { unit: "src/b.ts", status: "pending", ts: 1 });
    const ov = await buildEddGroundingOverview(root);
    expect(ov!).toContain("1/2 unit documented");
    expect(ov!).toContain("still pending");
  });

  it("eddGroundingForState: MyCL kökeninde undefined (no-op); foreign'de zemin döner", async () => {
    await addDone("src/a.ts", "does a");
    const mycl = { project_root: root, origin: "mycl" } as unknown as State;
    expect(await eddGroundingForState(mycl)).toBeUndefined();
    const foreign = { project_root: root, origin: "foreign" } as unknown as State;
    const g = await eddGroundingForState(foreign);
    expect(g).toBeDefined();
    expect(g!).toContain("does a");
  });
});
