// task-batch — hakem parse + deterministik kapı fail-closed matrisi (LLM/git YOK).
import { describe, expect, it } from "vitest";
import { candidatesToModules, parseBatchResponse, MAX_BATCH } from "../src/task-batch.js";
import type { TaskQueueItem } from "../src/task-queue/types.js";

const TASKS: TaskQueueItem[] = [
  { id: "aaa", ts: 1, text: "Blog modülünü ekle", status: "pending", source: "plan" },
  { id: "bbb", ts: 2, text: "Admin panelini ekle", status: "pending", source: "plan" },
  { id: "ccc", ts: 3, text: "Raporlama sayfası ekle", status: "pending", source: "manual" },
];

const raw = (parallel: unknown): string =>
  "```json\n" + JSON.stringify({ kind: "task_batch", parallel }) + "\n```";

describe("parseBatchResponse — LLM önerir, KOD karar verir (fail-closed)", () => {
  it("geçerli 2 aday + ayrık kapsam → kabul", () => {
    const c = parseBatchResponse(
      raw([
        { task_index: 0, scope_paths: ["src/blog/"] },
        { task_index: 1, scope_paths: ["src/admin/"] },
      ]),
      TASKS,
    );
    expect(c).not.toBeNull();
    expect(c!.map((x) => x.task.id)).toEqual(["aaa", "bbb"]);
  });

  it("KAPSAM ÇAKIŞMASI → null (deterministik kapı; LLM 'bağımsız' dese bile)", () => {
    const c = parseBatchResponse(
      raw([
        { task_index: 0, scope_paths: ["src/"] },
        { task_index: 1, scope_paths: ["src/admin/"] }, // src/ alt kümesi → çakışır
      ]),
      TASKS,
    );
    expect(c).toBeNull();
  });

  it("tek aday → null (<2 paralel anlamsız)", () => {
    expect(parseBatchResponse(raw([{ task_index: 0, scope_paths: ["src/a/"] }]), TASKS)).toBeNull();
  });

  it("geçersiz/çift index → null (öneri bütünüyle güvenilmez)", () => {
    expect(
      parseBatchResponse(
        raw([
          { task_index: 0, scope_paths: ["src/a/"] },
          { task_index: 9, scope_paths: ["src/b/"] },
        ]),
        TASKS,
      ),
    ).toBeNull();
    expect(
      parseBatchResponse(
        raw([
          { task_index: 0, scope_paths: ["src/a/"] },
          { task_index: 0, scope_paths: ["src/b/"] },
        ]),
        TASKS,
      ),
    ).toBeNull();
  });

  it("boş kapsam → null (fail-closed)", () => {
    expect(
      parseBatchResponse(
        raw([
          { task_index: 0, scope_paths: [] },
          { task_index: 1, scope_paths: ["src/b/"] },
        ]),
        TASKS,
      ),
    ).toBeNull();
  });

  it("blok yok / bozuk JSON → null", () => {
    expect(parseBatchResponse("düz metin", TASKS)).toBeNull();
    expect(parseBatchResponse(raw("not-array"), TASKS)).toBeNull();
  });
});

describe("candidatesToModules", () => {
  it("modül id = iş id (birleştirme dosya kanıtı iş-başına eşlenir)", () => {
    const mods = candidatesToModules([
      { task: TASKS[0], scope_paths: ["src/blog/"] },
      { task: TASKS[1], scope_paths: ["src/admin/"] },
    ]);
    expect(mods.map((m) => m.id)).toEqual(["aaa", "bbb"]);
    expect(mods[0].brief).toBe("Blog modülünü ekle");
    expect(mods[0].scope_paths).toEqual(["src/blog/"]);
  });
});

describe("MAX_BATCH", () => {
  it("v1 küme tavanı 3 (makine yükü + abonelik limiti doğal sınırı)", () => {
    expect(MAX_BATCH).toBe(3);
  });
});
