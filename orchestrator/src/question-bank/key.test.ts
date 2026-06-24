import { describe, it, expect } from "vitest";
import {
  WIDEST_ARTIFACT,
  artifactFileToken,
  bankKeyToPath,
  bankKeysFor,
  classifyArtifacts,
  matchGlob,
  normalizePath,
  phaseCheckpointId,
} from "./key.js";

describe("globToRegExp / matchGlob", () => {
  it("`*` slash-dışı eşleşir, slash'ı geçmez", () => {
    expect(matchGlob("*.json", "package.json")).toBe(true);
    expect(matchGlob("*.json", "a/package.json")).toBe(false);
  });

  it("`**/` herhangi dizin-derinliği (sıfır dahil)", () => {
    expect(matchGlob("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "lib/a.ts")).toBe(false);
  });

  it("ortada ve başta `**`", () => {
    expect(matchGlob("app/api/**/route.ts", "app/api/users/route.ts")).toBe(true);
    expect(matchGlob("**/migrations/**", "db/migrations/001.sql")).toBe(true);
    expect(matchGlob("**/migrations/**", "migrations/001.sql")).toBe(true);
    expect(matchGlob("**/migrations/**", "src/app.ts")).toBe(false);
  });

  it("regex özel karakterleri literal kaçışlanır (false-match yok)", () => {
    expect(matchGlob("a.b.json", "axbxjson")).toBe(false);
    expect(matchGlob("a.b.json", "a.b.json")).toBe(true);
  });

  it("`?` tek slash-dışı karakter", () => {
    expect(matchGlob("v?.ts", "v1.ts")).toBe(true);
    expect(matchGlob("v?.ts", "v12.ts")).toBe(false);
  });
});

describe("classifyArtifacts (coarsen-on-no-match)", () => {
  const profile = {
    artifact_globs: {
      route: ["app/**/route.ts", "src/routes/**/*"],
      migration: ["**/migrations/**"],
      component: ["**/*.tsx"],
    },
  };

  it("eşleşen dosyalar doğru tip(ler)e gider", () => {
    const t = classifyArtifacts(profile, ["app/api/users/route.ts", "ui/Button.tsx"]);
    expect(t.has("route")).toBe(true);
    expect(t.has("component")).toBe(true);
    expect(t.has(WIDEST_ARTIFACT)).toBe(false);
  });

  it("hiçbir glob'a uymayan dosya → WIDEST (under-check değil over-check)", () => {
    const t = classifyArtifacts(profile, ["src/lib/util.ts"]);
    expect(t).toEqual(new Set([WIDEST_ARTIFACT]));
  });

  it("profilde artifact_globs yoksa HER dosya WIDEST'e düşer (coarsen-to-full)", () => {
    expect(classifyArtifacts(null, ["a.ts", "b/c.ts"])).toEqual(new Set([WIDEST_ARTIFACT]));
    expect(classifyArtifacts({}, ["a.ts"])).toEqual(new Set([WIDEST_ARTIFACT]));
  });

  it("bir dosya birden çok tipe girebilir", () => {
    const p = { artifact_globs: { a: ["**/*.ts"], b: ["src/**"] } };
    const t = classifyArtifacts(p, ["src/x.ts"]);
    expect(t).toEqual(new Set(["a", "b"]));
  });
});

describe("normalizePath", () => {
  it("'./' önekini ve '\\' ayıracını normalize eder", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
  });
});

describe("bankKeysFor / path", () => {
  it("artefakt başına bir key (dedup)", () => {
    const keys = bankKeysFor("phase-10", "node-npm", ["route", "route", "*"]);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.artifact).sort()).toEqual(["*", "route"]);
  });

  it("WIDEST '*' dosya-adı token'ı '_all'", () => {
    expect(artifactFileToken("*")).toBe("_all");
    expect(artifactFileToken("route")).toBe("route");
    expect(artifactFileToken("a/b")).toBe("a_b");
  });

  it("KEY → deterministik dosya yolu", () => {
    const p = bankKeyToPath("/banks", { checkpoint: "phase-10", stack: "node-npm", artifact: "*" });
    expect(p).toBe("/banks/phase-10/node-npm/_all.json");
  });

  it("phaseCheckpointId", () => {
    expect(phaseCheckpointId(10)).toBe("phase-10");
  });
});
