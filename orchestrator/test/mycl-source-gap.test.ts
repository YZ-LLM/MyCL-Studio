// mycl-source-gap — "bunu projede çözemem, kendi kaynağım gelişmeli" boşlukları.
//
// NEDEN (YZLLM 2026-09-11): adli öz denetim Faz 11'in (sadeleştirme) 94 iterasyonda BİR KEZ bile
// koşmadığını gösterdi — aracı yalnız TypeScript'e bakıyor, proje JavaScript. Hiçbir proje tarafı iş
// bunu çözemez. Bugüne kadar bu durum "uygulanamaz" diye nötr gösterilip orada ölüyordu.
// YZLLM kararı: görünür kılmak yetmez, çözümü için yapıştırılabilir bir iş tanımı da üretilsin.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  buildSourcePrompt,
  classifyGapOwner,
  persistSourcePrompt,
  sourceGapKey,
  type SourceGap,
} from "../src/mycl-source-gap.js";

describe("classifyGapOwner — çözüm kimde", () => {
  it("MyCL kaynağı: kendi aracı bozuk ya da aracı tek dile bağlı", () => {
    expect(classifyGapOwner("mycl_tool_broken cmd=\"node arch-check.mjs\"")).toBe("mycl-source");
    expect(classifyGapOwner("ts_tool_js_project")).toBe("mycl-source");
    expect(classifyGapOwner("ts_tool_not_applicable")).toBe("mycl-source");
  });

  it("proje tarafı: araç projede eksik (mevcut 'aracı kur' işi zaten üstleniyor)", () => {
    expect(classifyGapOwner('missing_command cmd="gitleaks detect"')).toBe("project");
    expect(classifyGapOwner("stub_script")).toBe("project");
    expect(classifyGapOwner("redundant_gate_command")).toBe("project");
  });

  it("YANLIŞ ALARM YOK: tanınmayan/boş neden iş üretmez", () => {
    expect(classifyGapOwner("aborted")).toBe("not-applicable");
    expect(classifyGapOwner("profile_resolve_null gap=x covered=2")).toBe("not-applicable");
    expect(classifyGapOwner(undefined)).toBe("not-applicable");
    expect(classifyGapOwner("")).toBe("not-applicable");
  });
});

describe("buildSourcePrompt — kendi kendine yeten iş tanımı", () => {
  const faz11: SourceGap = {
    phase: 11,
    dimension: "Sadeleştirme",
    detail: "ts_tool_js_project",
    stack: "node-npm",
  };

  it("okuyanın bu sohbeti görmediği varsayılır: faz, boyut, stack ve kanıt promptun İÇİNDE", () => {
    const p = buildSourcePrompt(faz11);
    expect(p).toContain("Faz 11");
    expect(p).toContain("Sadeleştirme");
    expect(p).toContain("node-npm");
    expect(p).toContain("ts_tool_js_project");
  });

  it("KABUL EDİLMEYEN çözümleri açıkça yasaklar (kapıyı gevşetme / susturma)", () => {
    const p = buildSourcePrompt(faz11);
    expect(p).toContain("gevşetme");
    expect(p).toContain("Yanlış alarm");
    expect(p).toContain("GÖRÜNÜR");
  });

  it("stack bağımsızlığını ister — kök sorun zaten aracın tek dile bağlı olması", () => {
    expect(buildSourcePrompt(faz11)).toContain("stack bağımsız");
  });

  it("bozuk araç ile dar araç FARKLI teşhis alır (aynı şablon değil)", () => {
    const bozuk = buildSourcePrompt({ ...faz11, detail: 'mycl_tool_broken cmd="node arch-check.mjs"' });
    expect(bozuk).toContain("paketleme");
    expect(bozuk).toContain("arch-check.mjs"); // komut kanıt olarak taşınır
    expect(bozuk).not.toContain("TypeScript'e bağlı");
  });

  it("doğrulama şartı yazılı: birim testi, hedef projeyi çalıştırmadan", () => {
    const p = buildSourcePrompt(faz11);
    expect(p).toContain("Birim testleriyle".toLowerCase().slice(0, 5)); // "birim"
    expect(p).toContain("çalıştırmadan");
  });

  it("stack bilinmiyorsa uydurmaz", () => {
    const p = buildSourcePrompt({ phase: 11, dimension: "Sadeleştirme", detail: "ts_tool_js_project" });
    expect(p).toContain("bilinmiyor");
  });

  it("determinizm: aynı girdi → bayt aynı çıktı", () => {
    expect(buildSourcePrompt(faz11)).toBe(buildSourcePrompt(faz11));
  });
});

describe("sourceGapKey — aynı boşluk tek kimlik", () => {
  const g: SourceGap = { phase: 11, dimension: "Sadeleştirme", detail: "ts_tool_js_project", stack: "node-npm" };

  it("detayın değişken kısmı (cmd) kimliği kaydırmaz", () => {
    const a = sourceGapKey({ ...g, detail: 'mycl_tool_broken cmd="a.mjs"' });
    const b = sourceGapKey({ ...g, detail: 'mycl_tool_broken cmd="a.mjs" extra=1' });
    expect(a).toBe(b);
  });

  it("farklı faz / farklı stack → farklı kimlik", () => {
    expect(sourceGapKey(g)).not.toBe(sourceGapKey({ ...g, phase: 12 }));
    expect(sourceGapKey(g)).not.toBe(sourceGapKey({ ...g, stack: "deno" }));
  });
});

describe("persistSourcePrompt", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-srcgap-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const g: SourceGap = { phase: 11, dimension: "Sadeleştirme", detail: "ts_tool_js_project", stack: "node-npm" };

  it("promptu projeye yazar (sohbet kaydırılsa da elde kalsın)", async () => {
    const file = await persistSourcePrompt(root, g, buildSourcePrompt(g));
    expect(file).not.toBeNull();
    const body = await fs.readFile(file as string, "utf-8");
    expect(body).toContain("Faz 11");
  });

  it("aynı boşluk İKİNCİ kez yazılınca yeni dosya oluşmaz (tek kimlik)", async () => {
    await persistSourcePrompt(root, g, "a");
    await persistSourcePrompt(root, g, "b");
    const files = await fs.readdir(join(root, ".mycl", "mycl-source-tasks"));
    expect(files).toHaveLength(1);
  });

  it("yazamazsa null döner — akış DURMAZ (prompt zaten sohbette gösteriliyor)", async () => {
    expect(await persistSourcePrompt("/kesinlikle/olmayan/yol", g, "x")).toBeNull();
  });
});
