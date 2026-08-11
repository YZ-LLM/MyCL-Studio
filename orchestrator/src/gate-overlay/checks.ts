// gate-overlay/checks — phase_end gate'lerinin İTERASYON SONU denetimi.
//
// NEDEN ARAÇ ANI KANCASI YETMİYOR: kanca yalnız YAZMA ARAÇLARINI görür. Ajan `Bash` ile
// (`sed -i`, `git checkout`, betik koşturma) aynı dosyayı yan yoldan değiştirebilir. Bu yüzden
// file_immutable ve forbid_dependency_change burada İKİNCİ KEZ, taban çizgisi karşılaştırmasıyla
// DEDEKTİF olarak denetlenir: kanca önler, bu yakalar. İkisi birbirinin yedeği değil, tamamlayıcısı.
//
// NEDEN FAIL-CLOSED: bir gate SEÇİLDİYSE bu iterasyonun sözü verilmiş kısıtıdır. Doğrulayamıyorsak
// ("test komutu yok", "şemayı yorumlayamadım") doğru cevap "geçti" değil "kanıtlayamadım" =
// BAŞARISIZ'dır. Atlama olayı YAZILMAZ (`-skipped` soneki güvenlik atlaması semantiği taşır);
// dürüst duruş `-fail` + sebebin detayda taşınmasıdır.
//
// DETERMİNİZM (AD-5): aynı overlay + aynı dosya durumu → bayt aynı sonuç. Detay metinlerine
// zaman/süre/rastgele hiçbir şey karışmaz.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runSuiteProcess } from "../behavior-baseline.js";
import { isMissingCommand, isSpawnEnvFailure, resolveMechanicalCmd } from "../base/mechanical-runner.js";
import type { State } from "../types.js";
import { DEPENDENCY_MANIFEST_FILES, type CompiledOverlay } from "./compile.js";

/** Tek bir phase_end gate'inin sonucu. */
export interface OverlayCheckOutcome {
  gate_id: string;
  passed: boolean;
  /** Denetim olayı adı (ASCII). `-fail` soneki hüküm makinesinde gate başarısızlığı sayılır. */
  event: string;
  /** Denetim detayı — kısa, ASCII güvenli, ZAMANSIZ (tekrarlanabilirlik). */
  detail: string;
  /** Kullanıcıya gösterilecek tek satır Türkçe. */
  message: string;
}

/** SAF: gate kimliğinden denetim olayı adı (`file_must_change` → `overlay-file-must-change-fail`). */
export function overlayGateEvent(gateId: string, passed: boolean): string {
  return `overlay-${gateId.split("_").join("-")}-${passed ? "pass" : "fail"}`;
}

async function sha256File(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(path)).digest("hex");
  } catch {
    return null; // yok/okunamıyor — "yok" bilgisinin kendisi taşınır (compile.ts ile aynı sözleşme)
  }
}

// ───────────────────────── SAF karar çekirdekleri ─────────────────────────

/**
 * SAF: "değişmeliydi" kararı. baseline `undefined` = taban çizgisi HİÇ alınmamış → doğrulanamaz
 * → fail (kanıtsız geçmek yasak). Silinmiş dosya da bir DEĞİŞİKLİKTİR (hash → null).
 */
export function decideFileMustChange(
  baseline: string | null | undefined,
  current: string | null,
): { passed: boolean; reason: string } {
  if (baseline === undefined) {
    return { passed: false, reason: "baseline missing (cannot verify)" };
  }
  if (current === baseline) {
    return { passed: false, reason: current === null ? "file still absent" : "unchanged" };
  }
  return { passed: true, reason: current === null ? "deleted" : "changed" };
}

/** SAF: "değişmemeliydi" kararı (dedektif kanat — Bash ile yan yoldan değişimi yakalar). */
export function decideFileImmutable(
  baseline: string | null | undefined,
  current: string | null,
): { passed: boolean; reason: string } {
  if (baseline === undefined) {
    return { passed: false, reason: "baseline missing (cannot verify)" };
  }
  if (current === baseline) return { passed: true, reason: "unchanged" };
  if (current === null) return { passed: false, reason: "deleted" };
  if (baseline === null) return { passed: false, reason: "created" };
  return { passed: false, reason: "modified" };
}

/**
 * SAF: bağımlılık kilidi kararı. İki ihlal biçimi var — taban çizgisindeki bir bildirim
 * DEĞİŞTİ, ya da taban çizgisinde OLMAYAN yeni bir bildirim ORTAYA ÇIKTI (yeni paket
 * yöneticisi eklemek de bir bağımlılık değişikliğidir).
 */
export function decideDependencyLock(params: {
  baselined: Array<{ path: string; baseline: string | null; current: string | null }>;
  /** Taban çizgisinde OLMAYAN ama şimdi VAR olan bildirim dosyaları. */
  appeared: string[];
}): { passed: boolean; reason: string } {
  const changed = params.baselined
    .filter((b) => b.current !== b.baseline)
    .map((b) => b.path)
    .sort();
  const appeared = [...params.appeared].sort();
  if (changed.length === 0 && appeared.length === 0) {
    return { passed: true, reason: `${params.baselined.length} manifest unchanged` };
  }
  const parts: string[] = [];
  if (changed.length > 0) parts.push(`changed: ${changed.join(", ")}`);
  if (appeared.length > 0) parts.push(`new: ${appeared.join(", ")}`);
  return { passed: false, reason: parts.join(" | ") };
}

// ───────────────────────── Şema alt kümesi (SAF) ─────────────────────────

/**
 * Desteklenen JSON Schema ANAHTARLARI. Bilerek dar: bu dört anahtar dışında bir şey gören
 * doğrulayıcı "anlamadım" der ve gate FAIL olur — yorumlayamadığımız bir şemayla "geçti"
 * demek, doğrulama yapıyormuş gibi görünüp yapmamak olurdu.
 */
const SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
]);

/**
 * Doğrulama anlamı OLMAYAN, yalnız belgeleme amaçlı anahtarlar — yok sayılırlar. Yok saymak
 * SAHTE GEÇİŞ üretemez (hiçbir kısıt taşımıyorlar), ama şemayı elle yazan insanın alışkanlığını
 * (başlık/açıklama) kırmamak gate'in gereksiz yere kırmızıya dönmesini engeller.
 */
const SCHEMA_INERT_KEYS: ReadonlySet<string> = new Set(["$schema", "title", "description"]);

const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * SAF: şemanın desteklenen alt kümede olup olmadığını doğrular (İÇ İÇE). Sorun varsa gerekçe.
 */
export function schemaSubsetProblem(schema: unknown, where = "root"): string | null {
  if (!isPlainObject(schema)) return `${where}: schema must be an object`;
  for (const key of Object.keys(schema)) {
    if (SCHEMA_KEYS.has(key) || SCHEMA_INERT_KEYS.has(key)) continue;
    return `${where}: unsupported schema keyword "${key}"`;
  }
  if (schema.type !== undefined) {
    if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) {
      return `${where}: unsupported type ${JSON.stringify(schema.type)}`;
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      return `${where}: required must be an array of strings`;
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    return `${where}: additionalProperties must be a boolean`;
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) return `${where}: properties must be an object`;
    for (const [name, sub] of Object.entries(schema.properties)) {
      const problem = schemaSubsetProblem(sub, `${where}.${name}`);
      if (problem) return problem;
    }
  }
  return null;
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

/**
 * SAF: değeri alt küme şemasına göre doğrular; ihlalleri (sıralı, deterministik) döndürür.
 * Şemanın alt kümede olduğu ÖNCEDEN `schemaSubsetProblem` ile doğrulanmış olmalıdır.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  where = "root",
): string[] {
  const errors: string[] = [];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !typeMatches(type, value)) {
    errors.push(`${where}: expected ${type}`);
    return errors; // tip tutmuyorsa alt kurallar anlamsız (gürültü üretme)
  }
  const props = isPlainObject(schema.properties) ? schema.properties : undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (!isPlainObject(value)) {
    // Nesne değilse properties/required/additionalProperties uygulanamaz.
    if (props || required.length > 0) {
      if (type === undefined) errors.push(`${where}: expected object`);
    }
    return errors;
  }
  for (const name of [...required].sort()) {
    if (!(name in value)) errors.push(`${where}.${name}: required property missing`);
  }
  if (props) {
    for (const name of Object.keys(props).sort()) {
      if (!(name in value)) continue;
      errors.push(
        ...validateAgainstSchema(props[name] as Record<string, unknown>, value[name], `${where}.${name}`),
      );
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(props ? Object.keys(props) : []);
    for (const name of Object.keys(value).sort()) {
      if (!allowed.has(name)) errors.push(`${where}.${name}: property not allowed`);
    }
  }
  return errors;
}

// ───────────────────────── Denetim koşucusu (impure) ─────────────────────────

/** Test paketini koşan bağımlılık — testlerde gerçek süreç yerine sahte verilebilir. */
export interface OverlayCheckDeps {
  runTestSuite: (state: State) => Promise<{ ok: boolean; detail: string }>;
}

/**
 * Stack profilinin TEST komutunu koşar (mekanik fazların komut çözümünün AYNISI — ikinci bir
 * komut makinesi yok). Komut yoksa/ortam bozuksa: gate SEÇİLMİŞTİ ve doğrulanamıyor → fail.
 *
 * KAPSAM NOTU: test_must_pass.test_ref tek bir testi işaret eder, ama mekanik karar TÜM takım
 * üzerinden verilir. Daha SIKI bir yorum (takım kırmızıysa o tek test yeşil olsa da iterasyon
 * geçmez) — AD-2 yönünde bilinçli tercih. test_ref insan için detayda taşınır.
 */
async function runProfileTestSuite(state: State): Promise<{ ok: boolean; detail: string }> {
  let cmd: string | null;
  try {
    cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state);
  } catch (err) {
    return { ok: false, detail: `test command could not be resolved: ${String(err).slice(0, 120)}` };
  }
  if (!cmd) return { ok: false, detail: "no test command in stack profile (cannot verify)" };
  const res = await runSuiteProcess(cmd, state.project_root);
  if (isMissingCommand(res)) return { ok: false, detail: `test runner missing: ${cmd}` };
  if (isSpawnEnvFailure(res)) return { ok: false, detail: `test environment failure: ${cmd}` };
  return res.code === 0
    ? { ok: true, detail: `suite green: ${cmd}` }
    : { ok: false, detail: `suite red (exit=${res.code}): ${cmd}` };
}

export const defaultOverlayCheckDeps: OverlayCheckDeps = { runTestSuite: runProfileTestSuite };

function outcome(
  gate_id: string,
  passed: boolean,
  detail: string,
  message: string,
): OverlayCheckOutcome {
  return { gate_id, passed, event: overlayGateEvent(gate_id, passed), detail, message };
}

/**
 * Bu iterasyonun phase_end gate'lerini denetler. Sıra deterministiktir (seçim sırası korunur);
 * tool_deny gate'lerinden yalnız DEDEKTİF karşılığı olanlar (file_immutable,
 * forbid_dependency_change) burada tekrar bakılır.
 */
export async function runOverlayChecks(
  overlay: CompiledOverlay,
  state: State,
  deps: OverlayCheckDeps = defaultOverlayCheckDeps,
): Promise<OverlayCheckOutcome[]> {
  const root = state.project_root;
  const results: OverlayCheckOutcome[] = [];
  let dependencyLockChecked = false;

  for (const sel of overlay.selections) {
    if (sel.gate_id === "file_must_change") {
      const rel = sel.params.path ?? "";
      const d = decideFileMustChange(overlay.baselines[rel], await sha256File(join(root, rel)));
      results.push(
        outcome(
          sel.gate_id,
          d.passed,
          `${rel}: ${d.reason}`,
          d.passed
            ? `✅ Gate: "${rel}" bu iterasyonda değişti.`
            : `❌ Gate: "${rel}" değişmesi gerekiyordu ama değişmedi (${d.reason}).`,
        ),
      );
      continue;
    }

    if (sel.gate_id === "file_immutable") {
      const rel = sel.params.path ?? "";
      const d = decideFileImmutable(overlay.baselines[rel], await sha256File(join(root, rel)));
      results.push(
        outcome(
          sel.gate_id,
          d.passed,
          `${rel}: ${d.reason}`,
          d.passed
            ? `✅ Gate: dondurulmuş "${rel}" dosyasına dokunulmadı.`
            : `❌ Gate: dondurulmuş "${rel}" dosyası yine de değişti (${d.reason}) — muhtemelen Bash üzerinden.`,
        ),
      );
      continue;
    }

    if (sel.gate_id === "forbid_dependency_change") {
      if (dependencyLockChecked) continue; // aynı gate iki kez seçilse de tek karar
      dependencyLockChecked = true;
      const baselined: Array<{ path: string; baseline: string | null; current: string | null }> = [];
      const appeared: string[] = [];
      for (const name of DEPENDENCY_MANIFEST_FILES) {
        const known = Object.prototype.hasOwnProperty.call(overlay.baselines, name);
        const current = await sha256File(join(root, name));
        if (known) baselined.push({ path: name, baseline: overlay.baselines[name], current });
        else if (current !== null) appeared.push(name);
      }
      const d = decideDependencyLock({ baselined, appeared });
      results.push(
        outcome(
          sel.gate_id,
          d.passed,
          d.reason,
          d.passed
            ? "✅ Gate: bağımlılık listesi bu iterasyonda değişmedi."
            : `❌ Gate: bağımlılık listesi değişti (${d.reason}).`,
        ),
      );
      continue;
    }

    if (sel.gate_id === "test_must_pass") {
      const ref = sel.params.test_ref ?? "";
      const r = await deps.runTestSuite(state);
      results.push(
        outcome(
          sel.gate_id,
          r.ok,
          `${r.detail} | test_ref=${ref.slice(0, 80)}`,
          r.ok
            ? "✅ Gate: test paketi yeşil."
            : `❌ Gate: test paketi bu iterasyonu geçirmiyor (${r.detail}).`,
        ),
      );
      continue;
    }

    if (sel.gate_id === "schema_check") {
      const target = sel.params.target ?? "";
      const schemaRef = sel.params.schema_ref ?? "";
      const r = await checkSchemaGate(root, target, schemaRef);
      results.push(
        outcome(
          sel.gate_id,
          r.passed,
          `${target} vs ${schemaRef}: ${r.reason}`,
          r.passed
            ? `✅ Gate: "${target}" şemasına uyuyor.`
            : `❌ Gate: "${target}" şema denetiminden geçmedi (${r.reason}).`,
        ),
      );
      continue;
    }

    // forbid_new_files: yalnız tool_deny kanadı var (dedektif karşılığı için iterasyon-başı
    // TAM dosya envanteri saklamak gerekirdi — bu iterasyonun taban çizgisi onu tutmuyor).
  }
  return results;
}

async function checkSchemaGate(
  root: string,
  target: string,
  schemaRef: string,
): Promise<{ passed: boolean; reason: string }> {
  let schemaRaw: string;
  try {
    schemaRaw = await fs.readFile(join(root, schemaRef), "utf-8");
  } catch {
    return { passed: false, reason: "schema file unreadable" };
  }
  let schema: unknown;
  try {
    schema = JSON.parse(schemaRaw);
  } catch {
    return { passed: false, reason: "schema file is not valid JSON" };
  }
  const problem = schemaSubsetProblem(schema);
  if (problem) return { passed: false, reason: `unsupported schema — ${problem}` };

  let targetRaw: string;
  try {
    targetRaw = await fs.readFile(join(root, target), "utf-8");
  } catch {
    return { passed: false, reason: "target file unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(targetRaw);
  } catch {
    return { passed: false, reason: "target file is not valid JSON" };
  }
  const errors = validateAgainstSchema(schema as Record<string, unknown>, value);
  return errors.length === 0
    ? { passed: true, reason: "conforms" }
    : { passed: false, reason: errors.slice(0, 3).join("; ").slice(0, 200) };
}
