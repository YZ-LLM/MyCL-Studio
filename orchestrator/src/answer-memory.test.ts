import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAnswer,
  latestAnswerFor,
  appendAnswerMemory,
  readAnswerMemory,
  recallAnswer,
  recordAnswer,
  markReuseApproved,
  type AnswerMemoryRecord,
} from "./answer-memory.js";
import {
  OPT_QUEUE,
  OPT_STOP_MANUAL,
  OPT_ACCEPT_CONTINUE,
  OPT_ACCEPT_PERMANENT,
  OPT_REANALYZE,
} from "./error-analysis.js";

function rec(over: Partial<AnswerMemoryRecord>): AnswerMemoryRecord {
  return {
    ts: 1,
    scope: "gate-error",
    key: "8:x",
    phase: 8,
    answer: "bir çözüm",
    answerKind: "solution",
    sensitive: false,
    reuseApproved: false,
    occurrences: 1,
    ...over,
  };
}

describe("classifyAnswer", () => {
  it("sabit etiketleri 'fixed' sayar", () => {
    expect(classifyAnswer(OPT_QUEUE)).toBe("fixed");
    expect(classifyAnswer(OPT_STOP_MANUAL)).toBe("fixed");
    // trim toleransı
    expect(classifyAnswer(`  ${OPT_QUEUE}  `)).toBe("fixed");
  });
  it("serbest LLM çözümünü 'solution' sayar", () => {
    expect(classifyAnswer("Bu işi kapsam düzeltmesi olarak sınıflandır")).toBe("solution");
  });
  it("güvenlik/kontrol etiketleri 'fixed' (recall'a girmez → yalnız 'solution' hatırlanır)", () => {
    // mahkeme fix: bu etiketler Hook B'de hariç → sabit kalmaları kaydı engeller
    expect(classifyAnswer(OPT_ACCEPT_CONTINUE)).toBe("fixed");
    expect(classifyAnswer(OPT_ACCEPT_PERMANENT)).toBe("fixed");
    expect(classifyAnswer(OPT_REANALYZE)).toBe("fixed");
  });
});

describe("latestAnswerFor (son-satır-kazanır)", () => {
  it("aynı key için EN SON kaydı döndürür", () => {
    const records = [
      rec({ key: "8:x", answer: "eski", reuseApproved: false }),
      rec({ key: "8:y", answer: "başka" }),
      rec({ key: "8:x", answer: "yeni", reuseApproved: true }),
    ];
    const got = latestAnswerFor(records, "8:x");
    expect(got?.answer).toBe("yeni");
    expect(got?.reuseApproved).toBe(true);
  });
  it("kayıt yoksa null", () => {
    expect(latestAnswerFor([], "8:x")).toBeNull();
    expect(latestAnswerFor([rec({ key: "8:a" })], "8:z")).toBeNull();
  });
});

describe("answer-memory disk (append/read/recall/record/markReuseApproved)", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "answer-memory-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dosya yoksa read → [] ve recall → null (ilk kez)", async () => {
    expect(await readAnswerMemory(root)).toEqual([]);
    expect(await recallAnswer(root, "8:x")).toBeNull();
  });

  it("append + read round-trip", async () => {
    await appendAnswerMemory(root, rec({ key: "8:a", answer: "A" }));
    await appendAnswerMemory(root, rec({ key: "8:b", answer: "B" }));
    const all = await readAnswerMemory(root);
    expect(all.map((r) => r.answer)).toEqual(["A", "B"]);
  });

  it("bozuk satır atlanır, geçerli satırlar okunur", async () => {
    const p = join(root, ".mycl", "answer-memory.jsonl");
    await fs.mkdir(join(root, ".mycl"), { recursive: true });
    await fs.writeFile(p, `{"bad json\n${JSON.stringify(rec({ key: "8:ok", answer: "OK" }))}\n`);
    const all = await readAnswerMemory(root);
    expect(all).toHaveLength(1);
    expect(all[0]!.answer).toBe("OK");
  });

  it("recordAnswer: reuseApproved=false, occurrences artışı, son cevap kazanır", async () => {
    await recordAnswer(root, {
      key: "8:x", phase: 8, answer: "ilk", answerKind: "solution", scope: "gate-error", sensitive: false,
    });
    let cur = await recallAnswer(root, "8:x");
    expect(cur?.answer).toBe("ilk");
    expect(cur?.reuseApproved).toBe(false);
    expect(cur?.occurrences).toBe(1);

    // Kademe 2 "Hayır" güncellemesi → yeni cevap, occurrences 2
    await recordAnswer(root, {
      key: "8:x", phase: 8, answer: "ikinci", answerKind: "solution", scope: "gate-error", sensitive: false,
    });
    cur = await recallAnswer(root, "8:x");
    expect(cur?.answer).toBe("ikinci");
    expect(cur?.reuseApproved).toBe(false);
    expect(cur?.occurrences).toBe(2);
  });

  it("markReuseApproved: son cevabı koruyarak reuseApproved=true (Kademe 2 Evet)", async () => {
    await recordAnswer(root, {
      key: "8:x", phase: 8, answer: "seçilen", answerKind: "solution", scope: "gate-error", sensitive: false,
    });
    await markReuseApproved(root, "8:x");
    const cur = await recallAnswer(root, "8:x");
    expect(cur?.answer).toBe("seçilen");
    expect(cur?.reuseApproved).toBe(true);
    expect(cur?.occurrences).toBe(2);
  });

  it("markReuseApproved: kayıt yoksa no-op (savunmacı)", async () => {
    await markReuseApproved(root, "8:yok");
    expect(await recallAnswer(root, "8:yok")).toBeNull();
  });

  it("sensitive kayıt korunur (Kademe 3 kararı için)", async () => {
    await recordAnswer(root, {
      key: "13:sec", phase: 13, answer: "Kabul et, devam et", answerKind: "fixed", scope: "gate-error", sensitive: true,
    });
    await markReuseApproved(root, "13:sec");
    const cur = await recallAnswer(root, "13:sec");
    expect(cur?.sensitive).toBe(true);
    expect(cur?.reuseApproved).toBe(true);
  });
});
