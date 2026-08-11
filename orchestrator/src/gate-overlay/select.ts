// gate-overlay/select — model önerisini okuma + seçimi doğrulama (hepsi SAF).
//
// Akış: model bir öneri üretir (hangi gate'ler, hangi parametrelerle) → parseOverlayProposal
// biçimi ayıklar → validateSelection her seçimi ÜÇ kapıdan geçirir (sözlük, şema, bağlam) →
// yalnız üçünü de geçen seçim uygulanır.
//
// NEDEN üç kapı ayrı ve SIRALI: hata kodu ("unknown_gate" / "bad_params" / "bad_context")
// çağıranın ne yapacağını belirler — bilinmeyen gate modele geri bildirim, bozuk bağlam ise
// projede gerçekten olmayan bir dosyaya kilit vurma girişimidir. Tek bir "geçersiz" kodu
// bu ayrımı yok ederdi.
//
// NEDEN bağlam kapısı var: var olmayan bir dosya dondurulamaz, var olmayan bir dizine
// "yeni dosya ekleme" konamaz. Böyle bir gate sessizce hiçbir işe yaramaz — yani kullanıcı
// korunduğunu sanırken korunmaz. Uydurma yol = red.
//
// AD-2 (yalnız sıkılaştırıcı): buradaki hiçbir şey statik ayarları gevşetmez, yalnız
// üstüne kısıt EKLER. AD-5: puan/olasılık temelli karar dalı yoktur; her kapı ikilidir.
// `reason` alanları YALNIZ insanın okuması içindir — hiçbir mekanik karar (doğrulama,
// tekilleştirme, sıralama) reason'a bakmaz.

import type { GatePoolEntry, GateParamsSchema, GatePool } from "./pool.js";

/** Modelin havuzdan yaptığı tek bir seçim. */
export interface OverlaySelection {
  gate_id: string;
  params: Record<string, string>;
  /** Yalnız insan okuması için; hiçbir mekanik karar buna bakmaz. */
  reason?: string;
}

/**
 * Havuzda karşılığı olmayan bir risk. Kapalı sözlük (AD-1) gereği model kendi kuralını
 * yazamaz; bunun yerine eksiği BİLDİRİR ve sözlüğü insan büyütür.
 */
export interface MissingGate {
  risk_description: string;
  suggested_name?: string;
}

export interface OverlayProposal {
  selections: OverlaySelection[];
  missing: MissingGate[];
}

export interface OverlayContext {
  /** Projedeki dosyalar — göreli, normalize yollar. */
  projectFiles: ReadonlySet<string>;
  /** Projedeki dizinler — göreli, normalize yollar. */
  projectDirs: ReadonlySet<string>;
}

export type SelectionFailureCode = "unknown_gate" | "bad_params" | "bad_context";

export type SelectionResult =
  | { ok: true; entry: GatePoolEntry }
  | { ok: false; code: SelectionFailureCode; reason: string };

/** Yol taşıyan parametre adları — bunlara göreli + temiz yol kuralı uygulanır. */
const PATH_PARAM_NAMES: ReadonlySet<string> = new Set([
  "path",
  "dir",
  "target",
  "schema_ref",
]);

/**
 * Kabuk metakarakterleri. test_ref bir komut satırına ULAŞABİLİR; enjeksiyon kapısı
 * olmaması için bu karakterler baştan reddedilir (kaçış denemesi yerine red — kaçış
 * kuralları kabuk başına değişir, red her kabukta aynı şeyi yapar).
 */
const SHELL_META_PATTERN = /[;|&$`()<>\n]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parametreleri havuz şemasına göre doğrular. SAF, desteklenen alt küme:
 * zorunlular var mı, değerler string mi, şemada olmayan parametre var mı.
 */
export function validateParams(
  params: Readonly<Record<string, unknown>>,
  schema: GateParamsSchema,
): { ok: true } | { ok: false; reason: string } {
  if (!isPlainObject(params)) {
    return { ok: false, reason: "params bir nesne olmalı" };
  }
  for (const name of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      return { ok: false, reason: `zorunlu parametre eksik: ${name}` };
    }
  }
  for (const [name, value] of Object.entries(params)) {
    if (schema.additionalProperties === false && !(name in schema.properties)) {
      return { ok: false, reason: `şemada olmayan parametre: ${name}` };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        reason: `parametre metin olmalı: ${name} (gelen ${typeof value})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Yol biçimi kontrolü: boş değil, göreli, `..` yok, ters bölü yok.
 * Sorun varsa gerekçe, yoksa null döner.
 */
function pathProblem(value: string, label: string): string | null {
  if (value.trim() === "") return `${label} boş olamaz`;
  if (value.startsWith("/")) {
    return `${label} göreli olmalı, mutlak yol verilmiş: ${value}`;
  }
  if (value.includes("\\")) return `${label} ters bölü içeremez: ${value}`;
  if (value.split("/").includes("..")) {
    return `${label} ".." parçası içeremez: ${value}`;
  }
  return null;
}

/**
 * Gate'e özel bağlam kuralı: sorun varsa gerekçe, yoksa null.
 * Tablo havuzdaki HER gate'i kapsar; kapsamayan bir gate eklenirse
 * validateSelection fail-closed davranır (aşağıda).
 */
type ContextRule = (
  params: Readonly<Record<string, string>>,
  ctx: OverlayContext,
) => string | null;

const CONTEXT_RULES: Readonly<Record<string, ContextRule>> = {
  // Var olmayan dosya dondurulamaz — böyle bir kilit hiçbir şey korumaz.
  file_immutable: (params, ctx) =>
    ctx.projectFiles.has(params.path)
      ? null
      : `dondurulacak dosya projede yok: ${params.path}`,
  // Dosya HENÜZ olmayabilir: iterasyon onu yaratacaksa bu "değişti" sayılır.
  // Bu yüzden yalnız yol biçimi aranır, varlık aranmaz.
  file_must_change: () => null,
  // Şema referansı gerçek bir dosya olmalı; target üretilecek/değişecek dosyadır,
  // henüz var olmayabilir.
  schema_check: (params, ctx) =>
    ctx.projectFiles.has(params.schema_ref)
      ? null
      : `şema dosyası projede yok: ${params.schema_ref}`,
  // Var olmayan dizine "yeni dosya ekleme" koymak sessizce etkisizdir.
  forbid_new_files: (params, ctx) =>
    ctx.projectDirs.has(params.dir)
      ? null
      : `dizin projede yok: ${params.dir}`,
  forbid_dependency_change: () => null,
  test_must_pass: (params) => {
    const ref = params.test_ref;
    if (ref.trim() === "") return "test_ref boş olamaz";
    if (SHELL_META_PATTERN.test(ref)) {
      return `test_ref kabuk metakarakteri içeremez: ${ref}`;
    }
    return null;
  },
};

/**
 * Tek bir seçimi doğrular. ÜÇ kapı SIRAYLA: sözlük → şema → bağlam.
 * Sıra önemlidir: bilinmeyen gate'in şeması yoktur, şemadan geçmemiş parametrenin
 * bağlamı sorgulanamaz (değer string bile olmayabilir).
 */
export function validateSelection(
  sel: OverlaySelection,
  pool: GatePool,
  ctx: OverlayContext,
): SelectionResult {
  // 1) Sözlük — kapalı liste dışında hiçbir şey uygulanmaz (AD-1).
  const entry = pool.gates.find((g) => g.gate_id === sel.gate_id);
  if (!entry) {
    return {
      ok: false,
      code: "unknown_gate",
      reason: `havuzda böyle bir gate yok: ${sel.gate_id}`,
    };
  }
  // 2) Şema.
  const paramsOk = validateParams(sel.params, entry.params_schema);
  if (!paramsOk.ok) {
    return { ok: false, code: "bad_params", reason: paramsOk.reason };
  }
  // 3) Bağlam. Önce tüm yol parametrelerinin biçimi, sonra gate'e özel kural.
  // Şema özelliklerinin sırasında geziyoruz (modelin gönderdiği anahtar sırasında DEĞİL)
  // — böylece aynı girdi için gerekçe hep aynı çıkar.
  for (const name of Object.keys(entry.params_schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(sel.params, name)) continue;
    if (!PATH_PARAM_NAMES.has(name)) continue;
    const problem = pathProblem(sel.params[name], name);
    if (problem) return { ok: false, code: "bad_context", reason: problem };
  }
  const rule = CONTEXT_RULES[entry.gate_id];
  if (!rule) {
    // Havuza gate eklenmiş ama bağlam kuralı yazılmamış: sessizce geçirmek,
    // hiç doğrulanmamış bir gate'i uygulamak olurdu (KATI #4).
    return {
      ok: false,
      code: "bad_context",
      reason: `bu gate için bağlam kuralı tanımlı değil: ${entry.gate_id}`,
    };
  }
  const problem = rule(sel.params, ctx);
  if (problem) return { ok: false, code: "bad_context", reason: problem };
  return { ok: true, entry };
}

/**
 * Model çıktısını OverlayProposal'a çevirir. SAF.
 *
 * Kök seviyedeki tanımadığımız alanlar YOK SAYILIR (model çıktısı gürültülü olabilir,
 * kök gürültüsü zararsız). Buna karşılık selections/missing İÇİNDEKİ alanların tipi
 * yanlışsa öneri reddedilir — bozuk bir seçimi kısmen kabul etmek, hangi kısmının
 * uygulandığını belirsiz bırakırdı.
 */
export function parseOverlayProposal(
  raw: unknown,
): { ok: true; proposal: OverlayProposal } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "öneri bir nesne olmalı" };
  }
  const selections: OverlaySelection[] = [];
  const rawSelections = raw.selections;
  if (rawSelections !== undefined) {
    if (!Array.isArray(rawSelections)) {
      return { ok: false, error: "selections dizi olmalı" };
    }
    for (let i = 0; i < rawSelections.length; i++) {
      const item: unknown = rawSelections[i];
      if (!isPlainObject(item)) {
        return { ok: false, error: `selections[${i}] nesne olmalı` };
      }
      if (typeof item.gate_id !== "string" || item.gate_id.trim() === "") {
        return { ok: false, error: `selections[${i}].gate_id boş olmayan metin olmalı` };
      }
      if (!isPlainObject(item.params)) {
        return { ok: false, error: `selections[${i}].params nesne olmalı` };
      }
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(item.params)) {
        if (typeof v !== "string") {
          return {
            ok: false,
            error: `selections[${i}].params.${k} metin olmalı (gelen ${typeof v})`,
          };
        }
        params[k] = v;
      }
      if (item.reason !== undefined && typeof item.reason !== "string") {
        return { ok: false, error: `selections[${i}].reason metin olmalı` };
      }
      const sel: OverlaySelection = { gate_id: item.gate_id, params };
      if (typeof item.reason === "string") sel.reason = item.reason;
      selections.push(sel);
    }
  }
  const missing: MissingGate[] = [];
  const rawMissing = raw.missing;
  if (rawMissing !== undefined) {
    if (!Array.isArray(rawMissing)) {
      return { ok: false, error: "missing dizi olmalı" };
    }
    for (let i = 0; i < rawMissing.length; i++) {
      const item: unknown = rawMissing[i];
      if (!isPlainObject(item)) {
        return { ok: false, error: `missing[${i}] nesne olmalı` };
      }
      if (
        typeof item.risk_description !== "string" ||
        item.risk_description.trim() === ""
      ) {
        return {
          ok: false,
          error: `missing[${i}].risk_description boş olmayan metin olmalı`,
        };
      }
      if (item.suggested_name !== undefined && typeof item.suggested_name !== "string") {
        return { ok: false, error: `missing[${i}].suggested_name metin olmalı` };
      }
      const gap: MissingGate = { risk_description: item.risk_description };
      if (typeof item.suggested_name === "string") gap.suggested_name = item.suggested_name;
      missing.push(gap);
    }
  }
  return { ok: true, proposal: { selections, missing } };
}

/**
 * Ayırıcı: NUL karakteri. Yol veya test referansı gibi metinlerde geçmesi mümkün değil,
 * bu yüzden iki farklı parametre birleşimi asla aynı anahtara çakışmaz.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * Kanonik anahtar: gate_id + parametreler (ad sırasına göre sabitlenir, model anahtarları
 * hangi sırada gönderirse göndersin aynı anahtar çıkar). `reason` anahtara GİRMEZ — aynı
 * kısıt iki farklı gerekçeyle gelirse yine TEK kısıttır ve hiçbir mekanik karar reason'a
 * dayanamaz. Değerler olduğu gibi kullanılır; maskeleme yok (maskeleme farklı kimlikleri
 * birbirine çakıştırır).
 */
function canonicalKey(sel: OverlaySelection): string {
  const params = Object.keys(sel.params)
    .sort()
    .map((k) => `${k}=${sel.params[k]}`)
    .join(KEY_SEPARATOR);
  return `${sel.gate_id}${KEY_SEPARATOR}${params}`;
}

/**
 * Aynı kısıt birden fazla kez seçilmişse tekilleştirir; ilk geliş sırası korunur.
 * Aynı gate'i iki kez uygulamak ikinci kez hiçbir şey sıkılaştırmaz, yalnız
 * kullanıcıya çift rapor satırı ve çift red mesajı üretirdi.
 */
export function dedupeSelections(
  sels: readonly OverlaySelection[],
): OverlaySelection[] {
  const seen = new Set<string>();
  const out: OverlaySelection[] = [];
  for (const sel of sels) {
    const key = canonicalKey(sel);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sel);
  }
  return out;
}
