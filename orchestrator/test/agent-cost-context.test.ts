// agent-cost-context — AsyncLocalStorage bağlam testleri. EN KRİTİK: paralel async-zincirler izole mi
// (token-atfı doğru ajana gider mi) + await sonrası bağlam korunur mu. (recordTokenUsage'ın atıf emit'i
// bu bağlamı okur; yanlış propagation = yanlış ajana token.)

import { describe, expect, it } from "vitest";
import { withAgentRun, currentAgentRun } from "../src/agent-cost-context.js";

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("agent-cost-context (AsyncLocalStorage)", () => {
  it("bağlam DIŞINDA currentAgentRun undefined (atıf yapılmaz)", () => {
    expect(currentAgentRun()).toBeUndefined();
  });

  it("withAgentRun içinde bağlam okunur + await sonrası KORUNUR", async () => {
    const seen: Array<string | undefined> = [];
    await withAgentRun({ label: "Mimari", group: "Tasarım Paneli", phase: 5 }, async () => {
      seen.push(currentAgentRun()?.label); // await öncesi
      await tick();
      seen.push(currentAgentRun()?.label); // await SONRASI (propagation)
      await tick();
      seen.push(currentAgentRun()?.group);
    });
    expect(seen).toEqual(["Mimari", "Mimari", "Tasarım Paneli"]);
    expect(currentAgentRun()).toBeUndefined(); // çıkışta temiz
  });

  it("PARALEL koşular İZOLE — her zincir kendi ajanını görür (token karışmaz)", async () => {
    const labels: Record<string, string | undefined> = {};
    await Promise.all([
      withAgentRun({ label: "UX", group: "Tasarım Paneli", phase: 5 }, async () => {
        await tick(5);
        labels.a = currentAgentRun()?.label; // gecikmeli await'ten sonra hâlâ "UX"
      }),
      withAgentRun({ label: "Güvenlik", group: "Tasarım Paneli", phase: 5 }, async () => {
        await tick(2);
        labels.b = currentAgentRun()?.label; // "Güvenlik" — UX'inkiyle karışmaz
      }),
      withAgentRun({ label: "auth", group: "Modül Codegen", phase: 8 }, async () => {
        await tick(1);
        labels.c = currentAgentRun()?.phase ? `${currentAgentRun()?.label}-${currentAgentRun()?.phase}` : "?";
      }),
    ]);
    expect(labels.a).toBe("UX");
    expect(labels.b).toBe("Güvenlik");
    expect(labels.c).toBe("auth-8");
  });

  it("dönüş değeri aynen iletilir (worker {ok} döndürebilsin)", async () => {
    const r = await withAgentRun({ label: "x", group: "g", phase: 1 }, async () => ({ ok: true }));
    expect(r).toEqual({ ok: true });
  });
});
