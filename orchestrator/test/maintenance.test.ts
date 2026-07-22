// maintenance — bakım turu birim testleri (LLM/tarayıcı yok; unknown stack + tmpdir).
import { describe, expect, it } from "vitest";
import { runMaintenance, formatMaintenanceReport, type MaintenanceReport } from "../src/maintenance.js";
import { loadProfile, resolveCommand, _clearProfileCache } from "../src/profile-loader.js";
import { ALL_STACK_IDS } from "../src/types.js";
import type { State } from "../src/types.js";

const NO_DEV = {
  ensureDevServer: async () => ({ ok: false }),
  ensureE2E: async () => ({ proceed: false, reason: "test" }),
};

describe("runMaintenance — bölüm izolasyonu + görünür atlama", () => {
  it("unknown stack: outdated/update GÖRÜNÜR atlanır; taramalar + Full Test yine koşar", async () => {
    const state = {
      project_root: "/tmp/nonexistent-mycl-maintenance",
      stack: "unknown",
      project_type: "web",
    } as unknown as State;
    const r = await runMaintenance(state, NO_DEV);
    const byId = new Map(r.sections.map((s) => [s.id, s]));
    expect(byId.get("outdated")?.status).toBe("skipped");
    expect(byId.get("outdated")?.detail_tr).toContain("desteklenmiyor");
    expect(byId.get("update")?.status).toBe("skipped");
    // Full Test HER ZAMAN koşar (kullanıcının açık şartı) — burada bölümleri atlanmış da olsa rapor var.
    // 5 bölüm: birim/entegrasyon/E2E/rota/işlevsel (a11y+görsel 2026-07-22'de çıkarıldı; işlevsel eklendi).
    expect(r.fullTest.sections).toHaveLength(5);
    expect(r.checkpointRef).toBeNull();
  });
});

describe("profil conformance — outdated/update anahtarları", () => {
  it("19 profilin HEPSİ outdated ve update anahtarlarını AÇIKÇA bildirir (string|null)", async () => {
    _clearProfileCache();
    for (const id of ALL_STACK_IDS) {
      const p = await loadProfile(id);
      expect(p, id).not.toBeNull();
      // Alan AÇIKÇA tanımlı olmalı (null = bilinçli 'desteklenmiyor'; eksik = unutulmuş)
      expect(Object.prototype.hasOwnProperty.call(p!.commands, "outdated"), `${id}.outdated`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(p!.commands, "update"), `${id}.update`).toBe(true);
    }
  });

  it("örnek kanonik değerler: npm günceller; pip/gradle bilinçli null (elle)", async () => {
    expect(resolveCommand(await loadProfile("node-npm"), "update")).toBe("npm update");
    expect(resolveCommand(await loadProfile("node-npm"), "outdated")).toBe("npm outdated");
    expect(resolveCommand(await loadProfile("python-pip"), "update")).toBeNull();
    expect(resolveCommand(await loadProfile("gradle"), "outdated")).toBeNull();
    expect(resolveCommand(await loadProfile("rust"), "update")).toBe("cargo update");
  });
});

describe("formatMaintenanceReport", () => {
  it("bölüm ikonları + geri dönüş çapası satırı", () => {
    const r: MaintenanceReport = {
      sections: [
        { id: "outdated", label_tr: "Güncel olmayan bağımlılıklar", status: "info", detail_tr: "2 paket eski" },
        { id: "update", label_tr: "Bağımlılık güncelleme", status: "pass", detail_tr: "tamam" },
        { id: "audit", label_tr: "Bağımlılık güvenlik taraması", status: "fail", detail_tr: "3 zafiyet" },
        { id: "sast", label_tr: "Statik güvenlik taraması (SAST)", status: "skipped", detail_tr: "semgrep yok" },
      ],
      checkpointRef: "abcdef1234567890",
      auditRed: true,
      sastFindings: [],
      fullTest: { ok: true, sections: [], durationMs: 0 },
      durationMs: 30_000,
    };
    const msg = formatMaintenanceReport(r);
    expect(msg).toContain("🔧 **Bakım Turu**");
    expect(msg).toContain("ℹ️ **Güncel olmayan bağımlılıklar:**");
    expect(msg).toContain("✅ **Bağımlılık güncelleme:**");
    expect(msg).toContain("❌ **Bağımlılık güvenlik taraması:**");
    expect(msg).toContain("⏭ **Statik güvenlik taraması");
    expect(msg).toContain("git reset --hard abcdef1234");
  });

  it("checkpoint yoksa geri dönüş satırı yok", () => {
    const r: MaintenanceReport = {
      sections: [],
      checkpointRef: null,
      auditRed: false,
      sastFindings: [],
      fullTest: { ok: true, sections: [], durationMs: 0 },
      durationMs: 1000,
    };
    expect(formatMaintenanceReport(r)).not.toContain("git reset");
  });
});
