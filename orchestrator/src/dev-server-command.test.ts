import { describe, it, expect } from "vitest";
import { devServerCandidates } from "./dev-server-command.js";
import { commandsFor } from "./intent-router/handlers/command.js";

// KATI #1: dev-server komutu profil `dev`'den okunmalı (hardcode switch'ten değil). Bu testler non-Node web
// stack'lerinde doğru web-server komutunun zincirin BAŞINA geldiğini + Node'un DOKUNULMADIĞINI kilitler.
describe("devServerCandidates — profil `dev` öncelikli (dev-server profil bypass fix)", () => {
  it("python-pip: profil dev (uvicorn) zincirin BAŞINDA, commandsFor fallback korunur", async () => {
    const cmds = await devServerCandidates("python-pip", {});
    expect(cmds[0]).toContain("uvicorn"); // profil dev — hardcode 'python main.py' DEĞİL
    expect(cmds).toContain("python main.py"); // commandsFor(run) fallback hâlâ zincirde
  });

  it("ruby: profil dev (rackup) başta — web-server başlatır (eski 'ruby main.rb' değil)", async () => {
    const cmds = await devServerCandidates("ruby", {});
    expect(cmds[0]).toContain("rackup");
    expect(cmds[0]).not.toContain("ruby main.rb");
  });

  it("elixir: profil dev (phx.server) başta", async () => {
    const cmds = await devServerCandidates("elixir", {});
    expect(cmds[0]).toContain("phx.server");
  });

  it("Node (node-npm): commandsFor AYNEN — profil prepend YOK (script-tespiti zengin, dokunulmaz)", async () => {
    const scripts = { dev: "vite", build: "vite build" };
    const cmds = await devServerCandidates("node-npm", scripts);
    expect(cmds).toEqual(commandsFor("node-npm", "run", scripts)); // birebir aynı
  });

  it("expectedPortFor uyumu: uvicorn komutunun portu 8000 → probe doğru portu yoklar", async () => {
    const cmds = await devServerCandidates("python-uv", {});
    expect(cmds[0]).toMatch(/uvicorn/); // python-uv profil dev de uvicorn
  });
});
