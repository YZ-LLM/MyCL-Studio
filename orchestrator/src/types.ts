// Domain tipleri — spec §5.2'den.

export type PhaseId =
  | 0  // Debug Triage — standalone, pipeline'a girmez
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17;

/**
 * Proje stack'i — `detectStack(projectRoot)` çıktısı. v15.0'da state'e yazılır,
 * Phase 5/7/9 + mechanical fazlar (10-17) buradan okur ve stack-spesifik
 * komutları `assets/profiles/<stack>.json`'dan resolve eder.
 *
 * Bu tip command.ts'den buraya taşındı (v15.0); command.ts re-export ediyor.
 */
export type StackId =
  | "node-npm"
  | "node-yarn"
  | "node-pnpm"
  | "node-bun"
  | "deno"
  | "rust"
  | "python-poetry"
  | "python-uv"
  | "python-pip"
  | "go"
  | "ruby"
  | "php"
  | "maven"
  | "gradle"
  | "elixir"
  | "dart"
  | "swift"
  | "dotnet"
  | "unknown";

/**
 * Proje tipi — Phase 2 hassasiyet sonu Haiku ile sınıflandırılır. Faz 16 (E2E)
 * ve Faz 17 (Load) test runner seçimi + Faz 5/7 skip kararı buna bağlıdır.
 * Web app → Playwright, API → hurl/supertest, CLI → shell, library → null vb.
 */
export type ProjectType =
  | "web"      // browser UI uygulaması (React/Vue/Svelte/Angular ...)
  | "api"      // backend REST/GraphQL service (Express/FastAPI/Actix/Gin ...)
  | "cli"      // komut satırı aracı
  | "library"  // SDK / paket — UI yok, E2E yok
  | "mobile"   // iOS/Android (React Native / Flutter / native)
  | "desktop"  // Electron / Tauri / Qt
  | "ml"       // ML modeli / training pipeline
  | "game"     // oyun (Unity / Godot / browser oyun)
  | "unknown";

/**
 * UI karmaşıklık seviyesi (v15.13 spec gate). Faz 2 sınıflandırıcı üretir;
 * Faz 5 tasarım paneli gate'i kullanır. Yalnız UI tipleri için anlamlı.
 * undefined → fan-out KOŞAR (regresyon-güvenli; yalnız "simple" atlar).
 */
export type UiComplexity = "simple" | "moderate" | "complex";

/**
 * Frontend build tool — Phase 5 sonrası runtime injector seçimi için.
 * v15.0'da sadece "vite" implement; diğerleri v15.1+ mini sprint'lerde.
 */
export type BuildTool =
  | "vite"
  | "webpack"
  | "next"
  | "astro"
  | "esbuild"
  | "rollup"
  | "parcel"
  | "unknown";

export type PhaseType =
  | "qa"           // AskUserQuestion (Haiku micro-call)
  | "production"   // JSON schema strict output
  | "codegen"      // Read/Edit/Write/Bash
  | "mechanical"   // MyCL lokal komut, Claude'a gitmez
  | "validation";  // MyCL audit log okur

/** Faz hangi model tier'ını kullanır (config.selected_models.translator vs .main).
 *  NOT: Bu API key seçimi DEĞİL. Tüm Claude API çağrıları daima
 *  `config.api_keys.main` kullanır; `config.api_keys.translator` yalnızca
 *  `translator.ts` içinde (TR↔EN çevirisi) kullanılır.
 *  Yani Phase 1 askq:
 *    model = config.selected_models.translator (hafif tier — Sonnet 4.6)
 *    api   = config.api_keys.main              (Claude iş yaptırma key'i)
 */
export type ModelRole = "translator" | "main";

/** qa-askq tipi fazların ortak ayarları. Generic base controller okur. */
export interface AskqConfig {
  /** approval tool adı (örn. "request_intent_approval"). */
  approval_tool_name: string;
  /** clarifying tool adı; opsiyonel — bazı fazlar sadece approval kullanır. */
  clarifying_tool_name?: string;
  /**
   * Opsiyonel "abandon" tool adı — Claude bunu çağırırsa qa-askq outcome
   * `{ kind: "abandoned", abandonInput }` ile döner. Faz 2 compliance check
   * için: kullanıcı askq'da "Vazgeç" derse Claude bu tool'u çağırır. Set
   * edilmemişse abandon yolu kapalıdır (Phase 1/19 backward compat).
   */
  abandon_tool_name?: string;
  /**
   * Opsiyonel "UI tweak" tool adı — Claude bunu çağırırsa qa-askq outcome
   * `{ kind: "ui_tweak", tweakInput }` ile döner. Faz 6 UI Review için:
   * kullanıcı "şu butonu büyült" gibi tweak isterse Claude bu tool'u çağırır.
   * Orchestrator state.pending_ui_tweak set edip Faz 5'ya döner (mini-loop).
   * Set edilmemişse tweak yolu kapalıdır (backward compat).
   */
  tweak_tool_name?: string;
  /**
   * Opsiyonel "AC failure" tool adı — Claude bunu çağırırsa qa-askq outcome
   * `{ kind: "ac_failure", failureInput }` ile döner. Faz 6 UI Review için:
   * kullanıcı bir AC için functional failure raporlarsa Claude bu tool'u
   * çağırır; Phase 6 controller `runSingleFix` ile fix uygular, sonra aynı
   * AC için askq base'i yeniden çalıştırır (re-emit). Set edilmemişse
   * failure bridge kapalıdır (default davranış: Claude kendi promptu ile karar verir).
   */
  failure_tool_name?: string;
  /** approve sırasında özet alanının input key adı (örn. "summary", "pitch"). */
  approval_summary_field?: string;
  /** Pitch'in i18n suffix anahtarı (örn. "intent", "spec"). default: "generic". */
  approval_suffix_key?: string;
  /** Max askq döngüsü — sonsuza karşı koruma. */
  max_questions: number;
  /** İsteğe bağlı boyut listesi (örn. P2'nin 7 hassasiyet boyutu). */
  dimensions?: string[];
}

/** production-schema fazlarının çıktı artifact ayarı. */
export interface ProductionConfig {
  /** "write_X" tool adı (örn. "write_spec", "write_brief"). */
  write_tool_name: string;
  /** approval tool adı — onay askq için. */
  approval_tool_name: string;
  /** approval suffix i18n key. */
  approval_suffix_key?: string;
  /** Çıktı dosyasının proje köküne göre yolu (örn. ".mycl/spec.md"). */
  output_artifact_path: string;
  /** spec.md gibi Markdown çıktı için audit event adı (örn. "spec-block"). */
  artifact_audit_event?: string;
}

/**
 * Mechanical fazın çalıştırdığı komutun spec'i. Üç biçim (v15.0 Batch A):
 *
 *   1. **string** (backward-compat) — literal komut, örn. `"npm run lint"`.
 *      v14 davranışı; v15.0'da `assets/profiles/*.json` migration tamamlanana
 *      kadar mevcut spec'ler için kullanılır.
 *
 *   2. **`{ type: "profile_key", key }`** — `state.stack` profiline bakar
 *      ve `commands[key]`'i çözer. Stack tespit edilmemişse veya key tanımsızsa
 *      `null` → mechanical-runner `phase-N-skipped` yazar (mevcut isMissingCommand
 *      path'iyle paralel ama erken; subprocess spawn denemesi yok).
 *
 *   3. **`{ type: "project_type", which: "e2e" | "load" }`** — Faz 16/18 için;
 *      `state.stack` + `state.project_type` kombinasyonundan profil'in
 *      `e2e_by_project_type` veya `load_by_project_type` bloğundan resolve.
 */
export type MechanicalCommandSpec =
  | string
  | {
      type: "profile_key";
      key: string;
      /**
       * v15.9: Scoped varyant profil anahtarı (örn. "lint_scoped"). Değişen
       * kapsam (changedScope) doluysa + profilde bu key + `{files}` şablonu
       * varsa, komut yalnız değişen dosyalara daraltılır. Yoksa `key`
       * (tüm-proje) fallback. Sadece scope'lanabilir gate'lerde (lint/test).
       */
      scoped_key?: string;
    }
  | { type: "project_type"; which: "e2e" | "load" };

/** mechanical faz konfigü — lokal komut. */
export interface MechanicalConfig {
  /** Tarama komutu — literal string veya profile resolver spec'i. */
  scan_cmd: MechanicalCommandSpec;
  /** Düzeltme komutu — literal string veya profile resolver spec'i; opsiyonel. */
  fix_cmd?: MechanicalCommandSpec;
  /** Maks tarama+düzelt+yeniden-tara döngüsü. */
  max_rescans: number;
  /** Spec'te bu fazı aktive eden koşul — yoksa skip. örn. "has_ui". */
  skip_unless?: "has_ui" | "has_nfr" | "has_database" | "always";
  /**
   * Opsiyonel ek scan komutları — Faz 13'te npm audit'in yanında semgrep
   * (SAST) gibi araçları paralel çalıştırmak için. Her entry için ayrı
   * audit event'i (`{name}-pass` / `{name}-fail` / `{name}-skipped`),
   * ayrı isMissingCommand detection. `require_file` set ise dosya
   * project_root'ta yoksa scan skip (örn. snyk için ".snyk").
   *
   * Backward compat: undefined ise mevcut akış değişmez.
   */
  extra_scans?: Array<{
    /** ASCII-safe; audit event prefix olarak kullanılır (semgrep, snyk, ...). */
    name: string;
    /** Çalıştırılacak komut (mevcut execCmd ile aynı pattern). */
    cmd: string;
    /** Project root'ta bu dosya yoksa scan skipped (missing_file). */
    require_file?: string;
    /**
     * v15.9: Scoped şablon (örn. "semgrep --config auto {files} --error").
     * changedScope doluysa `{files}` değişen dosyalarla genişler; yoksa `cmd`
     * (tüm-proje) fallback.
     */
    scoped_cmd_template?: string;
    /**
     * Güvenlik-baseline Unit 3: "araç düzgün çalışmadı" exit kodları — BULGU
     * (fail) DEĞİL, SKIP olarak işlenir. Örn. semgrep fatal/bozuk-kural=2,
     * gitleaks eski-sürümde bilinmeyen-komut=126. Bunlar olmadan bozuk bir custom
     * kural ya da uyumsuz araç sürümü her projeyi yanlış-bloklardı. Atlanan güvenlik
     * taraması harness-verdict'te securitySkipped→PARTIAL ile dürüstçe yüzeye çıkar.
     */
    tool_error_codes?: number[];
  }>;
}

export interface PhaseSpec {
  id: PhaseId;
  type: PhaseType;
  /** i18n anahtarı — runtime t(`phase.N.name`, locale) ile resolve edilir. */
  name_i18n_key: string;
  /** Kullanıcının Settings'te seçtiği model rolü. mechanical/validation için undefined. */
  model_role?: ModelRole;
  allowed_tools?: string[];
  denied_paths?: string[];
  prompt_template_path?: string;
  output_schema_path?: string;
  /**
   * @deprecated v15.7 (2026-05-27) — Lazy gate loading planlamasından kalma
   * dead field. Hiçbir yerde runtime'da import edilmiyor; PHASE_SPECS girişleri
   * tutuyor ama gerçek gate logic'i controller içinde inline veya hook'larda.
   * Silmek için: PHASE_SPECS girişlerinden de kaldırılmalı (~17 entry).
   */
  gate_module_path: string;
  /**
   * @deprecated v15.7 (2026-05-27) — gate_module_path ile aynı dead field.
   */
  runner_module_path?: string;
  required_audits: string[];
  /** Faz tipi başına ayar — sadece o tipte dolu olur. */
  askq_config?: AskqConfig;
  production_config?: ProductionConfig;
  mechanical_config?: MechanicalConfig;
}

export interface State {
  /**
   * State şeması versiyonu (v15.0). Migration framework bu alanı okur,
   * eksik migrator'ları sırayla uygular. Yeni alanlar eklendiğinde
   * `state-migrations.ts` içine yeni migrator + bump.
   * Eski state'lerde undefined = v0.
   */
  schema_version?: number;
  /**
   * Proje stack'i — open_project sırasında `detectStack(projectRoot)` bir
   * kere çalışır, state'e yazılır. Tüm fazlar (özellikle 6/9 + mechanical
   * 11-18) buradan okur ve `assets/profiles/<stack>.json`'dan komut
   * resolve eder. v15.0 öncesi state'lerde undefined olabilir → migration.
   */
  stack?: StackId;
  /**
   * Proje tipi (web/api/cli/library/mobile/desktop/ml/game/unknown). Phase 2
   * hassasiyet sonu Haiku ile sınıflandırılır + confirm askq ile kullanıcıya
   * doğrulattırılır. Faz 16 E2E + Faz 17 Load runner seçimi ve Faz 5/7 skip
   * kararı buna bağlı.
   */
  project_type?: ProjectType;
  /**
   * Frontend build tool (vite/webpack/next/astro/...). Phase 5 sonrası
   * runtime injector seçimi için. v15.0'da sadece vite implement.
   */
  build_tool?: BuildTool;
  /**
   * `project_type === "library" | "cli"` ise Faz 5 (UI Yapımı) + Faz 6 (UI
   * İnceleme) skip edilir. Phase 2 sonunda set edilir, advanceToNextPhase
   * Faz 5 → Faz 7'e atlar.
   */
  skip_ui_phases?: boolean;
  /**
   * v15.6 (2026-05-24): Bu iterasyonda çalışacak fazlar listesi. Faz 3 LLM
   * needed_optional_phases ⊆ {5,6,7,8} üretir → kullanıcı onaylayınca burada
   * kalıcı saklanır = [4, ...optional, 9, 10, 11, 12, 13, 14, 15, 16, 17].
   * `undefined` → eski davranış (tüm fazlar). Yeni iterasyon başlarken
   * Phase 1 controller temizler. Auto-advance loop bunu kontrol edip kapsamı
   * dışındaki fazları sessizce atlar (audit: phase-N-skipped-by-scope).
   */
  needed_phases?: number[];
  /**
   * v15.6: Faz 3 LLM önerisi — kullanıcı henüz onaylamadı. Faz 3 sonrası
   * scope-confirm askq emit edilir; kullanıcı "Önerilen seti onayla" derse
   * `needed_phases = needed_phases_proposed` set edilir + temizlenir.
   * "Tüm fazları çalıştır" → needed_phases undefined (skip yok) + temizlenir.
   */
  needed_phases_proposed?: number[];
  /**
   * Faz 7 (Veritabanı Tasarımı) için yapısal gate (v15.2.3 borç C-3).
   * Phase 2 classifier Haiku ile spec'ten türetir; false ise Faz 7 atlanır.
   * undefined: classifier henüz çalışmamış → spec.md "has_database" heuristic
   * fallback'i devreye girer. Eski state'ler undefined kalır (backward-compat).
   */
  has_database?: boolean;
  /**
   * UI karmaşıklık seviyesi (v15.13 spec gate). Phase 2 classifier üretir;
   * Faz 5 tasarım paneli gate'i kullanır (yalnız "simple" → çok-perspektifli
   * fan-out ATLANIR, tek-ajan tasarım). undefined/moderate/complex → fan-out
   * KOŞAR. Eski state'ler undefined kalır (backward-compat; regresyon yok).
   */
  ui_complexity?: UiComplexity;
  current_phase: PhaseId;
  session_id: string;                 // UUIDv4
  spec_approved: boolean;
  spec_hash?: string;
  ui_flow_active: boolean;
  regression_block_active: boolean;
  tdd_compliance_score?: number;      // 0-100, Phase 8 sonrası
  last_write_ts?: number;
  /**
   * Faz 5 dev server'ı arka planda spawn ettiğinde pid burada saklanır.
   * Orchestrator startup'ta (open_project) yaşıyor mu kontrol eder; zombi
   * dev server'lar için kullanıcıyı uyarır.
   */
  dev_server_pid?: number;
  project_root: string;
  created_at: number;
  updated_at: number;
  /**
   * Phase 1 onaylı niyet özeti (EN). Faz 2 enriched_summary üretirse bu alan
   * üzerine yazılır — Faz 4+ son hâli kullanır.
   */
  intent_summary?: string;
  /**
   * Phase 1'in HAM özeti (translate çıktısı + onaylı). Faz 2 enriched üretip
   * intent_summary'ı güncellese bile bu alan değişmez — recovery / debug için.
   */
  intent_summary_raw?: string;
  /**
   * Pipeline iterasyon sayacı. İlk run = 1; Faz 20 tamamlandıktan sonra
   * kullanıcı yeni mesaj yazınca artırılır. Eski artefact'lar (spec.md, kod)
   * yerinde kalır — Claude yeni iterasyonda Read ile referans alabilir.
   */
  iteration_count?: number;
  /**
   * Escalation merdiveni — PER-DOMAIN basamak (Ümit 2026-06-11: "önceki tecrübeler önemli; yükseltme var düşürme
   * yok"). domain (phaseDomain: intent/spec/tdd-codegen/...) → o işin öğrenilmiş model+efor basamağı. Her iş kendi
   * alanının seviyesinden başlar (intent cheap kalır, codegen tırmanır); başarısızlıkta o domain tırmanır;
   * iterasyonlar arası TAŞINIR (monotonik, asla düşmez). Domain yoksa firstRung (cheap·low).
   */
  escalation_rungs?: Record<string, import("./escalation.js").Rung>;
  /**
   * Bu iterasyonun başlangıç timestamp'i (Date.now). Boot-resume'da hangi
   * audit event'lerinin BU iterasyona ait olduğunu belirler — audit tail'i
   * (son 300) iteration-N-start'ı kaçırırsa bile resume scope'u doğru kalır
   * (uzun iterasyonda önceki koşunun phase-complete'ini yanlış saymaz). iter=1'de
   * gereksiz (scope 0'dan başlar); yeni iterasyon reset'inde set edilir.
   */
  iteration_started_at?: number;
  /**
   * Phase 6'de kullanıcı UI tweak isterse Claude `request_ui_tweak` tool'una
   * verdiği description burada saklanır. Outer loop Phase 5'ya döner; Phase 5
   * tweak mode'da bu alanı okur ve statePatch'inde temizler.
   */
  pending_ui_tweak?: string;
  /**
   * v15.7 (2026-05-27): Phase 7 onaylanınca yazılan migration SQL dosyalarının
   * relative path listesi. Phase 8 başlangıcında bu migration'lar uygulanır
   * (apply komutu stack profile'a göre). Boş array Phase 7 atlandıysa veya
   * migration yoksa.
   */
  pending_migrations?: string[];
  /**
   * v15.7 (2026-05-27): Phase 0 D2 backend-only fix routing. D1 ana ajanı
   * `report_root_cause.fix_options[].plan_kind = "backend-only"` set ederse
   * orkestratör bu alanı set eder ve Phase 8'i fix mode'da başlatır. Phase 8
   * başlangıcında initialUserMessage'a inject edilir, statePatch ile
   * temizlenir.
   */
  pending_backend_fix?: string;
  /**
   * v15.9: Scoped mekanik gate'ler için "değişen kapsam" — fix/development
   * sonrası computeChangedScope (git diff ∪ blast-radius) ile set edilir.
   * Faz 10/13/14 bunu okuyup lint/güvenlik/birim-test'i bu dosyalara daraltır;
   * scope'lanamayan gate'ler (11/12/15/17) scoped-touch modunda atlanır.
   * undefined → full mod (tüm-proje, mevcut davranış). Pipeline sonu temizlenir.
   */
  changed_scope?: {
    /** Değişen kaynak dosyalar ∪ blast-radius (projectRoot-relative). */
    files: string[];
    /** Diff tabanı (fix checkpoint ref'i, varsa). */
    since?: string;
    /** Hesaplanma zamanı (stale scope koruması). */
    computed_at: number;
  };
  /**
   * v15.9: Faz 8 fix mode'da alınan git checkpoint ref'i (createCheckpoint).
   * Fix bittikten sonra computeChangedScope'a `since` olarak verilir → tam fix
   * diff'i. Tüketilince (scope hesaplanınca) temizlenir.
   */
  fix_checkpoint_ref?: string;
  /**
   * Ümit 2026-06-12 (#2): Faz 13 (Güvenlik) gate'i fix gerektirdi → fix sonrası Faz 13 yeniden taranırken
   * SCOPED değil TAM (whole-project) tara. Güvenlik fix'inin etkisi değişen-dosya dışına taşabilir + eksik
   * fix (örn. eklenmemiş Helmet) yakalanmalı. Faz 13 fix denenince set, yeniden-tarama tüketince temizlenir.
   */
  pending_security_reverify?: boolean;
  /**
   * Toplam UI tweak iterasyon sayısı; Phase 6 başarıyla tamamlandığında
   * sıfırlanır. MAX_UI_TWEAKS (5) aşıldığında force-complete Phase 7'e geçer.
   */
  ui_tweak_count?: number;
  /**
   * Phase 0 (Debug Triage) state machine. v15.7 (2026-05-26) sonrası sadece
   * D1 (investigate) + D2_WAITING (kullanıcı plan seçimi bekleniyor) var.
   * D3 (codegen fix) kaldırıldı — kullanıcı plan seçince orkestratör Faz 5'ten
   * itibaren pipeline tetikler (pending_ui_tweak + advanceToNextPhase(4)).
   * Phase 0 success/abort'ta `undefined` set edilir.
   *
   * `D3_RUNNING` variant geriye-uyumluluk için tutulur (eski state.json
   * dosyalarında olabilir); yeni kod asla set etmez.
   */
  pending_diagnostic?:
    | {
        phase: "D2_WAITING";
        askq_id: string;
        rootCauseTR: string;
        options: Array<{
          label: string;
          description: string;
          planSummary: string;
          /**
           * D1 ana ajan tarafından plan_kind tool field'ı üzerinden set edilir.
           * Eski state.json'larda olmayabilir; runtime'da kullanılırken
           * `?? "full-stack"` defansif default uygulanır. v15.7 (2026-05-27)
           * öncesi regex'le post-hoc classify ediliyordu.
           */
          planKind?:
            | "ui-only"
            | "backend-only"
            | "full-stack"
            | "new-iteration";
        }>;
        /**
         * D2 blast-radius — kök nedene dokunulursa etkilenen modüller.
         * Deterministik bağımlılık grafiğinden (fix/dep-graph) üretilir, model
         * üretmez. Grafik kurulamazsa (analyzer yok / dosya yok) undefined.
         */
        affected?: Array<{
          module: string;
          why: string;
          risk: "high" | "medium" | "low";
        }>;
        /**
         * 2026-06-09 (Ümit: "hata çözümünü sorma, kendin çöz"): D1 ajanının önerdiği (otomatik
         * uygulanacak) seçeneğin label'ı. Set ise index.ts askq YERİNE doğrudan bu seçeneği
         * route eder. Eski state.json'larda yok → askq fallback (geriye uyumlu).
         */
        auto_selected_label?: string;
        ts: number;
      }
    | {
        phase: "D3_RUNNING";
        selectedLabel: string;
        planSummary: string;
        ts: number;
      };
}

export type AuditCaller = "mycl-orchestrator" | "mycl-bridge" | "user";

export interface AuditEvent {
  ts: number;
  phase: PhaseId;
  event: string;                      // "phase-N-complete", "tdd-test-write", ...
  caller: AuditCaller;
  detail?: string;
}

/**
 * ADR (Architecture Decision Record) — dayanıklı, append-only "neden" kaydı.
 * Yer: <project_root>/.mycl/decisions.jsonl (audit.log'un kardeşi). Karar veren
 * fazlar (Brief/Spec/DB) onay anında OTOMATİK yazar; bellek/agent bağımlılığı yok.
 * audit.log "ne oldu" (event) tutar; bu "neden öyle karar verildi" tutar.
 */
export interface DecisionRecord {
  ts: number;
  phase: PhaseId;
  iteration: number;                  // state.iteration_count ?? 1
  title: string;                      // brief/spec/schema başlığı
  context: string;                    // 1-2 cümle (scope / özet)
  alternatives_considered: string[];  // atlanan fazlar / out-of-scope / [] yoksa
  chosen: string;                     // verilen karar
  reason: string;                     // gerekçe (needed_optional_phases_reason / risk özeti / "")
}

/** Tek model için faz-içi token dökümü (CostRecord.model_usage değeri). */
export interface ModelTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Per-faz token gözlemi — `.mycl/cost.jsonl` (append-only, audit/decisions kardeşi).
 * Faz tamamlanınca o fazın tüm turn'lerinin token toplamı yazılır. Maliyet
 * regresyonu (örn. Faz 0'ın 185k→90k optimizasyonu) bu kayıttan görünür.
 *
 * v15.14 (F1): TOKEN her zaman; `total_cost_usd` yalnız CLI/abonelik result'tan gelir
 * (API yolu USD vermez → undefined; uydurma $ yok). `model`/`model_usage` per-model
 * döküm için (recordTokenUsage akışından birikir). Tümü opsiyonel → JSONL additive,
 * eski kayıtlarda undefined (migration yok).
 */
export interface CostRecord {
  ts: number;
  phase: PhaseId;
  iteration: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Gerçek $ — yalnız CLI result'tan; API/eksikse undefined (token-only gösterilir). */
  total_cost_usd?: number;
  /** Bu fazda en çok token üreten (birincil) model — kısa gösterim için. */
  model?: string;
  /** Per-model token dökümü (faz birden çok model kullanabilir). */
  model_usage?: Record<string, ModelTokenUsage>;
}

// Saf gate fonksiyonu — yan etki yok, sadece karar.
export type GateResult = "complete" | "incomplete" | "fail";
export type GateFunction = (state: State, audit: AuditEvent[]) => GateResult;

// Mechanical runner — yan etkili, exec yapar, audit event ÖNERİR (yazmaz).
export interface MechResult {
  success: boolean;
  audit_event: string;
  detail?: string;
}
export type MechanicalRunner = (state: State) => Promise<MechResult>;

// Translator yönü.
export type TranslationDir = "tr-to-en" | "en-to-tr";

// Faz durumu — UI faz indicator için.
export type PhaseStatus = "running" | "waiting" | "complete" | "error";

// Orchestrator IPC mesajları (Tauri ↔ Node).
export interface IncomingMessage {
  kind: string;
  data?: unknown;
}

export interface OutgoingEvent {
  kind: string;
  data?: unknown;
}
