// phase-registry — MVP fazları için PhaseSpec kayıtları.
//
// Aşama II sonrası: PhaseSpec genişledi, faz başına askq_config /
// production_config / mechanical_config ile generic base controller'lar
// konfigürasyonu okur. name yerine name_i18n_key — runtime t() ile resolve.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { PhaseId, PhaseSpec } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ASSETS_ROOT = resolve(__dirname, "..", "..", "assets");

export function templatePath(name: string): string {
  return join(ASSETS_ROOT, "templates", name);
}

/**
 * YZLLM 2026-06-27: REPO KÖKÜNDEKİ dosya (assets DIŞI) — örn. müfettiş.md iletişim rehberi.
 * ASSETS_ROOT = <repo>/assets; bir üst = <repo>. Bundle'da da tutarlı (assets ../assets → _up_/assets,
 * repo-kökü dosyası ../<name> → _up_/<name>; resolve(ASSETS_ROOT,"..") ikisinde de _up_/ kökünü verir).
 */
export function repoRootFile(name: string): string {
  return resolve(ASSETS_ROOT, "..", name);
}

function gatePath(name: string): string {
  return join(ASSETS_ROOT, "gates", name);
}

function runnerPath(name: string): string {
  return join(ASSETS_ROOT, "runners", name);
}

function schemaPath(name: string): string {
  return join(ASSETS_ROOT, "schemas", name);
}

/**
 * v15.0: `assets/profiles/<stack>.json` yolu. Stack profil dosyaları
 * mechanical fazlar 10-17 + Phase 5 build/dev için stack-spesifik
 * komutları içerir. profile-loader.ts bu yoldan okur.
 */
export function profilePath(name: string): string {
  return join(ASSETS_ROOT, "profiles", name);
}


/**
 * Güvenlik-baseline gömülü araçları (örn. csp-check.mjs) orchestrator KÖKÜNDE
 * durur (harness.mjs gibi — .mjs, tsc derlemez). Mekanik runner extra_scan'i
 * HEDEF-PROJE cwd'sinde koşar → MUTLAK yol gerekir (aksi halde script bulunamaz).
 * __dirname = orchestrator/dist (runtime) veya orchestrator/src (vitest); ".." →
 * orchestrator kökü. Script csp_evaluator'ı orchestrator/node_modules'tan import eder.
 */
function securityToolPath(name: string): string {
  return resolve(__dirname, "..", name);
}

/** assets/security-rules/ altındaki custom kural dosyası (örn. data-sanitization.yml).
 *  Runner cwd=hedef-proje olduğundan MUTLAK yol gerekir (semgrep --config <abs>). */
function securityRulePath(name: string): string {
  return join(ASSETS_ROOT, "security-rules", name);
}

/** assets/quality-rules/ altındaki kod-kalite (güvenlik-DIŞI) kural dosyası (Birim 1:
 *  code-quality.yml). Güvenlikten AYRI klasör — semantik netlik (Faz 10 Lint extra_scan).
 *  securityRulePath ile aynı mutlak-yol gereği. */
function qualityRulePath(name: string): string {
  return join(ASSETS_ROOT, "quality-rules", name);
}

export const PHASE_SPECS: Partial<Record<PhaseId, PhaseSpec>> = {
  0: {
    id: 0,
    type: "codegen",
    name_i18n_key: "phase.0.name",
    model_role: "main",
    // Phase 0 Debug Triage — Read/Grep/Bash ile araştırma + Edit/Write ile fix.
    // denied_paths null (bug nerede olabilir bilinmiyor). Template Claude'a
    // "non-destructive fixes" sınırını koyar; large refactors için diagnostic
    // onayı bekler.
    allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    prompt_template_path: templatePath("phase-00-debug.md"),
    gate_module_path: gatePath("phase-00.ts"),
    required_audits: ["debug-triage-complete"],
  },
  1: {
    id: 1,
    type: "qa",
    name_i18n_key: "phase.1.name",
    model_role: "translator",
    allowed_tools: ["AskUserQuestion"],
    prompt_template_path: templatePath("phase-01-intent.md"),
    gate_module_path: gatePath("phase-01.ts"),
    required_audits: ["phase-1-intent-approve", "phase-1-complete"],
    askq_config: {
      approval_tool_name: "request_intent_approval",
      clarifying_tool_name: "ask_clarifying",
      approval_summary_field: "summary",
      approval_suffix_key: "intent",
      max_questions: 6, // üst sınır; talimat ≤3-4 hedefler (round-trip azalt, kalite=varsayım-göster)
    },
  },
  2: {
    id: 2,
    type: "qa",
    name_i18n_key: "phase.2.name",
    model_role: "translator",
    prompt_template_path: templatePath("phase-02-precision.md"),
    gate_module_path: gatePath("phase-02.ts"),
    required_audits: [
      "precision-dimension",
      "phase-2-precision-complete",
      "phase-2-complete",
    ],
    askq_config: {
      approval_tool_name: "complete_precision_audit",
      clarifying_tool_name: "ask_clarifying",
      // 8. boyut "COMPLIANCE" sonrası kullanıcı askq'da "Vazgeç" derse Claude
      // bu tool'u çağırır → qa-askq base controller "abandoned" outcome döner.
      abandon_tool_name: "abandon_iteration",
      approval_summary_field: "enriched_summary",
      approval_suffix_key: "generic",
      // Üst sınır (talimat asıl belirleyici — çoğu boyut varsayımla geçilir, sadece
      // gerçek belirsizlik sorulur). 22 → 14: COMPLIANCE buffer korunur, round-trip kesilir.
      max_questions: 14,
      dimensions: [
        "SCOPE",
        "USERS",
        "DATA",
        "SUCCESS",
        "EDGE",
        "PERFORMANCE",
        "SECURITY",
        "COMPLIANCE",
      ],
    },
  },
  3: {
    id: 3,
    type: "production",
    name_i18n_key: "phase.3.name",
    model_role: "main",
    prompt_template_path: templatePath("phase-03-brief.md"),
    gate_module_path: gatePath("phase-03.ts"),
    required_audits: ["phase-3-brief-approve", "phase-3-complete"],
    production_config: {
      write_tool_name: "write_brief",
      approval_tool_name: "request_brief_approval",
      approval_suffix_key: "generic",
      output_artifact_path: ".mycl/brief.md",
    },
  },
  4: {
    id: 4,
    type: "production",
    name_i18n_key: "phase.4.name",
    model_role: "main",
    allowed_tools: ["AskUserQuestion"],
    prompt_template_path: templatePath("phase-04-spec.md"),
    output_schema_path: schemaPath("phase-04-spec.json"),
    gate_module_path: gatePath("phase-04.ts"),
    required_audits: ["spec-block", "phase-4-spec-approve", "phase-4-complete"],
    production_config: {
      write_tool_name: "write_spec",
      approval_tool_name: "request_spec_approval",
      approval_suffix_key: "spec",
      output_artifact_path: ".mycl/spec.md",
      artifact_audit_event: "spec-block",
    },
  },
  5: {
    id: 5,
    type: "codegen",
    name_i18n_key: "phase.5.name",
    model_role: "main",
    // AskUserQuestion = doubt-driven eskalasyon (SDK backend; nadir). CLI backend
    // yüzeye çıkaramaz — flag opt-in + eskalasyon nadir olduğu için kabul edilir.
    allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion"],
    // v15.7 (2026-05-27): Backend yol yaygın konvansiyonları genişletildi —
    // adminpanel gibi root-level `backend/` kullanan projelerde Phase 5 UI
    // build backend dosyası yazmasın diye. `src/api/`, `src/server/` modern
    // Next.js/SvelteKit style; `backend/`, `server/`, `api/` root-level.
    denied_paths: [
      "src/api/",
      "src/server/",
      "backend/",
      "server/",
      "api/",
      "prisma/",
      "models/",
      "migrations/",
    ],
    prompt_template_path: templatePath("phase-05-ui.md"),
    gate_module_path: gatePath("phase-05.ts"),
    required_audits: ["ui-file-write", "ui-ready", "phase-5-complete"],
  },
  6: {
    id: 6,
    type: "qa",
    name_i18n_key: "phase.6.name",
    model_role: "translator",
    // Phase 6 DEFERRED MODE — controller askq açmaz, template load etmez.
    // Sadece chat'e yön gösterici mesaj yazıp "deferred" döner; bir sonraki
    // user_message intent classifier ile yorumlanır (approve_ui/revise_ui/
    // cancel_pipeline). Bu nedenle prompt_template_path field'ı YOK.
    gate_module_path: gatePath("phase-06.ts"),
    required_audits: ["phase-6-complete"],
    askq_config: {
      // askq_config field'ları deferred mode'da kullanılmıyor ama PhaseSpec
      // schema'sı korunsun diye dolduruldu (gelecekte qa-askq dönüşü için).
      approval_tool_name: "complete_ui_review",
      clarifying_tool_name: "ask_ui_check",
      tweak_tool_name: "request_ui_tweak",
      failure_tool_name: "report_ac_failure",
      approval_summary_field: "summary",
      approval_suffix_key: "generic",
      max_questions: 8,
    },
  },
  7: {
    id: 7,
    type: "production",
    name_i18n_key: "phase.7.name",
    model_role: "main",
    prompt_template_path: templatePath("phase-07-db.md"),
    gate_module_path: gatePath("phase-07.ts"),
    required_audits: ["phase-7-db-approve", "phase-7-complete"],
    production_config: {
      write_tool_name: "write_db_schema",
      approval_tool_name: "request_db_approval",
      approval_suffix_key: "generic",
      output_artifact_path: ".mycl/db-schema.md",
    },
  },
  8: {
    id: 8,
    type: "codegen",
    name_i18n_key: "phase.8.name",
    model_role: "main",
    // AskUserQuestion = doubt-driven eskalasyon (Faz 8 her zaman SDK backend).
    allowed_tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion"],
    prompt_template_path: templatePath("phase-08-tdd.md"),
    gate_module_path: gatePath("phase-08.ts"),
    required_audits: ["tdd-test-write", "tdd-prod-write", "tdd-green"],
  },
  9: {
    id: 9,
    type: "qa",
    name_i18n_key: "phase.9.name",
    model_role: "translator",
    prompt_template_path: templatePath("phase-09-risk.md"),
    gate_module_path: gatePath("phase-9.ts"),
    required_audits: ["risk-decision", "phase-9-complete"],
    askq_config: {
      approval_tool_name: "complete_risk_review",
      clarifying_tool_name: "ask_risk_decision",
      approval_summary_field: "summary",
      approval_suffix_key: "generic",
      max_questions: 20,
      // YZLLM 2026-06-13: risk-kararları (ask_risk_decision) zaten yanıtlandı → sonuç-onayı redundant.
      // Oto-sonuçlandır (ayrı "Onaylıyor musunuz?" açma; toggle'dan bağımsız).
      auto_conclude: true,
    },
  },
  10: {
    id: 10,
    type: "mechanical",
    name_i18n_key: "phase.10.name",
    runner_module_path: runnerPath("phase-10.ts"),
    gate_module_path: gatePath("phase-10.ts"),
    required_audits: ["lint-pass", "lint-fail"],
    mechanical_config: {
      // v15.0: stack profilinden resolve. node-npm → "npm run lint", python-uv
      // → "uv run ruff check .", vb. Profilde lint yoksa phase skip.
      // v15.9: scoped varyant — değişen dosyalara daralma (profilde lint_scoped
      // varsa). Yoksa lint (tüm-proje) fallback.
      scan_cmd: { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      fix_cmd: { type: "profile_key", key: "lint_fix", scoped_key: "lint_fix_scoped" },
      max_rescans: 1,
      skip_unless: "always",
      // Birim 1 (YZLLM 2026-06-12): kod-kalite anti-pattern semgrep seti — güvenlik-DIŞI
      // mühendislik kuralları (yutulan hata, debug artığı, ts-suppress kaçağı). Faz 10
      // (Lint) semantik yuva. Bozuk kural/araç-crash (exit 2) → fail DEĞİL skip
      // (tool_error_codes). scoped: changedScope doluysa yalnız değişen dosyalara koşar.
      // CANLI-BUG (2026-06-22, Arcelik_BO): semgrep ÜRETİLEN build çıktısını (`.next/` webpack
      // bundle'ları, dist/build/out, vendored kod) tarayıp false-positive üretip pipeline'ı
      // tıkıyordu (kaynakta 0, .next'te 17). Stack-bağımsız build-dir exclude'ları eklendi —
      // SADECE kaynak taranır (semgrep .next'i default'ta ELEMEZ; node_modules'u eler).
      extra_scans: [
        {
          name: "code-quality",
          cmd: `semgrep --config "${qualityRulePath("code-quality.yml")}" . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          scoped_cmd_template: `semgrep --config "${qualityRulePath("code-quality.yml")}" {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          // semgrep araç/kural sorunu → fail DEĞİL skip: 2=fatal/bozuk-kural(validate) +
          // bozuk-tarama-root, 7=runtime invalid-rule (düşman-gözü K3-A: tarama modunda
          // bozuk kural 2 değil 7 verir). Gerçek bulgu=1 → fail (skip değil).
          tool_error_codes: [2, 7],
        },
        {
          // Birim 2 (YZLLM 2026-06-12): mimari sınır guardrail'i — KESİN-client kodu (use
          // client / .vue|.svelte / RSC-olmayan SPA component) DB-sürücüsü veya node
          // server-builtin import edemez. Minik evrensel set (RSC-güvenli; belirsiz .tsx'e
          // dokunmaz). orchestrator-kökü .mjs, MUTLAK yol (runner cwd=hedef-proje).
          name: "architecture",
          cmd: `node "${securityToolPath("arch-check.mjs")}" --project .`,
          scoped_cmd_template: `node "${securityToolPath("arch-check.mjs")}" {files}`,
          tool_error_codes: [2], // beklenmeyen hata → skip (kendi script'im; semgrep değil → 7 yok)
        },
      ],
    },
  },
  11: {
    id: 11,
    type: "mechanical",
    name_i18n_key: "phase.11.name",
    gate_module_path: gatePath("phase-11.ts"),
    required_audits: ["simplify-pass", "simplify-fail"],
    mechanical_config: {
      // ts-prune (Node) / non-Node stack'lerde profilde tanımlıysa kendi aracı.
      scan_cmd: { type: "profile_key", key: "simplify" },
      max_rescans: 0,
      skip_unless: "always",
    },
  },
  12: {
    id: 12,
    type: "mechanical",
    name_i18n_key: "phase.12.name",
    gate_module_path: gatePath("phase-12.ts"),
    required_audits: ["perf-pass", "perf-fail"],
    mechanical_config: {
      // Performance: stack profilinde "perf" tanımlı projeler için çalışır.
      // Yoksa skip — Faz 10 lint ile çakışmaz.
      scan_cmd: { type: "profile_key", key: "perf" },
      max_rescans: 0,
      skip_unless: "always",
    },
  },
  13: {
    id: 13,
    type: "mechanical",
    name_i18n_key: "phase.13.name",
    gate_module_path: gatePath("phase-13.ts"),
    required_audits: ["security-pass", "security-fail"],
    mechanical_config: {
      // Security: stack profilinden (npm audit, pip-audit, cargo audit, ...).
      scan_cmd: { type: "profile_key", key: "security" },
      max_rescans: 0,
      skip_unless: "always",
      // SAST: semgrep ile kod-seviyesi güvenlik tarama. Stack-agnostic
      // (Python, JS, Go, Java, ...). Tool yoksa skip; security yine koşar.
      // v15.7 (2026-05-27): Batch A3 — custom security rules: `semgrep --config p/security-audit`
      // (semgrep registry'den OWASP-grade kural seti). `--config auto` ile birlikte
      // toplam coverage artar. assets/security-rules/ klasörü local custom rules için
      // rezerv; ileride mechanical runner runtime substitution ile entegre edilecek.
      // v15.9: scoped_cmd_template — changedScope doluysa semgrep yalnız değişen
      // dosyalara koşar (semgrep dosya/path listesi kabul eder); aksi → proje kökü `.`
      // (YZLLM 2026-06-20 İş 4: src/ değil kök → STACK-BAĞIMSIZ; node_modules/.git auto-skip).
      extra_scans: [
        {
          // Güvenlik-baseline (Unit 1): CSP değerlendirme (Google csp_evaluator —
          // Chrome "CSP Evaluator" extension'ının headless/otomatik karşılığı).
          // Web-UI olmayan projede self-skip; kaynak-tabanlı (index.html meta);
          // statik bulunamayan CSP → görünür atlama (false-fail YOK). MUTLAK yol:
          // runner cwd=hedef-proje, script csp_evaluator'ı orchestrator/node_modules'tan
          // import eder. Eşik severity<=40 blocking ("MEDIUM da bloklasın" — 2026-06-04).
          name: "csp-evaluator",
          cmd: `node "${securityToolPath("csp-check.mjs")}"`,
        },
        {
          // Güvenlik-baseline (Unit 3): secret-scan. Hard-coded API key/token/private-key.
          // gitleaks YERİNE semgrep p/secrets — mevcut semgrep mimarisine oturur (registry
          // config, path sorunu yok), dil-agnostik, gitleaks'in sürüm/komut/scope
          // kırılganlığı yok. Eksik→skip, semgrep-crash (exit 2)→skip (tool_error_codes).
          name: "semgrep-secrets",
          cmd: "semgrep --config p/secrets . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          scoped_cmd_template: "semgrep --config p/secrets {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          tool_error_codes: [2],
        },
        // tool_error_codes:[2]: semgrep fatal/crash (registry fetch hatası, bozuk hedef
        // kod parse'ı) exit 2 verir — bu BULGU değil → yanlış-blocking yapmasın → skip
        // (Unit 3 robustness; review landmine). exit 1 (gerçek bulgu) blocking kalır.
        {
          name: "semgrep",
          cmd: "semgrep --config auto . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          scoped_cmd_template: "semgrep --config auto {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          tool_error_codes: [2],
        },
        {
          name: "semgrep-security-audit",
          cmd: "semgrep --config p/security-audit . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          scoped_cmd_template: "semgrep --config p/security-audit {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          tool_error_codes: [2],
        },
        {
          name: "semgrep-owasp-top-ten",
          cmd: "semgrep --config p/owasp-top-ten . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          scoped_cmd_template: "semgrep --config p/owasp-top-ten {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet",
          tool_error_codes: [2],
        },
        {
          // Güvenlik tamamlığı: adanmış güvenlik-HTTP-başlık kontrolü (deps + kaynak
          // tarama; canlı-server FP'siz). Backend var ama helmet/manuel-header yoksa bulgu.
          // MUTLAK yol (runner cwd=hedef-proje). exit 2 = araç-hatası → skip.
          name: "security-headers",
          cmd: `node "${securityToolPath("headers-check.mjs")}" --project .`,
          tool_error_codes: [2],
        },
        {
          // Veri güvenliği: sanitizer kontrolü — kullanıcı verisi sanitize edilmeden
          // tehlikeli sink'lere (innerHTML/dangerouslySetInnerHTML/eval/SQL-concat) akıyor mu.
          // Custom semgrep YAML (mutlak yol); bozuk/fatal kural exit 2 → skip (yanlış-blocking yok).
          name: "data-sanitization",
          cmd: `semgrep --config "${securityRulePath("data-sanitization.yml")}" . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          scoped_cmd_template: `semgrep --config "${securityRulePath("data-sanitization.yml")}" {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          tool_error_codes: [2],
        },
        {
          // Web güvenliği: CORS yanlış-yapılandırma (* origin) + güvensiz cookie
          // (httpOnly/secure/sameSite — XSS/transport/CSRF). Custom semgrep (mutlak yol).
          name: "web-security",
          cmd: `semgrep --config "${securityRulePath("web-security.yml")}" . --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          scoped_cmd_template: `semgrep --config "${securityRulePath("web-security.yml")}" {files} --exclude='mycl-audit*' --exclude='.next' --exclude='dist' --exclude='build' --exclude='out' --exclude='coverage' --exclude='.turbo' --exclude='.svelte-kit' --exclude='.nuxt' --exclude='node_modules' --exclude='vendor' --exclude='target' --error --quiet`,
          tool_error_codes: [2],
        },
        {
          // Secret-scan (gitleaks — semgrep p/secrets'e ek, daha özel entropy+regex).
          // `detect` v8'in TÜM sürümlerinde çalışır (v8.19+ deprecated ama gizli/mevcut);
          // kurulu değilse exit 127 → isMissingCommand skip; leak → exit 1 → blocking.
          name: "gitleaks",
          cmd: "gitleaks detect --source src/ --no-git --no-banner --redact --exit-code 1",
        },
      ],
    },
  },
  14: {
    id: 14,
    type: "mechanical",
    name_i18n_key: "phase.14.name",
    gate_module_path: gatePath("phase-14.ts"),
    required_audits: ["unit-pass", "unit-fail"],
    mechanical_config: {
      // v15.9: scoped varyant — değişen dosyalarla ilgili testler (profilde
      // test_scoped varsa, örn. vitest related / jest --findRelatedTests).
      scan_cmd: { type: "profile_key", key: "test", scoped_key: "test_scoped" },
      max_rescans: 0,
      skip_unless: "always",
    },
  },
  15: {
    id: 15,
    type: "mechanical",
    name_i18n_key: "phase.15.name",
    gate_module_path: gatePath("phase-15.ts"),
    required_audits: ["integration-pass", "integration-fail"],
    mechanical_config: {
      scan_cmd: { type: "profile_key", key: "integration" },
      max_rescans: 0,
      skip_unless: "always",
    },
  },
  16: {
    id: 16,
    type: "mechanical",
    name_i18n_key: "phase.16.name",
    gate_module_path: gatePath("phase-16.ts"),
    required_audits: ["e2e-pass", "e2e-fail", "phase-15-skipped"],
    mechanical_config: {
      // v15.0 Batch B: project_type-aware E2E runner. node-npm + web →
      // Playwright, python-uv + api → hurl, library → null (skip). Her stack
      // profilinde `e2e_by_project_type` blok dolu.
      scan_cmd: { type: "project_type", which: "e2e" },
      max_rescans: 0,
      skip_unless: "has_ui",
    },
  },
  17: {
    id: 17,
    type: "mechanical",
    // YZLLM 2026-06-19: Faz 17 artık SIZMA TESTİ (pentest), yük testi DEĞİL. Mekanik runner KOŞMAZ —
    // index.ts `if (next === 17)` runPhase17Pentest'i (DAST katana+nuclei) çağırır. Bu mechanical_config
    // yalnız faz-tipini + skip kapısını belirler; scan_cmd kullanılmaz.
    name_i18n_key: "phase.17.name",
    gate_module_path: gatePath("phase-17.ts"),
    required_audits: ["phase-17-complete", "phase-16-skipped"],
    mechanical_config: {
      // scan_cmd interceptör tarafından BYPASS edilir (load test kaldırıldı). YZLLM 2026-06-20:
      // skip_unless has_ui DEĞİL has_web_target — sızma testi UI gerektirmez; HTTP sunan her proje
      // (web VEYA API) taranır. Yalnız HTTP-hedefi olmayan (CLI/library/ml) projelerde atlanır.
      scan_cmd: { type: "project_type", which: "load" },
      max_rescans: 0,
      skip_unless: "has_web_target",
    },
  },
};

/**
 * Sonraki faz haritası — ARDIŞIK, atlamasız. N → N+1. MyCL pipeline 20 faz,
 * deterministik: her faz mutlaka ziyaret edilir. Controller'ı olmayan fazlar
 * (PHASE_SPECS'te yok) otomatik skip stub ile geçer.
 */
export const PHASE_TRANSITIONS: Record<PhaseId, PhaseId | null> = {
  // Phase 0 (Debug Triage) standalone — pipeline'a girmez; sonrası yok.
  0: null,
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11,
  11: 12, 12: 13, 13: 14, 14: 15, 15: 16, 16: 17, 17: null,
};

export function hasController(phase: PhaseId): boolean {
  return getSpec(phase) !== undefined;
}

export function getSpec(phase: PhaseId): PhaseSpec | undefined {
  return PHASE_SPECS[phase];
}

/**
 * Zorunlu fazlar — her geliştirmede mutlaka çalışır. Opsiyonel fazlar
 * (5,6,7,8,9) orkestra ajanı tarafından Faz 1 sonrası kullanıcıya sorulur.
 * Faz 0 (Debug Triage) standalone — pipeline'a dahil değil, ne zorunlu ne
 * opsiyonel.
 *
 * Tek source of truth — frontend PhaseSidebar.tsx senkron tutmalı.
 */
// Faz 9 (Risk İncelemesi) ZORUNLU (YZLLM 2026-06-11: "Faz 9 asla atlanmasın" — düşman-gözü doğrulama katmanı,
// insan-incelemesinin yerini alır; atlanırsa kontrol delinir). Runtime zaten 9'u atlamıyor (isPhaseSkippedByScope
// yalnız 5-8); bu set'ler de artık gerçeği yansıtır.
export const REQUIRED_PHASES: ReadonlySet<PhaseId> = new Set([
  1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
]);

// Yalnız 5 (UI)/6 (UI review)/7 (DB) gerçekten opsiyonel (UI/DB yoksa atlanır). Faz 8 (TDD) artık ZORUNLU.
export const OPTIONAL_PHASES: ReadonlySet<PhaseId> = new Set([5, 6, 7]);

export function isRequiredPhase(phase: PhaseId): boolean {
  return REQUIRED_PHASES.has(phase);
}
