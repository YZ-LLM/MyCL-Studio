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
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { appendAudit, readAuditLog, readAuditLogTail } from "./audit.js";
import { currentSpecPath, currentSpecRelPath } from "./devs-paths.js";
import { createCodegenBackend, type CodegenBackend } from "./codegen/backend.js";
import { scanCspViolations, ensureCspMeta } from "./csp-compliance.js";
import { runVisualDesignAgent } from "./visual-design-agent.js";
import { runDesignFanout, negotiateConflicts } from "./design-fanout.js";
import { designPanelDecision, designSynthesizedInCurrentIteration } from "./design-panel-gate.js";
import { snapshotBeforeAutofix, disarmRollback } from "./fix-snapshot.js";
import { escalatedModelEffort } from "./escalation.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import {
  buildDevServerFailMessage,
  openBrowser,
  stopActiveDevServer,
  tryDevServerChain,
  waitForDevServer,
} from "./dev-server-launcher.js";
import {
  commandsFor,
  detectStack,
  expectedPortsFor,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { emitChatMessage, emitError, emitPhaseRunning } from "./ipc.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";
import { applyPrototype, surfacePrototypeModuleSearch } from "./prototype-cache.js";
import { replaceActiveWatcher } from "./runtime-error-watcher.js";
import { ensureViteRuntimeInjection, viteSourceEditAllowed } from "./vite-runtime-injector.js";
import { log } from "./logger.js";
import { substitute } from "./template-engine.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { translate } from "./translator.js";
import { safeEnv } from "./safe-env.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const execAsync = promisify(exec);

// LOGIN-İSTİSNASI yolları (YZLLM 2026-06-18, tavuk-yumurta): Faz 5 backend genelde denied; bu glob'lar
// phase-deny'ı EZER (tool-handlers extra_allowed_patterns) → MİNİMAL dev-login backend'i (auth endpoint +
// session + seed kullanıcı) yazılabilir, reviewer Faz 6'da giriş yapıp authenticated UI'yi görebilsin.
// Yalnız auth/login/session yolları; geri kalan backend Faz 8'de. Non-auth app'te eşleşen dosya yok → no-op.
// .mycl/.git default-deny'ını EZMEZ (tool-handlers'da ayrı kontrol).
const AUTH_EXCEPTION_PATTERNS = [
  "**/auth/**",
  "**/login/**",
  "**/logout/**",
  "**/session/**",
  "**/auth.*",
  "**/session.*",
];

export class Phase5Controller {
  public statePatch: Partial<State> = {};
  private base: CodegenBackend | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  /** false → escalation merdivenini TIRMANMA (model gücü çözmez); index.ts okur. */
  public lastFailEscalatable?: boolean;

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

    const specPath = currentSpecPath(this.state);
    try {
      await stat(specPath);
    } catch {
      emitError("Faz 5 spec.md gerektiriyor", { specPath });
      this.lastFailReason = "spec.md missing (Phase 4 incomplete)";
      return "fail";
    }

    // Prototip-cache (item 4): greenfield + stack biliniyor + bu stack için golden
    // prototip varsa, codegen BAŞLAMADAN baseline'ı projeye kopyala → ana ajan sıfırdan
    // değil doğrulanmış baseline üzerine geliştirir. Self-guard'lı + non-blocking.
    await applyPrototype(this.state);
    // Çapraz-prototip modül araması (YZLLM 2026-06-22): niyete uygun HAZIR modüller (login/ürünler
    // sayfası gibi) TÜM prototiplerde aranıp yüzeye çıkar → ajan sıfırdan yazmaz, yeniden kullanır.
    await surfacePrototypeModuleSearch(this.state);

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
        SPEC_PATH: currentSpecRelPath(this.state),
      });
    } catch (err) {
      log.error("phase-5", "template load failed", err);
      emitError("Şablon yüklenemedi", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }
    const escMe = escalatedModelEffort(this.state, this.config, "ui-codegen");
    const toolCtx: ToolContext = {
      project_root: this.state.project_root,
      // Backend yolları registry'deki spec.denied_paths'ten gelir — proje
      // tipine göre PhaseSpec'te ayarlanabilir.
      extra_denied_paths: this.spec.denied_paths,
      // LOGIN-İSTİSNASI (YZLLM 2026-06-18, tavuk-yumurta): backend genelde denied AMA review için
      // MİNİMAL dev-login'in (auth endpoint + session + seed kullanıcı) backend'i yazılabilsin →
      // reviewer Faz 6'da giriş yapıp authenticated UI'yi görebilsin. Yalnız auth/login/session
      // yolları; geri kalan backend Faz 8'de. Non-auth app'te eşleşen dosya yok → no-op.
      extra_allowed_patterns: AUTH_EXCEPTION_PATTERNS,
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
    // MyCL'in kendi senkron kurulumu başarısız olursa GERÇEK çıktısı buraya konur;
    // dev-server tanısına eklenir ki "next: command not found" değil ASIL kurulum hatası görünsün.
    let installFailOutput = "";

    // v15.13: Tasarım fan-out — çok-perspektifli tasarım paneli (architect/ux/security/data →
    // synthesizer → .mycl/design.md). YALNIZ CREATE (ilk iterasyon) + design_workflow flag açık +
    // tweak DEĞİL. Codegen design.md'yi okuyarak uygular. Başarısız/atlanırsa designInjection=""
    // → mevcut tek-ajan davranışı birebir korunur (regresyon yok). Open/Closed: createCodegenBackend
    // yolu DEĞİŞMEZ; yalnız ÖNCESİNE branch + normal initialUserMessage'a opsiyonel ek.
    let designInjection = "";
    const designFlag = this.config.claude_code_flags.design_workflow ?? "off";
    const isCreateIteration = (this.state.iteration_count ?? 1) <= 1;
    // v15.13 spec gate: kararı saf designPanelDecision'a devret (tek-doğruluk-kaynağı, izole test).
    // "simple" → panel atlanır (tek-ajan tasarım); undefined/moderate/complex → panel KOŞAR
    // (regresyon-güvenli). designInjection="" → mevcut tek-ajan codegen yolu birebir korunur.
    const panelDecision = designPanelDecision({
      designFlag,
      isTweakMode,
      isCreateIteration,
      uiComplexity: this.state.ui_complexity,
    });
    if (panelDecision === "skip-simple") {
      emitChatMessage(
        "system",
        "🎨 UI karmaşıklığı **basit** → tek ajanlı tasarım (çok perspektifli panel atlandı).",
      );
      log.info("phase-5", "design panel skipped (ui_complexity=simple)");
    }
    // Boot-resume israf önleme (YZLLM 2026-06-10: "kapatıp açınca fazın başına gidiyor"):
    // bu iterasyonda panel ZATEN sentezlendiyse (audit) + design.md duruyorsa yeniden KOŞMA —
    // kaldığı yerden (codegen'den) devam. Kontrol edilemezse normal koş (fail-open, panel zararsız).
    let designAlreadyDone = false;
    if (panelDecision === "run") {
      try {
        const tail = await readAuditLogTail(this.state.project_root, 600);
        if (designSynthesizedInCurrentIteration(tail)) {
          await stat(join(this.state.project_root, ".mycl", "design.md"));
          designAlreadyDone = true;
          designInjection =
            "\n\nA multi-perspective design plan has been written to .mycl/design.md. Read that file FIRST and implement the UI according to it.";
          emitChatMessage(
            "system",
            "🎨 Tasarım paneli bu iterasyonda zaten tamamlanmıştı — yeniden çalıştırılmadı; mevcut `.mycl/design.md` kullanılıyor.",
          );
        }
      } catch {
        // design.md yok / audit okunamadı → panel normal koşar.
      }
    }
    if (panelDecision === "run" && !designAlreadyDone) {
      try {
        const specContent = await readFile(
          currentSpecPath(this.state),
          "utf-8",
        );
        emitChatMessage(
          "system",
          "🎨 Tasarım paneli: architect/ux/security/data perspektifleri paralel çalışıyor → sentez ediliyor…",
        );
        emitPhaseRunning("Tasarım paneli çalışıyor (4 perspektif paralel)");
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
            emitPhaseRunning("Tasarım çatışmaları müzakere ediliyor");
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
                    ? "✅ Çatışmalar GERÇEK Agent Teams eş müzakeresiyle çözüldü; `.mycl/design.md` güncellendi."
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
            `⚠ Tasarım paneli atlandı (${design.reason}) — tek ajanlı tasarımla devam.`,
          );
        }
      } catch (err) {
        log.warn("phase-5", "design fan-out error", err);
        emitChatMessage("system", "⚠ Tasarım paneli hata verdi — tek ajanlı tasarımla devam.");
      }
    }

    const initialUserMessage = isTweakMode
      ? `UI tweak requested: ${tweakDescEn}\n\nApply only the requested change. Do NOT rewrite the whole UI. Backend paths are denied. Edit the minimal set of files; the dev server is already running (HMR will refresh the browser). Stop when \`${buildCmd}\` succeeds.`
      : `Begin Phase 5: build the UI. Backend paths are denied. Write all UI files AND a complete package.json — EVERY library you import MUST be listed in "dependencies" (or "devDependencies"), with the pipeline scripts from the spec. Do NOT run \`${installCmd}\`, do NOT run a build, do NOT start the dev server, do NOT touch node_modules — MyCL installs dependencies and launches the dev server itself after you stop. Stop when every file is written and package.json is complete.${designInjection}`;

    // YZLLM 2026-06-10: "silme kararı verirse önce yedek al." Codegen ajanı dosya silebilir/üstüne yazabilir
    // (supersession). Tweak modu zaten debug-fix yolunda snapshot'landı; normal codegen'de burada snapshot al →
    // ajan ne silerse silsin geri alınabilir (git checkpoint / git yoksa ~/.mycl/backups).
    if (!isTweakMode) await snapshotBeforeAutofix(this.state.project_root, Date.now());
    // Tasarım paneli/müzakere bittiyse banner'ı codegen'e geri al (staleness yok — her adım kendi etiketi).
    emitPhaseRunning(isTweakMode ? "UI rötuşu yazılıyor" : "UI kodu yazılıyor");
    this.base = createCodegenBackend({
      tag: "phase-5",
      phaseId: 5,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: escMe.modelId,
      effortOverride: escMe.effort,
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
        emitError("Faz 5 rötuş: değişiklik uygulanmadı — Claude yazmadı", null);
        this.lastFailReason = "tweak mode: no ui-tweak-applied events";
        // YZLLM 2026-06-13 (trace kökü): "hiç event yok" = ya tweak ZATEN uygulanmış (no-op) ya da
        // ajan yazamadı. İKİSİNDE de model-gücü çözmez — daha güçlü model de aynı dosyaları okuyup
        // "yapacak şey yok" der (trace: haiku→opus-max 11 rung, her biri 30-130dk, HEPSİ aynı sonuç).
        // escalatable=false → merdiveni TIRMANMA, doğrudan error-analysis'e (akıllı deep-debug zaten
        // "zaten uygulanmış"ı bulup pending_ui_tweak'i temizliyor — ama saatler tırmanmadan).
        this.lastFailEscalatable = false;
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
        // YZLLM 2026-06-15 (re-test8 bulgusu): Ajan DOĞAL bitti (outcome="done" — fail/abort yukarıda
        // yakalandı) ama hiç dosya yazmadı → kod spec'i ZATEN karşılıyor, DEĞİŞİKLİK GEREKMEDİ (örn.
        // önceki iterasyon çözmüş; YouTube binding gibi). Önceden bu "hata" sayılıp SONSUZ retry/loop
        // yaratıyordu ("no ui-file-write" → fail → yeniden Faz 5 → aynı sonuç). Doğru davranış:
        // zaten-karşılanıyor → fazı TEMİZ tamamla (no-op). Ajan gerçekten üretemediyse de downstream
        // (Faz 6 görsel-inceleme + Faz 8 testler + 10-17 gate'ler) yakalar → fail-safe. return YOK:
        // package.json doğrulaması + dev-server-start + phase-5-complete'e DÜŞ.
        emitChatMessage(
          "system",
          "✅ Faz 5: Kod spec'i ZATEN karşılıyor görünüyor — değişiklik gerekmedi (ajan inceledi, yazacak yeni bir şey bulmadı). Faz temiz geçiliyor; Faz 6'da UI'yi yine de inceleyeceksin.",
        );
        await appendAudit(this.state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-no-change-needed",
          caller: "mycl-orchestrator",
          detail: "codegen doğal bitti + hiç write yok → kod zaten spec'i karşılıyor",
        });
      }
      try {
        await stat(join(this.state.project_root, "package.json"));
      } catch {
        emitError("Faz 5: Claude koşusundan sonra package.json yok", null);
        this.lastFailReason = "package.json missing after codegen";
        return "fail";
      }

      // NOT: `phase-5-complete` audit'i dev server READY olduktan sonra yazılır
      // (aşağıda). Kullanıcı kuralı (feedback-faz-fail-propagation):
      // dev server fail → Faz 5 fail → Faz 6'ye geçilmez.
      // Bu sayede audit'te `phase-5-complete` yoksa resume akışı current_phase=5
      // kalır ve Faz 5 yeniden çalıştırılır.
    }

    // CSP UYUMLULUK GATE (YZLLM 2026-06-17): Faz 5'in ürettiği her UI %100 CSP-uyumlu olmalı, unsafe-* YOK.
    // İki deterministik adım (csp-compliance.ts). HER İKİ mode (normal + tweak) buradan geçer.
    //  1) scanCspViolations → kodda unsafe-* GEREKTİREN yapı (inline event handler / eval / new Function /
    //     string-gövdeli timer / javascript: URL / inline style) varsa: deterministik DÜZELTİLEMEZ (kod
    //     mantığı) → Faz 5 FAIL, ajan düzeltir. (Meta'yı ihlal VARKEN eklemek uygulamayı kırardı → önce tarama.)
    //  2) ensureCspMeta → kod temizken giriş HTML'ine (Vite/static) katı CSP meta-tag YOKSA MyCL kendisi ekler
    //     (ajan atlasa bile politika shiplenir → %100). Next/SSR gibi giriş HTML'i yoksa no-html (skip + log).
    const cspViolations = await scanCspViolations(this.state.project_root);
    if (cspViolations.length > 0) {
      const summary = cspViolations
        .slice(0, 10)
        .map((v) => `${v.file}:${v.line} [${v.kind}] ${v.snippet}`)
        .join("\n");
      emitError("phase-5: CSP ihlali — kod unsafe-* gerektiriyor", summary);
      emitChatMessage(
        "error",
        `🔒 Faz 5: CSP ihlali (${cspViolations.length}) — üretilen kod \`unsafe-inline\`/\`unsafe-eval\` ` +
          `gerektiren yapı içeriyor (inline event handler / eval / inline style / javascript:). %100 CSP için ` +
          `bunlar düzeltilmeli (JSX onClick, harici CSS-class, CSS değişkeni). Faz 5 yeniden çalışacak.`,
      );
      this.lastFailReason = `CSP ihlali (${cspViolations.length}): ${summary.slice(0, 200)}`;
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-csp-violation",
        caller: "mycl-orchestrator",
        detail: `${cspViolations.length} ihlal: ${[...new Set(cspViolations.map((v) => v.kind))].join(",")}`,
      });
      return "fail";
    }
    const cspMeta = await ensureCspMeta(this.state.project_root);
    if (cspMeta.action === "added") {
      emitChatMessage(
        "system",
        `🔒 CSP: kod zaten uyumlu; katı CSP politikası \`${cspMeta.file}\`'e otomatik eklendi → %100 CSP (unsafe-* yok).`,
      );
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-csp-meta-added",
        caller: "mycl-orchestrator",
        detail: `strict CSP meta eklendi: ${cspMeta.file}`,
      });
    } else if (cspMeta.action === "no-html") {
      // Vite/static giriş HTML'i yok (Next/SSR vb.) → meta deterministik eklenemez; ajan talimatı geçerli.
      log.info("phase-5", "csp meta skip — giriş HTML bulunamadı (Next/SSR olabilir)");
    }

    // Tweak mode'da dev server zaten ayakta — HMR yansıtır; spawn skip
    // (yeni spawn pid çakışmasına neden olur). pending_ui_tweak statePatch'te
    // temizlenir → Phase 6 tekrar çağrıldığında state temiz.
    if (isTweakMode && this.state.dev_server_pid) {
      this.statePatch = { pending_ui_tweak: undefined };
      // YZLLM 2026-06-18 KRİTİK (canlı remax_BO): tweak HMR'ı dev-server'ı 500'e düşürebilir (HMR bad-state) →
      // eski kod "Tweak uygulandı, dev server zaten ayakta" deyip 200 DOĞRULAMADAN complete diyordu → TÜM route
      // 500 veren BOZUK app Faz 6 incelemesine geçiyordu. FIX: tweak sonrası dev-server'ın 2xx/3xx servis ettiğini
      // DOĞRULA. Servis ediyorsa HMR yansıttı → complete. ETMİYORSA HMR bozulmuş → bozuk server'ı ÖLDÜR +
      // aşağıdaki normal başlatma yoluna DÜŞ (return YOK → tryDevServerChain ile yeniden başlatılır).
      const tweakProbe = [...new Set([5173, 3000, 5174, 5175, 5176, 5177, 8080, 4321, 5000, 3001])];
      const serving = (
        await Promise.all(tweakProbe.map((p) => waitForDevServer(p, 1500, { okOnly2xx: true })))
      ).some(Boolean);
      if (serving) {
        emitChatMessage(
          "system",
          "Tweak uygulandı. Dev server düzgün yanıt veriyor (2xx/3xx) — HMR ile browser otomatik yenilendi.",
        );
        log.info("phase-5", "tweak complete (dev server serving 2xx/3xx)");
        disarmRollback(); // faz başarıyla bitti → iyi işi kilitle (geri-alınmasın)
        return "complete";
      }
      emitChatMessage(
        "system",
        "⚠️ Tweak sonrası dev server düzgün yanıt vermiyor (HMR bozulmuş olabilir) — yeniden başlatılıyor…",
      );
      log.warn("phase-5", "tweak: dev server not serving 2xx — killing + restart via normal launch");
      stopActiveDevServer(this.state); // bozuk server'ı öldür + state.dev_server_pid temizle (port serbest kalır)
      // return YOK → aşağıdaki cmds/candidates + tryDevServerChain ile temiz YENİDEN başlatma.
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
      await ensureViteRuntimeInjection(this.state.project_root, {
        allowSourceEdit: viteSourceEditAllowed(this.state),
        gitignoreOnlyIfExists: this.state.origin === "foreign",
      });
    } catch (err) {
      // Load-bearing (sessiz-fallback denetimi): bu enjeksiyon UI çalışma-anı hatalarını yakalar → başarısızsa
      // runtime hataları sessizce yakalanmayabilir. log.warn→log.error + GÖRÜNÜR (kullanıcı bilsin).
      log.error("phase-5", "vite runtime-hata yakalama enjekte edilemedi — runtime hataları yakalanmayabilir", err);
      emitChatMessage("system", "⚠️ UI çalışma anı hatalarını yakalama enjekte edilemedi — bazı çalışma anı hataları otomatik yakalanmayabilir.");
    }
    // dev-ortam ≠ proje sorunu: dev server ZATEN çalışıyor mu? Kullanıcı dışarıdan başlatmış olabilir
    // (örn. MyCL 5173'te başlatamadı, kullanıcı 5176'da elle çalıştırdı). Spawn'dan ÖNCE aday + yaygın dev
    // portlarını KISA + PARALEL yokla; biri dev-server yanıtı veriyorsa onu KULLAN — boşuna yeniden başlatma/
    // fail etme + orkestratör bunu gereksiz tam-debug'a sokmasın. Phase 6 smoke testi yanlış server'ı yine yakalar.
    const probePorts = [
      ...new Set([...candidates.flatMap((c) => c.ports), 5173, 5174, 5175, 5176, 5177, 5178, 3000]),
    ];
    const existing = (
      await Promise.all(
        // okOnly2xx: yalnız 2xx/3xx servis eden server'ı "var" say — 500-veren/ölen (tweak-kill sonrası
        // yarı-ölü) bir server'ı YENİDEN KULLANMA (bozuk-yeşil önlenir; tweak-restart race'i kapanır).
        probePorts.map(async (p) => ({ p, up: await waitForDevServer(p, 1000, { okOnly2xx: true }) })),
      )
    ).find((r) => r.up);
    if (existing) {
      emitChatMessage(
        "system",
        `✅ Dev server zaten port ${existing.p}'te çalışıyor (dışarıdan başlatılmış görünüyor) — onu kullanıyorum, yeniden başlatmıyorum.`,
      );
      openBrowser(`http://localhost:${existing.p}`);
      if (!isTweakMode) {
        try {
          await runVisualDesignAgent(this.state, existing.p, this.config);
        } catch (err) {
          log.warn("phase-5", "visual design agent (external) error (non-blocking)", err);
        }
      }
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-complete",
        caller: "mycl-orchestrator",
        detail: `external dev server detected on port ${existing.p} (not spawned)`,
      });
      log.info("phase-5", "complete (external dev server)", { port: existing.p });
      disarmRollback(); // faz başarıyla bitti → iyi işi kilitle (geri-alınmasın)
      return "complete";
    }
    // KÖK FIX (YZLLM 2026-06-17, "cache kazımasını boşver" — semptomu değil kökü çöz):
    // Bağımlılık kurulumunu MyCL'in KENDİSİ garanti eder, codegen'e BIRAKMAZ. Eski davranış:
    // codegen `npm install`'ı arka planda çalıştırıp BEKLEMEDEN "başardı (exit 0)" sanıyordu →
    // node_modules eksik → `--offline`/cache-kazıma → `sh: next: command not found` → dev-server
    // hiç kalkmıyor → Faz 5 takılıyordu. Correct-by-construction: codegen yalnız dosya + tam
    // package.json yazar; KURULUMU burada MyCL SENKRON + TAM-bekleyerek yapar.
    // STACK-AGNOSTİK: installCmd profile'dan çözülür (npm/pip/cargo…); profile yoksa npm fallback —
    // o durumda yalnız package.json varsa koş (static/no-manifest projeyi kırma). Yalnız CREATE
    // iterasyonu (tweak'te deps zaten var, dış-server kontrolü de geçildiyse server zaten ayakta).
    // Fail SOFT (sessiz fallback yok): görünür asıl-hata + dev-server yine denenir; gerçek eksik
    // bağımlılığı dev-server tanısı + error-analysis yüzeye çıkarır.
    if (isCreateIteration) {
      const runInstall =
        !!this.state.stack ||
        (await stat(join(this.state.project_root, "package.json"))
          .then(() => true)
          .catch(() => false));
      if (runInstall) {
        emitChatMessage(
          "system",
          `📦 Bağımlılıklar kuruluyor — \`${installCmd}\` (MyCL garanti eder, codegen'e bırakılmaz)…`,
        );
        const inst = await execAsync(installCmd, {
          cwd: this.state.project_root,
          timeout: 600_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...safeEnv(), LC_ALL: "C" },
        }).then(
          (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
          (e: NodeJS.ErrnoException & {
            code?: number;
            stdout?: string;
            stderr?: string;
          }) => ({
            code: typeof e.code === "number" ? e.code : 1,
            out: `${e.stdout ?? ""}${e.stderr ?? e.message ?? ""}`,
          }),
        );
        if (inst.code === 0) {
          emitChatMessage("system", "📦 Bağımlılıklar kuruldu.");
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 5,
            event: "phase-5-install-ok",
            caller: "mycl-orchestrator",
            detail: installCmd,
          });
        } else {
          installFailOutput = inst.out.slice(-1500);
          emitChatMessage(
            "error",
            `📦 Bağımlılık kurulumu başarısız (\`${installCmd}\`, exit ${inst.code}). Asıl çıktı:\n\`\`\`\n${installFailOutput}\n\`\`\`\nYine de dev server denenecek; eksik bağımlılık varsa tanı bunu yüzeye çıkarır.`,
          );
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 5,
            event: "phase-5-install-fail",
            caller: "mycl-orchestrator",
            detail: `${installCmd} exit=${inst.code} ${installFailOutput.slice(-300)}`,
          });
        }
      }
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
      // GERÇEK spawn çıktısı (kör-teşhis fix, YZLLM 2026-06-10): stderr/spawn-error.
      // E2BIG/ENOENT/script-eksik artık görünür → analiz DOĞRU yeri tamir eder, node_modules silmez.
      const realOutput = [
        installFailOutput
          ? `[MyCL bağımlılık kurulumu başarısız — \`${installCmd}\`]\n${installFailOutput}`
          : "",
        ...chainResult.attempts.map((a) => a.output).filter((o): o is string => !!o),
      ]
        .filter(Boolean)
        .join("\n---\n")
        .slice(-1500);
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-dev-server-fail",
        caller: "mycl-orchestrator",
        detail: `attempts=${chainResult.attempts.length} timeout=${DEV_SERVER_TIMEOUT_MS}ms${realOutput ? ` output=${realOutput.slice(-300)}` : ""}`,
      });
      emitChatMessage(
        "error",
        `${diagnostic}\n\nDenenen komutlar (hepsi başarısız):\n${attemptsLog}` +
          (realOutput ? `\n\n**Sürecin gerçek çıktısı (asıl hata):**\n\`\`\`\n${realOutput}\n\`\`\`` : ""),
      );
      log.warn("phase-5", "dev server chain exhausted", {
        attempts: chainResult.attempts,
      });
      // lastFailReason → failPhase → error-analysis detail. GERÇEK çıktı buraya konur ki
      // analiz "timeout" değil ASIL hatayı (E2BIG vb.) görsün → doğru fix, döngü kırılır.
      this.lastFailReason =
        `dev server chain exhausted (${chainResult.attempts.length} attempts)` +
        (realOutput ? `\n\nSpawn output (the actual error — diagnose THIS, not generic causes):\n${realOutput}` : "");
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
      dbPath: `${this.state.project_root}/error_folder/mycl_errors.db`,
      config: this.config,
    });
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 5,
      event: "ui-dev-server-spawn",
      caller: "mycl-orchestrator",
      detail: `pid=${handle.pid} port=${handle.port} cmd=${usedCmd} prior_attempts=${chainResult.attempts.length}`,
    });

    // BUILD-BREAKER YAKALAMA (YZLLM 2026-06-18, canlı remax_BO HelpButton): dev-server "ayakta" YETMEZ —
    // codegen build-kıran bir hata ürettiyse (`'use client'` bileşeni server-only/`fs` modül import etmiş →
    // client bundle'a sızar → Next.js tüm build'i kırar; ya da syntax/runtime hatası) dev-server AYAKTA ama
    // `/` KALICI 5xx verir. Eskiden tryDevServerChain "ready" (herhangi HTTP yanıtı) deyip "✅ hazır" diyordu
    // → bozuk app Faz 6 incelemesine geçiyordu (kullanıcı 500 görüyordu). Artık `/` gerçekten SERVİS ediyor mu
    // (5xx HARİÇ: 2xx/3xx/4xx OK) doğrula; KALICI 5xx ise BUILD bozuk → failPhase → Faz 0 debug ASIL hatayı
    // bulup düzeltir. `serving` polling'i geçici derleme-500'ünü tolere eder, yalnız kalıcı 5xx fail eder;
    // 4xx'i kabul eder (404-on-`/` app yanlış-pozitif yok). Restart build hatasını ÇÖZMEZ → bu debug işi.
    const servingOk = await waitForDevServer(handle.port, 15_000, { serving: true });
    if (!servingOk) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 5,
        event: "phase-5-dev-server-5xx",
        caller: "mycl-orchestrator",
        detail: `dev server up (pid=${handle.pid} port=${handle.port}) but \`/\` serves persistent 5xx — BUILD broken`,
      });
      emitChatMessage(
        "error",
        `⚠️ Dev server ayakta (port ${handle.port}) ama \`/\` kalıcı olarak **5xx** veriyor — codegen build'i kıran bir hata üretti (en olası: \`'use client'\` bileşeni server-only/\`fs\`/\`server-only\` modülü import etmiş; ya da syntax/runtime hatası). "Ayakta" yetmez, app SERVİS etmeli → Faz 0 debug ASIL hatayı bulup düzeltecek.`,
      );
      this.lastFailReason =
        "The dev server process is UP but `/` serves a PERSISTENT 5xx response. The dev server started fine — the BUILD is broken. Most likely a `'use client'` component imports a server-only module (one that does `import 'server-only'` or uses `fs`/`node:*`), leaking it into the client bundle → Next.js fails the whole build → every route 5xx. (Other possibilities: a syntax/runtime error in a shared layout/module.) Diagnose the ACTUAL compile/build error — check client components' imports against server-only modules. Do NOT treat this as an environment/timeout/restart problem; a restart will NOT fix a broken build.";
      return "fail";
    }

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

    // GÖRSEL TASARIM AJANI (YZLLM 2026-06-17): dev-server hazır → estetik rötuş (screenshot → vision-claude →
    // CSS güzelleştir). Faz 6 (kullanıcı incelemesi) ÖNCESİ → kullanıcı daha güzel bir başlangıç görür.
    // non-blocking (kendi içinde fail-soft) + tweak-skip (kullanıcı-spesifik tweak'i ezmesin).
    if (!isTweakMode) {
      try {
        await runVisualDesignAgent(this.state, handle.port, this.config);
      } catch (err) {
        log.warn("phase-5", "visual design agent error (non-blocking)", err);
      }
    }

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
    disarmRollback(); // faz başarıyla bitti → iyi işi kilitle (geri-alınmasın)
    return "complete";
  }
}
