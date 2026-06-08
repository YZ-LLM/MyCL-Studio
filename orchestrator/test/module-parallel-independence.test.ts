import { describe, expect, it } from "vitest";
import {
  pathsOverlap,
  modulesDisjoint,
  shouldParallelize,
} from "../src/module-parallel/independence.js";

describe("pathsOverlap", () => {
  it("eşit → true", () => expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true));
  it("ebeveyn/çocuk → true", () => {
    expect(pathsOverlap("src/auth/", "src/auth/login.ts")).toBe(true);
    expect(pathsOverlap("src/auth/login.ts", "src/auth")).toBe(true);
  });
  it("kardeş → false", () => expect(pathsOverlap("src/auth/", "src/ui/")).toBe(false));
  it("önek-benzeri ama ayrı klasör → false", () =>
    expect(pathsOverlap("src/auth", "src/authx")).toBe(false));
});

describe("modulesDisjoint", () => {
  it("ayrık → ok", () => {
    const r = modulesDisjoint([
      { id: "auth", scope_paths: ["src/auth/"] },
      { id: "ui", scope_paths: ["src/ui/"] },
    ]);
    expect(r.ok).toBe(true);
  });
  it("çakışan → ok:false + neden", () => {
    const r = modulesDisjoint([
      { id: "auth", scope_paths: ["src/auth/"] },
      { id: "login", scope_paths: ["src/auth/login.ts"] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("çakışma");
  });
});

describe("shouldParallelize (fail-closed)", () => {
  const A = { id: "a", scope_paths: ["src/a/"] };
  const B = { id: "b", scope_paths: ["src/b/"] };
  it("flag kapalı → seri", () =>
    expect(shouldParallelize([A, B], { enabled: false }).parallel).toBe(false));
  it("<2 modül → seri", () =>
    expect(shouldParallelize([A], { enabled: true }).parallel).toBe(false));
  it("boş kapsam → seri", () =>
    expect(
      shouldParallelize([A, { id: "b", scope_paths: [] }], { enabled: true }).parallel,
    ).toBe(false));
  it("çakışan kapsam → seri", () =>
    expect(
      shouldParallelize([A, { id: "b", scope_paths: ["src/a/x.ts"] }], { enabled: true })
        .parallel,
    ).toBe(false));
  it("≥2 ayrık + flag → paralel", () =>
    expect(shouldParallelize([A, B], { enabled: true }).parallel).toBe(true));
});
