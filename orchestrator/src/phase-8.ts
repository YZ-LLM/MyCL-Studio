// phase-8 — TDD Implementation (codegen).
//
// Faz-spesifik: spec.md zorunlu, audit observer test/prod path + bash test cmd
// pattern'lerini izler. Gate: greens >= 1 && son event "tdd-green" → complete.
// tdd_compliance_score state'e patch olarak verilir.
//
// v15.7 (2026-05-27): Dosya header rot düzeltildi (eski "phase-9" yazıyordu).
// Phase8Controller → Phase 8 = TDD.

import { exec } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendAudit, readAuditLogTail } from "./audit.js";
import { createCodegenBackend, type CodegenBackend } from "./codegen/backend.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { backendForRole, type MyclConfig } from "./config.js";

const execAsync = promisify(exec);
import { emitChatMessage, emitError } from "./ipc.js";
import { log } from "./logger.js";
import { substitute } from "./template-engine.js";
import type { ToolDef } from "./claude-api.js";
import { scanTechDebt, type TechDebtFinding } from "./tech-debt-scanner.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

/**
 * Spec.md'nin Acceptance Criteria bölümünden AC sayısını çıkarır. Phase 4
 * spec'i `- **AC1**: ...` formatında yazıyor; satır başı bu kalıba uyan
 * her satır bir AC.
 */
export function countAcceptanceCriteria(acSection: string): number {
  const re = /^\s*-\s+\*\*AC\d+\*\*:/gm;
  const matches = acSection.match(re);
  return matches ? matches.length : 0;
}

const TEST_PATH_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\/__tests__\//,
  /\/tests?\//,
];
const PROD_EXT = /\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|rb|swift)$/;

function isTestPath(path: string): boolean {
  if (path.includes("node_modules")) return false;
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}
function isProdPath(path: string): boolean {
  if (path.includes("node_modules") || isTestPath(path)) return false;
  return PROD_EXT.test(path);
}
// Yaygın test runner pattern'leri. Faz 8 audit observer Bash command'ı bu
// listeye karşı test eder; match olursa exit code 0→tdd-green, nonzero→tdd-red
// yazar. Yeni runner gerekirse buraya ekle.
const TEST_CMD_PATTERNS: RegExp[] = [
  /\bnpm\s+(test|t)\b/,
  /\bpnpm\s+(test|t)\b/,
  /\byarn\s+test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\brspec\b/,
  /\bphpunit\b/,
  /\bbun\s+test\b/,
  /\bdeno\s+test\b/,
];

export function isTestCommand(cmd: string): boolean {
  return TEST_CMD_PATTERNS.some((re) => re.test(cmd));
}

export class Phase8Controller {
  public statePatch: Partial<State> = {};
  private base: CodegenBackend | null = null;
  /** v15.8: main='Claude Code Aboneliği' → CLI backend (TDD red/green self-report + anchor). */
  private cliMode = false;
  /** CLI'da ajanın çalıştırdığı son test komutu — MyCL anchor re-run için. */
  private lastTestCmd: string | null = null;
  /** Marker self-report audit yazımları — anchor'dan ÖNCE settle edilir (sıra/yarış). */
  private testResultWrites: Promise<void>[] = [];
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  /** v15.7 (2026-05-27): Faz 7'den gelen pending migration not — initialMessage'a eklenir. */
  private pendingMigrationNote = "";
  /** v15.7 (2026-05-27): Phase 0 D2 backend-only fix routing'ten gelen plan. */
  private pendingFixNote = "";

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
  }

  abort(): void {
    this.base?.abort();
  }

  /** doubt-driven eskalasyon cevabını codegen backend'e iletir (index.ts routing). */
  submitAskqAnswer(askqId: string, selected_tr: string): void {
    this.base?.submitAskqAnswer?.(askqId, selected_tr);
  }

  async run(): Promise<"complete" | "fail"> {
    log.info("phase-8", "run start");

    const specPath = join(this.state.project_root, ".mycl", "spec.md");
    try {
      await stat(specPath);
    } catch {
      emitError("phase 8 requires spec.md (Phase 4 output)", { specPath });
      this.lastFailReason = "spec.md missing (Phase 4 incomplete)";
      return "fail";
    }

    // v15.7 (2026-05-27): Batch A1 — Phase 7 onaylanmış migration'ları
    // initial message'a inject et ki TDD codegen DB context'ini bilsin.
    // Otomatik apply YAPMA (test ortamı / dev DB henüz hazır olmayabilir);
    // ana ajan stack-spesifik migration komutuyla (örn. npm run db:migrate)
    // kendisi uygulasın.
    let migrationNote = "";
    if (this.state.pending_migrations && this.state.pending_migrations.length > 0) {
      migrationNote =
        `\n\n**Pending migrations** (Faz 7'de üretildi, Phase 8 sen uygulamalısın):\n` +
        this.state.pending_migrations.map((p) => `- ${p}`).join("\n") +
        `\n\nStack profile'ın migration komutunu çağır (örn. \`npm run db:migrate\`, \`alembic upgrade head\`, \`bin/rails db:migrate\`). Eğer komut yoksa migration SQL'i direkt DB'ye uygula (psql/sqlite/mysql client).`;
      log.info("phase-8", "pending migrations injected", {
        count: this.state.pending_migrations.length,
      });
      // v15.7 (2026-05-27): R2-03 — tek seferlik tüketim. Sonraki Phase 8
      // çağrılarında aynı migration mesajı tekrar inject olmasın.
      this.statePatch = {
        ...this.statePatch,
        pending_migrations: undefined,
      };
    }
    this.pendingMigrationNote = migrationNote;

    // v15.7 (2026-05-27): Backend-only fix mode (Phase 0 D2 routing'den).
    // pending_backend_fix set ise: bug fix odaklı initial message + cleanup.
    let fixModeNote = "";
    if (this.state.pending_backend_fix) {
      fixModeNote =
        `\n\n**BUG FIX MODE — Phase 0 D2 yönlendirmesi**:\n${this.state.pending_backend_fix}\n\n` +
        `Bu bir geniş yeni-özellik talebi DEĞİL; mevcut backend'de targeted fix. ` +
        `Plan'daki dosyalara DAR scope edit yap. Önce ilgili AC'yi (varsa) test ile düşür, ` +
        `sonra minimal patch ile yeşil yap. Eski testleri kırma. Stop when full suite green.`;
      this.statePatch = {
        ...this.statePatch,
        pending_backend_fix: undefined, // tek seferlik tüketim
      };
      log.info("phase-8", "backend fix mode active");
    }
    this.pendingFixNote = fixModeNote;

    // v15.7 (2026-05-25): Retry loop KALDIRILDI. Kullanıcı talebi: "3 kere
    // denemesin. maliyet artıyor. önce smoke test yapsın." Tek deneme — agent
    // template'i integration-first + smoke-first kuralıyla zaten net. Fail
    // olursa kullanıcı manual müdahale eder (Faz 8'i sidebar'dan tekrar
    // tıklayabilir veya spec'i revize edebilir).
    return this.runAttempt(1, 1);
  }

  /** v15.7 (2026-05-25): AC sayısı bir Phase 8 run boyunca sabit. Cache et —
   *  3-10 attempt × 2 caller (countAcsForRetry + gate eval) spec.md'yi tekrar
   *  tekrar parse etmesin (~5-10K token/faz tasarruf). */
  private acCountCache: number | null = null;

  private async getAcCount(): Promise<number> {
    if (this.acCountCache !== null) return this.acCountCache;
    try {
      const specMdPath = join(this.state.project_root, ".mycl", "spec.md");
      const specMd = await readFile(specMdPath, "utf-8");
      this.acCountCache = countAcceptanceCriteria(specMd);
    } catch {
      this.acCountCache = 0;
    }
    return this.acCountCache;
  }

  // v15.7 (2026-05-25): countAcsForRetry + countGreensSoFar retry loop ile
  // birlikte kaldırıldı (kullanıcı: "3 kere denemesin").

  private async runAttempt(
    attempt: number,
    maxAttempts: number,
  ): Promise<"complete" | "fail"> {
    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      systemPrompt = substitute(tmpl, { PROJECT_ROOT: this.state.project_root });
    } catch (err) {
      log.error("phase-8", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    // v15.8: main='Claude Code Aboneliği' → CLI. CLI stream-json test exit-code
    // taşımadığı için TDD red/green ajanın MYCL_TEST_RESULT marker'ından gelir;
    // MyCL ayrıca son testi kendi koşup gate'i deterministik çapayla doğrular.
    this.cliMode = backendForRole(this.config, "main") === "cli";
    if (this.cliMode && !isClaudeAvailable()) {
      const m =
        "Main 'Claude Code Aboneliği' (CLI) seçili ama `claude` bulunamadı — " +
        "Faz 8 (TDD) çalıştırılamadı. API'ye SESSİZCE DÜŞÜLMEDİ. `claude` kur ya da " +
        "Ayarlar → Modeller'den main'i 'API' yap.";
      emitError("phase-8: claude bulunamadı (CLI)", m);
      emitChatMessage("system", `🔴 ${m}`);
      this.lastFailReason = "claude not found (CLI backend)";
      return "fail";
    }
    if (this.cliMode) {
      systemPrompt +=
        "\n\n---\n\n## CLI MODU — TEST SONUCU RAPORLAMA (ZORUNLU)\n" +
        "Araçların çıktısı MyCL'e test exit-code'unu taşımaz. Bu yüzden HER test " +
        "koşumundan (`npm test` vb.) SONRA, gördüğün gerçek çıktıya göre TEK satır yaz:\n" +
        "- Testler GEÇTİYSE (exit 0, PASS): `MYCL_TEST_RESULT: green`\n" +
        "- Testler BAŞARISIZSA: `MYCL_TEST_RESULT: red: <kısa neden>`\n" +
        "Test çıktısında PASS görmeden ASLA green deme. MyCL son testi KENDİ de koşup " +
        "doğrular — yanlış green gate'i geçirmez, sadece teknik borç gizler.";
    }

    const role = this.spec.model_role!;
    const toolCtx: ToolContext = {
      project_root: this.state.project_root,
      extra_denied_paths: this.spec.denied_paths,
    };

    // v15.7 (2026-05-25): Iteration-aware initial message — agent sadece BU
    // iterasyonda yeni/değişen AC'ler için test yazsın. Önceki iterasyonların
    // testleri zaten dosyalarda var, tekrar yazma. Kullanıcı: "sadece o
    // iterasyondaki iş için yapılacak test".
    const iterCount = this.state.iteration_count ?? 1;
    void maxAttempts; // retry kaldırıldı, attempt sabit 1
    void attempt;
    const initialMessage =
      `Begin Phase 8: TDD implementation (iteration ${iterCount}).\n\n` +
      `1. First read .mycl/spec.md to load acceptance criteria.\n` +
      `2. ÖNEMLİ — Iteration scope: Önceki iterasyonların testleri zaten ` +
      `dosyalarda var (tests/ veya __tests__/ veya *.test.* dosyaları). ` +
      `\`npm test\` ile mevcut suite'i koş, hangi AC'lerin zaten green olduğunu gör. ` +
      `Sen sadece BU iterasyonda spec'e yeni eklenen veya değişen AC'ler için ` +
      `test yaz (smoke-first + integration-first methodology). Eski testleri ` +
      `silme veya kırma — full suite son aşamada yeşil olsun.\n` +
      `3. Eğer ilk \`npm test\` çıktısında HER ŞEY zaten yeşilse ve bu iterasyon ` +
      `sadece refactor/dokümantasyon ise: tek bir smoke test ekle + final suite ` +
      `koş + dur. Faz tamamlanır.` +
      this.pendingMigrationNote +
      this.pendingFixNote;

    this.base = createCodegenBackend({
      tag: "phase-8",
      phaseId: 8,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage: initialMessage,
      tools: TOOLS_CODEGEN as unknown as ToolDef[],
      allowed_tool_names: this.spec.allowed_tools,
      toolContext: toolCtx,
      betas: this.config.claude_code_flags.betas,
      observer: (ctx) => this.observeTool(ctx),
      // CLI: ajanın MYCL_TEST_RESULT marker'ı → tdd-green/red audit (per-AC).
      onTestResult: this.cliMode
        ? (green, detail) => {
            // Sırayı koru: yazımı izle, anchor'dan önce settle edilecek.
            this.testResultWrites.push(this.recordTestResult(green, detail));
          }
        : undefined,
    });

    const outcome = await this.base.run();
    if (outcome.kind === "aborted") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "phase-8-aborted",
        caller: "user",
      });
      log.info("phase-8", "aborted", { turns: outcome.turns });
      this.lastFailReason = `aborted at turn ${outcome.turns}`;
      return "fail";
    }
    if (outcome.kind === "failed") {
      log.warn("phase-8", "codegen failed", { reason: outcome.reason });
      this.lastFailReason = outcome.reason;
      return "fail";
    }

    // v15.8 BÜTÜNLÜK ÇAPASI (CLI): ajanın self-report'una körü körüne güvenme —
    // ajanın koştuğu son test komutunu MyCL KENDİ koşar (deterministik exit code).
    // Otoriter SON tdd event'i bu olur → yanlış-green gate'i geçemez (sessiz teknik
    // borç önlenir). API yolunda observer'ın gerçek is_error'u zaten var → anchor yok.
    await this.runIntegrityAnchor();

    // Gate evaluation (v15.2.4 "ASLA TEKNİK BORÇ BIRAKMA" enforcement):
    //   1. AC sayısı kadar tdd-green (spec'in her AC'si yeşil olmalı)
    //   2. Son event tdd-green
    //   3. Tech debt sıfır — her tdd-tech-debt-detected sonrası aynı path
    //      için tdd-tech-debt-clean event'i gelmiş olmalı (temizlendi)
    //   4. Final full-suite run — son N event içinde test komutu
    //
    // v15.7 (2026-05-25): readAuditLogTail(1500) — Phase 8 event'leri ardışık
    // birikiyor (per-AC test-write/green/red + tech-debt scan). 1500 tail
    // tipik 30-50 AC için yeterli marj (her AC ~10-20 audit event).
    const audit = await readAuditLogTail(this.state.project_root, 1500);
    // v15.7 (2026-05-25): Iteration-scoped gate. Sadece BU iterasyonun
    // event'lerini say — eski iterasyonlardan kalan tdd-green'ler bu run'a
    // sayılmaz. Kullanıcı: "sadece o iterasyondaki iş için yapılacak test".
    // iteration-N-start event'i sınır olarak kullanılır; iter=1'de event yok
    // → tüm audit (eski davranış).
    const iterStart =
      iterCount > 1
        ? audit.find((e) => e.event === `iteration-${iterCount}-start`)
        : undefined;
    const iterStartTs = iterStart?.ts ?? 0;
    // v15.7 (2026-05-25): BUG FIX — observer phase=8 yazıyor (observeTool L371)
    // ama eski filter phase===9 arıyordu (v15.3 numbering renumber kalıntısı).
    // 75 tdd-green event yazılmasına rağmen gate "0 green" görüyordu.
    const p9All = audit.filter((e) => e.phase === 8);
    const p9 = p9All.filter((e) => e.ts >= iterStartTs);
    const greens = p9.filter((e) => e.event === "tdd-green").length;
    const reds = p9.filter((e) => e.event === "tdd-red").length;
    const lastEvent = p9.length > 0 ? p9[p9.length - 1].event : null;

    // Tech debt counting: her dosya için en son scan event'i kazanır.
    // (tdd-tech-debt-detected veya tdd-tech-debt-clean per path).
    const lastDebtByPath = new Map<string, "detected" | "clean">();
    for (const e of p9) {
      if (e.event === "tdd-tech-debt-detected" && e.detail) {
        // detail format: "<path>:<line> <category> — <reason>"
        const path = e.detail.split(":")[0];
        lastDebtByPath.set(path, "detected");
      } else if (e.event === "tdd-tech-debt-clean" && e.detail) {
        lastDebtByPath.set(e.detail, "clean");
      }
    }
    // QC v15.2.4 #3 fix: Bash `rm` ile silinen dosyalar audit'te "detected"
    // kalır → gate yanlış fail. fs.access ile dosya varlığını doğrula;
    // yoksa lastDebtByPath'ten temizle (silinmiş = teknik borç değil).
    const techDebtPathsRaw = [...lastDebtByPath.entries()]
      .filter(([, v]) => v === "detected")
      .map(([k]) => k);
    const techDebtPaths: string[] = [];
    for (const p of techDebtPathsRaw) {
      try {
        await stat(p);
        techDebtPaths.push(p); // dosya hâlâ var → tech debt
      } catch {
        // dosya yok (silinmiş) — tech debt sayma
        log.info("phase-8", "deleted file skipped from tech debt", { path: p });
      }
    }
    const techDebtCount = techDebtPaths.length;

    // AC sayısı — spec.md'den çıkar (v15.7: cache'li).
    const acCount = await this.getAcCount();
    // v15.7 (2026-05-25): Integration-first TDD — her AC için ayrı test
    // ZORUNLU değil. Gate `min_greens = max(3, ceil(acCount/5))` — 30 AC için
    // 6 grup test yeterli (uçtan uca senaryolar). Kullanıcı talebi: "TDD
    // sürecinde gereksiz testler yazmasın, bütünsel testler yapsın".
    // AC sayısı bilinmiyorsa 1'e fallback.
    const minGreens =
      acCount > 0 ? Math.max(3, Math.ceil(acCount / 5)) : 1;

    // Final full-suite: son 10 event içinde en az 1 tdd-green olmalı
    // (Bash test komutu + Claude'un final run'ı). Daha sıkı versiyon
    // pipeline-aware Bash event ekleyebilir; v15.2.4 minimal.
    const last10 = p9.slice(-10);
    const finalSuiteRun = last10.some((e) => e.event === "tdd-green");

    log.info("phase-8", "gate evaluate", {
      audit_count: p9.length,
      greens,
      reds,
      last_event: lastEvent,
      tech_debt_count: techDebtCount,
      ac_count: acCount,
      min_greens: minGreens,
      final_suite_run: finalSuiteRun,
    });

    const tddOk = greens >= minGreens && lastEvent === "tdd-green";
    const debtOk = techDebtCount === 0;
    if (tddOk && debtOk && finalSuiteRun) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "phase-8-complete",
        caller: "mycl-orchestrator",
      });
      // Score: AC coverage × 100 − tech debt penalty (5 puan/bulgu). Min 0.
      const acCoverage = greens / Math.max(1, minGreens);
      const baseScore = Math.min(100, Math.round(acCoverage * 100));
      const score = Math.max(0, baseScore - techDebtCount * 5);
      this.statePatch = { tdd_compliance_score: score };
      return "complete";
    }
    // Fail nedenini kullanıcıya görünür yap
    const reasons: string[] = [];
    if (!tddOk)
      reasons.push(`AC coverage yetersiz: ${greens}/${minGreens} green`);
    if (!debtOk)
      reasons.push(
        `${techDebtCount} dosyada tech debt: ${techDebtPaths.slice(0, 3).join(", ")}${
          techDebtPaths.length > 3 ? "..." : ""
        }`,
      );
    if (!finalSuiteRun) reasons.push("final test suite çalıştırılmadı");
    emitChatMessage(
      "system",
      `❌ Faz 8 gate fail: ${reasons.join("; ")}. MyCL_Pseudocode.md:203 — "ASLA TEKNİK BORÇ BIRAKMA".`,
    );
    this.lastFailReason = `gate fail: ${reasons.join("; ")}`;
    return "fail";
  }

  /**
   * CLI: ajanın MYCL_TEST_RESULT marker'ından gelen test sonucunu tdd-green/red
   * audit'ine yaz (gate'in per-AC green sayımı için). caller=mycl-bridge.
   */
  private async recordTestResult(green: boolean, detail: string): Promise<void> {
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 8,
      event: green ? "tdd-green" : "tdd-red",
      caller: "mycl-bridge",
      detail: detail.slice(0, 100),
    });
    log.info("phase-8", "cli test self-report", { green, detail: detail.slice(0, 60) });
  }

  /**
   * CLI bütünlük çapası: ajanın koştuğu son test komutunu MyCL deterministik koşar
   * (gerçek exit code) → otoriter SON tdd event. Geçerse tdd-green, başarısızsa
   * tdd-red → gate'in `lastEvent === "tdd-green"` koşulu yanlış-green'i eler.
   * Hiç test koşulmadıysa (lastTestCmd yok) çapa yok — gate zaten greens<minGreens ile fail eder.
   */
  private async runIntegrityAnchor(): Promise<void> {
    if (!this.cliMode) return;
    // Tüm marker self-report yazımları bitsin (anchor SON event olmalı → lastEvent doğru).
    await Promise.allSettled(this.testResultWrites);
    if (!this.lastTestCmd) return; // hiç test koşulmadı → gate greens<minGreens ile fail eder
    const cmd = this.lastTestCmd;
    emitChatMessage("system", `🔬 Faz 8 final doğrulama — MyCL testi kendi koşuyor: \`${cmd.slice(0, 80)}\``);
    let pass: boolean;
    let detail: string;
    try {
      await execAsync(cmd, {
        cwd: this.state.project_root,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      });
      pass = true;
      detail = "final suite (MyCL anchor): pass";
    } catch (err) {
      pass = false;
      const msg = err instanceof Error ? err.message : String(err);
      detail = `final suite (MyCL anchor): FAIL — ${msg.slice(0, 80)}`;
    }
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 8,
      event: pass ? "tdd-green" : "tdd-red",
      caller: "mycl-orchestrator",
      detail,
    });
    emitChatMessage(
      "system",
      pass
        ? "✅ Faz 8 final test (MyCL doğrulaması): GEÇTİ."
        : "🔴 Faz 8 final test (MyCL doğrulaması): BAŞARISIZ — gate fail (sessiz teknik borç önlendi).",
    );
  }

  private async observeTool(ctx: {
    tool_use: { name: string; input: Record<string, unknown> };
    result: { is_error: boolean };
  }): Promise<void> {
    const { name, input } = ctx.tool_use;
    const is_error = ctx.result.is_error;
    const audits: Array<{ event: string; detail?: string }> = [];
    if (name === "Write") {
      const path = String(input.file_path ?? input.path ?? "");
      if (!is_error) {
        if (isTestPath(path)) audits.push({ event: "tdd-test-write", detail: path });
        else if (isProdPath(path)) {
          audits.push({ event: "tdd-prod-write", detail: path });
          // MyCL_Pseudocode.md:203 "ASLA TEKNİK BORÇ BIRAKMA" — production
          // path'lerinde tech debt taraması. Bulguları audit'e yansıt; gate
          // tech_debt_count !== 0 ise faili döndürür.
          const content = String(input.content ?? "");
          await this.scanAndAuditTechDebt(path, content);
        }
      }
    } else if (name === "Edit" || name === "MultiEdit") {
      if (!is_error) {
        const path = String(input.file_path ?? input.path ?? "");
        audits.push({ event: "code-edit", detail: path });
        // Edit sonrası dosya içeriği input'ta yok (sadece replacement).
        // Disk'ten oku → tara. Test path'leri skip.
        if (isProdPath(path)) {
          try {
            const content = await readFile(path, "utf-8");
            await this.scanAndAuditTechDebt(path, content);
          } catch (err) {
            log.warn("phase-8", "edit tech-debt scan read failed", { path, err });
          }
        }
      }
    } else if (name === "Bash") {
      const cmd = String(input.command ?? "");
      if (isTestCommand(cmd)) {
        if (this.cliMode) {
          // CLI: is_error güvenilmez (stream-json hep false). tdd-green/red
          // MYCL_TEST_RESULT marker'ından (recordTestResult) gelir; burada sadece
          // komutu sakla — MyCL anchor'da bu komutu KENDİ koşar (otoriter final).
          this.lastTestCmd = cmd;
        } else {
          audits.push({
            event: is_error ? "tdd-red" : "tdd-green",
            detail: cmd.slice(0, 100),
          });
        }
      }
    }
    for (const a of audits) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: a.event,
        caller: "mycl-orchestrator",
        detail: a.detail,
      });
      log.info("audit-observer", "phase-8 audit", a);
    }
  }

  /**
   * Production dosyasını tarar; tech debt bulgularını her bulgu için tek bir
   * `tdd-tech-debt-detected` audit event olarak kaydeder. Phase 8 gate
   * evaluation bu sayıyı kontrol eder; sıfır olmazsa faili döndürür.
   *
   * Edit ile borç temizlenirse: önceki audit event'leri silinmez (immutable
   * log) ama gate son state'e bakar → temizlenen dosya artık yeni event
   * üretmez. Toplam count yeniden hesaplanır: gate'te
   * `readAuditLog`'tan tdd-tech-debt-detected sayar VE dosya bazlı dedupe
   * yapar (aynı path için son `tdd-prod-write` veya `code-edit` sonrası).
   *
   * v15.2.4: basitlik için sayar, dedupe yapmaz; kullanıcı temizlerse REFACTOR
   * adımında Edit + dosyayı yeniden tarar → temiz scan = yeni "tech-debt-clean"
   * event (Phase 8 ileri sürümünde marker; v15.2.4 minimal).
   */
  private async scanAndAuditTechDebt(path: string, content: string): Promise<void> {
    const findings: TechDebtFinding[] = scanTechDebt(content);
    if (findings.length === 0) {
      // Clean snapshot — gate evaluation dosya bazlı son scan'ı temiz sayar.
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "tdd-tech-debt-clean",
        caller: "mycl-orchestrator",
        detail: path,
      });
      return;
    }
    for (const f of findings) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "tdd-tech-debt-detected",
        caller: "mycl-orchestrator",
        detail: `${path}:${f.line} ${f.category} — ${f.reason}`,
      });
    }
    emitChatMessage(
      "system",
      `⚠️ Phase 8 tech-debt: ${path} — ${findings.length} bulgu ` +
        `(${findings.map((f) => f.category).join(", ")}). ` +
        `MyCL_Pseudocode.md:203 "ASLA TEKNİK BORÇ BIRAKMA" — REFACTOR ile temizle.`,
    );
    log.warn("phase-8", "tech debt detected", {
      path,
      count: findings.length,
      categories: findings.map((f) => f.category),
    });
  }
}
