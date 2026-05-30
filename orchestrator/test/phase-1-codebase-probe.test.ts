// phase-1-codebase-probe.test — buildCodebaseSnapshot çıktısı kontrol.
//
// v15.7 (2026-05-27): QC Round 5 — yeni modül test coverage gap closure.
// Snapshot: top-level dirs, package.json özet, src tree, backend routes
// (app.get/router.get), frontend routes (<Route path=>).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { buildCodebaseSnapshot } from "../src/phase-1-codebase-probe.js";

describe("phase-1-codebase-probe · buildCodebaseSnapshot", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-probe-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("boş proje → empty sentinel mesajı", async () => {
    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).toContain("Codebase snapshot");
    expect(s).toContain("empty project");
  });

  it("top-level dosya ve dizinleri listeler", async () => {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "# x", "utf-8");
    await writeFile(join(projectRoot, "package.json"), '{"name":"x"}', "utf-8");

    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).toContain("src/");
    expect(s).toContain("README.md");
    expect(s).toContain("package.json");
  });

  it("package.json deps + scripts özetler", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { dev: "vite", build: "tsc" },
        dependencies: { react: "^19.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
      "utf-8",
    );
    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).toContain("name: demo");
    expect(s).toContain("scripts:");
    expect(s).toContain("dev");
    expect(s).toContain("dependencies");
    expect(s).toContain("react");
    expect(s).toContain("devDependencies");
    expect(s).toContain("vitest");
  });

  it("node_modules + .git + dist gibi gizli dizinleri atlar", async () => {
    await mkdir(join(projectRoot, "node_modules", "foo"), { recursive: true });
    await mkdir(join(projectRoot, ".git", "refs"), { recursive: true });
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await mkdir(join(projectRoot, "src"), { recursive: true });
    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).not.toContain("node_modules");
    expect(s).not.toContain(".git");
    expect(s).not.toContain("dist/");
    expect(s).toContain("src/");
  });

  it("backend routes (Express) algılanır", async () => {
    await mkdir(join(projectRoot, "backend"), { recursive: true });
    await writeFile(
      join(projectRoot, "backend", "routes.ts"),
      `
import express from 'express';
const router = express.Router();
router.get('/api/users', (req, res) => res.json([]));
router.post('/api/users', (req, res) => res.json({}));
router.delete('/api/users/:id', (req, res) => res.sendStatus(204));
export { router };
      `,
      "utf-8",
    );
    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).toContain("Backend routes");
    expect(s).toContain("GET /api/users");
    expect(s).toContain("POST /api/users");
    expect(s).toContain("DELETE /api/users/:id");
  });

  it("frontend routes (React Router <Route path>) algılanır", async () => {
    await mkdir(join(projectRoot, "frontend", "src"), { recursive: true });
    await writeFile(
      join(projectRoot, "frontend", "App.tsx"),
      `
import { Routes, Route } from 'react-router-dom';
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/users/:id" element={<UserDetail />} />
    </Routes>
  );
}
      `,
      "utf-8",
    );
    const s = await buildCodebaseSnapshot(projectRoot);
    expect(s).toContain("Frontend routes");
    expect(s).toContain("/login");
    expect(s).toContain("/users/:id");
  });

  it("crash etmez (FS hatası) → fallback sentinel döner", async () => {
    // Var olmayan path
    const fakeRoot = join(tmpdir(), "mycl-nonexistent-" + Date.now());
    const s = await buildCodebaseSnapshot(fakeRoot);
    // readdir başarısız olur ama function throw etmemeli; ya empty ya unavailable
    expect(s).toContain("Codebase snapshot");
  });
});
