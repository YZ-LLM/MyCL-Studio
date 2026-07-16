// plan-mode — saf parse/format/persist + mod singleton testleri (LLM YOK; fixture).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  formatPlanTR,
  isPlanMode,
  parsePlanBlock,
  persistPlan,
  setPlanMode,
  type PlanProposal,
} from "../src/plan-mode.js";

const VALID_RAW = [
  "İşte plan:",
  "```json",
  JSON.stringify({
    kind: "work_plan",
    title_tr: "Blog Sitesi",
    summary_tr: "Blog sitesi üç adımda kurulur.",
    steps: [
      { text: "Yazı listesi ve detay sayfasıyla blog çekirdeğini kur.", priority: 1, rationale_tr: "Temel ürün." },
      { text: "Yönetici girişi ve yazı ekleme paneli ekle.", priority: 2, rationale_tr: "İçerik yönetimi çekirdeğin üstüne kurulur." },
    ],
  }),
  "```",
].join("\n");

describe("parsePlanBlock", () => {
  it("geçerli work_plan bloğunu parse eder", () => {
    const p = parsePlanBlock(VALID_RAW);
    expect(p).not.toBeNull();
    expect(p!.title_tr).toBe("Blog Sitesi");
    expect(p!.steps).toHaveLength(2);
    expect(p!.steps[0].priority).toBe(1);
  });

  it("bozuk/boş-adım → null (GÖRÜNÜR hata yolu; sessiz tek-iş fallback YOK)", () => {
    expect(parsePlanBlock("düz metin, blok yok")).toBeNull();
    expect(parsePlanBlock('```json\n{"kind":"work_plan","steps":[]}\n```')).toBeNull();
    expect(parsePlanBlock('```json\n{"kind":"work_plan","steps":[{"text":""}]}\n```')).toBeNull();
  });

  it("eksik priority/rationale toleranslı (sıra numarası + boş gerekçe)", () => {
    const p = parsePlanBlock(
      '```json\n{"kind":"work_plan","title_tr":"X","steps":[{"text":"adım bir"},{"text":"adım iki"}]}\n```',
    );
    expect(p!.steps.map((s) => s.priority)).toEqual([1, 2]);
    expect(p!.steps[0].rationale_tr).toBe("");
  });
});

describe("formatPlanTR", () => {
  it("adımlar öncelik sırasıyla numaralı + onay notu", () => {
    const plan: PlanProposal = {
      title_tr: "Deneme",
      summary_tr: "Özet.",
      steps: [
        { text: "İkinci iş", priority: 2, rationale_tr: "sonra" },
        { text: "İlk iş", priority: 1, rationale_tr: "önce" },
      ],
    };
    const msg = formatPlanTR(plan);
    expect(msg.indexOf("İlk iş")).toBeLessThan(msg.indexOf("İkinci iş"));
    expect(msg).toContain("🗺️ **İş Planı: Deneme**");
    expect(msg).toContain("2 adım");
  });
});

describe("persistPlan", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-plan-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("onaylanan plan .mycl/plans/<ts>.md olarak yazılır", async () => {
    const p = await persistPlan(root, {
      title_tr: "Kalıcı İz",
      summary_tr: "Özet.",
      steps: [{ text: "tek adım", priority: 1, rationale_tr: "neden" }],
    });
    expect(p).not.toBeNull();
    const body = await fs.readFile(p!, "utf-8");
    expect(body).toContain("# Kalıcı İz");
    expect(body).toContain("1. tek adım");
  });
});

describe("plan modu singleton", () => {
  it("varsayılan kapalı; set/read tutarlı", () => {
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
    setPlanMode(true);
    expect(isPlanMode()).toBe(true);
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
  });
});
