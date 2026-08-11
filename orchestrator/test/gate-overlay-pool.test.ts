import { describe, expect, it } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { GATE_POOL_PATH, loadGatePool, validateGatePool } from "../src/gate-overlay/pool.js";

// Kapalı gate sözlüğünün bekçisi. İki iş yapar:
// 1) DEPODAKİ GERÇEK assets/gate-pool.json doğrulayıcıdan geçer — dosya bayatlar/bozulursa
//    test düşer, yani bozuk havuz çalışma anında değil burada yakalanır.
// 2) Bozuk havuz örnekleri reddedilir ve hata mesajı HANGİ girişte neyin bozuk olduğunu söyler.

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..");
const realPoolPath = resolve(repoRoot, "assets", "gate-pool.json");

function readRealPool(): unknown {
  return JSON.parse(readFileSync(realPoolPath, "utf-8"));
}

/** Doğrulayıcıdan geçen taban giriş — bozuk örnekler bunun üstüne kurulur. */
function baseEntry(): Record<string, unknown> {
  return {
    gate_id: "file_immutable",
    version: 1,
    description: "Belirtilen dosya bu iterasyon boyunca değiştirilemez.",
    params_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    executor: "tool_deny",
  };
}

function poolWith(...gates: unknown[]): unknown {
  return { pool_version: 1, gates };
}

function errorsOf(raw: unknown): string {
  const result = validateGatePool(raw);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join(" | ");
}

describe("gerçek havuz dosyası", () => {
  it("depodaki assets/gate-pool.json doğrulayıcıdan geçer", () => {
    const result = validateGatePool(readRealPool());
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("Faz A sözlüğü tam: 6 gate, beklenen kimlik ve executor'larla", () => {
    const result = validateGatePool(readRealPool());
    if (!result.ok) throw new Error(result.errors.join("; "));
    const byId = new Map(result.pool.gates.map((g) => [g.gate_id, g]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "forbid_dependency_change",
        "forbid_new_files",
        "file_immutable",
        "file_must_change",
        "schema_check",
        "test_must_pass",
      ].sort(),
    );
    expect(byId.get("file_immutable")!.executor).toBe("tool_deny");
    expect(byId.get("file_must_change")!.executor).toBe("phase_end");
    expect(byId.get("schema_check")!.executor).toBe("phase_end");
    expect(byId.get("forbid_new_files")!.executor).toBe("tool_deny");
    expect(byId.get("forbid_dependency_change")!.executor).toBe("tool_deny");
    expect(byId.get("test_must_pass")!.executor).toBe("phase_end");
    // Parametre adları Faz B'nin bağlam kurallarıyla birebir eşleşmeli.
    expect(byId.get("schema_check")!.params_schema.required.sort()).toEqual([
      "schema_ref",
      "target",
    ]);
    expect(byId.get("forbid_dependency_change")!.params_schema.required).toEqual([]);
  });

  it("loadGatePool aynı dosyayı çözer (paketleme yolu doğru)", async () => {
    expect(GATE_POOL_PATH).toBe(realPoolPath);
    const pool = await loadGatePool();
    expect(pool.pool_version).toBe(1);
    expect(pool.gates).toHaveLength(6);
  });
});

describe("bozuk havuz reddedilir ve hatalı girişi işaret eder", () => {
  it("kök nesne değilse", () => {
    expect(errorsOf([])).toContain("kök");
    expect(errorsOf("havuz")).toContain("kök");
  });

  it("gates boş olamaz", () => {
    expect(errorsOf(poolWith())).toContain("gates boş olamaz");
  });

  it("gates dizi değilse", () => {
    expect(errorsOf({ pool_version: 1, gates: {} })).toContain("gates dizi olmalı");
  });

  it("pool_version 1 değilse", () => {
    expect(errorsOf({ pool_version: 2, gates: [baseEntry()] })).toContain("pool_version");
  });

  it("alan eksik (description yok)", () => {
    const broken = baseEntry();
    delete broken.description;
    const msg = errorsOf(poolWith(broken));
    expect(msg).toContain("file_immutable");
    expect(msg).toContain("description");
  });

  it("alan eksik (gate_id yok) — indeksle işaret edilir", () => {
    const broken = baseEntry();
    delete broken.gate_id;
    const msg = errorsOf(poolWith(broken));
    expect(msg).toContain("gates[0]");
    expect(msg).toContain("gate_id");
  });

  it("bilinmeyen executor", () => {
    const msg = errorsOf(poolWith({ ...baseEntry(), executor: "shell" }));
    expect(msg).toContain("file_immutable");
    expect(msg).toContain("executor");
  });

  it("additionalProperties yok", () => {
    const broken = baseEntry();
    const schema = { ...(broken.params_schema as Record<string, unknown>) };
    delete schema.additionalProperties;
    broken.params_schema = schema;
    const msg = errorsOf(poolWith(broken));
    expect(msg).toContain("file_immutable");
    expect(msg).toContain("additionalProperties");
  });

  it("additionalProperties true", () => {
    const broken = baseEntry();
    broken.params_schema = {
      ...(broken.params_schema as Record<string, unknown>),
      additionalProperties: true,
    };
    expect(errorsOf(poolWith(broken))).toContain("additionalProperties");
  });

  it("required'da properties'te olmayan ad", () => {
    const broken = baseEntry();
    broken.params_schema = {
      ...(broken.params_schema as Record<string, unknown>),
      required: ["path", "hedef"],
    };
    const msg = errorsOf(poolWith(broken));
    expect(msg).toContain("file_immutable");
    expect(msg).toContain("hedef");
  });

  it("desteklenmeyen parametre tipi (string dışı)", () => {
    const broken = baseEntry();
    broken.params_schema = {
      ...(broken.params_schema as Record<string, unknown>),
      properties: { path: { type: "number" } },
    };
    expect(errorsOf(poolWith(broken))).toContain("type");
  });

  it("çift gate_id", () => {
    const msg = errorsOf(poolWith(baseEntry(), baseEntry()));
    expect(msg).toContain("tekrar ediyor");
    expect(msg).toContain("gates[1]");
  });

  it("gate_id snake_case değil", () => {
    const msg = errorsOf(poolWith({ ...baseEntry(), gate_id: "FileImmutable" }));
    expect(msg).toContain("snake_case");
  });

  it("gate girişinde desteklenmeyen alan (yazım hatası sessizce geçmez)", () => {
    const msg = errorsOf(poolWith({ ...baseEntry(), executer: "tool_deny" }));
    expect(msg).toContain("executer");
  });

  it("birden çok sorun tek turda raporlanır", () => {
    const broken = baseEntry();
    delete broken.description;
    broken.executor = "shell";
    const result = validateGatePool(poolWith(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// Kabul kriteri (AD-6): missing_gate kaydı havuza OTOMATİK hiçbir ekleme yapmaz. Havuz yalnız git
// üzerinden, insan eliyle değişir. Bu test kaynak ağacında gate-pool.json'a YAZAN kod olmadığını kilitler.
describe("AD-6: havuz yalnız insan eliyle değişir", () => {
  it("kaynakta gate-pool.json'a yazan hiçbir kod yok", async () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".ts")) {
          const body = await fs.readFile(full, "utf-8");
          // Yazma niyeti: writeFile/appendFile çağrısıyla AYNI satırda gate-pool geçiyorsa şüpheli.
          for (const line of body.split("\n")) {
            if (line.includes("gate-pool") && /writeFile|appendFile|createWriteStream/.test(line)) {
              offenders.push(`${full}: ${line.trim().slice(0, 120)}`);
            }
          }
        }
      }
    }
    await walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
