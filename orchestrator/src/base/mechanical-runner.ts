// base/mechanical-runner — LLM olmadan lokal komut çalıştıran fazlar (Faz 10-17).
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
import { buildProjectFacts } from "../project-facts.js";
import { ensureTsPruneConfig, ensureSemgrepIgnore, isNextJsProject, NEXT_TSPRUNE_IGNORE } from "../ensure-gate-configs.js";
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

// Skip reason SINIFLANDIRMASI (YZLLM 2026-07-01, "sarı olanların sebebi"): bir gate atlandığında iki AYRI durum var:
//   (a) UYGULANAMAZ (N/A) — araç bu proje tipine KAVRAMSAL olarak uygulanamaz (TS aracı JS projesinde).
//       Bu bir eksiklik DEĞİL → nötr sunulur (sarı "aracı ekle" uyarısı YANLIŞ alarm olurdu).
//   (b) DOĞRULANMADI — araç kurulabilirdi ama yok / stub / MyCL-aracı bozuk / girdi eksik / profilde komut yok →
//       GERÇEK boşluk, sarı uyar. Şüpheli reason'ı (a)'ya koyma → false-green (kontrol edilmedi ama "geçerli değil" sanılır).
// MAHKEME (2026-07-01, çapraz-aile): `profile_resolve_null` BİLEREK N/A'DAN ÇIKARILDI — profilde komut null olması
// (ör. dart/deno `security: null`) "bu stack güvenli" DEMEK DEĞİL; Faz 13 güvenlik boyutu null iken nötr sunmak
// false-green + harness-verdict'in securitySkip→PARTIAL kararıyla çelişir. Yalnız KAVRAMSAL-N/A (TS-tool) burada.
export const GATE_SKIP_NOT_APPLICABLE = new Set<string>([
  "ts_tool_js_project", // TS aracı (ts-prune/tsc) JS projesinde — .ts kaynağı yok
  "ts_tool_not_applicable", // TS aracı ama tsconfig yok
]);

/** Bir skip reason "uygulanamaz (N/A)" mı (nötr sunulmalı) yoksa "doğrulanmadı" mı (sarı uyarı). SAF. */
export function isNotApplicableSkip(reason: string | undefined | null): boolean {
  if (!reason) return false;
  // detail formatı: "<reason> cmd=..." → ilk kelime reason'dır.
  return GATE_SKIP_NOT_APPLICABLE.has(String(reason).trim().split(/\s+/)[0]);
}

/** SAF (YZLLM 2026-07-24 "aracı eklemeye karar vermesi ve çalıştırması gerekiyordu"): bir gate-skip'i
 *  ARAÇ KURULUMUYLA oto-çözülebilir mi? missing_command (araç/komut sistemde yok) + stub_script (echo-stub,
 *  gerçek kontrol yok) → EVET (kuyruğa "aracı kur + gate'i koştur" işi açılır). mycl_tool_broken (MyCL'in
 *  KENDİ paketleme bug'ı — proje işi değil), aborted (kullanıcı iptali), profile_resolve_null (stack bu
 *  boyutu tanımlamıyor — profil işi) ve N/A sınıfı → HAYIR (yalnız görünür kalır). */
export function isToolInstallableSkip(reason: string | undefined | null): boolean {
  if (!reason) return false;
  const first = String(reason).trim().split(/\s+/)[0];
  if (first === "missing_command" || first === "stub_script" || first === "redundant_gate_command") return true;
  // 2026-08-03: profilde komut BOŞ olması iki ayrı şey olabilir —
  //  (a) gerekçesi yazılmış ve başka bir tarayıcı kapsıyor  → nötr, iş açma (yanlış alarm olurdu)
  //  (b) gerekçesiz boşluk (profil eksik)                    → GERÇEK eksik → "aracı kur" işi aç
  // Ayrım skip detayına yazılan `gap=` / `covered=` alanlarından okunur (aşağıdaki sınıflandırıcı).
  if (first === "profile_resolve_null") return classifyProfileNullDetail(String(reason)) === "installable_gap";
  return false;
}

/** SAF: `profile_resolve_null gap=<neden> covered=<n>` detayını sınıflandır. */
export function classifyProfileNullDetail(detail: string): "not_applicable" | "installable_gap" {
  const covered = /covered=(\d+)/.exec(detail)?.[1];
  const hasGap = detail.includes("gap=");
  // Gerekçe VAR ve en az bir tarayıcı kapsıyorsa nötr; aksi halde gerçek boşluk.
  return hasGap && Number(covered ?? 0) > 0 ? "not_applicable" : "installable_gap";
}

// OE denetimi (YZLLM onayı 2026-07-29): DEĞİŞMEYEN skip mesajları chat'e aynı neden sürdükçe BİR kez
// yazılır (canlı cave kanıtı: "Faz 12 atlandı — komut tanımlı değil" 40 iterasyon boyunca her tur aynı
// mesaj). Yalnız chat tekrarı kesilir — audit event'i HER iterasyon yazılmaya devam eder ve doğrulama
// özeti atlanan boyutları her tur listeler (KATI #4 görünürlük kaybolmaz). Gate GERÇEKTEN koştuğunda
// kayıt silinir → araç sonradan kaldırılır/bozulursa skip YENİDEN duyurulur; neden değişirse de duyurulur.
// Bellek içi (süreç yeniden başlarsa bir kez daha söylenir — kasıtlı, kalıcı dosya durumu gerekmez).
const announcedSkips = new Map<string, string>(); // key(proje|faz|kapsam) → son duyurulan skip nedeni

/** SAF karar: bu skip chat'e duyurulmalı mı? İlk görüş / neden değişimi → true (ve kaydedilir). */
export function shouldAnnounceSkip(key: string, reason: string): boolean {
  if (announcedSkips.get(key) === reason) return false;
  announcedSkips.set(key, reason);
  return true;
}

/** Gate gerçekten koştu (pass/fail) → skip kaydını sil ki sonraki skip yeniden duyurulsun. */
export function clearAnnouncedSkip(key: string): void {
  announcedSkips.delete(key);
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * MechanicalCommandSpec'i resolve eder → çalıştırılabilir komut string'i
 * veya null (profile/state eksik → skip semantiği).
 *
 * Üç biçim (v15.0 Batch A):
 *   - string: literal komut, doğrudan döner (backward-compat).
 *   - profile_key: `state.stack` profilinden komut alır.
 *   - project_type: Faz 16 (E2E) için stack + project_type kombinasyonu. `load` ucu
 *     Faz 17 pentest'e geçtiğinden üretimde koşmaz (yalnız birim testlerinde).
 */
/** Shell tek-tırnak quote (regex yok): tek tırnakları '\'' ile escape. */
export function shellQuote(p: string): string {
  return `'${p.split("'").join("'\\''")}'`;
}

/** `{files}` placeholder'ını shell-safe scope yollarıyla genişlet. */
export function expandFilesPlaceholder(template: string, files: string[]): string {
  return template.split("{files}").join(files.map(shellQuote).join(" "));
}

/**
 * Bu kapının komutu, başka bir boyutun komutunun AYNISI mı? (paket yöneticisi script'leri açılarak)
 * Karşılaştırılan boyutlar: build/test/lint — bir kapının bunlardan birini tekrar çalıştırması ölçüm değildir.
 */
async function checkRedundantAgainstSiblings(
  state: State,
  key: string,
  resolved: string,
): Promise<{ redundant: boolean; sameAs?: string }> {
  if (!state.stack) return { redundant: false };
  // Yalnız ölçüm/analiz kapıları için anlamlı (build'in kendisi build'e eşit olabilir).
  if (!["perf", "simplify", "security", "integration"].includes(key)) return { redundant: false };
  try {
    const profile = await loadProfile(state.stack);
    const siblings: Record<string, string | null> = {};
    for (const k of ["build", "test", "lint"] as const) {
      if (k === key) continue;
      siblings[k] = resolveCommand(profile, k as ProfileCommandKey);
    }
    const scripts = await readManifestScripts(state.project_root);
    return isRedundantGateCommand({ resolved, siblings, manifestScripts: scripts });
  } catch {
    return { redundant: false }; // profil/manifest okunamadı → kuşkuda ENGELLEME (yanlış alarm yasağı)
  }
}

/** package.json scripts (yoksa boş) — "npm run X" gövdesini açmak için. */
async function readManifestScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

/** Profildeki `command_gaps` girdisini oku (komut null ise NEDEN + neyle kapsanıyor). null = gerekçe yok. */
export async function resolveCommandGap(
  stack: State["stack"] & string,
  spec: MechanicalCommandSpec,
): Promise<{ reason: string; covered_by?: string[] } | null> {
  if (typeof spec === "string" || spec.type !== "profile_key") return null;
  try {
    const profile = (await loadProfile(stack)) as unknown as {
      command_gaps?: Record<string, { reason?: string; covered_by?: string[] }>;
    };
    const g = profile?.command_gaps?.[spec.key];
    return g?.reason ? { reason: g.reason, covered_by: g.covered_by } : null;
  } catch {
    return null; // profil okunamadı → gerekçe yok say (kuşkuda GERÇEK boşluk → görünür kalır)
  }
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
 * Ortam/spawn faulti (KOD veya TEST hatası DEĞİL): runner süreci bile başlatılamadı —
 * E2BIG / posix_spawn / ARG_MAX (argument list too long) / ENOMEM / EAGAIN. Testler
 * KOŞMADI. Bu durum tdd-red SAYILMAMALI: kod-fix → rollback → tekrar döngüsünü tetikler
 * (adminpanel 21-iterasyon Faz 8 loop'unun çekirdeği, deep-research 2026-06-13). Ortam
 * faultu → tdd-unverified + halt (kullanıcı ortamı temizler), kod codegen'i tetiklenmez.
 */
export function isSpawnEnvFailure(result: {
  code: number;
  stdout: string;
  stderr: string;
}): boolean {
  const s = `${result.stderr}\n${result.stdout}`;
  return (
    /\bE2BIG\b/.test(s) ||
    /posix_spawn/i.test(s) ||
    /argument list too long/i.test(s) ||
    /\bENOMEM\b/.test(s) ||
    /spawn \S+ EAGAIN/.test(s) ||
    // execCmd'in spawn-fault/timeout işareti (YZLLM 2026-06-23 sessiz-fallback denetimi): timeout-kill
    // (SIGTERM/SIGKILL, code=null) errno metni TAŞIMAZ → işaret olmazsa "normal fail" sanılıp fix-döngüsüne girer.
    /\[ENV\] (command timed out|spawn failed)/i.test(s)
  );
}

/**
 * 2026-06-10 (YZLLM logları): MyCL'in KENDİ node aracı (csp-check.mjs / headers-check.mjs) bundle'da
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
 * 2026-06-10 (YZLLM): TypeScript-only bir araç (ts-prune/ts-morph/tsc) JS projesinde (tsconfig yok) çöktüğünde
 * bu PROJE hatası DEĞİL — araç bu proje tipine UYGULANAMAZ. Eski davranış: ts-prune ts-morph FileNotFoundError
 * ile patlıyor → MyCL "proje hatası" sanıp "tsconfig oluştur + yeni iterasyon" gibi saçma fix'e gidiyordu.
 * Tespit: ts-morph/ts-prune/tsc imzası + (FileNotFoundError | tsconfig bulunamadı). SAF.
 */
/**
 * 2026-06-11 (YZLLM: "Faz 12 1 saniyede geçti — normal mi?"): gate script'i GERÇEK kontrol değil, echo-stub
 * ("vite build && echo 'perf check passed'" gibi). Echo'yla "geçti" basan script o boyutu DOĞRULAMAZ → gate
 * görünür biçimde atlanır (sahte-yeşil sayılmaz). SAF.
 */
export function isStubGateCommand(cmd: string): boolean {
  return /echo\s+['"][^'"]*(pass|passed|ok|success|check)[^'"]*['"]/i.test(cmd);
}

/**
 * SAF (2026-08-03): "anlamsız eşitlik" stub'ı — bir kapının komutu BAŞKA bir kapının komutunun aynısı mı?
 *
 * CANLI KANIT: MyCL'in kendi Faz 5 şablonu codegen'e `"perf": "npm run build"` yazmayı ZORUNLU tutuyordu
 * ("prod build başarılı = performans temeli tamam" varsayımı). Sonuç: performans kapısı yalnız build'i
 * TEKRAR çalıştırıyordu — hiçbir performans ölçümü yok, ama kapı yeşil. `isStubGateCommand` yalnız
 * `echo "passed"` desenini yakaladığı için bu sessizce geçiyordu.
 *
 * Paket yöneticisi `run <script>` biçimindeki komutlar manifest gövdesine açılır (npm/pnpm/yarn/bun);
 * açılmış gövde başka bir boyutun gövdesiyle aynıysa bu kapı O boyutu ölçüyordur, kendi boyutunu DEĞİL.
 */
export function isRedundantGateCommand(inp: {
  /** Bu kapının çözülmüş komutu (örn. "npm run perf"). */
  resolved: string;
  /** Diğer boyutların çözülmüş komutları (örn. { build: "npm run build", test: "npm test" }). */
  siblings: Readonly<Record<string, string | null | undefined>>;
  /** package.json scripts (varsa) — "npm run X" gövdesini açmak için. */
  manifestScripts?: Readonly<Record<string, string>>;
}): { redundant: boolean; sameAs?: string } {
  // Script gövdesi başka bir script'i çağırabilir (canlı vaka: perf → "npm run build" → "vite build").
  // Bu yüzden ÖZYİNELEMELİ açılım; döngüye karşı derinlik tavanı + görülen script kaydı.
  const expand = (cmd: string, depth = 0, seen = new Set<string>()): string => {
    const norm = cmd.trim().replace(/\s+/g, " ");
    if (depth >= 5) return norm;
    const m = /^(?:npm|pnpm|yarn|bun)(?: run)? ([\w:-]+)$/.exec(norm);
    const scriptName = m?.[1];
    if (!scriptName || seen.has(scriptName)) return norm;
    const body = inp.manifestScripts?.[scriptName];
    if (!body) return norm;
    seen.add(scriptName);
    return expand(body, depth + 1, seen);
  };
  const mine = expand(inp.resolved);
  if (!mine) return { redundant: false };
  for (const [key, sib] of Object.entries(inp.siblings)) {
    if (!sib) continue;
    if (expand(sib) === mine) return { redundant: true, sameAs: key };
  }
  return { redundant: false };
}

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
  /** YZLLM 2026-06-14: fail eden extra-scan'ların TAM çıktısı — outcome.stderr'e katılır ki error-analysis,
   *  main-scan'in (örn. eslint E2BIG) ardındaki GERÇEK bulguları (semgrep "N Code Findings") görüp maskelemesin. */
  private extraFailOutputs: string[] = [];

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

    // Önden-doğru (YZLLM 2026-07-01, "sarı kalmasın"): bu faz semgrep kullanıyorsa (Faz 10 code-quality /
    // Faz 13 güvenlik seti — hep extra_scans'te) `.semgrepignore` yaz (yoksa) → minified-OLMAYAN vendor
    // bundle'ları (CKEditor/TinyMCE `bundles/`) taranıp false-positive üretmesin. CLI --exclude minified'ı
    // eler, bu dizin-anchored vendor'ı. Var olana dokunmaz; fail-soft.
    if ((opts.mechanical.extra_scans ?? []).some((e) => /\bsemgrep\b/.test(e.cmd))) {
      const si = await ensureSemgrepIgnore(opts.state.project_root).catch(() => "present" as const);
      if (si === "written") log.info(opts.tag, "wrote .semgrepignore (vendor/minified false-positive önleme)");
    }

    // Ana scan loop'u (mevcut behavior) — sonuç pass/fail/skipped.
    const mainOutcome = await this.runMainScan(timeout);

    // Extra scans (opsiyonel — Faz 13 semgrep, vs.) — main scan sonucu ne olursa olsun çalışır.
    // 2026-08-03 DÜZELTME: eskiden ana tarama atlanınca ek taramalar da atlanıyordu. Faz 13'te ana komut
    // stack profilinden gelir ve dört stack'te (dart/deno/flutter/swift) BOŞ → o projelerde semgrep dahil
    // TÜM güvenlik taramaları hiç koşmadı (sıfır güvenlik doğrulaması). Ek taramalar stack'ten BAĞIMSIZ
    // olduğu için ana komutun yokluğu onları geçersiz kılmaz. Bayrak opt-in → diğer fazlarda davranış aynı.
    if (mainOutcome.kind === "skipped" && !opts.mechanical.run_extras_when_main_skipped) {
      return mainOutcome;
    }

    const extras = opts.mechanical.extra_scans;
    if (!extras || extras.length === 0) {
      if (mainOutcome.kind === "pass") emitChatMessage("system", `✅ ${this.label} — geçti.`);
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
      // YZLLM 2026-06-14: extra-scan BULGULARINI da stderr'e KAT — yoksa error-analysis yalnız main-scan çıktısını
      // (örn. eslint E2BIG) görüp gerçek bulguları (semgrep "N Code Findings") MASKELİYOR → yanlış teşhis + loop.
      const mainStderr = mainOutcome.kind === "fail" ? mainOutcome.stderr : "";
      const stderr = [mainStderr, ...this.extraFailOutputs].filter((s) => s.trim()).join("\n\n---\n\n");
      return {
        kind: "fail",
        rescans: mainOutcome.kind === "fail" ? mainOutcome.rescans : 0,
        stderr,
      };
    }
    // TÜM alt-taramalar da geçti → şimdi dürüstçe "geçti" denebilir.
    if (mainOutcome.kind === "pass") emitChatMessage("system", `✅ ${this.label} — geçti (tüm alt taramalar dahil).`);
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
    // OE denetimi: aynı skip nedeni sürdükçe chat mesajı bir kez (audit her zaman yazılır).
    const skipKey = `${opts.state.project_root}|${opts.phaseId}|extra:${extra.name}`;

    // require_file: project_root içinde dosya yoksa skip (örn. snyk için
    // ".snyk", k6 için "loadtest.js").
    if (extra.require_file) {
      try {
        await access(join(opts.state.project_root, extra.require_file));
      } catch (e) {
        const code = (e as { code?: string }).code;
        // errno-AYRIMI (sessiz-fallback denetimi): yalnız ENOENT "gerçekten yok → meşru skip". Dosya VAR ama
        // okunamıyorsa (EACCES/ELOOP/EIO) bunu "yok" sanmak, güvenlik/perf gate'ini (snyk/k6) sessiz no-op
        // yapar ve tekrarlayan izin/bozulma sorununu maskeler → fail-closed + GÖRÜNÜR.
        if (code && code !== "ENOENT") {
          log.error(opts.tag, `${extra.name} require_file access error (not ENOENT)`, { code, file: extra.require_file });
          await appendAudit(opts.state.project_root, {
            ts: Date.now(),
            phase: opts.phaseId,
            event: `${extra.name}-access-error`,
            caller: "mycl-orchestrator",
            detail: `code=${code} file="${extra.require_file}"`,
          });
          emitChatMessage(
            "system",
            `❌ ${extra.name}: gerekli dosya (${extra.require_file}) VAR ama erişilemiyor (${code}) — ortam sorunu, ` +
              `gate ATLANMADI (sessiz no-op değil). Erişimi düzeltip tekrar koş.`,
          );
          return "fail";
        }
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `${extra.name}-skipped`,
          caller: "mycl-orchestrator",
          detail: `missing_file file="${extra.require_file}"`,
        });
        if (shouldAnnounceSkip(skipKey, "missing_file"))
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
      if (shouldAnnounceSkip(skipKey, "missing_command"))
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
      if (shouldAnnounceSkip(skipKey, "mycl_tool_broken"))
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
      if (shouldAnnounceSkip(skipKey, "ts_tool_not_applicable"))
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
      if (shouldAnnounceSkip(skipKey, "tool_error"))
        emitChatMessage(
          "system",
          `⏭ ${extra.name} atlandı — araç düzgün çalışmadı (çıkış kodu ${result.code}; bulgu değil, araç/sürüm sorunu).`,
        );
      return "skipped";
    }

    // Tarama GERÇEKTEN koştu (pass/fail) → skip kaydını sil; sonraki skip yeniden duyurulur.
    clearAnnouncedSkip(skipKey);

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
    // Tam çıktıyı (snippet değil) topla → error-analysis bu bulguları main-scan'in (örn. E2BIG) ardında görsün,
    // maskelenmesin (gerçek-koşu: Faz 10 eslint-E2BIG semgrep'in 2 bulgusunu gizleyip loop yaptırdı).
    if (extraTail) this.extraFailOutputs.push(`[${extra.name}]\n${extraTail.slice(0, 2000)}`);
    return "fail";
  }

  /**
   * Mevcut ana scan akışı (scan_cmd + fix_cmd loop). Önceden inline `run()`
   * gövdesindeydi; extra_scans pattern'ı eklenince ayrı method'a çıkarıldı.
   */
  private async runMainScan(timeout: number): Promise<MechanicalOutcome> {
    const { opts } = this;
    // OE denetimi: aynı skip nedeni sürdükçe chat mesajı bir kez (audit her zaman yazılır).
    const skipKey = `${opts.state.project_root}|${opts.phaseId}|main`;
    // v15.0 Batch A: scan_cmd ve fix_cmd artık literal string olabilir veya
    // profile_key/project_type resolver spec'i. Resolve sonucu null ise (profile
    // yok, key tanımsız) → phase-N-skipped (subprocess spawn denemesi yok).
    let scanCmd = await resolveMechanicalCmd(
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
      // 2026-08-03: profilde komut yoksa GEREKÇE var mı? (command_gaps) — gerekçeli ve başka bir tarayıcıyla
      // kapsanan boşluk NÖTR sunulur; gerekçesiz boşluk GERÇEK eksiktir → otomatik "aracı kur" işi açılır.
      const gap = stackDetected ? await resolveCommandGap(opts.state.stack!, opts.mechanical.scan_cmd) : null;
      const auditDetail = stackDetected
        ? `profile_resolve_null stack="${opts.state.stack}"` +
          (gap ? ` gap=${gap.reason} covered=${gap.covered_by?.length ?? 0}` : "")
        : `stack_not_detected`;
      const userMsg = stackDetected
        ? gap && (gap.covered_by?.length ?? 0) > 0
          ? `➖ ${this.label}: bu proje türünde ayrı bir araç yok — bu boyut ${gap.covered_by!.join(", ")} tarafından kapsanıyor.`
          : `⏭ ${this.label} atlandı — bu proje türü için tanımlı komut yok. Bu boyut DOĞRULANMADI.`
        : `⏭ ${this.label} atlandı — projenin teknoloji türü tespit edilemedi.`;
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `phase-${opts.phaseId}-skipped`,
        caller: "mycl-orchestrator",
        detail: auditDetail,
      });
      if (shouldAnnounceSkip(skipKey, stackDetected ? "profile_resolve_null" : "stack_not_detected"))
        emitChatMessage("system", userMsg);
      return { kind: "skipped", reason: "profile_resolve_null" };
    }
    // 2026-08-03: ANLAMSIZ EŞİTLİK — bu kapının komutu başka bir boyutun komutuyla aynıysa (canlı örnek:
    // `perf` = `npm run build`) bu kapı KENDİ boyutunu ölçmüyordur. Sahte yeşil yerine görünür atlama +
    // otomatik iş ("bu boyutu gerçekten ölçen bir komut ekle").
    if (typeof opts.mechanical.scan_cmd !== "string" && opts.mechanical.scan_cmd.type === "profile_key") {
      const redundant = await checkRedundantAgainstSiblings(opts.state, opts.mechanical.scan_cmd.key, scanCmd);
      if (redundant.redundant) {
        const detail = `redundant_gate_command sameAs=${redundant.sameAs} cmd="${scanCmd}"`;
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail,
        });
        if (shouldAnnounceSkip(skipKey, "redundant_gate_command"))
          emitChatMessage(
            "system",
            `⚠️ ${this.label} atlandı — komutu "${redundant.sameAs}" boyutunun komutuyla AYNI (${scanCmd}). ` +
              `Bu, o boyutu tekrar çalıştırmaktır; bu boyut DOĞRULANMADI. Gerçekten ölçen bir komut gerekiyor.`,
          );
        return { kind: "skipped", reason: detail };
      }
    }
    // 2026-06-11 (YZLLM "1 saniyede geçti — normal mi?"): echo-stub script (gerçek kontrol değil) → bu boyut
    // DOĞRULANMAZ; sahte-yeşil yerine görünür skip.
    if (isStubGateCommand(scanCmd)) {
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: `phase-${opts.phaseId}-skipped`,
        caller: "mycl-orchestrator",
        detail: `stub_script cmd="${scanCmd}"`,
      });
      if (shouldAnnounceSkip(skipKey, "stub_script"))
        emitChatMessage(
          "system",
          `⚠️ ${this.label} atlandı — script gerçek bir kontrol içermiyor (echo-stub: "${scanCmd.slice(0, 80)}"). Bu boyut DOĞRULANMADI; gerçek bir kontrol komutu ekleyin.`,
        );
      return { kind: "skipped", reason: "stub_script" };
    }
    // TS-only araç (ts-prune/tsc) + JS projesi (tsconfig kalıntısı olsa bile .ts kaynağı yok) → koşmak anlamsız
    // (boş tarama = sahte-yeşil). project-facts dile bakar (kaynak dosyalardan).
    if (/ts-prune|\btsc\b/.test(scanCmd)) {
      const facts = await buildProjectFacts(opts.state.project_root).catch(() => null);
      if (facts?.language === "javascript") {
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail: `ts_tool_js_project cmd="${scanCmd}"`,
        });
        if (shouldAnnounceSkip(skipKey, "ts_tool_js_project"))
          emitChatMessage(
            "system",
            `⏭ ${this.label} atlandı — TypeScript aracı ama proje JavaScript (kaynakta .ts yok${facts.hasTsconfig ? "; tsconfig.json kalıntı görünüyor" : ""}). Boş tarama "geçti" sayılmaz.`,
          );
        return { kind: "skipped", reason: "ts_tool_js_project" };
      }
    }
    // Önden-doğru (YZLLM 2026-06-19, "sarı kalmasın"): Faz 11 ts-prune Next.js-AWARE.
    // Buraya geldiyse (ts-prune + JS-skip geçilmedi) proje TypeScript. Next.js ise
    // framework-convention export'ları false-positive vermesin diye `.ts-prunerc.json` yaz
    // (yoksa) → ts-prune temiz tarar → fail-then-fix (sarı) OLMAZ. [[project_gate_fix_requirements_0619]]
    if (/ts-prune/.test(scanCmd)) {
      const tsp = await ensureTsPruneConfig(opts.state.project_root).catch(() => "present" as const);
      if (tsp === "written") {
        log.info(opts.tag, "wrote Next.js-aware .ts-prunerc.json (ts-prune false-positive önleme)");
      }
      // ASIL ETKİ (YZLLM canlı-test 0621): config-ignore bu ts-prune sürümünde UYGULANMIYOR ama CLI
      // `-i` ÇALIŞIYOR (ampirik: Vestel). Next.js'te framework-convention + tool-config regex'ini CLI
      // `-i` ile enjekte et → middleware/layout/global-error/page/vitest.config false-positive'leri elenir.
      // Tek-tırnak shell-güvenli (regex'te tek-tırnak yok; execCmd /bin/sh -c).
      if (await isNextJsProject(opts.state.project_root)) {
        scanCmd = `${scanCmd} -i '${NEXT_TSPRUNE_IGNORE}'`;
        log.info(opts.tag, "ts-prune -i Next.js-aware ignore enjekte edildi (config-ignore etkisiz)");
      }
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
        if (shouldAnnounceSkip(skipKey, "missing_command"))
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
        if (shouldAnnounceSkip(skipKey, "mycl_tool_broken"))
          emitChatMessage(
            "system",
            `⏭ ${this.label} atlandı — MyCL'in kendi aracı çalışmadı (paketleme bug'ım, proje sorunu DEĞİL).`,
          );
        return { kind: "skipped", reason: "mycl_tool_broken" };
      }
      // TS-only araç (ts-prune/ts-morph/tsc) JS projesinde (tsconfig yok) → uygulanamaz → skip.
      // YZLLM vakası: Faz 11 ts-prune JS projesinde çöküp "tsconfig oluştur + yeni iterasyon" saçmalığına yol açtı.
      if (isTsToolNotApplicable(scanResult)) {
        log.warn(opts.tag, "TS tool not applicable (no tsconfig / JS project) — skipping", { cmd: scanCmd });
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: `phase-${opts.phaseId}-skipped`,
          caller: "mycl-orchestrator",
          detail: `ts_tool_not_applicable cmd="${scanCmd}"`,
        });
        if (shouldAnnounceSkip(skipKey, "ts_tool_not_applicable"))
          emitChatMessage(
            "system",
            `⏭ ${this.label} atlandı — bu TypeScript aracı JS projesine (tsconfig yok) uygulanamaz. Proje hatası DEĞİL; tsconfig oluşturmuyorum.`,
          );
        return { kind: "skipped", reason: "ts_tool_not_applicable" };
      }
      // Tarama GERÇEKTEN koştu (skip sınıfına girmedi) → skip kaydını sil; sonraki skip yeniden duyurulur.
      clearAnnouncedSkip(skipKey);
      // Ortam/spawn faultu VEYA timeout (süreç bile başlatılamadı / asıldı) → testler KOŞMADI. Bunu "fail"
      // (kod hatası) sanıp fix_cmd retry + orkestratör codegen döngüsüne sokmak YANLIŞ (adminpanel 21-iter kökü).
      // GÖRÜNÜR fail + [ENV]-imzalı stderr döndür (retry YOK) → failPhase'in isEnvironmentError gate'i durdurur.
      if (isSpawnEnvFailure(scanResult)) {
        const why = scanResult.stderr.trim() || scanResult.stdout.trim();
        log.error(opts.tag, "spawn/timeout env-fault — halting (NOT a project failure)", { cmd: scanCmd, why: why.slice(0, 200) });
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: opts.fail_event ?? `phase-${opts.phaseId}-fail`,
          caller: "mycl-orchestrator",
          detail: `spawn_env_fault cmd="${scanCmd}" ${why.slice(0, 160)}`,
        });
        emitChatMessage(
          "system",
          `🔴 ${this.label} — komut çalıştırılamadı/asıldı (ortam: bellek/işlem/timeout). Bu PROJE hatası DEĞİL; ` +
            `kod kurcalamıyorum. Ortamı düzeltip tekrar koş. (${why.slice(0, 120)})`,
        );
        return { kind: "fail", rescans, stderr: why };
      }
      if (scanResult.code === 0) {
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: opts.pass_event,
          caller: "mycl-orchestrator",
          detail: `cmd="${scanCmd}" rescans=${rescans}`,
        });
        // "geçti" mesajı BURADA atılmaz (YZLLM 2026-06-11: Faz 13 'geçti' dedi, semgrep sonra fail oldu —
        // yanıltıcı). Final mesajı run() tüm extra taramalar bitince atar.
        return { kind: "pass", rescans };
      }

      if (!fixCmd || rescans >= opts.mechanical.max_rescans) {
        // v15.7 (2026-05-27): Playwright "No tests found", ESLint, npm gibi
        // tool'lar hatayı stdout'a yazıyor. stderr boşsa stdout'a düş ki
        // audit + chat snippet'i boş kalmasın.
        const tail = scanResult.stderr.trim() || scanResult.stdout.trim();
        const snippet = tail.slice(0, 200);
        // Fail audit'i fail_event opsiyoneline bağlama (sessiz-fallback denetimi): fail_event tanımsız bir
        // faz başarısız olursa müfettiş trajectory'si audit.jsonl'den HİÇ fail kaydı görmez (gözle görünür
        // ❌ var ama makine-izi yok → boşluk). Her zaman bir fail event yaz (yoksa jenerik phase-N-fail).
        await appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.phaseId,
          event: opts.fail_event ?? `phase-${opts.phaseId}-fail`,
          caller: "mycl-orchestrator",
          detail: snippet,
        });
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
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
        killed?: boolean;
        signal?: string | null;
      };
      const numericCode = typeof e.code === "number";
      // Timeout-kill (execp timeout → SIGTERM/SIGKILL, code=null) ve spawn-fault (code=string errno:
      // ENOMEM/EAGAIN/E2BIG) GERÇEK exit DEĞİL. code:1'e (normal lint/test fail) yıkamak, asılan aracı/
      // ortam-faultunu sessiz "proje-fail"e çevirir → boşuna fix_cmd retry + orkestratör codegen-rollback
      // döngüsü (adminpanel 21-iter Faz 8 KÖKÜ, 2026-06-23 denetimi). stderr'i [ENV] işaretle ki
      // isSpawnEnvFailure (scan loop) + isEnvironmentError (failPhase) yakalayıp döngüyü retry'sız durdursun
      // (timeout'ta errno METNİ yoktur → işaret olmazsa gizli kalır).
      const timedOut = e.killed === true || e.signal === "SIGTERM" || e.signal === "SIGKILL";
      const spawnErrno = !numericCode && typeof e.code === "string" ? e.code : "";
      let stderr = String(e.stderr ?? e.message ?? "");
      if (timedOut) stderr = `[ENV] command timed out / process killed after ${timeout_ms}ms (no exit code) — ${stderr}`;
      else if (spawnErrno) stderr = `[ENV] spawn failed (${spawnErrno}) — ${stderr}`;
      return {
        code: numericCode ? (e.code as number) : 1,
        stdout: String(e.stdout ?? ""),
        stderr,
      };
    }
  }
}
