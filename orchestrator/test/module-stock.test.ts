// module-stock — saf helpers (slugToken/matchesModule/isModuleStale/sanitizeDescriptor/
// parseModuleBlock) + extract round-trip + guard'lar. MYCL_HOME temp'e izole → gerçek
// ~/.mycl KİRLENMEZ (paths.ts:46 MYCL_HOME override). prototype-cache.test.ts deseni.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugToken,
  matchesModule,
  isModuleStale,
  sanitizeDescriptor,
  parseModuleBlock,
  extractModule,
  listAvailableModules,
} from "../src/module-stock.js";
import type { State } from "../src/types.js";

const fakeState = (project_root: string, stack: string): State =>
  ({ project_root, stack, current_phase: 17, intent_summary: "anket uygulaması" }) as unknown as State;

describe("module-stock · saf helpers", () => {
  it("slugToken: İngilizce ad → slug (trim + collapse + lowercase)", () => {
    expect(slugToken("Survey Builder")).toBe("survey-builder");
    expect(slugToken("User Authentication!")).toBe("user-authentication");
    expect(slugToken("  Trim__me 123  ")).toBe("trim-me-123");
  });

  it("matchesModule: files üyeliği + DENY guard", () => {
    const files = ["src/components/Survey.tsx", "api/survey.ts"];
    expect(matchesModule("src/components/Survey.tsx", files)).toBe(true);
    expect(matchesModule("api/survey.ts", files)).toBe(true);
    expect(matchesModule("src/other.ts", files)).toBe(false);
    expect(matchesModule("node_modules/x/survey.ts", files)).toBe(false); // DENY
  });

  it("isModuleStale: 31 gün > 30 → bayat", () => {
    const DAY = 86400000;
    expect(isModuleStale({ createdAt: 1_000_000_000_000 - 1 * DAY }, 1_000_000_000_000)).toBe(false);
    expect(isModuleStale({ createdAt: 1_000_000_000_000 - 31 * DAY }, 1_000_000_000_000)).toBe(true);
  });

  it("sanitizeDescriptor: name+files zorunlu; mutlak/../DENY reddedilir; dedup", () => {
    const d = sanitizeDescriptor({
      name: " Survey ",
      files: ["src/a.ts", "src/a.ts", "/etc/passwd", "../x.ts", "node_modules/y.ts", "  src/b.ts  "],
      db_tables: ["surveys", 1],
      routes: ["/survey"],
    });
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Survey");
    expect(d!.files).toEqual(["src/a.ts", "src/b.ts"]); // dedup + mutlak/../DENY elendi
    expect(d!.db_tables).toEqual(["surveys"]); // string-olmayan elendi
    expect(d!.routes).toEqual(["/survey"]);
  });

  it("sanitizeDescriptor: name yok / files boş → null", () => {
    expect(sanitizeDescriptor({ files: ["a.ts"] })).toBeNull();
    expect(sanitizeDescriptor({ name: "X", files: [] })).toBeNull();
    expect(sanitizeDescriptor({ name: "X", files: ["/abs", "../up"] })).toBeNull(); // hepsi reddedildi
  });

  it("parseModuleBlock: {kind:modules,modules:[...]} parse + sanitize + token-dedup", () => {
    const text = `bakıyorum...\n{"kind":"modules","modules":[{"name":"Survey","files":["src/s.ts"]},{"name":"Survey","files":["src/s2.ts"]},{"name":"Auth","files":["src/a.ts"]}]}`;
    const ds = parseModuleBlock(text);
    expect(ds.map((d) => d.name)).toEqual(["Survey", "Auth"]); // 2. Survey (aynı token) elendi
  });

  it("parseModuleBlock: boş modül listesi / blok yok → []", () => {
    expect(parseModuleBlock(`{"kind":"modules","modules":[]}`)).toEqual([]);
    expect(parseModuleBlock("düz metin")).toEqual([]);
  });
});

describe("module-stock · extract round-trip (MYCL_HOME izole)", () => {
  let myclHome: string;
  let src: string;
  const origHome = process.env.MYCL_HOME;

  beforeEach(async () => {
    myclHome = await mkdtemp(join(tmpdir(), "mycl-mod-"));
    process.env.MYCL_HOME = myclHome;
    src = await mkdtemp(join(tmpdir(), "mod-src-"));
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = origHome;
    await Promise.all([
      rm(myclHome, { recursive: true, force: true }),
      rm(src, { recursive: true, force: true }),
    ]).catch(() => {});
  });

  it("explicit descriptor → SADECE listelenen var-olan dosyalar + manifest; feature-dışı SIZMAZ", async () => {
    await mkdir(join(src, "src", "components"), { recursive: true });
    await writeFile(join(src, "src", "components", "Survey.tsx"), "// survey ui");
    await mkdir(join(src, "api"), { recursive: true });
    await writeFile(join(src, "api", "survey.ts"), "// survey api");
    await writeFile(join(src, "src", "unrelated.ts"), "// başka feature");

    const ok = await extractModule(fakeState(src, "node-npm"), {
      name: "Survey",
      files: ["src/components/Survey.tsx", "api/survey.ts", "api/nonexistent.ts"],
      db_tables: ["surveys"],
      routes: ["/survey"],
    });
    expect(ok).toBe(true);

    const dir = join(myclHome, "modules", "survey");
    expect(existsSync(join(dir, "src", "components", "Survey.tsx"))).toBe(true);
    expect(existsSync(join(dir, "api", "survey.ts"))).toBe(true);
    expect(existsSync(join(dir, "api", "nonexistent.ts"))).toBe(false); // var-olmayan atlandı
    expect(existsSync(join(dir, "src", "unrelated.ts"))).toBe(false); // descriptor-dışı SIZMADI
    expect(existsSync(join(dir, "module.json"))).toBe(true);

    const mods = await listAvailableModules("node-npm");
    expect(mods.map((m) => m.token)).toContain("survey");
    expect(mods[0]!.fileCount).toBe(2); // yalnız gerçek-kopyalananlar
  });

  it("descriptor.files tümü var-olmayan → false, çöp dizin bırakmaz", async () => {
    const ok = await extractModule(fakeState(src, "node-npm"), {
      name: "Ghost",
      files: ["src/yok1.ts", "src/yok2.ts"],
    });
    expect(ok).toBe(false);
    expect(existsSync(join(myclHome, "modules", "ghost"))).toBe(false);
  });

  it("listAvailableModules: boş → []; stack-filtre cross-stack'i eler", async () => {
    expect(await listAvailableModules("node-npm")).toEqual([]);
    await writeFile(join(src, "x.ts"), "x");
    await extractModule(fakeState(src, "node-npm"), { name: "Foo", files: ["x.ts"] });
    expect((await listAvailableModules("node-npm")).map((m) => m.token)).toEqual(["foo"]);
    expect(await listAvailableModules("rust")).toEqual([]); // farklı stack → filtrelendi
  });
});
