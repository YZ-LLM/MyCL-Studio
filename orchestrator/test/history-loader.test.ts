import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  appendHistory,
  loadMessages,
  type HistoryEntry,
} from "../src/history-loader.js";

describe("history-loader", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-history-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("appendHistory + loadMessages roundtrip", async () => {
    await appendHistory(projectRoot, {
      ts: 1000,
      kind: "chat_message",
      data: { role: "user", text: "hello" },
    });
    await appendHistory(projectRoot, {
      ts: 2000,
      kind: "translation",
      data: { dir: "tr-to-en", input: "merhaba", output: "hello" },
    });
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 100,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].kind).toBe("chat_message");
    expect(result.events[1].kind).toBe("translation");
    expect(result.older_available).toBe(false);
    expect(result.oldest_returned_ts).toBe(1000);
  });

  it("loadMessages returns empty result when file missing", async () => {
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 100,
    });
    expect(result.events).toEqual([]);
    expect(result.older_available).toBe(false);
    expect(result.oldest_returned_ts).toBe(0);
  });

  it("since_ts filter excludes older events + sets older_available", async () => {
    for (let i = 0; i < 5; i++) {
      await appendHistory(projectRoot, {
        ts: 1000 + i * 100,
        kind: "chat_message",
        data: { role: "user", text: `m${i}` },
      });
    }
    const result = await loadMessages(projectRoot, {
      since_ts: 1200, // includes ts >= 1200 → m2, m3, m4
      limit: 100,
    });
    expect(result.events).toHaveLength(3);
    expect(result.oldest_returned_ts).toBe(1200);
    expect(result.older_available).toBe(true); // m0, m1 dışta kaldı
  });

  it("until_ts (exclusive) supports lazy load chunk", async () => {
    for (let i = 0; i < 5; i++) {
      await appendHistory(projectRoot, {
        ts: 1000 + i * 100,
        kind: "chat_message",
        data: { role: "user", text: `m${i}` },
      });
    }
    // Lazy: [since=0, until=1200) → m0, m1
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      until_ts: 1200,
      limit: 100,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].data).toMatchObject({ text: "m0" });
    expect(result.events[1].data).toMatchObject({ text: "m1" });
    expect(result.older_available).toBe(false);
  });

  it("limit caps results + older_available signals more", async () => {
    for (let i = 0; i < 10; i++) {
      await appendHistory(projectRoot, {
        ts: 1000 + i,
        kind: "chat_message",
        data: { i },
      });
    }
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 3,
    });
    expect(result.events).toHaveLength(3);
    // En yeni 3 event döner (ts=1009, 1008, 1007 → kronolojik 1007,1008,1009)
    expect(result.events.map((e) => e.ts)).toEqual([1007, 1008, 1009]);
    expect(result.older_available).toBe(true);
  });

  it("corrupted JSON line is skipped silently", async () => {
    const dir = join(projectRoot, ".mycl");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "history.log");
    await writeFile(
      file,
      [
        JSON.stringify({ ts: 1000, kind: "chat_message", data: { x: 1 } }),
        "this is not json",
        JSON.stringify({ ts: 2000, kind: "translation", data: { y: 2 } }),
        '{"ts":"not-a-number","kind":"chat_message","data":{}}',
        JSON.stringify({ ts: 3000, kind: "claude_stream", data: { z: 3 } }),
      ].join("\n") + "\n",
    );
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 100,
    });
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.ts)).toEqual([1000, 2000, 3000]);
  });

  it("preserves entry data structure", async () => {
    const original: HistoryEntry = {
      ts: 5000,
      kind: "claude_stream",
      data: {
        sub: "tool_use",
        tool_name: "Read",
        tool_input: { file_path: "/foo/bar.ts" },
      },
    };
    await appendHistory(projectRoot, original);
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 100,
    });
    // v15.6: enrichRecord _schema_v + _record_ts ekler — toMatchObject (subset)
    expect(result.events[0]).toMatchObject(original);
  });

  it("filters noise events (token_usage/init/relevance_call) from limit count", async () => {
    // 5 chat_message + 50 noise claude_stream — limit=5 olsa bile tüm 5
    // chat_message dönmeli (noise limit'i tüketmemeli). Kullanıcı raporu
    // (2026-05-23): yoğun projelerde claude_stream dosya satırlarının %85'i
    // → chat_message UI'a ulaşmıyordu.
    for (let i = 0; i < 50; i++) {
      await appendHistory(projectRoot, {
        ts: 1000 + i,
        kind: "claude_stream",
        data: { sub: "token_usage", usage: { input_tokens: i, output_tokens: i } },
      });
    }
    for (let i = 0; i < 5; i++) {
      await appendHistory(projectRoot, {
        ts: 2000 + i,
        kind: "chat_message",
        data: { role: "user", text: `m${i}` },
      });
    }
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 5,
    });
    expect(result.events.filter((e) => e.kind === "chat_message")).toHaveLength(5);
    expect(result.events.filter((e) => e.kind === "claude_stream")).toHaveLength(0);
  });

  it("keeps non-noise claude_stream (text/tool_use/tool_result)", async () => {
    await appendHistory(projectRoot, {
      ts: 1000,
      kind: "claude_stream",
      data: { sub: "text", text: "hello" },
    });
    await appendHistory(projectRoot, {
      ts: 2000,
      kind: "claude_stream",
      data: { sub: "token_usage", usage: {} },
    });
    await appendHistory(projectRoot, {
      ts: 3000,
      kind: "claude_stream",
      data: { sub: "tool_use", tool_name: "Read" },
    });
    const result = await loadMessages(projectRoot, {
      since_ts: 0,
      limit: 100,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => (e.data as { sub: string }).sub)).toEqual([
      "text",
      "tool_use",
    ]);
  });
});

// 2026-06-10 (Ümit: "chat ekranı bile aynı kalmalı"): stream seli chat'i boğamaz (adil kota).
describe("loadMessages — chat adil kotası", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-history-fair-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("limit'i aşan stream deltası varken eski chat mesajları YİNE gelir", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    const lines: string[] = [];
    // Önce 5 chat (eski), sonra 500 stream delta (yeni) — eski davranışta limit=100
    // pencereyi deltalar doldurur, chat hiç gelmezdi.
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ ts: 1000 + i, kind: "chat_message", data: { role: "system", text: `m${i}` } }));
    }
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ ts: 2000 + i, kind: "claude_stream", data: { sub: "text", text: "x" } }));
    }
    await writeFile(join(projectRoot, ".mycl", "history.log"), lines.join("\n") + "\n");
    const res = await loadMessages(projectRoot, { since_ts: 0, limit: 100 });
    const chats = res.events.filter((e) => e.kind === "chat_message");
    expect(chats).toHaveLength(5); // hepsi geldi (ayrı kota)
    expect(res.events.filter((e) => e.kind === "claude_stream")).toHaveLength(100); // stream kendi limitinde
  });
});
