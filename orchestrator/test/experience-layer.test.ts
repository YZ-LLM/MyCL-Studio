// experience-layer — ders deposu (AŞAMA 3 temeli). SIZDIRMASIZLIK: ham ders artık PROJE-YEREL
// (<proje>/.mycl/lessons.jsonl) — depo testleri tmpdir'i proje kökü olarak kullanır.
// İlkeler: ders=iddia (recall öneri, auto-uygula yok), geri-alınabilir (retracted hariç), verified önce.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSignature,
  signatureOverlap,
  recordLesson,
  recallLessons,
  retractLesson,
  type Lesson,
} from "../src/experience-layer.js";

const L = (over: Partial<Lesson>): Lesson => ({
  signature: "sig",
  problem: "p",
  resolution: "r",
  principle: "pr",
  verified: false,
  ts: 1,
  ...over,
});

describe("experience-layer · saf imza fonksiyonları", () => {
  it("normalizeSignature: küçük harf + noktalama→boşluk", () => {
    expect(normalizeSignature("ts-prune: Next.js Export!")).toBe("ts prune next js export");
  });
  it("signatureOverlap: ortak kelime oranı", () => {
    expect(signatureOverlap("ts-prune next export", "ts-prune next false-positive")).toBeGreaterThan(0.4);
    expect(signatureOverlap("ts-prune next", "tamamen alakasız konu başka")).toBe(0);
  });
});

describe("experience-layer · depo (proje-yerel .mycl/lessons.jsonl)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-lessons-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("record + recall round-trip (benzer imza)", async () => {
    await recordLesson(root, L({ signature: "ts-prune Next framework-export false-positive", principle: "CLI -i" }));
    const hits = await recallLessons(root, "ts-prune Next export flag");
    expect(hits.length).toBe(1);
    expect(hits[0].principle).toBe("CLI -i");
  });

  it("dedup: aynı imza → GÜNCELLER (çift kayıt değil)", async () => {
    await recordLesson(root, L({ signature: "i18n password label", verified: false }));
    await recordLesson(root, L({ signature: "i18n password label", verified: true, principle: "scanner i18n-skip" }));
    const hits = await recallLessons(root, "i18n password label");
    expect(hits.length).toBe(1);
    expect(hits[0].verified).toBe(true);
  });

  it("retracted ders → recall'da YOK (zehirlenme önleme)", async () => {
    await recordLesson(root, L({ signature: "yanlış ders konu" }));
    expect((await recallLessons(root, "yanlış ders konu")).length).toBe(1);
    expect(await retractLesson(root, "yanlış ders konu")).toBe(true);
    expect((await recallLessons(root, "yanlış ders konu")).length).toBe(0);
  });

  it("verified ders öncelikli sıralanır", async () => {
    await recordLesson(root, L({ signature: "konu A weak", verified: false }));
    await recordLesson(root, L({ signature: "konu A strong", verified: true }));
    const hits = await recallLessons(root, "konu A", { minOverlap: 0.3 });
    expect(hits[0].verified).toBe(true); // verified önce
  });

  it("alakasız imza → recall boş (yanlış-uygulama önleme)", async () => {
    await recordLesson(root, L({ signature: "ts-prune next export" }));
    expect((await recallLessons(root, "tamamen başka bir güvenlik konusu")).length).toBe(0);
  });
});
