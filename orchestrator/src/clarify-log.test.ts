// clarify-log — Faz 1/2 clarify Q&A kalıcı kayıt + iterasyon-kapsamlı okuma (YZLLM 2026-07-03).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordClarify, readClarifyForIteration, clearClarifyLog } from "./clarify-log.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "clarify-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("clarify-log", () => {
  it("dosya yoksa boş dizi (geriye uyumlu)", async () => {
    expect(await readClarifyForIteration(root, 1)).toEqual([]);
  });

  it("kaydet + oku (yazım sırası korunur)", async () => {
    recordClarify(root, { ts: 1, iteration: 1, phase: 1, question: "Notlar nereye?", answer: "PostgreSQL" });
    recordClarify(root, { ts: 2, iteration: 1, phase: 2, question: "Kimlik doğrulama?", answer: "JWT" });
    const recs = await readClarifyForIteration(root, 1);
    expect(recs.map((r) => r.answer)).toEqual(["PostgreSQL", "JWT"]);
    expect(recs[0].question).toBe("Notlar nereye?");
  });

  it("İZOLASYON: yalnız eşleşen iteration döner (eski Q&A sızmaz)", async () => {
    recordClarify(root, { ts: 1, iteration: 1, phase: 1, question: "Q-iter1", answer: "A1" });
    recordClarify(root, { ts: 2, iteration: 2, phase: 1, question: "Q-iter2", answer: "A2" });
    expect((await readClarifyForIteration(root, 1)).map((r) => r.question)).toEqual(["Q-iter1"]);
    expect((await readClarifyForIteration(root, 2)).map((r) => r.question)).toEqual(["Q-iter2"]);
    expect(await readClarifyForIteration(root, 3)).toEqual([]);
  });

  it("bozuk satır atlanır (fail-soft)", async () => {
    recordClarify(root, { ts: 1, iteration: 1, phase: 1, question: "iyi", answer: "cevap" });
    await fs.appendFile(join(root, ".mycl", "clarify-log.jsonl"), "{bozuk json\n", "utf8");
    recordClarify(root, { ts: 2, iteration: 1, phase: 1, question: "iyi2", answer: "cevap2" });
    expect((await readClarifyForIteration(root, 1)).map((r) => r.answer)).toEqual(["cevap", "cevap2"]);
  });
});

describe("clearClarifyLog", () => {
  it("düşen işin clarify'ını temizler → sonraki iş sıfırdan (sızma yok)", async () => {
    recordClarify(root, { ts: 1, iteration: 1, phase: 1, question: "task1-Q", answer: "task1-A" });
    expect((await readClarifyForIteration(root, 1)).length).toBe(1);
    clearClarifyLog(root);
    expect(await readClarifyForIteration(root, 1)).toEqual([]);
    // temizleme sonrası yeni kayıt sorunsuz
    recordClarify(root, { ts: 2, iteration: 1, phase: 1, question: "task2-Q", answer: "task2-A" });
    expect((await readClarifyForIteration(root, 1)).map((r) => r.question)).toEqual(["task2-Q"]);
  });
  it("dosya yokken clear no-op (fail-soft)", () => {
    expect(() => clearClarifyLog(root)).not.toThrow();
  });
});
