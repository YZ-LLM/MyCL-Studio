import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyclConfig } from "../src/config.js";
import type { State } from "../src/types.js";

// translate + loadMessages + runClaudeCli mock (vi.hoisted — factory'den önce tanımlı).
const { translateMock, loadMessagesMock, runCliMock } = vi.hoisted(() => ({
  translateMock: vi.fn(),
  loadMessagesMock: vi.fn(),
  runCliMock: vi.fn(),
}));
vi.mock("../src/translator.js", () => ({ translate: translateMock }));
vi.mock("../src/history-loader.js", () => ({ loadMessages: loadMessagesMock }));
// Abonelik özeti CLI ile üretilir → gerçek `claude` spawn'ı YAPMA (mock).
vi.mock("../src/cli-run.js", () => ({ runClaudeCli: runCliMock }));

import {
  _clearSummaryCache,
  buildConversationContext,
  renderConversationSection,
} from "../src/conversation-context.js";

const config = {
  selected_models: { translator: "m", main: "m" },
  api_keys: { translator: "k", main: "k" },
  agent_backends: { orchestrator: "api", translator: "api", main: "api" },
} as unknown as MyclConfig;
const state = { project_root: "/tmp/x" } as unknown as State;

const TR = ["merhaba", "anket sayfası içinde", "şunu düzelt"];
const EN_MARKER = "ENGLISH_ONLY_MARKER";

function msgEvents(texts: string[]): unknown {
  return { events: texts.map((t) => ({ kind: "chat_message", data: { role: "user", text: t } })) };
}

beforeEach(() => {
  _clearSummaryCache();
  translateMock.mockReset();
  translateMock.mockImplementation(async () => ({ text: EN_MARKER }));
  loadMessagesMock.mockReset();
  loadMessagesMock.mockResolvedValue(msgEvents(TR));
  runCliMock.mockReset();
});

// v15.x (2026-06-04): abonelik (saf-CLI) modunda özet ARTIK atlanmaz — CLI ile üretilir.
describe("conversation-context · abonelik (CLI) özeti — parite", () => {
  const subConfig = {
    selected_models: { translator: "m", main: "m" },
    api_keys: { translator: "k", main: "k" },
    agent_backends: { orchestrator: "cli", translator: "cli", main: "cli" },
  } as unknown as MyclConfig;

  it("8+ mesaj + saf-abonelik → özet runClaudeCli ile üretilir (atlanmaz)", async () => {
    // 8 user mesajı: 3 older + 5 recent → SUMMARY_TRIGGER(7) aşılır, özet tetiklenir.
    const eight = Array.from({ length: 8 }, (_, i) => `mesaj ${i + 1}`);
    loadMessagesMock.mockResolvedValue(msgEvents(eight));
    runCliMock.mockResolvedValue({ ok: true, text: "CLI_SUMMARY_MARKER", toolUses: [], turns: 1 });

    const ctx = await buildConversationContext(subConfig, state);
    expect(ctx.earlier_summary).toBe("CLI_SUMMARY_MARKER"); // CLI yolu kullanıldı (atlanmadı)
    expect(runCliMock).toHaveBeenCalledTimes(1);
  });

  it("abonelik özeti CLI fail → null (fail-safe, takılma yok)", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `mesaj ${i + 1}`);
    loadMessagesMock.mockResolvedValue(msgEvents(eight));
    runCliMock.mockResolvedValue({ ok: false, error: "boom", text: "", toolUses: [], turns: 0 });
    const ctx = await buildConversationContext(subConfig, state);
    expect(ctx.earlier_summary).toBeNull(); // fail → null (caller recent ile devam)
  });
});

describe("conversation-context · ana ajan (forMainAgent) İngilizce", () => {
  it("recentLanguage:'en' → son mesajları çevirir; render İngilizce, HAM TÜRKÇE YOK", async () => {
    const ctx = await buildConversationContext(config, state, { recentLanguage: "en" });
    expect(ctx.recent_messages_en).toEqual([EN_MARKER, EN_MARKER, EN_MARKER]);
    const out = renderConversationSection(ctx, { forMainAgent: true });
    expect(out).toContain(EN_MARKER);
    // Ham Türkçe mesajlar ana ajan render'ında OLMAMALI:
    expect(out).not.toContain("anket sayfası");
    expect(out).not.toContain("düzelt");
  });

  it("orkestratör (default) HAM TÜRKÇE görür — regresyon guard", async () => {
    const ctx = await buildConversationContext(config, state); // recentLanguage yok
    const out = renderConversationSection(ctx); // forMainAgent yok
    expect(out).toContain("anket sayfası içinde");
    expect(ctx.recent_messages_en).toBeUndefined();
  });

  it("boş sohbet → İngilizce sentinel (Türkçe değil)", async () => {
    loadMessagesMock.mockResolvedValue(msgEvents([]));
    const ctx = await buildConversationContext(config, state, { recentLanguage: "en" });
    const out = renderConversationSection(ctx, { forMainAgent: true });
    expect(out).toContain("New conversation");
    expect(out).not.toContain("Yeni sohbet");
  });

  it("cache: aynı mesaj setiyle iki build → translate yalnız bir tur (3 çağrı, ikinci 0)", async () => {
    await buildConversationContext(config, state, { recentLanguage: "en" });
    expect(translateMock.mock.calls.length).toBe(3); // 3 mesaj
    await buildConversationContext(config, state, { recentLanguage: "en" });
    expect(translateMock.mock.calls.length).toBe(3); // cache hit → ek çağrı yok
  });

  it("çeviri başarısız → recents BOŞ, ham TR'ye DÜŞMEZ (Türkçe sızıntısı yok)", async () => {
    translateMock.mockRejectedValue(new Error("boom"));
    const ctx = await buildConversationContext(config, state, { recentLanguage: "en" });
    expect(ctx.recent_messages_en).toEqual([]);
    const out = renderConversationSection(ctx, { forMainAgent: true });
    expect(out).not.toContain("anket sayfası");
    expect(out).not.toContain("düzelt");
  });
});
