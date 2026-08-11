// gate-overlay/checks — iterasyon SONU gate denetimleri (tmpdir fixture; LLM yok, süreç yok).
//
// Korunan garantiler:
//  - DEDEKTİF kanat: kanca yalnız yazma araçlarını görür; Bash ile yan yoldan yapılan değişikliği
//    taban çizgisi karşılaştırması yakalar (file_immutable / forbid_dependency_change).
//  - FAIL-CLOSED: seçilmiş bir gate doğrulanamıyorsa "geçti" değil BAŞARISIZ (ve asla `-skipped`).
//  - TEKRARLANABİLİRLİK: aynı overlay + aynı dosya durumu → bayt aynı sonuç (AD-5).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledOverlay } from "../src/gate-overlay/compile.js";
import {
  overlayGateEvent,
  runOverlayChecks,
  schemaSubsetProblem,
  validateAgainstSchema,
  type OverlayCheckDeps,
} from "../src/gate-overlay/checks.js";
import type { State } from "../src/types.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-checks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");

function state(): State {
  return { project_root: root } as unknown as State;
}

function overlay(
  selections: CompiledOverlay["selections"],
  baselines: Record<string, string | null>,
): CompiledOverlay {
  return {
    overlay_version: 1,
    pool_version: 1,
    iteration_key: "iter1-1",
    compiled_at: 1,
    selections,
    baselines,
  };
}

/** Testte gerçek test paketi koşulmaz — komut çözümü/süreç ayrı ayrı kanıtlanmış makinedir. */
const greenSuite: OverlayCheckDeps = {
  runTestSuite: async () => ({ ok: true, detail: "suite green: npm test" }),
};
const redSuite: OverlayCheckDeps = {
  runTestSuite: async () => ({ ok: false, detail: "suite red (exit=1): npm test" }),
};
const noCmdSuite: OverlayCheckDeps = {
  runTestSuite: async () => ({ ok: false, detail: "no test command in stack profile (cannot verify)" }),
};

describe("olay adları", () => {
  it("gate kimliği → tire ayraçlı olay adı; sonek pass/fail", () => {
    expect(overlayGateEvent("file_must_change", false)).toBe("overlay-file-must-change-fail");
    expect(overlayGateEvent("file_must_change", true)).toBe("overlay-file-must-change-pass");
    expect(overlayGateEvent("schema_check", false)).toBe("overlay-schema-check-fail");
    expect(overlayGateEvent("forbid_dependency_change", false)).toBe(
      "overlay-forbid-dependency-change-fail",
    );
  });
});

describe("file_must_change", () => {
  it("dosya DEĞİŞTİ → geçer", async () => {
    await fs.writeFile(join(root, "a.ts"), "yeni\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_must_change", params: { path: "a.ts" } }], { "a.ts": sha("eski\n") }),
      state(),
    );
    expect(r[0].passed).toBe(true);
    expect(r[0].event).toBe("overlay-file-must-change-pass");
  });

  it("dosya AYNI kaldı → başarısız", async () => {
    await fs.writeFile(join(root, "a.ts"), "eski\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_must_change", params: { path: "a.ts" } }], { "a.ts": sha("eski\n") }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-file-must-change-fail");
    expect(r[0].detail).toContain("unchanged");
  });

  it("taban çizgisi null + dosya ARTIK VAR → geçer (yaratılması bekleniyordu)", async () => {
    await fs.writeFile(join(root, "yeni.ts"), "x\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_must_change", params: { path: "yeni.ts" } }], { "yeni.ts": null }),
      state(),
    );
    expect(r[0].passed).toBe(true);
  });

  it("taban çizgisi null + dosya HÂLÂ YOK → başarısız", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_must_change", params: { path: "yeni.ts" } }], { "yeni.ts": null }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("file still absent");
  });

  it("taban çizgisi HİÇ YOK → doğrulanamaz → başarısız (fail-closed)", async () => {
    await fs.writeFile(join(root, "a.ts"), "x\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_must_change", params: { path: "a.ts" } }], {}),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("baseline missing");
  });
});

describe("file_immutable — DEDEKTİF kanat (Bash ile yan yoldan değişimi yakalar)", () => {
  it("dokunulmadı → geçer", async () => {
    await fs.writeFile(join(root, "c.ts"), "sabit\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_immutable", params: { path: "c.ts" } }], { "c.ts": sha("sabit\n") }),
      state(),
    );
    expect(r[0].passed).toBe(true);
  });

  it("içerik değiştirildi → başarısız", async () => {
    await fs.writeFile(join(root, "c.ts"), "degisti\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_immutable", params: { path: "c.ts" } }], { "c.ts": sha("sabit\n") }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-file-immutable-fail");
    expect(r[0].detail).toContain("modified");
  });

  it("dosya SİLİNDİ → başarısız", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_immutable", params: { path: "c.ts" } }], { "c.ts": sha("sabit\n") }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("deleted");
  });

  it("yoktu ama YARATILDI → başarısız", async () => {
    await fs.writeFile(join(root, "c.ts"), "x\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "file_immutable", params: { path: "c.ts" } }], { "c.ts": null }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("created");
  });
});

describe("forbid_dependency_change", () => {
  it("bildirimler aynı → geçer", async () => {
    await fs.writeFile(join(root, "package.json"), "{}\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "forbid_dependency_change", params: {} }], { "package.json": sha("{}\n") }),
      state(),
    );
    expect(r[0].passed).toBe(true);
  });

  it("bildirim DEĞİŞTİ → başarısız", async () => {
    await fs.writeFile(join(root, "package.json"), '{"deps":1}\n');
    const r = await runOverlayChecks(
      overlay([{ gate_id: "forbid_dependency_change", params: {} }], { "package.json": sha("{}\n") }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-forbid-dependency-change-fail");
    expect(r[0].detail).toContain("changed: package.json");
  });

  it("taban çizgisinde OLMAYAN yeni bildirim dosyası → başarısız", async () => {
    await fs.writeFile(join(root, "package.json"), "{}\n");
    await fs.writeFile(join(root, "requirements.txt"), "flask\n");
    const r = await runOverlayChecks(
      overlay([{ gate_id: "forbid_dependency_change", params: {} }], { "package.json": sha("{}\n") }),
      state(),
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("new: requirements.txt");
  });

  it("aynı gate iki kez seçilse de TEK karar üretilir", async () => {
    await fs.writeFile(join(root, "package.json"), "{}\n");
    const r = await runOverlayChecks(
      overlay(
        [
          { gate_id: "forbid_dependency_change", params: {} },
          { gate_id: "forbid_dependency_change", params: {} },
        ],
        { "package.json": sha("{}\n") },
      ),
      state(),
    );
    expect(r).toHaveLength(1);
  });
});

describe("test_must_pass", () => {
  it("takım yeşil → geçer, test_ref detayda insan için taşınır", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "test_must_pass", params: { test_ref: "cart.spec.ts" } }], {}),
      state(),
      greenSuite,
    );
    expect(r[0].passed).toBe(true);
    expect(r[0].detail).toContain("test_ref=cart.spec.ts");
  });

  it("takım kırmızı → başarısız", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "test_must_pass", params: { test_ref: "cart.spec.ts" } }], {}),
      state(),
      redSuite,
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-test-must-pass-fail");
  });

  it("test komutu YOK → doğrulanamaz → başarısız (asla -skipped)", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "test_must_pass", params: { test_ref: "x" } }], {}),
      state(),
      noCmdSuite,
    );
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-test-must-pass-fail");
    expect(r[0].event).not.toContain("skipped");
    expect(r[0].detail).toContain("cannot verify");
  });
});

describe("schema_check", () => {
  const NESTED_SCHEMA = {
    type: "object",
    properties: {
      name: { type: "string" },
      server: {
        type: "object",
        properties: { port: { type: "integer" }, tls: { type: "boolean" } },
        required: ["port"],
        additionalProperties: false,
      },
    },
    required: ["name", "server"],
    additionalProperties: false,
  };

  async function writeSchemaAnd(target: unknown): Promise<void> {
    await fs.writeFile(join(root, "schema.json"), JSON.stringify(NESTED_SCHEMA));
    await fs.writeFile(join(root, "config.json"), JSON.stringify(target));
  }

  const sel: CompiledOverlay["selections"] = [
    { gate_id: "schema_check", params: { target: "config.json", schema_ref: "schema.json" } },
  ];

  it("İÇ İÇE şemaya uyan hedef → geçer", async () => {
    await writeSchemaAnd({ name: "a", server: { port: 8080, tls: true } });
    const r = await runOverlayChecks(overlay(sel, {}), state());
    expect(r[0].passed).toBe(true);
  });

  it("iç içe zorunlu alan eksik → başarısız", async () => {
    await writeSchemaAnd({ name: "a", server: { tls: true } });
    const r = await runOverlayChecks(overlay(sel, {}), state());
    expect(r[0].passed).toBe(false);
    expect(r[0].event).toBe("overlay-schema-check-fail");
    expect(r[0].detail).toContain("root.server.port");
  });

  it("iç içe yanlış tip → başarısız", async () => {
    await writeSchemaAnd({ name: "a", server: { port: "8080" } });
    const r = await runOverlayChecks(overlay(sel, {}), state());
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("expected integer");
  });

  it("fazladan alan (additionalProperties:false) → başarısız", async () => {
    await writeSchemaAnd({ name: "a", server: { port: 1 }, fazla: 1 });
    const r = await runOverlayChecks(overlay(sel, {}), state());
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("not allowed");
  });

  it("şema ALT KÜME DIŞINDA → başarısız (yorumlayamadığımız şemayla 'geçti' denmez)", async () => {
    await fs.writeFile(
      join(root, "schema.json"),
      JSON.stringify({ type: "object", properties: { a: { type: "string", pattern: "^x" } } }),
    );
    await fs.writeFile(join(root, "config.json"), JSON.stringify({ a: "x" }));
    const r = await runOverlayChecks(overlay(sel, {}), state());
    expect(r[0].passed).toBe(false);
    expect(r[0].detail).toContain("unsupported schema");
  });

  it("hedef JSON değil / şema dosyası yok → başarısız", async () => {
    await fs.writeFile(join(root, "schema.json"), JSON.stringify(NESTED_SCHEMA));
    await fs.writeFile(join(root, "config.json"), "bu json degil");
    const bad = await runOverlayChecks(overlay(sel, {}), state());
    expect(bad[0].passed).toBe(false);
    expect(bad[0].detail).toContain("not valid JSON");

    await rm(join(root, "schema.json"));
    const missing = await runOverlayChecks(overlay(sel, {}), state());
    expect(missing[0].passed).toBe(false);
    expect(missing[0].detail).toContain("schema file unreadable");
  });
});

describe("SAF şema yardımcıları", () => {
  it("alt küme dışı anahtar yakalanır (iç içe dahil)", () => {
    expect(schemaSubsetProblem({ type: "object" })).toBeNull();
    expect(schemaSubsetProblem({ type: "object", $schema: "x", title: "t" })).toBeNull();
    expect(schemaSubsetProblem({ type: "object", minLength: 2 })).toContain("minLength");
    expect(
      schemaSubsetProblem({ type: "object", properties: { a: { type: "string", enum: ["x"] } } }),
    ).toContain("root.a");
    expect(schemaSubsetProblem({ type: "tuple" })).toContain("unsupported type");
  });

  it("ihlaller SIRALI ve deterministik döner", () => {
    const errors = validateAgainstSchema(
      { type: "object", properties: { b: { type: "string" } }, required: ["z", "a"] },
      { b: 1 },
    );
    expect(errors[0]).toContain("root.a");
    expect(errors[1]).toContain("root.z");
    expect(errors[2]).toContain("root.b: expected string");
  });
});

describe("kapsam + tekrarlanabilirlik", () => {
  it("yalnız araç-anı gate'i seçilmişse iterasyon-sonu kontrolü ÜRETİLMEZ", async () => {
    const r = await runOverlayChecks(
      overlay([{ gate_id: "forbid_new_files", params: { dir: "src" } }], {}),
      state(),
    );
    expect(r).toEqual([]);
  });

  it("aynı overlay + aynı dosya durumu → BAYT AYNI sonuç (AD-5)", async () => {
    await fs.writeFile(join(root, "a.ts"), "yeni\n");
    await fs.writeFile(join(root, "c.ts"), "sabit\n");
    await fs.writeFile(join(root, "package.json"), "{}\n");
    const ov = overlay(
      [
        { gate_id: "file_must_change", params: { path: "a.ts" } },
        { gate_id: "file_immutable", params: { path: "c.ts" } },
        { gate_id: "forbid_dependency_change", params: {} },
      ],
      { "a.ts": sha("eski\n"), "c.ts": sha("sabit\n"), "package.json": sha("{}\n") },
    );
    const first = await runOverlayChecks(ov, state());
    const second = await runOverlayChecks(ov, state());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((x) => x.passed)).toBe(true);
  });
});
