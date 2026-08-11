// gate-overlay Faz C — ZORLAMA katmanı: ayar enjeksiyonu, kanarya, engel ayrıştırma, API paritesi.
//
// Korunan garantiler:
//  - overlay VERİLMEZSE üretilen ayar bugünküyle BAYT BAYT aynı (davranış regresyonu yok, KATI #14).
//  - overlay VERİLİRSE tek fark `hooks` anahtarıdır (AD-2 mekanik kanıtı — derin fark).
//  - kanca enjekte edildiyse kanarya işareti YOKSA koşu başarısız sayılır (kapısız koşu sessizce geçmez).
//  - engellenen yazma çağrısı KANIT SAYILMAZ (sahte yeşil fix).
//  - API/SDK yolu CLI kancasıyla AYNI kararı ve AYNI mesajı verir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSandboxSettings, type OverlayHooks } from "../src/agent-sandbox.js";
import { setActiveOverlay, type CompiledOverlay } from "../src/gate-overlay/compile.js";
import {
  overlayAckDir,
  overlayGuardPath,
  overlaySettingsFor,
  sandboxOverlayArg,
  verifyOverlayCanary,
} from "../src/gate-overlay/enforce.js";
import {
  filterDeniedWriteEvidence,
  parsePermissionDenials,
} from "../src/codegen/cli-backend.js";
import { executeTool } from "../src/tool-handlers.js";

const BASE = {
  projectRoot: "/Users/umit/proje",
  ultracode: false,
  platform: "darwin" as NodeJS.Platform,
  home: "/Users/umit",
};

const HOOKS: OverlayHooks = {
  guardPath: "/opt/mycl/overlay-guard.mjs",
  rulesB64: "eyJhIjoxfQ==",
  ackPath: "/Users/umit/proje/.mycl/overlays/ack/1-1-2.json",
};

const TOOL_DENY_OVERLAY: CompiledOverlay = {
  overlay_version: 1,
  pool_version: 1,
  iteration_key: "iter1-1",
  compiled_at: 1,
  selections: [
    { gate_id: "file_immutable", params: { path: "src/config.ts" } },
    { gate_id: "forbid_new_files", params: { dir: "src" } },
  ],
  baselines: {},
};

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-enforce-"));
  setActiveOverlay(null);
});

afterEach(async () => {
  setActiveOverlay(null);
  await rm(root, { recursive: true, force: true });
});

describe("C2 · ayar enjeksiyonu — overlay verilmezse ÇIKTI DEĞİŞMEZ", () => {
  for (const policy of ["enforce", "warn", "off"] as const) {
    it(`policy=${policy}: overlay yokken hooks anahtarı HİÇ yazılmaz`, () => {
      const s = buildAgentSandboxSettings({ ...BASE, policy }).settings;
      expect(JSON.stringify(s)).not.toContain("hooks");
    });
  }

  it("mac/linux DIŞI platformda da overlay yokken hooks yok", () => {
    const s = buildAgentSandboxSettings({ ...BASE, platform: "win32", policy: "enforce" }).settings;
    expect(JSON.stringify(s)).not.toContain("hooks");
  });

  it("overlay'li ayar = overlay'siz ayar + YALNIZ hooks (derin fark)", () => {
    for (const policy of ["enforce", "warn", "off"] as const) {
      for (const ultracode of [false, true]) {
        const without = buildAgentSandboxSettings({ ...BASE, ultracode, policy }).settings;
        const withHooks = buildAgentSandboxSettings({
          ...BASE,
          ultracode,
          policy,
          overlay: HOOKS,
        }).settings;
        expect(withHooks.hooks).toBeDefined();
        const stripped = { ...withHooks };
        delete stripped.hooks;
        // Anahtar sırası dahil BAYT BAYT aynı: hiçbir başka alan değişmemiş/eksilmemiş.
        expect(JSON.stringify(stripped)).toBe(JSON.stringify(without));
      }
    }
  });

  it("hooks bloğu: SessionStart kanaryası + YALNIZ yazma araçlarına PreToolUse", () => {
    const s = buildAgentSandboxSettings({ ...BASE, policy: "enforce", overlay: HOOKS }).settings;
    const hooks = s.hooks as {
      SessionStart: Array<{ hooks: Array<{ type: string; command: string }> }>;
      PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    };
    expect(hooks.SessionStart[0].hooks[0].command).toContain(`--ack "${HOOKS.ackPath}"`);
    expect(hooks.SessionStart[0].hooks[0].command).toContain(`"${HOOKS.guardPath}"`);
    expect(hooks.PreToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(`--rules ${HOOKS.rulesB64}`);
  });

  it("sandbox KAPALI olsa da kancalar eklenir (overlay ayrı bir sözleşme)", () => {
    const s = buildAgentSandboxSettings({ ...BASE, policy: "off", overlay: HOOKS }).settings;
    expect(s.hooks).toBeDefined();
    expect(s.sandbox).toBeUndefined();
  });
});

describe("C2 · overlaySettingsFor", () => {
  it("tool_deny seçimi yoksa null — kanca da kanarya da yok", async () => {
    setActiveOverlay({
      ...TOOL_DENY_OVERLAY,
      selections: [{ gate_id: "test_must_pass", params: { test_ref: "x" } }],
    });
    expect(await overlaySettingsFor({ projectRoot: root, phase: 5 })).toBeNull();
    expect(sandboxOverlayArg(null)).toBeUndefined();
  });

  it("tool_deny seçimi varsa enjeksiyon üretir; ack yolu spawn başına BENZERSİZ", async () => {
    setActiveOverlay(TOOL_DENY_OVERLAY);
    const a = await overlaySettingsFor({ projectRoot: root, phase: 5 });
    const b = await overlaySettingsFor({ projectRoot: root, phase: 5 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.ackPath).not.toBe(b!.ackPath);
    expect(a!.rulesB64).toBe(b!.rulesB64); // aynı overlay → aynı kural (determinizm)
    expect(a!.guardPath).toBe(overlayGuardPath());
    expect(a!.ackPath.startsWith(overlayAckDir(root))).toBe(true);
  });

  it("muhafız betiği gerçekten diskte (paketleme/yol çözümü doğrulaması)", async () => {
    await expect(fs.stat(overlayGuardPath())).resolves.toBeDefined();
  });
});

describe("C3 · kanarya", () => {
  it("işaret VARSA sorun yok ve işaret tüketilir", async () => {
    setActiveOverlay(TOOL_DENY_OVERLAY);
    const inj = (await overlaySettingsFor({ projectRoot: root, phase: 5 }))!;
    await fs.writeFile(inj.ackPath, "{}\n", "utf-8");
    expect(await verifyOverlayCanary(inj)).toBeNull();
    await expect(fs.stat(inj.ackPath)).rejects.toThrow();
  });

  it("işaret YOKSA hata metni döner + overlay-canary-fail denetime yazılır", async () => {
    setActiveOverlay(TOOL_DENY_OVERLAY);
    const inj = (await overlaySettingsFor({ projectRoot: root, phase: 8 }))!;
    const err = await verifyOverlayCanary(inj);
    expect(err).not.toBeNull();
    const audit = await fs.readFile(join(root, ".mycl", "audit.log"), "utf-8");
    expect(audit).toContain("overlay-canary-fail");
    // `-fail` soneki BİLİNÇLİ: hüküm makinesi gate başarısızlığı sayar → kapısız koşu "tamamlandı" olmaz.
    expect(audit).not.toContain("overlay-canary-skipped");
  });
});

describe("C5 · permission_denials — sahte yeşil fix", () => {
  it("engelleri ayrıştırır (bozuk girdiler sessizce atlanır)", () => {
    const denials = parsePermissionDenials({
      type: "result",
      permission_denials: [
        { tool_name: "Write", tool_use_id: "toolu_1", tool_input: { file_path: "src/config.ts" } },
        { tool_name: "NotebookEdit", tool_use_id: "toolu_2", tool_input: { notebook_path: "a.ipynb" } },
        "bozuk",
        {},
      ],
    });
    expect(denials).toHaveLength(2);
    expect(denials[0]).toEqual({ tool_name: "Write", tool_use_id: "toolu_1", target: "src/config.ts" });
    expect(denials[1].target).toBe("a.ipynb");
  });

  it("alan yoksa boş liste (bugünkü davranış korunur)", () => {
    expect(parsePermissionDenials({ type: "result" })).toEqual([]);
    expect(parsePermissionDenials({ type: "result", permission_denials: "x" })).toEqual([]);
  });

  it("ENGELLENEN tool_use yazma kanıtı SAYILMAZ, diğerleri korunur", () => {
    const queued = [
      { id: "toolu_1", name: "Write" },
      { id: "toolu_2", name: "Write" },
      { id: "", name: "Write" }, // kimliksiz → düşürülemez (yanlış düşürme yapma)
    ];
    const kept = filterDeniedWriteEvidence(queued, new Set(["toolu_1"]));
    expect(kept.map((k) => k.id)).toEqual(["toolu_2", ""]);
  });

  it("engel YOKSA hiçbir kanıt düşmez", () => {
    const queued = [{ id: "toolu_1", name: "Write" }];
    expect(filterDeniedWriteEvidence(queued, new Set())).toEqual(queued);
  });
});

describe("C4 · API/SDK yolu paritesi (executeTool)", () => {
  it("dondurulmuş dosyaya Write ENGELLENİR ve mesaj muhafızla aynı", async () => {
    await fs.writeFile(join(root, "config.ts"), "eski\n", "utf-8");
    setActiveOverlay({
      ...TOOL_DENY_OVERLAY,
      selections: [{ gate_id: "file_immutable", params: { path: "config.ts" } }],
    });
    const res = await executeTool("Write", { file_path: "config.ts", content: "yeni" }, {
      project_root: root,
    });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("file_immutable");
    // Engel gerçek: dosya DEĞİŞMEMİŞ olmalı.
    expect(await fs.readFile(join(root, "config.ts"), "utf-8")).toBe("eski\n");
    const audit = await fs.readFile(join(root, ".mycl", "audit.log"), "utf-8");
    expect(audit).toContain("overlay_gate_triggered");
  });

  it("forbid_new_files: var olanı düzenlemek serbest, YENİSİNİ yaratmak yasak", async () => {
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "var.ts") , "a\n", "utf-8");
    setActiveOverlay({
      ...TOOL_DENY_OVERLAY,
      selections: [{ gate_id: "forbid_new_files", params: { dir: "src" } }],
    });
    const blocked = await executeTool("Write", { file_path: "src/yeni.ts", content: "x" }, {
      project_root: root,
    });
    expect(blocked.is_error).toBe(true);
    expect(blocked.content).toContain("forbid_new_files");

    const allowed = await executeTool("Write", { file_path: "src/var.ts", content: "b" }, {
      project_root: root,
    });
    expect(allowed.is_error).toBe(false);
    expect(await fs.readFile(join(root, "src", "var.ts"), "utf-8")).toBe("b");
  });

  it("overlay YOKSA yazma yolu bugünküyle aynı (davranış regresyonu yok)", async () => {
    setActiveOverlay(null);
    const res = await executeTool("Write", { file_path: "serbest.ts", content: "x" }, {
      project_root: root,
    });
    expect(res.is_error).toBe(false);
  });

  it("okuma araçları overlay'den ETKİLENMEZ", async () => {
    await fs.writeFile(join(root, "config.ts"), "eski\n", "utf-8");
    setActiveOverlay({
      ...TOOL_DENY_OVERLAY,
      selections: [{ gate_id: "file_immutable", params: { path: "config.ts" } }],
    });
    const res = await executeTool("Read", { file_path: "config.ts" }, { project_root: root });
    expect(res.is_error).toBe(false);
  });
});
