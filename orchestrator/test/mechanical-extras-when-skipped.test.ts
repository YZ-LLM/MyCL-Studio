// Ana tarama atlanınca ek taramalar koşsun mu (Faz 13 güvenlik boşluğu).
//
// KÖK NEDEN (2026-08-03, kodda doğrulandı): `run()` "ana tarama skipped → hemen dön" diyordu. Faz 13'te ana
// komut stack profilinden geliyor ve dart/deno/flutter/swift profillerinde BOŞ → o projelerde semgrep,
// gizli anahtar taraması, güvenlik başlıkları, içerik güvenlik politikası dahil HİÇBİR güvenlik taraması
// koşmuyordu. Kullanıcının "hiçbir katmanda güvenlik açığı olmasın" hedefinin tam tersi: sıfır doğrulama.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MechanicalRunnerBase } from "../src/base/mechanical-runner.js";
import { PHASE_SPECS } from "../src/phase-registry.js";
import type { State } from "../src/types.js";

let projectRoot: string;
const fakeState = (): State => ({
  current_phase: 13,
  session_id: "t",
  spec_approved: false,
  project_root: projectRoot,
  created_at: 0,
  updated_at: 0,
  // stack YOK → profile_resolve_null → ana tarama atlanır (dart/deno/flutter/swift durumunun aynısı)
});

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "mycl-extras-"));
});
afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("ana tarama atlanınca ek taramalar", () => {
  it("VARSAYILAN (bayrak yok): eski davranış — ek taramalar KOŞMAZ", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "t-old",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: { type: "profile_key", key: "security" }, // stack yok → resolve null → skipped
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [{ name: "semgrep", cmd: "true" }],
      },
      pass_event: "security-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).not.toContain("semgrep-pass"); // ek tarama hiç koşmadı (eski sözleşme korunuyor)
  });

  it("BAYRAK AÇIK: ana tarama atlansa da ek taramalar KOŞAR, atlama GÖRÜNÜR kalır", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "t-new",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: { type: "profile_key", key: "security" },
        max_rescans: 0,
        skip_unless: "always",
        run_extras_when_main_skipped: true,
        extra_scans: [{ name: "semgrep", cmd: "true" }],
      },
      pass_event: "security-pass",
    });
    const out = await runner.run();
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("semgrep-pass"); // güvenlik taraması GERÇEKTEN koştu
    expect(audit).toContain("phase-13-skipped"); // ana boyutun atlandığı yine görünür (sahte "tarandı" yok)
    expect(out.kind).toBe("skipped"); // dürüst: ana boyut doğrulanmadı → özet sarı kalır
  });

  it("BAYRAK AÇIK + ek tarama bulgu buldu → faz FAIL (bulgu yutulmaz)", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "t-fail",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: { type: "profile_key", key: "security" },
        max_rescans: 0,
        skip_unless: "always",
        run_extras_when_main_skipped: true,
        extra_scans: [{ name: "semgrep", cmd: "false" }],
      },
      pass_event: "security-pass",
      fail_event: "security-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("fail");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("semgrep-fail");
  });
});

describe("faz kaydı sözleşmesi", () => {
  it("Faz 13 bayrağı AÇIK (dört stack'teki sıfır tarama boşluğu kapalı)", () => {
    expect(PHASE_SPECS[13]?.mechanical_config?.run_extras_when_main_skipped).toBe(true);
  });

  it("Faz 12 bayrağı AÇIK (19 stack'in 13'ünde perf komutu yok — ölçüm yine de koşmalı)", () => {
    // Stack bağımsız iki ölçüm (paket boyutu + sayfa skoru) profil komutundan BAĞIMSIZ çalışır.
    expect(PHASE_SPECS[12]?.mechanical_config?.run_extras_when_main_skipped).toBe(true);
    const names = (PHASE_SPECS[12]?.mechanical_config?.extra_scans ?? []).map((e) => e.name);
    expect(names).toContain("bundle-budget");
    expect(names).toContain("perf-web");
  });

  it("REGRESYON KİLİDİ: geri kalan mekanik fazlar bayrağı AÇMAZ (davranışları değişmedi)", () => {
    for (const id of [10, 11, 14, 15, 16, 17]) {
      expect(PHASE_SPECS[id as 10]?.mechanical_config?.run_extras_when_main_skipped ?? false).toBe(false);
    }
  });
});
