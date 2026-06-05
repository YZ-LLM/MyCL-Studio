// phase-5 — UI Build (codegen, backend denied).
//
// Spec'te UI varsa Claude UI dosyalarını yazar; backend paths denied. UI yoksa
// (spec heuristic) orchestrator bu fazı atlatır.
//
// v15.7 (2026-05-27): Dosya header rot düzeltildi — eski sürüm "phase-6"
// yazıyordu (1-indexed pseudocode'tan kayma), şimdi 0-indexed pipeline ile
// hizalı: Phase5Controller → Phase 5 = UI Build.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { appendAudit, readAuditLog } from "./audit.js";
import { createCodegenBackend, type CodegenBackend } from "./codegen/backend.js";
import { runDesignFanout, negotiateConflicts } from "./design-fanout.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import {
  buildDevServerFailMessage,
  openBrowser,
  stopActiveDevServer,
  tryDevServerChain,
} from "./dev-server-launcher.js";
import {
  commandsFor,
  detectStack,
  expectedPortsFor,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { emitChatMessage, emitError } from "./ipc.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";
import { applyPrototype } from "./prototype-cache.js";
import { replaceActiveWatcher } from "./runtime-error-watcher.js";
import { ensureViteRuntimeInjection } from "./vite-runtime-injector.js";
import { log } from "./logger.js";
import { substitute } from "./template-engine.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { translate } from "./translator.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

export class Phase5Controller {
  public statePatch: Partial<State> = {};
  private base: CodegenBackend | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;

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
    log.info("phase-5", "run start");

    const specPath = join(this.state.project_root, ".mycl", "spec.md");
    try {
      await stat(specPath);
    } catch {
      emitError("phase-5 requires spec.md", { specPath });
      this.lastFailReason = "spec.md missing (Phase 4 incomplete)";
      return "fail";
    }

    // Prototip-cache (item 4): greenfield + stack biliniyor + bu stack için golden
    // prototip varsa, codegen BAŞLAMADAN baseline'ı projeye kopyala → ana ajan sıfırdan
    // değil doğrulanmış baseline üzerine geliştirir. Self-guard'lı + non-blocking.
    await applyPrototype(this.state);

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      // v15.7 (2026-05-25): Feature flag inject — Playwright kapalıysa
      // template "install ETME" diyecek (PLAYWRIGHT_ENABLED=false).
      const playwrightEnabled =
        this.config.features.playwright_enabled === false ? "false" : "true";
      systemPrompt = substitute(tmpl, {
        PROJECT_ROOT: this.state.project_root,
        PLAYWRIGHT_ENABLED: playwrightEnabled,
      });
    } catch (err) {
      log.error("phase-5", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }

    const role = this.spec.model_role!;
    const toolCtx: ToolContext = {
      project_root: this.state.project_root,
      // Backend yolları registry'deki spec.denied_paths'ten gelir — proje
      // tipine göre PhaseSpec'te ayarlanabilir.
      extra_denied_paths: this.spec.denied_paths,
    };

    // Tweak mode kontrolü: Phase 6 ui_tweak outcome'da set edilen
    // state.pending_ui_tweak okunur. Set ise initial message + audit event
    // ismi farklı; dev server zaten ayakta olduğu için spawn skip.
    const tweakDesc = this.state.pending_ui_tweak;
    const isTweakMode = !!tweakDesc;
    log.info("phase-5", "mode", { isTweakMode });

    // v15.7 (2026-05-26): Ana ajan saf İngilizce. Tweak description kullanıcıdan
    // gelir (TR olabilir) → translate. State'te orijinal TR korunur. Translate
    // fail → orijinal kullanılır (translator EN içerikse verbatim döner).
    let tweakDescEn = tweakDesc;
    if (isTweakMode && tweakDesc) {
      try {
        const tr = await translate(this.config, tweakDesc, "tr-to-en");
        tweakDescEn = tr.text;
      } catch (err) {
        log.warn("phase-5", "tweak desc translation failed", err);
      }
    }

    // v15.0 Batch C: stack-aware build/install komutları. state.stack profile'ı
    // okunup install + build çözülür. Profil yok veya komut tanımsızsa
    // npm fallback (backward-compat — adminpanel ve diğer Node projeleri).
    let installCmd = "npm install";
    let buildCmd = "npm run build";
    if (this.state.stack) {
      const profile = await loadProfile(this.state.stack);
      installCmd = resolveCommand(profile, "install") ?? installCmd;
      buildCmd = resolveCommand(profile, "build") ?? buildCmd;
    }

    // v15.13: Tasarım fan-out — çok-perspektifli tasarım paneli (architect/ux/security/data →
    // synthesizer → .mycl/design.md). YALNIZ CREATE (ilk iterasyon) + design_workflow flag açık +
    // tweak DEĞİL. Codegen design.md'yi okuyarak uygular. Başarısız/atlanırsa designInjection=""
    // → mevcut tek-ajan davranışı birebir korunur (regresyon yok). Open/Closed: createCodegenBackend
    // yolu DEĞİŞMEZ; yalnız ÖNCESİNE branch + normal initialUserMessage'a opsiyonel ek.
    let designInjection = "";
    const designFlag = this.config.claude_code_flags.design_workflow ?? "off";
    const isCreateIteration = (this.state.iteration_count ?? 1) <= 1;
    if (!isTweakMode && designFlag !== "off" && (designFlag === "always" || isCreateIteration)) {
      try {
        const specContent = await readFile(
          join(this.state.project_root, ".mycl", "spec.md"),
          "utf-8",
        );
        emitChatMessage(
          "system",
          "🎨 Tasarım paneli: architect/ux/security/data perspektifleri paralel çalışıyor → sentez…",
        );
        const design = await runDesignFanout(this.config, this.state.project_root, specContent);
        if (design.ok) {
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 5,
            event: "ui-design-synthesized",
            caller: "mycl-orchestrator",
            detail: `perspectives=${design.perspectivesUsed}/4 conflicts=${design.conflicts.length}`,
          });
          designInjection =
            "\n\nA multi-perspective design plan has been written to .mycl/design.md. Read that file FIRST and implement the UI according to it.";
          emitChatMessage(
            "system",
            `✅ Tasarım paneli tamam (${design.perspectivesUsed}/4 perspektif). \`.mycl/design.md\` yazıldı.`,
          );
          // Layer B: çatışma + opt-in → GERÇEK Agent Teams (abonelik) / cross-critique (API) müzakere.
          if (design.conflicts.length > 0 && (this.config.claude_code_flags.agent_teams_optin ?? false)) {
            emitChatMessage(
              "system",
              `🤝 ${design.conflicts.length} tasarım çatışması müzakereye gidiyor: ${design.conflicts.map((c) => c.topic).join("; ").slice(0, 140)}…`,
            );
            try {
              const nego = await negotiateConflicts(
                this.config,
                this.state.project_root,
                design.designMarkdown ?? "",
                design.conflicts,
              );
              if (nego.ok) {
                await appendAudit(this.state.project_root, {
                  ts: Date.now(),
                  phase: 5,
                  event: "ui-design-negotiated",
                  caller: "mycl-orchestrator",
                  detail: `mode=${nego.mode} conflicts=${design.conflicts.length}`,
                });
                emitChatMessage(
                  "system",
                  nego.mode === "team"
                    ? "✅ Çatışmalar GERÇEK Agent Teams peer-müzakeresiyle çözüldü; `.mycl/design.md` güncellendi."
                    : "✅ Çatışmalar cross-critique turuyla çözüldü (API modu); `.mycl/design.md` güncellendi.",
                );
              } else {
                emitChatMessage(
                  "system",
                  `ℹ️ Müzakere uygulanamadı (${nego.reason}) — sentezleyicinin provizyon kararı kullanılıyor.`,
                );
              }
            } catch (err) {
              log.warn("phase-5", "design negotiate error", err);
              emitChatMessage(
                "system",
                "ℹ️ Müzakere hata verdi — sentezleyicinin provizyon kararı kullanılıyor.",
              );
            }
          } else if (design.conflicts.length > 0) {
            emitChatMessage(
              "system",
              `ℹ️ ${design.conflicts.length} çelişki sentezleyicide provizyon karara bağlandı (gerçek müzakere için: Settings → agent_teams_optin).`,
            );
          }
        } else {
          emitChatMessage(
            "system",
            `⚠ Tasarım paneli atlandı (${design.reason}) — tek-ajan tasarımıyla devam.`,
          );
        }
      } catch (err) {
        log.warn("phase-5", "design fan-out error", err);
        emitChatMessage("system", "⚠ Tasarım paneli hata verdi — tek-ajan tasarımıyla devam.");
      }
    }

    const initialUserMessage = isTweakMode
      ? `UI tweak requested: ${tweakDescEn}\n\nApply only the requested change. Do NOT rewrite the whole UI. Backend paths are denied. Edit the minimal set of files; the dev server is already running (HMR will refresh the browser). Stop when \`${buildCmd}\` succeeds.`
      : `Begin Phase 5: build the UI. Backend paths are denied. Write UI files, run \`${installCmd}\` if needed, and run \`${buildCmd}\` to verify. Stop when build succeeds.${designInjection}`;

    this.base = createCodegenBackend({
      tag: "phase-5",
      phaseId: 5,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage,
      tools: TOOLS_CODEGEN as unknown as ToolDef[],
      allowed_tool_names: this.spec.allowed_tools,
      toolContext: toolCtx,
      betas: this.config.claude_code_flags.betas,
      observer: async (ctx) => {
        // Audit event ismi mode'a göre değişir:
        //   - normal mode + Write → "ui-file-write"
        //   - tweak mode + Write/Edit → "ui-tweak-applied"
        // Post-run check normal mode'da ui-file-write event sayar; tweak
        // mode'da ayrı check yapılır (statePatch'te pending_ui_tweak temizlenir).
        if (ctx.result.is_error) return;
        if (isTweakMode && (ctx.tool_use.name === "Edit" || ctx.tool_use.name === "Write")) {
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 5,
            event: "ui-tweak-applied",
            caller: "mycl-orchestrator",
            detail: String(ctx.tool_use.input.file_path ?? ""),
          });
        } else if (ctx.tool_use.name === "Write") {
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 5,
            event: "ui-file-write",
            caller: "mycl-orchestrator",
            detail: String(ctx.tool_use.input.file_path ?? ""),
          });
        }
      },
    });

    const outcome = await this.base.run();
    if (outcome.kind === "aborted") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-aborted",
        caller: "user",
      });
      log.info("phase-5", "aborted", { turns: outcome.turns });
      this.lastFailReason = `aborted at turn ${outcome.turns}`;
      return "fail";
    }
    if (outcome.kind === "failed") {
      log.warn("phase-5", "codegen failed", { reason: outcome.reason });
      this.lastFailReason = outcome.reason;
      // v15.7 (2026-05-27): Batch A2 — codegen fail durumunda kullanıcıya
      // ne yapacağını söyle. Dev server otomatik başlamaz; manuel start
      // veya pipeline re-run.
      emitChatMessage(
        "system",
        `⚠ Faz 5 (UI) kod üretemedi: ${outcome.reason}\n\nSeçenekler:\n` +
          `• Sidebar'dan Faz 5'e tıkla → "✅ Çalıştır" (tekrar dene)\n` +
          `• Spec'i revize et: composer'a "yeniden tasarla" yaz\n` +
          `• Manuel UI kodu yaz, sonra Faz 5'i atla (advance ile Faz 7'e geç)`,
      );
      // state.phase_5_degraded flag — UI gözleminde araç-belirleyici. Mevcut
      // state şemasında yok, ama statePatch ile geçici işaretlenebilir.
      // Burada minimal: audit event yaz, pipeline'ı durdurma kararı caller'a.
      try {
        await appendAudit(this.state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-degraded",
          caller: "mycl-orchestrator",
          detail: `reason="${outcome.reason.slice(0, 100)}"`,
        });
      } catch (e) {
        log.warn("phase-5", "degraded audit fail", e);
      }
      return "fail";
    }

    // Çıktı bazlı doğrulama — Claude'un belirli bir marker echo etmesine
    // güvenmek yerine **diskte gerçekte ne var** ile karar verilir.
    // Normal mode: en az 1 ui-file-write + package.json
    // Tweak mode: en az 1 ui-tweak-applied (Edit veya Write)
    const audit = await readAuditLog(this.state.project_root);
    if (isTweakMode) {
      const tweakWrites = audit.filter(
        (e) =>
          e.phase === 5 &&
          e.event === "ui-tweak-applied" &&
          (e.ts > (this.state.updated_at ?? 0)), // sadece bu turun event'leri
      );
      if (tweakWrites.length === 0) {
        emitError("phase-5 tweak: no ui-tweak-applied events — Claude yazmadı", null);
        this.lastFailReason = "tweak mode: no ui-tweak-applied events";
        return "fail";
      }
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-tweak-complete",
        caller: "mycl-orchestrator",
        detail: `tweak verified: ${tweakWrites.length} file(s) changed — "${tweakDesc.slice(0, 80)}"`,
      });
    } else {
      const uiWrites = audit.filter(
        (e) => e.phase === 5 && e.event === "ui-file-write",
      );
      if (uiWrites.length === 0) {
        emitError("phase-5: no ui-file-write events — Claude yazmadı", null);
        this.lastFailReason = "no ui-file-write events";
        return "fail";
      }
      try {
        await stat(join(this.state.project_root, "package.json"));
      } catch {
        emitError("phase-5: package.json not present after Claude run", null);
        this.lastFailReason = "package.json missing after codegen";
        return "fail";
      }

      // NOT: `phase-5-complete` audit'i dev server READY olduktan sonra yazılır
      // (aşağıda). Kullanıcı kuralı (feedback-faz-fail-propagation):
      // dev server fail → Faz 5 fail → Faz 6'ye geçilmez.
      // Bu sayede audit'te `phase-5-complete` yoksa resume akışı current_phase=5
      // kalır ve Faz 5 yeniden çalıştırılır.
    }

    // Tweak mode'da dev server zaten ayakta — HMR yansıtır; spawn skip
    // (yeni spawn pid çakışmasına neden olur). pending_ui_tweak statePatch'te
    // temizlenir → Phase 6 tekrar çağrıldığında state temiz.
    if (isTweakMode && this.state.dev_server_pid) {
      this.statePatch = { pending_ui_tweak: undefined };
      emitChatMessage(
        "system",
        "Tweak uygulandı. Dev server zaten ayakta — HMR ile browser otomatik yenilenir.",
      );
      log.info("phase-5", "tweak complete (dev server skipped)");
      return "complete";
    }

    // Boot-resume / Faz-6-deferred re-entry: Faz 5 yeniden çalışıyor ve state'te
    // eski bir dev_server_pid kalmış olabilir. Yeni spawn'dan ÖNCE eski process'i
    // temiz kapat — aksi halde orphan + port çakışması (tweak yolu yukarıda zaten
    // skip etti, buraya yalnız gerçek (re-)spawn gerektiğinde gelinir).
    if (this.state.dev_server_pid !== undefined) {
      stopActiveDevServer(this.state);
    }

    // Dev server'ı arka planda başlat + tarayıcıyı aç. Faz 6 (UI Review) bu
    // sayede kullanıcıya görünen UI üzerinde anlamlı sorular sorabilir.
    // spawn detached → orchestrator çıkışından bağımsız yaşar; kullanıcı
    // dev server'ı kendisi durdurmalı (Ctrl+C terminalde).
    //
    // Kullanıcı kuralı (feedback-faz-fail-propagation): dev server fail →
    // hard fail. Pipeline Phase 6'ye geçmez; kullanıcı `buildDevServerFail
    // Message` diagnostic'ini görür, manuel düzeltir, "devam et" yazar →
    // current_phase=6 kalır, Phase 5 yeniden başlar.
    //
    // Chain runner (2026-05-20): tek-app yerine aday komut listesi denenir.
    // todomaster gibi full-stack projelerde `npm run dev` backend başlatır →
    // chain ikinci aday (`npm run dev:frontend` veya `npx vite`) ile Vite'a
    // ulaşır. Backward compat: tek-aday durumunda davranış aynı.
    const DEV_SERVER_TIMEOUT_MS = 20_000;
    const stack = detectStack(this.state.project_root);
    const scripts = readNodeScripts(this.state.project_root);
    const cmds = commandsFor(stack, "run", scripts);
    if (cmds.length === 0) {
      emitChatMessage(
        "error",
        `❌ Faz 5: Dev server için komut türetilemedi (stack=${stack}). package.json scripts kontrol edin.`,
      );
      this.lastFailReason = `dev server command not derivable (stack=${stack})`;
      return "fail";
    }
    const candidates = cmds.map((cmd) => ({
      cmd,
      ports: expectedPortsFor(cmd, scripts, this.state.project_root),
    }));
    // Vite plugin inject — UI runtime hatalarını yakalama (idempotent).
    try {
      await ensureViteRuntimeInjection(this.state.project_root);
    } catch (err) {
      log.warn("phase-5", "vite injection failed (non-fatal)", err);
    }
    emitChatMessage(
      "system",
      `Dev server başlatılıyor — aday komut(lar): ${cmds.map((c) => `\`${c}\``).join(", ")}…`,
    );
    const chainResult = await tryDevServerChain(
      this.state.project_root,
      candidates,
      DEV_SERVER_TIMEOUT_MS,
    );
    if (!chainResult.ok || !chainResult.handle || !chainResult.cmd) {
      const lastAttempt =
        chainResult.attempts[chainResult.attempts.length - 1];
      const diagnostic = await buildDevServerFailMessage(
        this.state.project_root,
        lastAttempt?.reason === "process_died" ? -1 : 0,
        lastAttempt?.port ?? 5173,
        DEV_SERVER_TIMEOUT_MS,
      );
      const attemptsLog = chainResult.attempts
        .map((a) => `  • \`${a.cmd}\` (port=${a.port}, ${a.reason})`)
        .join("\n");
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-dev-server-fail",
        caller: "mycl-orchestrator",
        detail: `attempts=${chainResult.attempts.length} timeout=${DEV_SERVER_TIMEOUT_MS}ms`,
      });
      emitChatMessage(
        "error",
        `${diagnostic}\n\nDenenen komutlar (hepsi başarısız):\n${attemptsLog}`,
      );
      log.warn("phase-5", "dev server chain exhausted", {
        attempts: chainResult.attempts,
      });
      this.lastFailReason = `dev server chain exhausted (${chainResult.attempts.length} attempts)`;
      return "fail";
    }
    const handle = chainResult.handle;
    const usedCmd = chainResult.cmd;
    this.statePatch = { dev_server_pid: handle.pid };
    replaceActiveWatcher({
      pid: handle.pid,
      stdout: handle.stdout,
      stderr: handle.stderr,
      projectRoot: this.state.project_root,
      dbPath: `${this.state.project_root}/error_folder/errors.db`,
      config: this.config,
    });
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 5,
      event: "ui-dev-server-spawn",
      caller: "mycl-orchestrator",
      detail: `pid=${handle.pid} port=${handle.port} cmd=${usedCmd} prior_attempts=${chainResult.attempts.length}`,
    });
    if (chainResult.attempts.length > 0) {
      const priorList = chainResult.attempts
        .map((a) => `\`${a.cmd}\``)
        .join(", ");
      emitChatMessage(
        "system",
        `Dev server hazır: pid=${handle.pid}, port ${handle.port}, komut=\`${usedCmd}\`. (Daha önce denenip başarısız olanlar: ${priorList})`,
      );
    } else {
      emitChatMessage(
        "system",
        `Dev server hazır: pid=${handle.pid}, port ${handle.port}, komut=\`${usedCmd}\`.`,
      );
    }

    emitChatMessage(
      "system",
      `✅ Dev server hazır: http://localhost:${handle.port}. Tarayıcı açılıyor.`,
    );
    openBrowser(`http://localhost:${handle.port}`);

    // SUCCESS path — burada `phase-5-complete` audit yazılır. Audit'te yoksa
    // resume akışı Phase 5'i yeniden çalıştırır.
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 5,
      event: "phase-5-complete",
      caller: "mycl-orchestrator",
      detail: `output_verified + dev server ready on port ${handle.port}`,
    });
    log.info("phase-5", "complete");
    return "complete";
  }
}
