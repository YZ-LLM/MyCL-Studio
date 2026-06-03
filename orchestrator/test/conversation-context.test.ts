import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyclConfig } from "../src/config.js";
import type { State } from "../src/types.js";

// translate + loadMessages mock (vi.hoisted — factory'den önce tanımlı).
const { translateMock, loadMessagesMock } = vi.hoisted(() => ({
  translateMock: vi.fn(),
  loadMessagesMock: vi.fn(),
}));
vi.mock("../src/translator.js", () => ({ translate: translateMock }));
vi.mock("../src/history-loader.js", () => ({ loadMessages: loadMessagesMock }));

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
