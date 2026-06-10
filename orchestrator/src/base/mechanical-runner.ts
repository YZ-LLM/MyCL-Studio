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
  /**
   * v15.9: Değişen kapsam (projectRoot-relative dosyalar). Doluysa scope'lanabilir
   * gate'ler (scoped_key/scoped_cmd_template taşıyan) yalnız bu dosyalara daralır;
   * boş/undefined → tüm-proje (mevcut davranış).
   */
  changedScope?: string[];
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
/** Shell tek-tırnak quote (regex yok): tek tırnakları '\'' ile escape. */
export function shellQuote(p: string): string {
  return `'${p.split("'").join("'\\''")}'`;
}

/** `{files}` placeholder'ını shell-safe scope yollarıyla genişlet. */
export function expandFilesPlaceholder(template: string, files: string[]): string {
  return template.split("{files}").join(files.map(shellQuote).join(" "));
}

export async function resolveMechanicalCmd(
  spec: MechanicalCommandSpec,
  state: State,
  changedScope?: string[],
): Promise<string | null> {
  if (typeof spec === "string") return spec;
  // QC A: union exhaustiveness — yeni `type` eklenirse TS `never` branch'inde
  // compile-time error verir. Sessizce yanlış kola düşmez.
  switch (spec.type) {
    case "profile_key": {
      if (!state.stack) return null;
      const profile = await loadProfile(state.stack);
      // v15.9 scoped: scoped_key tanımlı + scope dolu + profilde {files} şablonu
      // varsa → değişen dosyalara daralt. Aksi → tüm-proje key fallback.
      if (spec.scoped_key && changedScope && changedScope.length > 0) {
        const scopedTmpl = resolveCommand(profile, spec.scoped_key as ProfileCommandKey);
        if (scopedTmpl && scopedTmpl.includes("{files}")) {
          return expandFilesPlaceholder(scopedTmpl, changedScope);
        }
      }
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
export function isMissingCommand(result: {
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
    /npm error code E[A-Z]+\s+npm error.*Missing script/.test(s) ||
    // v15.10: `npx --no-install <tool>` aracı projede kurulu değilse npx bunu
    // yazıp iptal eder. "Araç yok" → hard-fail değil, skip (örn. Faz 11 ts-prune
    // kurulu olmayan repo) → pipeline kesilmez, görünür `phase-N-skipped`.
    /npx canceled due to missing packages/i.test(s)
  );
}

/**
 * 2026-06-10 (Ümit logları): MyCL'in KENDİ node aracı (csp-check.mjs / headers-check.mjs) bundle'da
 * kendi modülünü bulamayınca "Cannot find module '/Applications/MyCL Studio.app/...'" ile çöküyordu →
 * MyCL bunu PROJE güvenlik hatası sanıp sqlite3'ü v6'ya (kırıcı!) yükseltmeye çalıştı. Bu MyCL'in
 * paketleme bug'ı, projenin sorunu DEĞİL. Tespit: modül-çözüm hatası + yolun MyCL kurulumunu (app
 * bundle / _up_ / Applications) işaret etmesi. SAF. Projenin KENDİ "Cannot find module"'ı (bare paket /
 * proje yolu) bundle işaretçisi taşımaz → yanlışlıkla skip edilmez (gerçek proje hatası fail kalır).
 */
export function isMyclToolBroken(result: { code: number; stdout: string; stderr: string }): boolean {
  const s = `${result.stderr}\n${result.stdout}`;
  const moduleNotFound = /Cannot find module/i.test(s) || /ERR_MODULE_NOT_FOUND/.test(s);
  const pointsAtMyclInstall = /(MyCL Studio\.app|\.app\/Contents|[/\\]_up_[/\\]|[/\\]Applications[/\\])/.test(s);
  return moduleNotFound && pointsAtMyclInstall;
}

/**
 * 2026-06-10 (Ümit): TypeScript-only bir araç (ts-prune/ts-morph/tsc) JS projesinde (tsconfig yok) çöktüğünde
 * bu PROJE hatası DEĞİL — araç bu proje tipine UYGULANAMAZ. Eski davranış: ts-prune ts-morph FileNotFoundError
 * ile patlıyor → MyCL "proje hatası" sanıp "tsconfig oluştur + yeni iterasyon" gibi saçma fix'e gidiyordu.
 * Tespit: ts-morph/ts-prune/tsc imzası + (FileNotFoundError | tsconfig bulunamadı). SAF.
 */
export function isTsToolNotApplicable(result: { code: number; stdout: string; stderr: string }): boolean {
  const s = `${result.stderr}\n${result.stdout}`;
  const tsTool = /ts-morph|ts-prune|\btsc\b/i.test(s);
  const configMiss =
    /FileNotFoundError/i.test(s) ||
    /could not find a? ?tsconfig/i.test(s) ||
    /tsconfig\.json['"]? ?(not found|does not exist|bulunamadı)/i.test(s) ||
    /No inputs were found in config/i.test(s);
  return tsTool && configMiss;
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
    // Ekstra taramalar (örn. Faz 13: semgrep/gitleaks/csp/headers) BAĞIMSIZ + salt-okunur → PARALEL koş.
    // Saf hız kazancı; kod YAZMADIKLARI için çakışma riski yok (yalnız analiz). abort'ta hiç başlatma.
    // (Fazlar-ARASI paralel DEĞİL — o faz-makinesini/singleton'ı bozar; yalnız faz-İÇİ bağımsız taramalar.)
    if (!this.aborted) {
      const extraResults = await Promise.all(
        extras.map((extra) => this.runExtraScan(extra, timeout)),
      );
      if (extraResults.some((r) => r === "fail")) anyFail = true;
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

    // v15.9 scoped: scoped_cmd_template + scope dolu → değişen dosyalara daralt;
    // aksi → cmd (tüm-proje) fallback.
    const effectiveCmd =
      extra.scoped_cmd_template &&
      opts.changedScope &&
      opts.changedScope.length > 0 &&
      extra.scoped_cmd_template.includes("{files}")
        ? expandFilesPlaceholder(extra.scoped_cmd_template, opts.changedScope)
        : extra.cmd;
    const result = await this.execCmd(effectiveCmd, timeout_ms);
    log.info(opts.tag, "extra scan", {
      name: extra.name,
      cmd: effectiveCmd,
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

    // MyCL'in KENDİ aracı bozuk (bundle path module-not-found) → PROJE hatası DEĞİL → skip + dürüst rapor.
    // Proje koduna/bağımlılığına DOKUNMA (sqlite3-v6 felaketi buradan çıktı). Güvenlik açığı anlamına gelmez.
    if (isMyclToolBroken(result)) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `${extra.name}-skipped`,
        caller: "mycl-orchestrator",
        detail: `mycl_tool_broken code=${result.code} cmd="${extra.cmd}"`,
      });
      emitChatMessage(
        "system",
        `⏭ ${extra.name} atlandı — MyCL'in kendi tarama aracı çalışmadı (paketleme bug'ım, proje sorunu DEĞİL; güvenlik açığı anlamına GELMEZ). Bunu kendi tarafımda düzelteceğim.`,
      );
      return "skipped";
    }
    // TS-only araç JS projesinde (tsconfig yok) → uygulanamaz → skip (tsconfig oluştur saçmalığı yok).
    if (isTsToolNotApplicable(result)) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `${extra.name}-skipped`,
        caller: "mycl-orchestrator",
        detail: `ts_tool_not_applicable code=${result.code} cmd="${extra.cmd}"`,
      });
      emitChatMessage(
        "system",
        `⏭ ${extra.name} atlandı — bu TypeScript aracı JS projesine (tsconfig yok) uygulanamaz. Bu bir proje hatası DEĞİL; tsconfig oluşturmuyorum.`,
      );
      return "skipped";
    }

    // Güvenlik-baseline Unit 3: "araç düzgün çalışmadı" exit kodları (örn. semgrep
    // fatal/bozuk-kural=2, gitleaks eski-sürüm bilinmeyen-komut=126) → BULGU değil →
    // fail değil SKIP. Bozuk custom kural / uyumsuz araç sürümü projeyi yanlış-
    // bloklamasın (review landmine). Atlama harness-verdict'te securitySkipped→PARTIAL.
    if (extra.tool_error_codes && extra.tool_error_codes.includes(result.code)) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `${extra.name}-skipped`,
        caller: "mycl-orchestrator",
        detail: `tool_error code=${result.code} cmd="${extra.cmd}"`,
      });
      emitChatMessage(
        "system",
        `⏭ ${extra.name} atlandı — araç düzgün çalışmadı (çıkış kodu ${result.code}; bulgu değil, araç/sürüm sorunu).`,
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
    const scanCmd = await resolveMechanicalCmd(
      opts.mechanical.scan_cmd,
      opts.state,
      opts.changedScope,
    );
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
      ? await resolveMechanicalCmd(opts.mechanical.fix_cmd, opts.state, opts.changedScope)
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
      // MyCL'in kendi aracı bozuk (bundle module-not-found) → proje hatası DEĞİL → skip.
      if (isMyclToolBroken(scanResult)) {
        log.warn(opts.tag, "mycl tool broken — skipping (own packaging bug)", { cmd: scanCmd });
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail: `mycl_tool_broken cmd="${scanCmd}"`,
        });
        emitChatMessage(
          "system",
          `⏭ ${this.label} atlandı — MyCL'in kendi aracı çalışmadı (paketleme bug'ım, proje sorunu DEĞİL).`,
        );
        return { kind: "skipped", reason: "mycl_tool_broken" };
      }
      // TS-only araç (ts-prune/ts-morph/tsc) JS projesinde (tsconfig yok) → uygulanamaz → skip.
      // Ümit vakası: Faz 11 ts-prune JS projesinde çöküp "tsconfig oluştur + yeni iterasyon" saçmalığına yol açtı.
      if (isTsToolNotApplicable(scanResult)) {
        log.warn(opts.tag, "TS tool not applicable (no tsconfig / JS project) — skipping", { cmd: scanCmd });
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail: `ts_tool_not_applicable cmd="${scanCmd}"`,
        });
        emitChatMessage(
          "system",
          `⏭ ${this.label} atlandı — bu TypeScript aracı JS projesine (tsconfig yok) uygulanamaz. Proje hatası DEĞİL; tsconfig oluşturmuyorum.`,
        );
        return { kind: "skipped", reason: "ts_tool_not_applicable" };
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
