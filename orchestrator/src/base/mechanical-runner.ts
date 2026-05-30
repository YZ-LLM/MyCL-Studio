// base/mechanical-runner — LLM olmadan lokal komut çalıştıran fazlar (P11-P18).
//
// Pattern:
//   1. scan_cmd çalıştır → exit=0 ise pass-event yaz, complete.
//   2. exit!=0 ve fix_cmd varsa fix_cmd çalıştır, sonra scan_cmd tekrar.
//   3. max_rescans'a kadar 1-2 tekrarla; hâlâ fail'se phase-N-fail.
//
// Audit event isimleri faz başına PhaseSpec.required_audits[0] alınır.

import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendAudit } from "../audit.js";
import { emitChatMessage, emitClaudeStream } from "../ipc.js";
import { log } from "../logger.js";
import {
  loadProfile,
  resolveCommand,
  resolveProjectTypeCommand,
  type ProfileCommandKey,
} from "../profile-loader.js";
import { safeEnv } from "../safe-env.js";
import type {
  MechanicalCommandSpec,
  MechanicalConfig,
  PhaseId,
  State,
} from "../types.js";

const execp = promisify(exec);

export interface MechanicalRunOpts {
  /** İç tanımlayıcı (günlük + audit için, örn. "phase-16"). Sohbete YAZILMAZ. */
  tag: string;
  /**
   * Sohbete yazılacak Türkçe etiket (örn. "Faz 16: E2E Testler"). Verilmezse
   * `tag` kullanılır (geriye dönük uyum). v15.8 (2026-05-30): kullanıcıya
   * "phase-16" gibi iç ad sızmasın diye eklendi.
   */
  displayLabel?: string;
  phaseId: PhaseId;
  state: State;
  mechanical: MechanicalConfig;
  /** Pass durumunda yazılacak audit event (örn. "lint-pass"). */
  pass_event: string;
  /** Fail durumunda yazılacak audit event (örn. "lint-fail"). */
  fail_event?: string;
  /** Komutlar için timeout (ms). default 120000. */
  timeout_ms?: number;
}

export type MechanicalOutcome =
  | { kind: "pass"; rescans: number }
  | { kind: "fail"; rescans: number; stderr: string }
  | { kind: "skipped"; reason: string };

const DEFAULT_TIMEOUT = 120_000;

/**
 * MechanicalCommandSpec'i resolve eder → çalıştırılabilir komut string'i
 * veya null (profile/state eksik → skip semantiği).
 *
 * Üç biçim (v15.0 Batch A):
 *   - string: literal komut, doğrudan döner (backward-compat).
 *   - profile_key: `state.stack` profilinden komut alır.
 *   - project_type: Faz 16/18 için stack + project_type kombinasyonu.
 */
export async function resolveMechanicalCmd(
  spec: MechanicalCommandSpec,
  state: State,
): Promise<string | null> {
  if (typeof spec === "string") return spec;
  // QC A: union exhaustiveness — yeni `type` eklenirse TS `never` branch'inde
  // compile-time error verir. Sessizce yanlış kola düşmez.
  switch (spec.type) {
    case "profile_key": {
      if (!state.stack) return null;
      const profile = await loadProfile(state.stack);
      return resolveCommand(profile, spec.key as ProfileCommandKey);
    }
    case "project_type": {
      if (!state.stack) return null;
      const projectType = state.project_type ?? "unknown";
      const profile = await loadProfile(state.stack);
      return resolveProjectTypeCommand(profile, spec.which, projectType);
    }
    default: {
      const _exhaustive: never = spec;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * scan_cmd çalıştırıldığında "komut/script yok" durumunu fail'den ayırır.
 * Belirtiler:
 *   - exit code 127 (POSIX: command not found)
 *   - stderr'de "Missing script:" (npm-spesifik)
 *   - stderr'de "command not found"
 *   - stderr'de "could not determine executable" (npx)
 */
function isMissingCommand(result: {
  code: number;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.code === 127) return true;
  const s = `${result.stderr}\n${result.stdout}`;
  return (
    /Missing script:/.test(s) ||
    /command not found/i.test(s) ||
    /could not determine executable/i.test(s) ||
    /npm error code E[A-Z]+\s+npm error.*Missing script/.test(s)
  );
}

export class MechanicalRunnerBase {
  private aborted = false;

  constructor(private readonly opts: MechanicalRunOpts) {}

  /** Sohbete yazılacak Türkçe faz etiketi (iç "phase-N" sızmaz). */
  private get label(): string {
    return this.opts.displayLabel ?? this.opts.tag;
  }

  /**
   * Mechanical runner abort — bir sonraki komut başlatmadan önce yakalanır.
   * Çalışmakta olan exec() çağrısı tamamlanmasını bekler (promisify(exec)
   * child handle vermiyor). Bu pratikte yeterli: scan komutu 60sn'lik
   * timeout'a sahip; abort bir scan + fix cycle'ında en geç 2× cycle süresinde
   * etki eder.
   */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    log.info(this.opts.tag, "abort requested");
  }

  async run(): Promise<MechanicalOutcome> {
    const { opts } = this;
    const timeout = opts.timeout_ms ?? DEFAULT_TIMEOUT;

    emitClaudeStream({
      sub: "init",
      text: `mech-${opts.tag}`,
      model: "none",
      cwd: opts.state.project_root,
    });

    // Ana scan loop'u (mevcut behavior) — sonuç pass/fail/skipped.
    const mainOutcome = await this.runMainScan(timeout);

    // Extra scans (opsiyonel — Faz 13 semgrep, vs.) — main scan sonucu ne
    // olursa olsun çalışır (skipped hariç; scan_cmd missing ise extra'ları da
    // koşturmak anlamsız). Her extra'nın kendi audit event'i; final outcome
    // main + extra'ların kombinasyonu.
    if (mainOutcome.kind === "skipped") {
      return mainOutcome;
    }

    const extras = opts.mechanical.extra_scans;
    if (!extras || extras.length === 0) {
      return mainOutcome;
    }

    let anyFail = mainOutcome.kind === "fail";
    for (const extra of extras) {
      if (this.aborted) break;
      const extraOutcome = await this.runExtraScan(extra, timeout);
      if (extraOutcome === "fail") anyFail = true;
    }

    // Kombinasyon: main fail veya herhangi bir extra fail ise final fail.
    if (anyFail) {
      const stderr = mainOutcome.kind === "fail" ? mainOutcome.stderr : "";
      return {
        kind: "fail",
        rescans: mainOutcome.kind === "fail" ? mainOutcome.rescans : 0,
        stderr,
      };
    }
    return mainOutcome;
  }

  /**
   * Tek bir extra scan komutu çalıştır. Audit'e `{name}-pass` / `{name}-fail`
   * / `{name}-skipped` event'i yazar. require_file set ise yokluğunda skipped.
   * Returns: "pass" | "fail" | "skipped"
   */
  private async runExtraScan(
    extra: NonNullable<MechanicalConfig["extra_scans"]>[number],
    timeout_ms: number,
  ): Promise<"pass" | "fail" | "skipped"> {
    const { opts } = this;

    // require_file: project_root içinde dosya yoksa skip (örn. snyk için
    // ".snyk", k6 için "loadtest.js").
    if (extra.require_file) {
      try {
        await access(join(opts.state.project_root, extra.require_file));
      } catch {
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `${extra.name}-skipped`,
          caller: "mycl-orchestrator",
          detail: `missing_file file="${extra.require_file}"`,
        });
        emitChatMessage(
          "system",
          `⏭ ${extra.name} atlandı — gerekli dosya yok (${extra.require_file}).`,
        );
        return "skipped";
      }
    }

    const result = await this.execCmd(extra.cmd, timeout_ms);
    log.info(opts.tag, "extra scan", {
      name: extra.name,
      cmd: extra.cmd,
      code: result.code,
    });

    if (isMissingCommand(result)) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `${extra.name}-skipped`,
        caller: "mycl-orchestrator",
        detail: `missing_command cmd="${extra.cmd}"`,
      });
      emitChatMessage(
        "system",
        `⏭ ${extra.name} atlandı — bu araç sistemde kurulu değil.`,
      );
      return "skipped";
    }

    if (result.code === 0) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `${extra.name}-pass`,
        caller: "mycl-orchestrator",
        detail: `cmd="${extra.cmd}"`,
      });
      emitChatMessage("system", `✅ ${extra.name} — geçti.`);
      return "pass";
    }

    const extraTail = result.stderr.trim() || result.stdout.trim();
    const extraSnippet = extraTail.slice(0, 200);
    await appendAudit(opts.state.project_root, {
      ts: Date.now(),
      phase: opts.phaseId,
      event: `${extra.name}-fail`,
      caller: "mycl-orchestrator",
      detail: extraSnippet,
    });
    emitChatMessage(
      "system",
      `❌ ${extra.name} — başarısız.` +
        (extraSnippet ? ` (${extraSnippet.slice(0, 120)})` : ""),
    );
    return "fail";
  }

  /**
   * Mevcut ana scan akışı (scan_cmd + fix_cmd loop). Önceden inline `run()`
   * gövdesindeydi; extra_scans pattern'ı eklenince ayrı method'a çıkarıldı.
   */
  private async runMainScan(timeout: number): Promise<MechanicalOutcome> {
    const { opts } = this;
    // v15.0 Batch A: scan_cmd ve fix_cmd artık literal string olabilir veya
    // profile_key/project_type resolver spec'i. Resolve sonucu null ise (profile
    // yok, key tanımsız) → phase-N-skipped (subprocess spawn denemesi yok).
    const scanCmd = await resolveMechanicalCmd(opts.mechanical.scan_cmd, opts.state);
    if (scanCmd === null) {
      log.info(opts.tag, "scan cmd unresolved — skipping phase", {
        spec: opts.mechanical.scan_cmd,
        stack: opts.state.stack,
        project_type: opts.state.project_type,
      });
      // QC B: stack undefined vs profile-key missing ayrımı — kullanıcıya net
      // mesaj. Stack tespit edilmediyse "proje stack'i tespit edilemedi",
      // tespit edildi ama profil/key yoksa "bu stack için komut tanımlı değil".
      const stackDetected = Boolean(opts.state.stack);
      const auditDetail = stackDetected
        ? `profile_resolve_null stack="${opts.state.stack}"`
        : `stack_not_detected`;
      const userMsg = stackDetected
        ? `⏭ ${this.label} atlandı — bu proje türü için tanımlı komut yok.`
        : `⏭ ${this.label} atlandı — projenin teknoloji türü tespit edilemedi.`;
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `phase-${opts.phaseId}-skipped`,
        caller: "mycl-orchestrator",
        detail: auditDetail,
      });
      emitChatMessage("system", userMsg);
      return { kind: "skipped", reason: "profile_resolve_null" };
    }
    const fixCmd = opts.mechanical.fix_cmd
      ? await resolveMechanicalCmd(opts.mechanical.fix_cmd, opts.state)
      : null;
    // QC C: scan_cmd resolve oldu ama fix_cmd verildiği halde resolve null —
    // profil'de scan tanımlı, fix tanımsız (örn. python-uv `lint` var,
    // `lint_fix` eksik kalırsa). Log uyarısı: scan fail durumunda direkt fail
    // olacak, kullanıcı bunu fark edebilsin.
    if (opts.mechanical.fix_cmd && fixCmd === null) {
      log.warn(opts.tag, "fix_cmd spec defined but resolved null — no auto-fix", {
        spec: opts.mechanical.fix_cmd,
        stack: opts.state.stack,
      });
    }

    let rescans = 0;
    while (true) {
      if (this.aborted) {
        log.info(opts.tag, "aborted at scan boundary", { rescans });
        return { kind: "skipped", reason: "aborted" };
      }
      const scanResult = await this.execCmd(scanCmd, timeout);
      log.info(opts.tag, "scan result", {
        cmd: scanCmd,
        code: scanResult.code,
        stdout_len: scanResult.stdout.length,
        stderr_len: scanResult.stderr.length,
      });
      // Komut/script projede yok → fail değil skip. Birçok proje (lint scripti
      // olmayan repo, ts-prune kurulu olmayan repo, vs.) için Faz 10-16'nın
      // hard fail etmesi pipeline'ı keserdi. Bu yolla pipeline devam eder.
      if (isMissingCommand(scanResult)) {
        log.info(opts.tag, "scan cmd missing — skipping phase", { cmd: scanCmd });
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail: `missing_command cmd="${scanCmd}"`,
        });
        emitChatMessage(
          "system",
          `⏭ ${this.label} atlandı — bu proje için ilgili komut tanımlı değil.`,
        );
        return { kind: "skipped", reason: "missing_command" };
      }
      if (scanResult.code === 0) {
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: opts.pass_event,
          caller: "mycl-orchestrator",
          detail: `cmd="${scanCmd}" rescans=${rescans}`,
        });
        emitChatMessage("system", `✅ ${this.label} — geçti.`);
        return { kind: "pass", rescans };
      }

      if (!fixCmd || rescans >= opts.mechanical.max_rescans) {
        // v15.7 (2026-05-27): Playwright "No tests found", ESLint, npm gibi
        // tool'lar hatayı stdout'a yazıyor. stderr boşsa stdout'a düş ki
        // audit + chat snippet'i boş kalmasın.
        const tail = scanResult.stderr.trim() || scanResult.stdout.trim();
        const snippet = tail.slice(0, 200);
        if (opts.fail_event) {
          await appendAudit(opts.state.project_root, {
            ts: Date.now(),
            phase: opts.phaseId,
            event: opts.fail_event,
            caller: "mycl-orchestrator",
            detail: snippet,
          });
        }
        emitChatMessage(
          "system",
          `❌ ${this.label} — başarısız.` +
            (snippet ? ` (${snippet.slice(0, 120)})` : ""),
        );
        // v15.7 (2026-05-27): outcome.stderr field'a da fallback uygula —
        // caller (örn. only-run handler) bu field'ı consume edebilir; sadece
        // stderr verirken stdout-only hataları kaybediyorduk.
        return { kind: "fail", rescans, stderr: tail };
      }

      log.info(opts.tag, "fix attempt", { cmd: fixCmd, rescans });
      await this.execCmd(fixCmd, timeout);
      rescans++;
    }
  }

  private async execCmd(
    cmd: string,
    timeout_ms: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execp(cmd, {
        cwd: this.opts.state.project_root,
        timeout: timeout_ms,
        // Güvenlik: hassas env'leri filtrele (safe-env allowlist).
        env: { ...safeEnv(), LC_ALL: "C" },
        maxBuffer: 10 * 1024 * 1024,
      });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? ""),
      };
    }
  }
}
