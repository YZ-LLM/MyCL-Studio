// task-queue/store — append/patch/read + öncelik-sıralı sonraki-iş testleri.
// YZLLM 2026-06-14: "her iş Faz 1'den başlar + çok-problem önceliklendirilmiş
// sıralı kuyruk + tamamlanınca tarih + uygulanamaz".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTask,
  readTasks,
  removeTask,
  patchTask,
  nextPendingTask,
  nextAutoPendingTask,
  taskStatus,
} from "../src/task-queue/store.js";
import { parseSplitBlock } from "../src/task-queue/intake.js";
import { MAX_TASK_AUTO_RETRIES, type TaskQueueItem } from "../src/task-queue/types.js";

describe("task-queue store", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-taskq-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("append → read opsiyonel alanları korur (priority/status/source)", async () => {
    const t: TaskQueueItem = {
      id: "a",
      ts: 1,
      text: "youtube linki görünmüyor",
      priority: 2,
      status: "pending",
      source: "auto",
    };
    await appendTask(projectRoot, t);
    const back = await readTasks(projectRoot);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject(t);
  });

  it("eski kayıt (opsiyonel alan yok) geriye-uyumlu okunur", async () => {
    await appendTask(projectRoot, { id: "old", ts: 5, text: "eski" });
    const back = await readTasks(projectRoot);
    expect(back[0]).toMatchObject({ id: "old", ts: 5, text: "eski" });
    expect(back[0]?.status).toBeUndefined();
    expect(taskStatus(back[0]!)).toBe("pending"); // alan yoksa pending
  });

  it("patchTask en son patch'i taban kayda merge eder (kısmî güncelleme)", async () => {
    await appendTask(projectRoot, { id: "a", ts: 1, text: "iş", status: "pending", priority: 3 });
    await patchTask(projectRoot, "a", { status: "running" });
    await patchTask(projectRoot, "a", { status: "done", completed_at: 999 });
    const back = await readTasks(projectRoot);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      id: "a",
      text: "iş",
      priority: 3, // patch'lerde dokunulmadı → korunur
      status: "done", // en son patch
      completed_at: 999,
    });
  });

  it("tombstone + patch birlikte: silinen kayıt patch'e rağmen düşer", async () => {
    await appendTask(projectRoot, { id: "a", ts: 1, text: "iş" });
    await patchTask(projectRoot, "a", { status: "running" });
    await removeTask(projectRoot, "a");
    const back = await readTasks(projectRoot);
    expect(back).toHaveLength(0);
  });

  it("nextPendingTask: öncelik (1=en yüksek), eşitlikte FIFO; running/done atlanır", async () => {
    const items: TaskQueueItem[] = [
      { id: "c", ts: 30, text: "c", priority: 1, status: "pending" },
      { id: "a", ts: 10, text: "a", priority: 2, status: "pending" },
      { id: "b", ts: 20, text: "b", priority: 1, status: "pending" },
      { id: "d", ts: 5, text: "d", status: "done" },
      { id: "e", ts: 1, text: "e", status: "running" },
    ];
    // priority 1 olanlar (b@20, c@30) → FIFO ile b önce.
    expect(nextPendingTask(items)?.id).toBe("b");
  });

  it("nextAutoPendingTask: yalnız source=auto işler auto-drain'e girer (manuel/eski hariç)", async () => {
    const mixed: TaskQueueItem[] = [
      { id: "m", ts: 1, text: "manuel", priority: 1, status: "pending", source: "manual" },
      { id: "legacy", ts: 2, text: "eski (source yok)", priority: 1, status: "pending" },
      { id: "a", ts: 3, text: "auto-düşük", priority: 5, status: "pending", source: "auto" },
      { id: "b", ts: 4, text: "auto-yüksek", priority: 2, status: "pending", source: "auto" },
    ];
    // Manuel (öncelik 1) + eski daha yüksek öncelikli ama auto-drain'e girmez →
    // yalnız auto işler arasından öncelik 2 (b) seçilir.
    expect(nextAutoPendingTask(mixed)?.id).toBe("b");
    // Auto iş yoksa null (manuel işler oto-koşmaz).
    const onlyManual: TaskQueueItem[] = [
      { id: "m", ts: 1, text: "m", status: "pending", source: "manual" },
    ];
    expect(nextAutoPendingTask(onlyManual)).toBeNull();
  });

  it("nextPendingTask: önceliksiz iş en sona (Infinity); hepsi bitince null", async () => {
    const withUnprioritized: TaskQueueItem[] = [
      { id: "x", ts: 1, text: "x" }, // priority yok → en sona
      { id: "y", ts: 2, text: "y", priority: 5 },
    ];
    expect(nextPendingTask(withUnprioritized)?.id).toBe("y");
    const allDone: TaskQueueItem[] = [
      { id: "x", ts: 1, text: "x", status: "done" },
      { id: "y", ts: 2, text: "y", status: "dropped" },
    ];
    expect(nextPendingTask(allDone)).toBeNull();
  });
});

describe("intake parseSplitBlock", () => {
  it("çok-problem bloğunu text+priority ile parse eder", () => {
    const raw =
      'analiz\n```json\n{"kind":"task_split","tasks":[{"text":"YouTube linki görünmüyor","priority":1},{"text":"Yeni kullanıcı listede yok","priority":2}]}\n```';
    const out = parseSplitBlock(raw);
    expect(out).toHaveLength(2);
    expect(out?.[0]).toEqual({ text: "YouTube linki görünmüyor", priority: 1, already_queued: false });
    expect(out?.[1]?.priority).toBe(2);
  });

  it("priority eksik/geçersizse sıraya göre türetir; boş text atlanır", () => {
    const raw =
      '```json\n{"kind":"task_split","tasks":[{"text":"ilk"},{"text":"   "},{"text":"ikinci","priority":0}]}\n```';
    const out = parseSplitBlock(raw);
    // "ilk" → priority 1 (out.length+1=1); boş atlandı; "ikinci" priority 0 geçersiz → out.length+1=2
    expect(out).toEqual([
      { text: "ilk", priority: 1, already_queued: false },
      { text: "ikinci", priority: 2, already_queued: false },
    ]);
  });

  it("blok yok / tasks dizi değil → null (fail-soft)", () => {
    expect(parseSplitBlock("düz metin, json yok")).toBeNull();
    expect(parseSplitBlock('```json\n{"kind":"task_split","tasks":"x"}\n```')).toBeNull();
  });

  it("geçerli blok + boş tasks → [] (null DEĞİL): salt onay/gözlem ya da hepsi zaten kuyrukta (YZLLM 2026-06-15)", () => {
    // Boş tasks LLM'in KASITLI sinyali (yeni iş yok) → caller ham-metni tek-iş yapıp duplicate üretmesin.
    expect(parseSplitBlock('```json\n{"kind":"task_split","tasks":[]}\n```')).toEqual([]);
  });
});

describe("düşürme yok → yeniden deneme merdiveni (YZLLM 2026-07-18: 'kuyrukta düştü işaretlemeyi kaldır, çözsün')", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-taskq-retry-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("attempts + last_fail patch-fold ile taşınır (pending'e dönüş kaydı)", async () => {
    await appendTask(root, { id: "t1", ts: 1, text: "iş", status: "running", source: "auto" });
    await patchTask(root, "t1", { status: "pending", attempts: 1, last_fail: "boş build" });
    const t = (await readTasks(root)).find((x) => x.id === "t1");
    expect(t?.status).toBe("pending");
    expect(t?.attempts).toBe(1);
    expect(t?.last_fail).toBe("boş build");
  });

  it("attempts < tavan → otomatik seçilir; tavana ulaşan iş SEÇİLMEZ ama pending KALIR (kaybolmaz)", async () => {
    await appendTask(root, { id: "cap", ts: 1, text: "takılan iş", status: "pending", source: "auto" });
    await appendTask(root, { id: "ok", ts: 2, text: "sıradaki iş", status: "pending", source: "auto" });
    await patchTask(root, "cap", { attempts: 2 }); // 2 < 3 → hâlâ seçilebilir (öncelik/FIFO gereği ilk o)
    let items = await readTasks(root);
    expect(nextPendingTask(items)?.id).toBe("cap");
    await patchTask(root, "cap", { attempts: MAX_TASK_AUTO_RETRIES }); // tavan doldu
    items = await readTasks(root);
    expect(nextPendingTask(items)?.id).toBe("ok"); // tavanlı iş atlanır, sıradaki seçilir
    expect(items.find((x) => x.id === "cap")?.status ?? "pending").toBe("pending"); // düşürülmedi
  });

  it("tavanlı iş tek başınaysa → seçim null (sonsuz döngü yok) ama kuyrukta görünür durur", async () => {
    await appendTask(root, { id: "solo", ts: 1, text: "çözülemeyen", status: "pending", source: "auto" });
    await patchTask(root, "solo", { attempts: MAX_TASK_AUTO_RETRIES, last_fail: "3 farklı yaklaşım da tamamlanamadı" });
    const items = await readTasks(root);
    expect(nextPendingTask(items)).toBeNull();
    expect(items).toHaveLength(1);
  });
});
