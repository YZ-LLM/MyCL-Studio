// gate-overlay/compile — derleme + kalıcılaştırma. LLM YOK: derleyici saf, geri kalanı geçici dizinde.
//
// Burada korunan asıl garantiler:
//  - Kapalı sözlük (AD-1): sözlük dışı serbest metin HİÇBİR kısıta dönüşmez.
//  - Determinizm (AD-5): aynı girdi → bayt aynı çıktı (puan/rastgelelik yok).
//  - Tek aktif overlay (AD-4): yeni derleme eskisini arşive taşımadan yazılmaz.
//  - Görünür bozukluk (AD-8): okunamayan overlay "kısıt yok" sayılmaz, fırlatır.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatePool } from "../src/gate-overlay/pool.js";
import type { GatePool } from "../src/gate-overlay/pool.js";
import type { OverlayContext } from "../src/gate-overlay/select.js";
import {
  buildOverlayInventory,
  buildOverlayPrompt,
  compileOverlayFromProposal,
  computeBaselines,
  getActiveOverlay,
  overlayArchiveDir,
  overlayCurrentPath,
  persistOverlay,
  readActiveOverlay,
  setActiveOverlay,
  type CompiledOverlay,
} from "../src/gate-overlay/compile.js";

let pool: GatePool;
beforeAll(async () => {
  pool = await loadGatePool();
});

const ctx: OverlayContext = {
  projectFiles: new Set([
    "src/app.ts",
    "src/schema/user.schema.json",
    "package.json",
  ]),
  projectDirs: new Set([".", "src", "src/components"]),
};

/** Modelin tipik çıktısı: açıklama + tek ```json bloğu. */
function block(body: unknown): string {
  return `Here is my analysis.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

const VALID_BODY = {
  kind: "gate_overlay",
  selections: [
    { gate_id: "file_immutable", params: { path: "src/app.ts" }, reason: "dokunulmamalı" },
    { gate_id: "forbid_dependency_change", params: {} },
  ],
  missing: [{ risk_description: "migration geri alınabilir olmalı", suggested_name: "reversible_migration" }],
};

describe("compileOverlayFromProposal", () => {
  it("geçerli blok → seçimler kabul edilir, missing taşınır", () => {
    const res = compileOverlayFromProposal(block(VALID_BODY), pool, ctx);
    expect(res.parseError).toBeUndefined();
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted.map((a) => a.gate_id)).toEqual([
      "file_immutable",
      "forbid_dependency_change",
    ]);
    expect(res.accepted[0].reason).toBe("dokunulmamalı");
    expect(res.missing).toHaveLength(1);
    expect(res.missing[0].suggested_name).toBe("reversible_migration");
  });

  it("havuz dışı gate_id → unknown_gate ile düşer (uydurma kural uygulanmaz)", () => {
    const res = compileOverlayFromProposal(
      block({ kind: "gate_overlay", selections: [{ gate_id: "no_console_log", params: {} }] }),
      pool,
      ctx,
    );
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].code).toBe("unknown_gate");
  });

  it("bozuk parametre → bad_params ile düşer", () => {
    const res = compileOverlayFromProposal(
      block({
        kind: "gate_overlay",
        selections: [{ gate_id: "file_immutable", params: { dosya: "src/app.ts" } }],
      }),
      pool,
      ctx,
    );
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0].code).toBe("bad_params");
  });

  it("projede olmayan yol → bad_context ile düşer", () => {
    const res = compileOverlayFromProposal(
      block({
        kind: "gate_overlay",
        selections: [{ gate_id: "file_immutable", params: { path: "src/yok.ts" } }],
      }),
      pool,
      ctx,
    );
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0].code).toBe("bad_context");
  });

  it("blok yoksa parseError döner (sessiz boş overlay YOK)", () => {
    const res = compileOverlayFromProposal("Sadece düz metin yazdım, JSON yok.", pool, ctx);
    expect(res.parseError).toBeTruthy();
    expect(res.accepted).toHaveLength(0);
  });

  it("bloğun biçimi bozuksa kısmi kabul YOK", () => {
    const res = compileOverlayFromProposal(
      block({ kind: "gate_overlay", selections: [{ gate_id: "file_immutable", params: { path: 3 } }] }),
      pool,
      ctx,
    );
    expect(res.parseError).toBeTruthy();
    expect(res.accepted).toHaveLength(0);
  });

  it("sözlük dışı SERBEST METİN kural hiçbir şekilde yorumlanmaz (AD-1)", () => {
    const raw = block({
      kind: "gate_overlay",
      rules: ["Never touch src/app.ts", "All functions must be pure"],
      custom_gate: { name: "no_any", enforce: true },
      selections: [],
      missing: [],
    });
    const res = compileOverlayFromProposal(raw, pool, ctx);
    expect(res.parseError).toBeUndefined();
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
  });

  it("aynı kısıt iki kez seçilirse tekilleşir", () => {
    const res = compileOverlayFromProposal(
      block({
        kind: "gate_overlay",
        selections: [
          { gate_id: "file_immutable", params: { path: "src/app.ts" } },
          { gate_id: "file_immutable", params: { path: "src/app.ts" }, reason: "yine" },
        ],
      }),
      pool,
      ctx,
    );
    expect(res.accepted).toHaveLength(1);
  });

  it("DETERMİNİZM: aynı metin + havuz + bağlam → bayt aynı sonuç", () => {
    const raw = block(VALID_BODY);
    const a = JSON.stringify(compileOverlayFromProposal(raw, pool, ctx));
    const b = JSON.stringify(compileOverlayFromProposal(raw, pool, ctx));
    expect(a).toBe(b);
  });

  it("DETERMİNİZM: parametre anahtar sırası çıktıyı değiştirmez", () => {
    const first = compileOverlayFromProposal(
      block({
        kind: "gate_overlay",
        selections: [
          {
            gate_id: "schema_check",
            params: { target: "src/api.ts", schema_ref: "src/schema/user.schema.json" },
          },
        ],
      }),
      pool,
      ctx,
    );
    const second = compileOverlayFromProposal(
      block({
        kind: "gate_overlay",
        selections: [
          {
            gate_id: "schema_check",
            params: { schema_ref: "src/schema/user.schema.json", target: "src/api.ts" },
          },
        ],
      }),
      pool,
      ctx,
    );
    expect(JSON.stringify(first.accepted)).toBe(JSON.stringify(second.accepted));
  });
});

describe("buildOverlayPrompt", () => {
  it("havuzdaki HER gate promptta adıyla geçer (model tahmin etmek zorunda kalmaz)", () => {
    const { system } = buildOverlayPrompt(pool, "bir iş", "envanter");
    for (const gate of pool.gates) {
      expect(system, `promptta eksik gate: ${gate.gate_id}`).toContain(gate.gate_id);
    }
  });

  it("çıktı sözleşmesi ve iş metni/envanter promptta yer alır", () => {
    const { system, user } = buildOverlayPrompt(pool, "kullanıcı girişi ekle", "src/ (3 files)");
    expect(system).toContain('"kind"');
    expect(system).toContain("gate_overlay");
    expect(user).toContain("kullanıcı girişi ekle");
    expect(user).toContain("src/ (3 files)");
  });
});

describe("dosya sistemine dokunan bölüm", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-overlay-"));
  });
  afterEach(async () => {
    setActiveOverlay(null);
    await rm(root, { recursive: true, force: true });
  });

  const overlayOf = (over: Partial<CompiledOverlay> = {}): CompiledOverlay => ({
    overlay_version: 1,
    pool_version: pool.pool_version,
    iteration_key: "iter1-1000",
    compiled_at: 1000,
    selections: [],
    baselines: {},
    ...over,
  });

  describe("computeBaselines", () => {
    it("var olan dosya sha256, olmayan null", async () => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "merhaba", "utf-8");
      const baselines = await computeBaselines(
        [
          { gate_id: "file_immutable", params: { path: "src/app.ts" } },
          { gate_id: "file_must_change", params: { path: "src/yeni.ts" } },
        ],
        root,
      );
      expect(baselines["src/app.ts"]).toBe(
        createHash("sha256").update(Buffer.from("merhaba", "utf-8")).digest("hex"),
      );
      expect(baselines["src/yeni.ts"]).toBeNull();
    });

    it("forbid_dependency_change YALNIZ projede var olan bağımlılık dosyalarını tabanlar", async () => {
      await writeFile(join(root, "package.json"), "{}", "utf-8");
      await writeFile(join(root, "go.mod"), "module x", "utf-8");
      const baselines = await computeBaselines(
        [{ gate_id: "forbid_dependency_change", params: {} }],
        root,
      );
      expect(Object.keys(baselines).sort()).toEqual(["go.mod", "package.json"]);
      expect(baselines["package.json"]).toBeTruthy();
      expect(baselines["Cargo.toml"]).toBeUndefined();
    });

    it("seçim yoksa taban çizgisi de yok", async () => {
      await writeFile(join(root, "package.json"), "{}", "utf-8");
      expect(await computeBaselines([], root)).toEqual({});
    });
  });

  describe("persistOverlay / readActiveOverlay", () => {
    it("yeni dosya yazılır, tmp artığı bırakmaz, hash içerikle uyumlu", async () => {
      const overlay = overlayOf();
      const hash = await persistOverlay(root, overlay);
      const raw = await readFile(overlayCurrentPath(root), "utf-8");
      expect(createHash("sha256").update(raw).digest("hex")).toBe(hash);
      const entries = await readdir(join(root, ".mycl", "overlays"));
      expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
      expect(await readActiveOverlay(root)).toEqual(overlay);
    });

    it("İKİNCİ derleme eskisini archive/'a taşır — current.json HEP tek ve yeni (AD-4)", async () => {
      await persistOverlay(root, overlayOf({ iteration_key: "iter1-1000", compiled_at: 1000 }));
      await persistOverlay(
        root,
        overlayOf({
          iteration_key: "iter2-2000",
          compiled_at: 2000,
          selections: [{ gate_id: "forbid_dependency_change", params: {} }],
        }),
      );
      const active = await readActiveOverlay(root);
      expect(active?.iteration_key).toBe("iter2-2000");
      expect(active?.selections).toHaveLength(1);
      const archived = await readdir(overlayArchiveDir(root));
      expect(archived).toEqual(["1000-iter1-1000.json"]);
      const old = JSON.parse(await readFile(join(overlayArchiveDir(root), archived[0]), "utf-8"));
      expect(old.iteration_key).toBe("iter1-1000");
    });

    it("overlay yoksa null (kısıt seçilmemiş olmak meşru)", async () => {
      expect(await readActiveOverlay(root)).toBeNull();
    });

    it("bozuk JSON → THROW (AD-8: 'okunamıyor' ile 'kısıt yok' aynı şey değil)", async () => {
      await mkdir(join(root, ".mycl", "overlays"), { recursive: true });
      await writeFile(overlayCurrentPath(root), "{ bu json değil", "utf-8");
      await expect(readActiveOverlay(root)).rejects.toThrow(/overlay gecersiz/);
    });

    it("yapısı bozuk overlay → THROW", async () => {
      await mkdir(join(root, ".mycl", "overlays"), { recursive: true });
      await writeFile(
        overlayCurrentPath(root),
        JSON.stringify({ overlay_version: 1, pool_version: 1, iteration_key: "x", compiled_at: 1, selections: "hepsi", baselines: {} }),
        "utf-8",
      );
      await expect(readActiveOverlay(root)).rejects.toThrow(/selections dizi olmalı/);
    });
  });

  describe("buildOverlayInventory", () => {
    it("türetilmiş dizinler her derinlikte elenir, kalanlar bağlama girer", async () => {
      await mkdir(join(root, "src", "components"), { recursive: true });
      await mkdir(join(root, "packages", "web", "node_modules", "x"), { recursive: true });
      await mkdir(join(root, ".mycl"), { recursive: true });
      await writeFile(join(root, "package.json"), "{}", "utf-8");
      await writeFile(join(root, "src", "app.ts"), "x", "utf-8");
      await writeFile(join(root, "src", "components", "Btn.tsx"), "x", "utf-8");
      await writeFile(join(root, "packages", "web", "node_modules", "x", "index.js"), "x", "utf-8");
      await writeFile(join(root, ".mycl", "state.json"), "{}", "utf-8");

      const inv = await buildOverlayInventory(root);
      expect(inv.truncated).toBe(false);
      expect([...inv.ctx.projectFiles].sort()).toEqual([
        "package.json",
        "src/app.ts",
        "src/components/Btn.tsx",
      ]);
      expect(inv.ctx.projectDirs.has("src/components")).toBe(true);
      expect(inv.ctx.projectDirs.has(".")).toBe(true);
      expect(inv.summary).toContain("package.json");
    });

    it("okunamayan kök → görünür hata (sessiz boş envanter yok)", async () => {
      await expect(buildOverlayInventory(join(root, "yok"))).rejects.toThrow(/okunamadı/);
    });
  });

  describe("bellek tutucusu", () => {
    it("set/get aynı kaydı verir, null ile temizlenir", () => {
      const overlay = overlayOf();
      setActiveOverlay(overlay);
      expect(getActiveOverlay()).toEqual(overlay);
      setActiveOverlay(null);
      expect(getActiveOverlay()).toBeNull();
    });
  });
});

describe("denetim olay adları (isim kilidi)", () => {
  // audit.ts ASCII zorunlu; ayrıca `-fail` biten olay hüküm makinesinde gate başarısızlığı,
  // `-skipped` biten olay Faz 13/17'de güvenlik atlaması sayılır. Overlay olayları NÖTR kalmalı —
  // yoksa "3 gate reddedildi" gibi normal bir tur, pipeline hükmünü kırmızıya çevirirdi.
  const EVENTS = ["overlay_compiled", "overlay_selection_rejected", "missing_gate"];
  it("ASCII + hüküm makinesinin sonek desenlerine çarpmaz", () => {
    for (const ev of EVENTS) {
      expect(/^[\x20-\x7E]+$/.test(ev), ev).toBe(true);
      expect(ev.endsWith("-fail"), ev).toBe(false);
      expect(ev.endsWith("-skipped"), ev).toBe(false);
    }
  });
});
