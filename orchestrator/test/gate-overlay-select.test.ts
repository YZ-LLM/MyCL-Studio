import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadGatePool } from "../src/gate-overlay/pool.js";
import type { GatePool } from "../src/gate-overlay/pool.js";
import {
  dedupeSelections,
  parseOverlayProposal,
  validateSelection,
} from "../src/gate-overlay/select.js";
import type { OverlayContext, OverlaySelection } from "../src/gate-overlay/select.js";

// Seçim doğrulamanın üç kapısı: sözlük (unknown_gate), şema (bad_params), bağlam (bad_context).
// Testler GERÇEK havuzu kullanır — sözlük ile bağlam kuralları birbirinden ayrı düşerse burada
// yakalanır (havuza gate eklenip kuralı yazılmazsa "bağlam kuralı tanımlı değil" ile düşer).

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, "..", "src", "gate-overlay");

const ctx: OverlayContext = {
  projectFiles: new Set([
    "src/app.ts",
    "src/schema/user.schema.json",
    "package.json",
  ]),
  projectDirs: new Set(["src", "src/components", "docs"]),
};

/** Havuzdaki her gate için geçerli bir örnek seçim. */
const VALID_SELECTIONS: Record<string, OverlaySelection> = {
  file_immutable: { gate_id: "file_immutable", params: { path: "src/app.ts" } },
  file_must_change: {
    gate_id: "file_must_change",
    params: { path: "src/henuz-yok.ts" },
  },
  schema_check: {
    gate_id: "schema_check",
    params: { target: "src/api/user.ts", schema_ref: "src/schema/user.schema.json" },
  },
  forbid_new_files: { gate_id: "forbid_new_files", params: { dir: "src/components" } },
  forbid_dependency_change: { gate_id: "forbid_dependency_change", params: {} },
  test_must_pass: {
    gate_id: "test_must_pass",
    params: { test_ref: "test/user.test.ts" },
  },
};

let pool: GatePool;

beforeAll(async () => {
  pool = await loadGatePool();
});

describe("geçerli seçimler", () => {
  it("havuzdaki 6 gate'in her biri için geçerli seçim kabul edilir", () => {
    expect(Object.keys(VALID_SELECTIONS)).toHaveLength(pool.gates.length);
    for (const gate of pool.gates) {
      const sel = VALID_SELECTIONS[gate.gate_id];
      expect(sel, `örnek seçim eksik: ${gate.gate_id}`).toBeDefined();
      const result = validateSelection(sel, pool, ctx);
      expect(result.ok ? "" : `${result.code}: ${result.reason}`).toBe("");
      if (result.ok) expect(result.entry.gate_id).toBe(gate.gate_id);
    }
  });

  it("file_must_change henüz var olmayan dosyayı kabul eder (iterasyon onu yaratabilir)", () => {
    const result = validateSelection(
      { gate_id: "file_must_change", params: { path: "src/yeni/modul.ts" } },
      pool,
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("reason alanı doğrulamayı etkilemez (yalnız insan okuması için)", () => {
    const withReason = { ...VALID_SELECTIONS.file_immutable, reason: "sözleşme dosyası" };
    expect(validateSelection(withReason, pool, ctx).ok).toBe(true);
    const withEmptyReason = { ...VALID_SELECTIONS.file_immutable, reason: "" };
    expect(validateSelection(withEmptyReason, pool, ctx).ok).toBe(true);
  });
});

describe("unknown_gate — kapalı sözlük dışı hiçbir şey uygulanmaz", () => {
  it("havuzda olmayan gate reddedilir", () => {
    const result = validateSelection(
      { gate_id: "kendi_uydurdugum_kural", params: { path: "src/app.ts" } },
      pool,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_gate");
      expect(result.reason).toContain("kendi_uydurdugum_kural");
    }
  });
});

describe("bad_params — şema kapısı", () => {
  const expectBadParams = (sel: OverlaySelection, needle: string) => {
    const result = validateSelection(sel, pool, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_params");
      expect(result.reason).toContain(needle);
    }
  };

  it("zorunlu parametre eksik", () => {
    expectBadParams({ gate_id: "file_immutable", params: {} }, "path");
  });

  it("iki zorunludan biri eksik", () => {
    expectBadParams(
      { gate_id: "schema_check", params: { target: "src/api/user.ts" } },
      "schema_ref",
    );
  });

  it("şemada olmayan fazla parametre", () => {
    expectBadParams(
      { gate_id: "file_immutable", params: { path: "src/app.ts", mod: "readonly" } },
      "mod",
    );
  });

  it("parametresiz gate'e parametre verilemez", () => {
    expectBadParams(
      { gate_id: "forbid_dependency_change", params: { path: "package.json" } },
      "path",
    );
  });

  it("string olmayan değer", () => {
    // Model çıktısı doğrudan değil, elle kurulmuş seçim: doğrulayıcı kendi başına da
    // tip kontrolü yapmalı (parseOverlayProposal'a güvenip atlamamalı).
    const sel = {
      gate_id: "file_immutable",
      params: { path: 42 as unknown as string },
    };
    expectBadParams(sel, "path");
  });
});

describe("bad_context — bağlam kapısı", () => {
  const expectBadContext = (sel: OverlaySelection, needle: string) => {
    const result = validateSelection(sel, pool, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_context");
      expect(result.reason).toContain(needle);
    }
  };

  it("mutlak yol reddedilir", () => {
    expectBadContext(
      { gate_id: "file_immutable", params: { path: "/etc/passwd" } },
      "göreli olmalı",
    );
  });

  it('".." parçası reddedilir', () => {
    expectBadContext(
      { gate_id: "file_must_change", params: { path: "../baska-proje/x.ts" } },
      "..",
    );
  });

  it("boş yol reddedilir", () => {
    expectBadContext({ gate_id: "file_must_change", params: { path: "  " } }, "boş");
  });

  it("ters bölü reddedilir", () => {
    expectBadContext(
      { gate_id: "file_must_change", params: { path: "src\\app.ts" } },
      "ters bölü",
    );
  });

  it("file_immutable: projede olmayan dosya dondurulamaz", () => {
    expectBadContext(
      { gate_id: "file_immutable", params: { path: "src/olmayan.ts" } },
      "projede yok",
    );
  });

  it("schema_check: projede olmayan şema referansı reddedilir", () => {
    expectBadContext(
      {
        gate_id: "schema_check",
        params: { target: "src/api/user.ts", schema_ref: "src/olmayan.schema.json" },
      },
      "şema dosyası projede yok",
    );
  });

  it("forbid_new_files: projede olmayan dizin reddedilir", () => {
    expectBadContext(
      { gate_id: "forbid_new_files", params: { dir: "src/olmayan-dizin" } },
      "dizin projede yok",
    );
  });

  it("test_ref noktalı virgül içeremez (komut enjeksiyonu kapısı)", () => {
    expectBadContext(
      { gate_id: "test_must_pass", params: { test_ref: "test/a.test.ts; rm -rf ." } },
      "kabuk metakarakteri",
    );
  });

  it("test_ref ters tırnak içeremez", () => {
    expectBadContext(
      { gate_id: "test_must_pass", params: { test_ref: "test/`whoami`.test.ts" } },
      "kabuk metakarakteri",
    );
  });

  it("test_ref boş olamaz", () => {
    expectBadContext({ gate_id: "test_must_pass", params: { test_ref: "   " } }, "boş");
  });
});

describe("parseOverlayProposal", () => {
  it("geçerli öneri okunur", () => {
    const result = parseOverlayProposal({
      selections: [
        {
          gate_id: "file_immutable",
          params: { path: "src/app.ts" },
          reason: "sözleşme dosyası",
        },
      ],
      missing: [{ risk_description: "migration geri alınamıyor", suggested_name: "migration_reversible" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.selections).toHaveLength(1);
      expect(result.proposal.selections[0].reason).toBe("sözleşme dosyası");
      expect(result.proposal.missing[0].suggested_name).toBe("migration_reversible");
    }
  });

  it("selections dizi değilse hata", () => {
    const result = parseOverlayProposal({ selections: { gate_id: "file_immutable" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("selections");
  });

  it("missing yoksa boş dizi kabul edilir", () => {
    const result = parseOverlayProposal({
      selections: [{ gate_id: "file_immutable", params: { path: "src/app.ts" } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.missing).toEqual([]);
  });

  it("kök seviyedeki fazla alanlar yok sayılır (model gürültüsü zararsız)", () => {
    const result = parseOverlayProposal({
      selections: [],
      missing: [],
      aciklama: "modelin eklediği serbest metin",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.selections).toEqual([]);
  });

  it("seçim içindeki bilinmeyen alan hata değildir, taşınmaz", () => {
    const result = parseOverlayProposal({
      selections: [
        { gate_id: "file_immutable", params: { path: "src/app.ts" }, severity: "high" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.selections[0]).toEqual({
        gate_id: "file_immutable",
        params: { path: "src/app.ts" },
      });
    }
  });

  it("bozuk seçim alanları reddedilir", () => {
    expect(parseOverlayProposal({ selections: [{ params: {} }] }).ok).toBe(false);
    expect(
      parseOverlayProposal({ selections: [{ gate_id: "file_immutable" }] }).ok,
    ).toBe(false);
    expect(
      parseOverlayProposal({
        selections: [{ gate_id: "file_immutable", params: { path: 42 } }],
      }).ok,
    ).toBe(false);
    expect(parseOverlayProposal({ missing: [{ risk_description: "" }] }).ok).toBe(false);
    expect(parseOverlayProposal("metin").ok).toBe(false);
  });
});

describe("dedupeSelections", () => {
  it("aynı seçim iki kez gelirse tek kalır", () => {
    const sel = VALID_SELECTIONS.file_immutable;
    expect(dedupeSelections([sel, { ...sel }])).toHaveLength(1);
  });

  it("parametre anahtar sırası farklı olsa da aynı kısıt tekilleşir", () => {
    const a: OverlaySelection = {
      gate_id: "schema_check",
      params: { target: "src/api/user.ts", schema_ref: "src/schema/user.schema.json" },
    };
    const b: OverlaySelection = {
      gate_id: "schema_check",
      params: { schema_ref: "src/schema/user.schema.json", target: "src/api/user.ts" },
    };
    expect(dedupeSelections([a, b])).toHaveLength(1);
  });

  it("gerekçe farklı olsa da aynı kısıt tekilleşir (reason karara girmez)", () => {
    const sel = VALID_SELECTIONS.file_immutable;
    const out = dedupeSelections([
      { ...sel, reason: "birinci gerekçe" },
      { ...sel, reason: "ikinci gerekçe" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("birinci gerekçe");
  });

  it("farklı parametreler ayrı kalır ve sıra korunur", () => {
    const out = dedupeSelections([
      { gate_id: "file_immutable", params: { path: "src/app.ts" } },
      { gate_id: "file_immutable", params: { path: "package.json" } },
      { gate_id: "file_immutable", params: { path: "src/app.ts" } },
    ]);
    expect(out.map((s) => s.params.path)).toEqual(["src/app.ts", "package.json"]);
  });
});

describe("determinizm", () => {
  it("aynı girdi iki çağrıda aynı sonucu verir", () => {
    for (const sel of Object.values(VALID_SELECTIONS)) {
      expect(validateSelection(sel, pool, ctx)).toEqual(validateSelection(sel, pool, ctx));
    }
    const bad: OverlaySelection = {
      gate_id: "schema_check",
      params: { target: "/mutlak/hedef.ts", schema_ref: "src/olmayan.json" },
    };
    // Gerekçe de sabit: parametre sırası modele göre değil şemaya göre geziliyor.
    expect(validateSelection(bad, pool, ctx)).toEqual(validateSelection(bad, pool, ctx));
    const raw = { selections: [VALID_SELECTIONS.file_immutable], missing: [] };
    expect(parseOverlayProposal(raw)).toEqual(parseOverlayProposal(raw));
  });

  it("parametre anahtar sırası gerekçeyi değiştirmez", () => {
    const a = validateSelection(
      {
        gate_id: "schema_check",
        params: { target: "/mutlak/hedef.ts", schema_ref: "/mutlak/sema.json" },
      },
      pool,
      ctx,
    );
    const b = validateSelection(
      {
        gate_id: "schema_check",
        params: { schema_ref: "/mutlak/sema.json", target: "/mutlak/hedef.ts" },
      },
      pool,
      ctx,
    );
    expect(a).toEqual(b);
  });
});

describe("AD-5 kilidi — puan temelli karar yok", () => {
  it("gate-overlay kaynak dosyalarında skor/olasılık izi yok", () => {
    // AD-5: overlay kararları ikili olmalı. Kaynağa bir skor kavramı sızarsa (yorumda bile)
    // eşik tartışması başlar ve "eşiğin altında kaldı" diye sessizce atlanan kısıtlar doğar.
    // Bu test YALNIZ src dosyalarını tarar — desen bu test dosyasında kaçınılmaz olarak geçer.
    const forbidden = /confidence|certainty|güven skoru/i;
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf-8");
      expect(forbidden.test(content), `${file} skor kavramı içeriyor`).toBe(false);
    }
  });
});
