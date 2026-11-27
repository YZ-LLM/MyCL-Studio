// text-only-cli-calls — yalnız metin işleyen üç yardımcı CLI çağrısı ARAÇSIZ, süre tavanlı ve
// tarafsız klasörde koşar: ilgililik sınıflandırıcısı, konuşma özeti, proje tipi sınıflandırıcısı.
//
// CANLI KANIT (ekransız deneme koşusu 6, 2026-11-27): üçü de `disallowedTools` vermiyordu ve
// `cwd: process.cwd()` ile koşuyordu. Sınıflandırıcı parça metinlerini görev sanıp MyCL'in başlatıldığı
// klasöre 10 dosya yazdı; iki deneme 147 + 93 saniye sürdü (toplam süre tavanı yoktu, varsayılan 30 dk).
//
// Gerçek `claude` başlatılmaz: `runClaudeCli` taklit edilir ve çağrıya verilen SEÇENEKLER denetlenir.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyclConfig } from "../src/config.js";
import type { Chunk } from "../src/relevance/types.js";
import type { State } from "../src/types.js";

const { runCliMock, loadMessagesMock } = vi.hoisted(() => ({
  runCliMock: vi.fn(),
  loadMessagesMock: vi.fn(),
}));
vi.mock("../src/cli-run.js", () => ({ runClaudeCli: runCliMock }));
vi.mock("../src/subscription-mode.js", () => ({
  isSubscriptionMode: () => true,
  noteSubscriptionSkipOnce: vi.fn(),
}));
vi.mock("../src/translator.js", () => ({ translate: vi.fn(async () => ({ text: "EN" })) }));
vi.mock("../src/history-loader.js", () => ({ loadMessages: loadMessagesMock }));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/ipc.js", () => ({
  emitClaudeStream: vi.fn(),
  emitChatMessage: vi.fn(),
  emitError: vi.fn(),
  withClaudeStreamBanner: async (_opts: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { _clearSummaryCache, buildConversationContext } from "../src/conversation-context.js";
import { classifyProjectType } from "../src/project-type-classifier.js";
import { buildCliScoringMessage, scoreChunksViaCli } from "../src/relevance/classifier.js";
import { wrapChatSummaryUserForCli } from "../src/chat-summary.js";
import { wrapDistillUserForCli } from "../src/lesson-distill.js";
import { ZERO_TOOLS_DISALLOWED } from "../src/tool-policy.js";

const NOTR_KLASOR = "/tmp/mycl-notr-klasor-testi";
/** Toplam süre tavanı "kısa" sayılır: sıfırdan büyük, varsayılan 30 dakikanın çok altında. */
const KISA_TAVAN_UST_SINIRI_MS = 300_000;

const config = {
  selected_models: { translator: "claude-haiku-4-5", main: "m" },
  api_keys: { translator: "", main: "" },
  agent_backends: { orchestrator: "cli", translator: "cli", main: "cli" },
} as unknown as MyclConfig;

let eskiMyclHome: string | undefined;

beforeAll(() => {
  eskiMyclHome = process.env.MYCL_HOME;
  process.env.MYCL_HOME = NOTR_KLASOR; // globalConfigDir() → açık geçersiz kılma (gerçek ~/.mycl'e dokunulmaz)
});

afterAll(() => {
  if (eskiMyclHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = eskiMyclHome;
});

beforeEach(() => {
  runCliMock.mockReset();
  loadMessagesMock.mockReset();
  _clearSummaryCache();
});

interface GorulenSecenekler {
  cwd?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  wallClockMs?: number;
  timeoutMs?: number;
}

function tekCagri(): GorulenSecenekler {
  expect(runCliMock).toHaveBeenCalledTimes(1);
  return runCliMock.mock.calls[0]![0] as GorulenSecenekler;
}

function aracsizVeTavanli(opts: GorulenSecenekler): void {
  // Sıfır araç listesi: prompt cümlesi değil, deny-list.
  expect(opts.disallowedTools).toEqual(ZERO_TOOLS_DISALLOWED);
  expect(opts.allowedTools ?? []).toEqual([]);
  // Sert toplam süre tavanı (timeoutMs yalnız sessizlik süresidir).
  expect(typeof opts.wallClockMs).toBe("number");
  expect(opts.wallClockMs!).toBeGreaterThan(0);
  expect(opts.wallClockMs!).toBeLessThanOrEqual(KISA_TAVAN_UST_SINIRI_MS);
  // Tarafsız klasör: MyCL'in başlatıldığı klasör değil.
  expect(opts.cwd).toBe(NOTR_KLASOR);
  expect(opts.cwd).not.toBe(process.cwd());
}

describe("yalnız metin işleyen CLI çağrıları — araçsız, tavanlı, tarafsız klasörde", () => {
  it("ilgililik sınıflandırıcısı", async () => {
    const chunks: Chunk[] = [{ id: "c1", source: "audit", text: "phase-4 approved", metadata: {} } as Chunk];
    runCliMock.mockResolvedValue({
      ok: true,
      text: '{"kind":"relevance_scores","scores":[{"id":"c1","score":7,"reason":"ilgili"}]}',
      toolUses: [],
      turns: 1,
    });
    const scored = await scoreChunksViaCli("claude-haiku-4-5", "Kaldığın yerden devam et.", chunks);
    expect(scored).toHaveLength(1);
    aracsizVeTavanli(tekCagri());
  });

  it("konuşma özeti", async () => {
    const sekiz = Array.from({ length: 8 }, (_, i) => `mesaj ${i + 1}`);
    loadMessagesMock.mockResolvedValue({
      events: sekiz.map((t) => ({ kind: "chat_message", data: { role: "user", text: t } })),
    });
    runCliMock.mockResolvedValue({ ok: true, text: "OZET", toolUses: [], turns: 1 });
    const ctx = await buildConversationContext(config, { project_root: "/tmp/x" } as unknown as State);
    expect(ctx.earlier_summary).toBe("OZET");
    aracsizVeTavanli(tekCagri());
  });

  it("proje tipi sınıflandırıcısı", async () => {
    runCliMock.mockResolvedValue({
      ok: true,
      text: '{"kind":"project_type","project_type":"cli","has_database":false,"ui_complexity":"simple"}',
      toolUses: [],
      turns: 1,
    });
    const r = await classifyProjectType(config, "A small command line tool that renames files in bulk.");
    expect(r.project_type).toBe("cli");
    aracsizVeTavanli(tekCagri());
  });
});

// CANLI KANIT (ekransız deneme koşuları 6, 7, 13; 2026-11-27): niyet cümlesi ("Kaldığın yerden devam et.")
// ham ve en baştaydı; model puan yerine işe girişti. Kullanıcı metni artık açıkça VERİ olarak sınırlanır ve
// çıktı talimatı verinin ARDINDAN yinelenir. Etiketler satır başında aranır: giriş cümlesi de etiket adlarını anar.
describe("yalnız metin işleyen CLI çağrıları — kullanıcı metni veri sınırı içinde", () => {
  const NIYET = "Kaldığın yerden devam et.";

  it("sınıflandırıcı: niyet veri sınırı içinde, mesaj çıktı talimatıyla biter", () => {
    const chunks = [
      { id: "c1", source: "audit", text: "phase-4 approved", metadata: {} },
      { id: "c2", source: "spec", text: "todo app", metadata: {} },
    ] as unknown as Chunk[];
    const msg = buildCliScoringMessage(NIYET, chunks);
    const ac = msg.indexOf("\n<intent>\n");
    const kapa = msg.indexOf("\n</intent>");
    const niyet = msg.indexOf(NIYET);
    expect(ac).toBeGreaterThan(0); // önce "bu veridir" cümlesi
    expect(msg.slice(0, ac)).toMatch(/DATA/);
    expect(niyet).toBeGreaterThan(ac);
    expect(niyet).toBeLessThan(kapa);
    // Parçalar da kendi sınırı içinde ve niyetten sonra.
    const parcaAc = msg.indexOf("\n<chunks>\n");
    const parcaKapa = msg.indexOf("\n</chunks>");
    expect(parcaAc).toBeGreaterThan(kapa);
    expect(msg.indexOf("[id=c2]")).toBeLessThan(parcaKapa);
    // Çıktı talimatı verinin ARDINDAN, son satır JSON kalıbı.
    const sonrasi = msg.slice(parcaKapa);
    expect(sonrasi).toMatch(/Do NOT call any tool/);
    expect(sonrasi).toMatch(/2 entries/);
    expect(msg.trimEnd().endsWith('"reason":"<short>"}]}')).toBe(true);
  });

  it("sınıflandırıcı CLI çağrısı bu mesajı gönderir", async () => {
    const chunks: Chunk[] = [{ id: "c1", source: "audit", text: "phase-4 approved", metadata: {} } as Chunk];
    runCliMock.mockResolvedValue({
      ok: true,
      text: '{"kind":"relevance_scores","scores":[{"id":"c1","score":7,"reason":"ilgili"}]}',
      toolUses: [],
      turns: 1,
    });
    await scoreChunksViaCli("claude-haiku-4-5", NIYET, chunks);
    const opts = runCliMock.mock.calls[0]![0] as { userMessage: string };
    expect(opts.userMessage).toBe(buildCliScoringMessage(NIYET, chunks));
  });

  it("konuşma özeti ve proje tipi: kullanıcı metni sınır içinde", async () => {
    loadMessagesMock.mockResolvedValue({
      events: Array.from({ length: 8 }, (_, i) => ({ kind: "chat_message", data: { role: "user", text: `${NIYET} ${i}` } })),
    });
    runCliMock.mockResolvedValue({ ok: true, text: "OZET", toolUses: [], turns: 1 });
    await buildConversationContext(config, { project_root: "/tmp/x" } as unknown as State);
    const ozet = (runCliMock.mock.calls[0]![0] as { userMessage: string }).userMessage;
    expect(ozet.indexOf("\n<messages>\n")).toBeLessThan(ozet.indexOf(NIYET));
    expect(ozet.indexOf(NIYET)).toBeLessThan(ozet.indexOf("\n</messages>"));
    expect(ozet.slice(ozet.indexOf("\n</messages>"))).toMatch(/Do NOT call any tool/);

    runCliMock.mockReset();
    runCliMock.mockResolvedValue({
      ok: true,
      text: '{"kind":"project_type","project_type":"cli","has_database":false,"ui_complexity":"simple"}',
      toolUses: [],
      turns: 1,
    });
    await classifyProjectType(config, `A small CLI. ${NIYET}`);
    const tip = (runCliMock.mock.calls[0]![0] as { userMessage: string }).userMessage;
    expect(tip.indexOf("\n<summary>\n")).toBeLessThan(tip.indexOf(NIYET));
    expect(tip.indexOf(NIYET)).toBeLessThan(tip.indexOf("\n</summary>"));
    expect(tip.trimEnd().endsWith("}")).toBe(true);
  });

  it("sohbet özeti: kesilme notu sınırın DIŞINDA, döküm içinde", () => {
    const NOT = "(NOT: döküm uzundu — yalnız EN YENİ kısım verildi; özetin başında bunu tek cümleyle belirt.)";
    const kesik = wrapChatSummaryUserForCli(`${NOT}\n\n[01.01 10:00 user] ${NIYET}`);
    expect(kesik.indexOf(NOT)).toBeLessThan(kesik.indexOf("\n<dokum>\n"));
    expect(kesik.indexOf(NIYET)).toBeGreaterThan(kesik.indexOf("\n<dokum>\n"));
    expect(kesik.indexOf(NIYET)).toBeLessThan(kesik.indexOf("\n</dokum>"));
    const tam = wrapChatSummaryUserForCli(`[01.01 10:00 user] ${NIYET}`);
    expect(tam).not.toContain(NOT);
    expect(tam.slice(tam.indexOf("\n</dokum>"))).toMatch(/YALNIZ özeti yaz/);
  });

  it("ders damıtma: sorun/çözüm sınır içinde, mesaj JSON kalıbıyla biter", () => {
    const msg = wrapDistillUserForCli(`Sorun: ${NIYET}\n\nÇözüm: x\n\nYerel ilke: y`);
    expect(msg.indexOf("\n<veri>\n")).toBeLessThan(msg.indexOf(NIYET));
    expect(msg.indexOf(NIYET)).toBeLessThan(msg.indexOf("\n</veri>"));
    expect(msg.trimEnd().endsWith('{"kind":"skip"}')).toBe(true);
  });
});
