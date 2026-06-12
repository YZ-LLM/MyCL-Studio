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
import { appendAudit, appendHandoff, readAuditLogTail } from "./audit.js";
import { isMissingCommand, resolveMechanicalCmd } from "./base/mechanical-runner.js";
import { probeTestValidity } from "./test-validity.js";
import { createCodegenBackend, type CodegenBackend } from "./codegen/backend.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { createCheckpoint, getChangedFiles, restoreCheckpoint } from "./git.js";
import { safeEnv } from "./safe-env.js";

const execAsync = promisify(exec);
import { emitChatMessage, emitError } from "./ipc.js";
import { snapshotBeforeAutofix, disarmRollback } from "./fix-snapshot.js";
import { escalatedModelEffort } from "./escalation.js";
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

/**
 * Keystone ① (kod-analiz 2026-06-07, Cichra+Missions birleşimi): spec.md'den AC ID listesi.
 * SAF — `- **AC3**: ...` satırlarından AC-id'leri çıkarır (countAcceptanceCriteria ile aynı desen, id yakalar).
 */
export function parseAcIds(acSection: string): string[] {
  const re = /^\s*-\s+\*\*(AC\d+)\*\*:/gm;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(acSection)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Keystone ① — AC→test izlenebilirliği (çalıştırılabilir doğrulama-sözleşmesi). SAF.
 * green-event detail'lerinden AC-id'leri (regex \bAC\d+\b) çıkar; hangi AC kapsandı/kapsanmadı?
 * `tagged=false` → hiçbir green AC-id taşımıyor (worker etiketlemiyor / SDK modu) → caller SESSİZ kalmalı
 * (regresyon/gürültü yok). Etiketleme aktifse kapsanmayan AC'ler görünür kılınır (enforcement DEĞİL, rapor).
 */
export function acCoverage(
  acIds: string[],
  greenDetails: string[],
): { tagged: boolean; covered: string[]; uncovered: string[] } {
  const found = new Set<string>();
  for (const d of greenDetails) {
    const matches = (d ?? "").match(/\bAC\d+\b/g);
    if (matches) for (const id of matches) found.add(id);
  }
  return {
    tagged: found.size > 0,
    covered: acIds.filter((id) => found.has(id)),
    uncovered: acIds.filter((id) => !found.has(id)),
  };
}

/**
 * Fix modu repro-first kontrolü: olay akışında bir `tdd-red` (repro testi
 * başarısız = bug üretildi) ardından DAHA SONRA bir `tdd-green` var mı? Bu sıra
 * "önce bug'ı kırmızıyla üret, sonra yeşil yap" disiplinini objektifleştirir.
 * Sadece yeşil (repro yok) → false → gate fix modunda reddeder. Export — testlenebilir.
 */
export function hasReproRedThenGreen(events: Array<{ event: string }>): boolean {
  let sawRed = false;
  for (const e of events) {
    if (e.event === "tdd-red") sawRed = true;
    else if (e.event === "tdd-green" && sawRed) return true;
  }
  return false;
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

// v15.10: repro-gate kapsamı için "kozmetik" dosya (stil/markup/doküman/görsel)
// ayrımı — yalnız bunlar değiştiyse mantık değişikliği yok → repro-gate muaf.
// Diğer her şey (kod, config) mantık sayılır (güvenli taraf). Regex yerine uzantı
// kümesi (minimal).
const COSMETIC_EXTS = new Set([
  ".css", ".scss", ".sass", ".less", ".html", ".htm",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".md", ".markdown", ".txt",
]);
export function isCosmeticFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && COSMETIC_EXTS.has(path.slice(dot).toLowerCase());
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
  /** Fix modu (pending_backend_fix) — repro-first gate + checkpoint/rollback. */
  private isFixMode = false;
  /** Fix öncesi git checkpoint ref'i (rollback hedefi). null → rollback yok. */
  private checkpointRef: string | null = null;

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

    // v15.7/v15.10: Fix mode (Phase 0 D2 routing'den). Backend fix →
    // pending_backend_fix; UI/frontend fix → fix_checkpoint_ref set (D2'de
    // checkpoint alındı, pending_ui_tweak Faz 5'te tüketildi). İKİSİ de fix-
    // güvenlik katmanını (checkpoint/rollback + scoped-gate + repro-gate) açar.
    const isBackendFix = Boolean(this.state.pending_backend_fix);
    const isUiFix = !isBackendFix && Boolean(this.state.fix_checkpoint_ref);
    let fixModeNote = "";
    if (isBackendFix) {
      this.isFixMode = true;
      fixModeNote =
        `\n\n**BUG FIX MODE — Phase 0 D2 yönlendirmesi**:\n${this.state.pending_backend_fix}\n\n` +
        `Bu bir geniş yeni-özellik talebi DEĞİL; mevcut backend'de targeted fix.\n` +
        `ZORUNLU repro-first sıra:\n` +
        `1. ÖNCE bug'ı yeniden üreten bir test yaz ve koş → testin KIRMIZI (fail) olduğunu ` +
        `DOĞRULA (bug hâlâ üretilebiliyor). Repro yazmadan patch yapma.\n` +
        `2. SONRA minimal patch uygula (plan'daki dosyalara DAR scope).\n` +
        `3. Aynı testi tekrar koş → YEŞİL; ardından FULL suite yeşil.\n` +
        `Gate kırmızı-önce-yeşil sırası arar — repro testi yoksa fix REDDEDİLİR. Eski testleri kırma.`;
      this.statePatch = {
        ...this.statePatch,
        pending_backend_fix: undefined, // tek seferlik tüketim
      };
      log.info("phase-8", "backend fix mode active (repro-first + checkpoint)");
    } else if (isUiFix) {
      this.isFixMode = true;
      fixModeNote =
        `\n\n**FIX MODE (UI/frontend) — Phase 0 yönlendirmesi**:\n` +
        `Bu targeted bir fix; mevcut davranışı bozma, kapsamı dar tut.\n` +
        `MANTIK değiştiriyorsan (yalnız stil/markup değil) repro-first uygula: ÖNCE bug'ı ` +
        `üreten test (KIRMIZI), SONRA minimal patch → YEŞİL; ardından FULL suite yeşil.\n` +
        `Mantık dosyası değiştiyse gate kırmızı-önce-yeşil sırası arar; eski testleri kırma.`;
      log.info("phase-8", "ui fix mode active (repro-first if logic + checkpoint)");
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

  /** Keystone ①: AC ID listesi (AC→test kapsam raporu için; cache'li). */
  private acIdsCache: string[] | null = null;
  private async getAcIds(): Promise<string[]> {
    if (this.acIdsCache !== null) return this.acIdsCache;
    try {
      const specMd = await readFile(
        join(this.state.project_root, ".mycl", "spec.md"),
        "utf-8",
      );
      this.acIdsCache = parseAcIds(specMd);
    } catch {
      this.acIdsCache = [];
    }
    return this.acIdsCache;
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
        "- Testler GEÇTİYSE (exit 0, PASS): `MYCL_TEST_RESULT: green: <kapsanan AC-id'ler; örn. AC3 veya AC3,AC4>`\n" +
        "  (AC→test izlenebilirliği: hangi kabul kriterini doğruladığını yaz; bütünsel test birden çok AC kapsıyorsa virgülle.)\n" +
        "- Testler BAŞARISIZSA: `MYCL_TEST_RESULT: red: <kısa neden>`\n" +
        "Test çıktısında PASS görmeden ASLA green deme. MyCL son testi KENDİ de koşup " +
        "doğrular — yanlış green gate'i geçirmez, sadece teknik borç gizler.";
    }

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

    // Ümit 2026-06-10: "silme kararı → önce yedek." TDD codegen ajanı dosya silebilir/üstüne yazabilir. Fix modu
    // zaten debug-fix yolunda snapshot'landı; normal TDD'de burada snapshot al → silinen geri alınabilir.
    if (!this.isFixMode) await snapshotBeforeAutofix(this.state.project_root, Date.now());
    // Escalation (Ümit 2026-06-11): model+efor PER-DOMAIN merdivenden — bu domain'in (tdd-codegen) öğrenilmiş
    // basamağından başlar, sorun çıktıkça failPhase tırmandırır (monotonik). Config kral: tier→model config'ten.
    const me = escalatedModelEffort(this.state, this.config, "tdd-codegen");
    emitChatMessage("system", `🧠 Codegen: **${me.modelLabel}** · efor ${me.effort} (merdiven)`);
    this.base = createCodegenBackend({
      tag: "phase-8",
      phaseId: 8,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: me.modelId,
      effortOverride: me.effort,
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

    // v15.9 Fix modu: kod değişikliği ÖNCESİ git checkpoint (regresyon/başarısız
    // fix'te otomatik geri alma hedefi). SADECE temiz working-tree'de etkin;
    // kirliyse görünür uyarı + rollback devre dışı (kullanıcı WIP'i riske girmez).
    if (this.isFixMode) {
      if (this.state.fix_checkpoint_ref) {
        // v15.10: D2 routing'de (ilk kod değişiminden ÖNCE) alındı — onu kullan.
        // ui fix'lerde ilk değişim Faz 5'te olduğu için checkpoint orada erken
        // alınmış olmalı; burada yeniden almak fix sonrası state'i yakalardı.
        this.checkpointRef = this.state.fix_checkpoint_ref;
      } else {
        // Fallback (eski state / doğrudan Faz 8 fix): burada al.
        const cp = await createCheckpoint(this.state.project_root);
        if (cp.ok && cp.ref) {
          this.checkpointRef = cp.ref;
          emitChatMessage(
            "system",
            "📌 Fix öncesi checkpoint alındı — regresyon olursa değişiklikler otomatik geri alınacak.",
          );
        } else {
          this.checkpointRef = null;
          emitChatMessage(
            "system",
            `⚠️ Otomatik geri alma kapalı: ${cp.reason}. Regresyon yine raporlanır, ama geri almayı elle yaparsın.`,
          );
        }
      }
    }

    const outcome = await this.base.run();
    if (outcome.kind === "aborted") {
      await this.rollbackFixIfNeeded();
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
      await this.rollbackFixIfNeeded();
      return "fail";
    }

    // v15.9 BÜTÜNLÜK ÇAPASI (HER İKİ MOD): ajanın testine körü körüne güvenme —
    // MyCL profilden gelen DETERMİNİSTİK TAM-SUITE'i KENDİ koşar (gerçek exit code).
    // Otoriter SON tdd event'i bu olur → yanlış-green gate'i geçemez + regresyon
    // (yeni iş eskiyi kırdı) yakalanır. Hem Fix hem Development iterasyonunda geçerli.
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
    // KÖK FİX (kod-analiz 2026-06-07): önce state.iteration_started_at (güvenilir, resume de bunu
    // birincil kullanıyor); sadece o yoksa audit-tail marker'ına düş. Eskiden uzun iterasyonda
    // (30-50 AC) marker 1500-tail penceresinden taşarsa iterStartTs=0 olup ESKİ iterasyonun
    // tdd-green'leri sayılıyor → gate YANLIŞ "geçti" veriyordu (false-pass).
    const iterStart =
      iterCount > 1
        ? audit.find((e) => e.event === `iteration-${iterCount}-start`)
        : undefined;
    const iterStartTs =
      iterCount > 1
        ? (this.state.iteration_started_at ?? iterStart?.ts ?? 0)
        : 0;
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

    // Keystone ① + enforcement — AC→test izlenebilirliği (Cichra+Missions: çalıştırılabilir doğrulama-
    // sözleşmesi; Michal "ölçemiyorsan zorlayamazsın"). Worker testleri AC-id ile etiketliyorsa
    // (acCov.tagged) VE kapsanmayan AC varsa → gate GEÇMEZ (aşağıda acCoverageOk). Worker hiç etiketlemiyorsa
    // (SDK modu / eski akış) → tagged=false → enforcement GRACEFUL kapalı (eski davranış, regresyon yok).
    let acCov: { tagged: boolean; covered: string[]; uncovered: string[] } = {
      tagged: false,
      covered: [],
      uncovered: [],
    };
    try {
      acCov = acCoverage(
        await this.getAcIds(),
        p9.filter((e) => e.event === "tdd-green").map((e) => e.detail ?? ""),
      );
    } catch (e) {
      log.warn("phase-8", "AC coverage hesaplanamadı (non-blocking)", e);
    }
    const acCoverageOk = !acCov.tagged || acCov.uncovered.length === 0;

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
    // Fix modu: repro-first ZORUNLU — kırmızı (repro) önce, sonra yeşil sırası
    // (Ümit prensip 1: repro yazmadan dokundurma). v15.10: yalnız MANTIK
    // değişikliklerinde zorunlu — backend fix her zaman; UI fix'te değişen
    // dosyalarda stil/markup dışı kod varsa. Salt-kozmetik tweak → muaf (repro
    // testi anlamsız). Fix dışı: muaf.
    let reproRequired = this.isFixMode && Boolean(this.state.pending_backend_fix);
    if (this.isFixMode && !reproRequired && this.checkpointRef) {
      try {
        const changed = await getChangedFiles(this.state.project_root, this.checkpointRef);
        reproRequired = changed.some((f) => !isCosmeticFile(f));
      } catch {
        reproRequired = true; // belirsizse güvenli taraf: repro iste
      }
    }
    const reproOk = !reproRequired || hasReproRedThenGreen(p9);
    if (tddOk && debtOk && finalSuiteRun && reproOk && acCoverageOk) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "phase-8-complete",
        caller: "mycl-orchestrator",
      });
      // Score: AC coverage × 100 − tech debt penalty (5 puan/bulgu). Min 0.
      const acCovRatio = greens / Math.max(1, minGreens);
      const baseScore = Math.min(100, Math.round(acCovRatio * 100));
      const score = Math.max(0, baseScore - techDebtCount * 5);
      // v15.9: önceki patch'i koru (pending_backend_fix:undefined kaybolmasın) +
      // fix checkpoint ref'ini köprüle (advanceToNextPhase scoped kapsamı bu
      // commit'ten itibaren hesaplar = tam fix diff'i). Checkpoint yoksa undefined.
      this.statePatch = {
        ...this.statePatch,
        tdd_compliance_score: score,
        fix_checkpoint_ref: this.checkpointRef ?? undefined,
      };
      // ③ Structured handoff (Missions): faz devir kaydı (ayrı .mycl/handoffs.jsonl; non-blocking).
      try {
        await appendHandoff(this.state.project_root, {
          ts: Date.now(),
          phase: 8,
          iteration: this.state.iteration_count ?? 1,
          status: "complete",
          summary: `green=${greens} red=${reds} tech_debt=${techDebtCount} score=${score}`,
        });
      } catch (e) {
        log.warn("phase-8", "handoff write failed (non-blocking)", e);
      }
      disarmRollback(); // faz başarıyla bitti → iyi işi kilitle (geri-alınmasın)
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
    if (!reproOk) reasons.push("repro-first ihlali: bug'ı yeniden üreten failing test (kırmızı→yeşil) yok");
    if (!acCoverageOk)
      reasons.push(
        `testsiz kabul kriterleri (AC→test): ${acCov.uncovered.join(", ")} — ilgili testi yaz veya bütünsel testi AC ile etiketle (MYCL_TEST_RESULT: green: ACx)`,
      );
    emitChatMessage(
      "system",
      `❌ Faz 8 gate fail: ${reasons.join("; ")}. MyCL_Pseudocode.md:203 — "ASLA TEKNİK BORÇ BIRAKMA".`,
    );
    this.lastFailReason = `gate fail: ${reasons.join("; ")}`;
    await this.rollbackFixIfNeeded();
    // ③ Structured handoff (Missions): başarısız devir — durum + neden + keşfedilen (takip zemini).
    try {
      await appendHandoff(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        iteration: this.state.iteration_count ?? 1,
        status: "fail",
        summary: reasons.join("; ").slice(0, 300),
        discovered:
          acCov.uncovered.length > 0
            ? [`testsiz kabul kriterleri: ${acCov.uncovered.join(",")}`]
            : undefined,
      });
    } catch (e) {
      log.warn("phase-8", "handoff write failed (non-blocking)", e);
    }
    return "fail";
  }

  /**
   * Fix modunda + checkpoint alınmışsa, değişiklikleri checkpoint'e geri al
   * (regresyon/başarısız fix → pre-fix temiz duruma dön). .mycl + error_folder
   * korunur. Tek seferlik (ref temizlenir). Fix dışı / checkpoint yok → no-op.
   */
  private async rollbackFixIfNeeded(): Promise<void> {
    if (!this.isFixMode || !this.checkpointRef) return;
    const ref = this.checkpointRef;
    this.checkpointRef = null; // tek seferlik
    try {
      const ok = await restoreCheckpoint(this.state.project_root, ref);
      emitChatMessage(
        "system",
        ok
          ? "↩️ Başarısız/regresyonlu fix — değişiklikler checkpoint'e geri alındı (MyCL state ve hata kataloğu korundu)."
          : "⚠️ Otomatik geri alma kısmen başarısız — değişiklikleri elle gözden geçir.",
      );
    } catch (err) {
      log.warn("phase-8", "rollback failed", err);
      emitChatMessage("system", "⚠️ Otomatik geri alma başarısız — değişiklikleri elle gözden geçir.");
    }
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
   * Bütünlük çapası (HER İKİ MOD): MyCL, profilden gelen DETERMİNİSTİK TAM-SUITE
   * test komutunu (`profile_key:test` → ör. `npm test`, `pytest`, `cargo test`)
   * kendi koşar (gerçek exit code) → otoriter SON tdd event. Geçerse tdd-green,
   * başarısızsa tdd-red → gate'in `lastEvent === "tdd-green"` koşulu hem yanlış-
   * green'i hem REGRESYONU (yeni iş eskiyi kırdı) eler.
   *
   * Komut kaynağı: önce profil tam-suite; yoksa (CLI'da) ajanın son test komutu;
   * o da yoksa çapa atlanır. "Test script/runner yok" (isMissingCommand) gerçek
   * başarısızlık DEĞİL → çapa atlanır, yanlış-red yazılmaz (Stage 3b fix modunda
   * repro testini ayrıca zorunlu kılar).
   */
  private async runIntegrityAnchor(): Promise<void> {
    // CLI modunda marker self-report yazımları bitsin (anchor SON event olmalı).
    if (this.cliMode) await Promise.allSettled(this.testResultWrites);

    // Deterministik tam-suite: profilden çöz; yoksa ajanın son komutuna düş.
    let cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, this.state);
    let source = "profil tam-suite";
    if (!cmd) {
      cmd = this.lastTestCmd;
      source = "ajanın son test komutu";
    }
    if (!cmd) {
      // Ümit 2026-06-11 (tehlike taraması): ne profil ne ajan test komutu → MyCL BAĞIMSIZ doğrulayamıyor.
      // SESSİZCE self-report'a GÜVENME (sahte-yeşil riski) → görünür uyar + `tdd-unverified` audit (Faz 9 düşman-gözü
      // bunu açık risk sayar; harness de görür). Güven modeli: doğrulanamayan "yeşil" yeşil sayılmaz.
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "tdd-unverified",
        caller: "mycl-orchestrator",
        detail: "no test command (profile+agent) — agent green self-report NOT independently verified",
      });
      emitChatMessage(
        "system",
        "⚠️ Faz 8: çalıştırılabilir test komutu yok (profil + ajan) — ajanın 'yeşil' raporu **bağımsız doğrulanMADI**. " +
          "Risk olarak işaretlendi (Faz 9 risk incelemesi bunu ele alır). Bir test script'i (örn. package.json `test`) gerekir.",
      );
      return;
    }

    emitChatMessage(
      "system",
      `🔬 Faz 8 final doğrulama (${source}) — MyCL kendi koşuyor: \`${cmd.slice(0, 80)}\``,
    );
    const res = await this.runCmdResult(cmd);

    // Test script/runner yok → regresyon değil (yanlış-red yazma) AMA bağımsız doğrulama da YAPILAMADI →
    // sessizce geçirme: self-report doğrulanmadı (Ümit tehlike-taraması) → `tdd-unverified` + görünür uyarı.
    if (isMissingCommand(res)) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 8,
        event: "tdd-unverified",
        caller: "mycl-orchestrator",
        detail: `test runner/script missing ('${cmd.slice(0, 40)}') — green NOT independently verified`,
      });
      emitChatMessage(
        "system",
        `⚠️ Faz 8 final doğrulama yapılamadı — '${cmd.slice(0, 40)}' test komutu/script'i bulunamadı; ajanın 'yeşil' ` +
          "raporu **bağımsız doğrulanMADI** (risk olarak işaretlendi, Faz 9 ele alır).",
      );
      return;
    }

    const pass = res.code === 0;
    const detail = pass
      ? `final suite (MyCL anchor, ${source}): pass`
      : `final suite (MyCL anchor, ${source}): FAIL — ${(res.stderr || res.stdout).slice(0, 120)}`;
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
        ? "✅ Faz 8 final tam-suite (MyCL doğrulaması): GEÇTİ."
        : "🔴 Faz 8 final tam-suite (MyCL doğrulaması): BAŞARISIZ — gate fail (regresyon / sessiz teknik borç önlendi).",
    );
    // Ümit 2026-06-12 (güveni kökten sağlamlaştır): testler YEŞİL — ama gerçekten koruyor mu? MUTASYON PROB'u:
    // değişen bir dosyayı küçük boz, test KIRMIZIYA dönmeli; dönmüyorsa testler sahte-yeşil. Görünür uyarı + audit.
    if (pass) await this.runMutationProbe(cmd);
  }

  /**
   * Mutasyon prob'u (sahte-yeşil panzehiri): değişen kaynağa davranışsal mutasyon → test KIRMIZI bekle → geri al.
   * Yakalayamazsa testler zayıf → `tdd-tests-weak` audit + görünür uyarı (Faz 9 düşman-gözü de ele alır). Hata-güvenli.
   */
  private async runMutationProbe(testCmd: string): Promise<void> {
    const changed = this.state.changed_scope?.files ?? [];
    if (changed.length === 0) return; // değişen dosya bilinmiyor → prob atla
    emitChatMessage("system", "🧬 Test-geçerliliği prob'u — kodu küçük bozup testlerin gerçekten yakaladığını doğruluyorum…");
    const r = await probeTestValidity({
      config: this.config,
      projectRoot: this.state.project_root,
      testCmd,
      candidateFiles: changed,
      runCmd: (c) => this.runCmdResult(c),
    });
    if (!r.checked) return; // prob koşamadı (aday yok/mutasyon üretilemedi) — sessiz, sahte-alarm verme
    if (r.caught) {
      emitChatMessage("system", `✅ Test-geçerliliği: testler bozulan davranışı yakaladı (${r.file}) — koruma gerçek.`);
      return;
    }
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 8,
      event: "tdd-tests-weak",
      caller: "mycl-orchestrator",
      detail: `mutation NOT caught in ${r.file} — tests may be shallow/false-green`,
    });
    emitChatMessage(
      "system",
      `⚠️ Test-geçerliliği UYARISI: \`${r.file}\` küçük bir davranış-bozumunda testler HÂLÂ geçti — testler o davranışı ` +
        "gerçekten sınamıyor olabilir (sahte-yeşil riski). Faz 9 risk incelemesi bunu ele alır.",
    );
  }

  /**
   * Komutu çalıştır, {code, stdout, stderr} döndür (mechanical-runner.execCmd
   * deseni). Güvenlik: env safeEnv() allowlist + LC_ALL=C (mekanik fazlarla aynı
   * disiplin). Hata → exit code (sayı değilse 1).
   */
  private async runCmdResult(
    cmd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.state.project_root,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...safeEnv(), LC_ALL: "C" },
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
