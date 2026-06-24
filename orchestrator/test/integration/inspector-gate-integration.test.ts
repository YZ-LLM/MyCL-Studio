// ENTEGRASYON (taklit/mock): gate-bulgusu incelemesi UÇTAN UCA — inspectGateFinding → runInspectorCheckpoint
// → runInspectorPass → runInspectorTurn (SDK kolu) → mahkemeRuling. Mevcut testler mahkemeRuling'i SAF test
// ediyordu; bu test asıl ASENKRON ZİNCİRİ sabitler (wiring fix'lerden ÖNCE — TDD güvenlik ağı; aşama 2-4
// bir şey bozarsa burası yakalar).
//
// İZOLASYON (YZLLM "sahte cevaplar sistemde kalmasın, iyi temizle"): (1) yalnız claude-api.runTurn taklit
// edilir, GERÇEK API/CLI çağrısı YOK; (2) MYCL_HOME geçici dizine alınır → recallLessons gerçek lessons.jsonl'a
// DOKUNMAZ, hiçbir gerçek veri okunmaz/yazılmaz; (3) test bittiğinde geçici dizin silinir, iz kalmaz.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runTurn'ü taklit et — diğer tüm gerçek dışa-aktarımlar korunur (importOriginal). inspector SDK döngüsü
// runTurn çağırır; bunu sabit bir verdict'e bağlarsak GERÇEK çağrı olmaz, sonuç her seferinde aynı.
const runTurnMock = vi.fn();
vi.mock("../../src/claude-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/claude-api.js")>();
  return { ...actual, runTurn: (...a: unknown[]) => runTurnMock(...a) };
});

import { inspectGateFinding, mahkemeRuling } from "../../src/inspector.js";
import type { MyclConfig } from "../../src/config.js";

// API-modu + Claude anahtarı → inspectorClaudeEnv ANTHROPIC_API_KEY döndürür → runInspectorTurn SDK koluna
// girer (CLI/claude binary'ye DÜŞMEZ). Böylece gerçek komut spawn edilmez; runTurnMock devreye girer.
const cfg = {
  agent_backends: { main: "api" },
  api_keys: { main: "test-key", translator: "t" },
} as unknown as MyclConfig;

/** Müfettişin verdiği sabit (sahte) verdict metni — JSON bloğu, araç-kullanımı YOK (model durdu). */
const verdictTurn = (stance: "agree" | "flag" | "escalate") => ({
  assistantContent: `\`\`\`json\n{"stance":"${stance}","reason":"sabit-test gerekçesi","evidence":"dosyaları okudum"}\n\`\`\``,
  toolUses: [],
  stop_reason: "end_turn",
});

let myclHome: string;
let prevHome: string | undefined;

beforeAll(async () => {
  // Global dizini geçici klasöre al → gerçek ~/.mycl/lessons.jsonl'a DOKUNMA (izolasyon).
  prevHome = process.env.MYCL_HOME;
  myclHome = await mkdtemp(join(tmpdir(), "mycl-inspect-it-"));
  process.env.MYCL_HOME = myclHome;
});

afterAll(async () => {
  // İz bırakma: env eski haline, geçici dizin silinir.
  if (prevHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = prevHome;
  await rm(myclHome, { recursive: true, force: true });
});

beforeEach(() => {
  runTurnMock.mockReset();
});

describe("entegrasyon · inspectGateFinding → mahkemeRuling (taklit runTurn, SDK kolu, izole)", () => {
  it("flag yolu + müfettiş AGREE → mahkeme PROCEED (zincir uçtan uca; gerçek çağrı yok)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    const cp = await inspectGateFinding(cfg, { projectRoot: myclHome, gateLabel: "lint", errors: "'x' kullanılmıyor" });
    // SDK koluna girildi (CLI değil) → runTurn taklidi çağrıldı, gerçek API/CLI yok.
    expect(runTurnMock).toHaveBeenCalled();
    const ruling = mahkemeRuling(cp);
    expect(ruling.action).toBe("proceed");
    expect(ruling.convened).toBe(true);
  });

  it("flag yolu + müfettiş FLAG → mahkeme ESCALATE (tartışmasız SUPPRESS YOK — güvenli eşleme)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("flag"));
    const cp = await inspectGateFinding(cfg, { projectRoot: myclHome, gateLabel: "lint", errors: "'x' kullanılmıyor" });
    expect(runTurnMock).toHaveBeenCalled();
    expect(mahkemeRuling(cp).action).toBe("escalate");
  });

  it("müfettiş üretemezse (runTurn hata atar) → mahkeme ESCALATE (fail-closed, sessiz-AGREE YOK)", async () => {
    runTurnMock.mockRejectedValue(new Error("api erişilemez"));
    const cp = await inspectGateFinding(cfg, { projectRoot: myclHome, gateLabel: "lint", errors: "'x' kullanılmıyor" });
    expect(runTurnMock).toHaveBeenCalled();
    expect(mahkemeRuling(cp).action).toBe("escalate");
  });
});

// Wiring sinyalleri (Aşama 2-4): mekanik-taban sinyalleri kaynağından türetilince tartışma yolunu açar.
// (Müfettiş "agree" dönünce tartışma ilk geçişte çözülür → runReasoning/savunma gerekmez; outcome'da
// "resolution" alanı varsa TAM-TARTIŞMA yolundan geçilmiştir = wiring çalıştı.)
describe("entegrasyon · wiring sinyalleri → tartışma yolu (Aşama 2-4)", () => {
  it("isStuck: hata 'cli idle timeout' içerir → TARTIŞMA yolu (flag değil)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    const cp = await inspectGateFinding(cfg, {
      projectRoot: myclHome,
      gateLabel: "Faz 9",
      errors: "cli idle timeout 600000ms",
    });
    // outcome bir DebateOutcome (resolution alanı) → mekanik taban (isStuck) tartışmayı tetikledi.
    expect(cp.outcome && "resolution" in cp.outcome).toBe(true);
    expect(mahkemeRuling(cp).action).toBe("proceed");
  });

  it("highStakesAction: güvenlik bulgusu + müfettiş AGREE → tartışma + ESCALATE (anlaşma tek başına güvenli değil)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    const cp = await inspectGateFinding(cfg, {
      projectRoot: myclHome,
      gateLabel: "Faz 13",
      errors: "güvenlik açığı: secret sızıntısı",
    });
    expect(cp.highStakes).toBe(true);
    expect(cp.outcome && "resolution" in cp.outcome).toBe(true);
    // Yüksek-riskte müfettiş katılsa bile oto-proceed YOK → insana (güvenli eşleme).
    expect(mahkemeRuling(cp).action).toBe("escalate");
  });

  it("highStakes genişletilmiş dağarcık: dar listede olmayan XSS bile yüksek-risk sayılır (2026-06-24 fix)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    // "XSS" eski 7-kelime listesinde YOK (güvenlik|security|secret|credential|csp|injection|auth) →
    // eskiden highStakes=false (düşük inceleme). Genişletilmiş regex artık yakalıyor.
    const cp = await inspectGateFinding(cfg, {
      projectRoot: myclHome,
      gateLabel: "Faz 10",
      errors: "potential XSS in rendered task title (unescaped innerHTML)",
    });
    expect(cp.highStakes).toBe(true);
    expect(mahkemeRuling(cp).action).toBe("escalate");
  });

  it("highStakes YAPISAL override: caller highStakes=true verince regex'e bakılmaz (Faz 13 yolu)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    // errors'ta hiçbir güvenlik kelimesi yok ama caller yapısal olarak yüksek-risk diyor → güvenilir.
    const cp = await inspectGateFinding(cfg, {
      projectRoot: myclHome,
      gateLabel: "gate",
      errors: "beklenmedik çıktı farkı",
      highStakes: true,
    });
    expect(cp.highStakes).toBe(true);
    expect(mahkemeRuling(cp).action).toBe("escalate");
  });

  it("highStakes false-positive YOK: 'author' yüksek-risk sayılmaz (mahkeme: \\bauth → \\bauth(...)\\b fix)", async () => {
    runTurnMock.mockResolvedValue(verdictTurn("agree"));
    // '@author' eskiden \bauth ile MATCH → gereksiz highStakes+debate. Artık eşleşmiyor.
    const cp = await inspectGateFinding(cfg, {
      projectRoot: myclHome,
      gateLabel: "Faz 10",
      errors: "unused import in file // @author John Doe",
    });
    expect(cp.highStakes).toBe(false);
    expect(mahkemeRuling(cp).action).toBe("proceed"); // medium flag yolu → agree → proceed
  });
});
