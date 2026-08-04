// persistSelectedModels — alan bazlı merge + AÇIK temizleme.
//
// NEDEN (YZLLM 2026-08-04): merge boş/eksik değeri "mevcut değeri koru" sayıyor. Bu koruma 2026-06-07'de
// bilinçli eklendi (eksik arayüz yükü mevcut per-rol modeli sessizce silmesin). Ama yan etkisi şuydu:
// opsiyonel bir alan bir kez set edildikten sonra arayüzden GERİ ALINAMIYORDU. "Plan modeli boş
// bırakılırsa bugünkü davranış sürer" sözü, boş bırakabilmeyi gerektiriyor.
//
// Testler GERÇEK diske değil, MYCL_HOME ile geçici dizine yazar — kullanıcının ~/.mycl dosyasına dokunmaz.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { persistSelectedModels, readSelectedModels, type SelectedModels } from "../src/config.js";

let dir = "";
let prevHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mycl-cfg-"));
  prevHome = process.env.MYCL_HOME;
  process.env.MYCL_HOME = dir;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = prevHome;
  await rm(dir, { recursive: true, force: true });
});

const base: SelectedModels = { translator: "claude-haiku-4-5", main: "claude-opus-5" };

describe("persistSelectedModels", () => {
  it("geçici dizine yazar (kullanıcının gerçek config'i etkilenmez)", async () => {
    await persistSelectedModels(base);
    await expect(fs.access(join(dir, "config.json"))).resolves.toBeUndefined();
  });

  it("plan_model yazılır ve okunur", async () => {
    await persistSelectedModels({ ...base, plan_model: "claude-fable-5" });
    expect((await readSelectedModels())?.plan_model).toBe("claude-fable-5");
  });

  it("KORUMA: sonraki kayıt alanı taşımıyorsa plan_model SİLİNMEZ", async () => {
    await persistSelectedModels({ ...base, plan_model: "claude-fable-5" });
    await persistSelectedModels(base); // eksik yük — 2026-06-07 koruması
    expect((await readSelectedModels())?.plan_model).toBe("claude-fable-5");
  });

  it("AÇIK TEMİZLEME: clear listesi verilirse alan gerçekten silinir", async () => {
    await persistSelectedModels({ ...base, plan_model: "claude-fable-5" });
    await persistSelectedModels(base, { clear: ["plan_model"] });
    expect((await readSelectedModels())?.plan_model).toBeUndefined();
  });

  it("temizleme YALNIZ istenen alanı siler — diğerleri korunur", async () => {
    await persistSelectedModels({
      ...base,
      plan_model: "claude-fable-5",
      orchestrator: "claude-opus-5",
      model_tiers: { strong: "claude-opus-5" },
    });
    await persistSelectedModels(base, { clear: ["plan_model"] });
    const sel = await readSelectedModels();
    expect(sel?.plan_model).toBeUndefined();
    expect(sel?.orchestrator).toBe("claude-opus-5");
    expect(sel?.model_tiers?.strong).toBe("claude-opus-5");
    expect(sel?.main).toBe("claude-opus-5");
  });
});
