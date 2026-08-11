// gate-overlay/pool — kapalı gate sözlüğü (assets/gate-pool.json) + saf doğrulayıcı.
//
// NEDEN kapalı sözlük (AD-1): model iterasyon başına serbest metin kural yazabilseydi, o metni
// yorumlayacak İKİNCİ bir model katmanı gerekirdi; yorum hatası doğrudan yanlış engellemeye
// (veya hiç engellememeye) dönüşürdü. Model yalnız buradaki gate'lerden birini SEÇER, parametresini
// şema doğrular. Sözlükte olmayan hiçbir şey çalıştırılmaz.
//
// NEDEN doğrulayıcı SAF: aynı fonksiyon hem depodaki gerçek havuz dosyasını hem testteki bozuk
// örnekleri denetler — disk/IO ayrı tutulunca "gerçek dosya bayatladı" testi mümkün oluyor.
//
// NEDEN sessiz kabul yok (KATI #4): bozuk havuz = görünür hata + dur. Hata mesajı DOSYA YOLUNU
// taşır, çünkü paketlenmiş uygulamada dosya farklı yerde durur ve kullanıcı hangi dosyaya
// bakacağını bilmelidir.
//
// AD-5: burada puan/olasılık temelli hiçbir karar dalı yoktur — her kontrol ikilidir
// (geçer, ya da gerekçesiyle düşer).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRootFile } from "../phase-registry.js";

/**
 * Gate'in NEREDE uygulandığı:
 * - "tool_deny": araç çağrısı anında engel (dosyaya dokunma girişimi reddedilir).
 * - "phase_end": iterasyon/faz sonunda MyCL'in koştuğu mekanik kontrol.
 */
export type GateExecutor = "tool_deny" | "phase_end";

/**
 * JSON Schema'nın DESTEKLENEN ALT KÜMESİ. Bilerek dar: yalnız düz string parametreler.
 * Genel bir şema motoru (ajv) eklemiyoruz — yeni bağımlılık, kapalı sözlüğün ihtiyacından
 * kat kat büyük bir yüzey açardı; alt küme elle doğrulanacak kadar küçük.
 */
export interface GateParamsSchema {
  type: "object";
  properties: Record<string, { type: "string" }>;
  required: string[];
  additionalProperties: false;
}

export interface GatePoolEntry {
  /** snake_case kimlik; havuzda benzersiz. */
  gate_id: string;
  /** Gate tanımının sürümü (bugün tüm girişlerde 1). */
  version: number;
  /** Sade Türkçe tek cümle — kullanıcıya doğrudan gösterilebilir. */
  description: string;
  params_schema: GateParamsSchema;
  executor: GateExecutor;
}

export interface GatePool {
  pool_version: number;
  gates: GatePoolEntry[];
}

/** Kimlik biçimi: küçük harfle başlar, küçük harf/rakam/alt çizgi devam eder. */
const GATE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

const VALID_EXECUTORS: ReadonlySet<string> = new Set<GateExecutor>([
  "tool_deny",
  "phase_end",
]);

/** Bir gate girişinde izin verilen üst seviye alanlar — fazlası yazım hatası demektir. */
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "gate_id",
  "version",
  "description",
  "params_schema",
  "executor",
]);

/** params_schema içinde izin verilen alanlar. */
const SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * params_schema'yı desteklenen alt kümeye göre doğrular. Bulunan her sorun `errors`e
 * eklenir (ilkinde durmayız — havuz dosyasını düzelten kişi tüm sorunları bir turda görsün).
 */
function validateParamsSchema(
  raw: unknown,
  where: string,
  errors: string[],
): void {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: params_schema nesne olmalı`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!SCHEMA_KEYS.has(key)) {
      errors.push(`${where}: params_schema içinde desteklenmeyen alan "${key}"`);
    }
  }
  if (raw.type !== "object") {
    errors.push(`${where}: params_schema.type "object" olmalı`);
  }
  // additionalProperties EKSİKSE de hata: "belirtilmemiş" JSON Schema'da "serbest" demektir,
  // yani kapalı sözlüğün tam tersi. Bu yüzden açıkça false yazılmış olmalı.
  if (raw.additionalProperties !== false) {
    errors.push(
      `${where}: params_schema.additionalProperties açıkça false olmalı (kapalı parametre listesi)`,
    );
  }
  const props = raw.properties;
  const propNames: string[] = [];
  if (!isPlainObject(props)) {
    errors.push(`${where}: params_schema.properties nesne olmalı`);
  } else {
    for (const [name, def] of Object.entries(props)) {
      propNames.push(name);
      if (!isPlainObject(def)) {
        errors.push(`${where}: params_schema.properties.${name} nesne olmalı`);
        continue;
      }
      const keys = Object.keys(def);
      if (keys.length !== 1 || def.type !== "string") {
        errors.push(
          `${where}: params_schema.properties.${name} yalnız {"type":"string"} olabilir`,
        );
      }
    }
  }
  const required = raw.required;
  if (!Array.isArray(required)) {
    errors.push(`${where}: params_schema.required dizi olmalı`);
    return;
  }
  const seen = new Set<string>();
  required.forEach((name, i) => {
    if (typeof name !== "string") {
      errors.push(`${where}: params_schema.required[${i}] string olmalı`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`${where}: params_schema.required içinde tekrar eden ad "${name}"`);
    }
    seen.add(name);
    if (!propNames.includes(name)) {
      errors.push(
        `${where}: params_schema.required içindeki "${name}" properties'te tanımlı değil`,
      );
    }
  });
}

/**
 * Havuzun tamamını doğrular. SAF: dosya sistemine dokunmaz.
 * Hata mesajları hangi girişte (indeks + varsa gate_id) neyin bozuk olduğunu söyler.
 */
export function validateGatePool(
  raw: unknown,
): { ok: true; pool: GatePool } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["kök: havuz bir nesne olmalı"] };
  }
  if (raw.pool_version !== 1) {
    errors.push(
      `kök: pool_version 1 olmalı, gelen ${JSON.stringify(raw.pool_version)}`,
    );
  }
  const gates = raw.gates;
  if (!Array.isArray(gates)) {
    errors.push("kök: gates dizi olmalı");
    return { ok: false, errors };
  }
  if (gates.length === 0) {
    errors.push("kök: gates boş olamaz (kapalı sözlük en az bir gate içermeli)");
  }
  const seenIds = new Set<string>();
  gates.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`gates[${i}]: giriş nesne olmalı`);
      return;
    }
    const id = entry.gate_id;
    // Hata mesajı okunur olsun: kimlik sağlamsa indeks yerine kimliği göster.
    const where =
      typeof id === "string" && id !== "" ? `gates[${i}] (${id})` : `gates[${i}]`;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        errors.push(`${where}: desteklenmeyen alan "${key}"`);
      }
    }
    if (typeof id !== "string") {
      errors.push(`${where}: gate_id string olmalı (alan eksik veya yanlış tipte)`);
    } else if (!GATE_ID_PATTERN.test(id)) {
      errors.push(`${where}: gate_id snake_case olmalı ("${id}")`);
    } else if (seenIds.has(id)) {
      errors.push(`${where}: gate_id benzersiz olmalı, "${id}" tekrar ediyor`);
    } else {
      seenIds.add(id);
    }
    if (typeof entry.version !== "number" || !Number.isInteger(entry.version) || entry.version < 1) {
      errors.push(`${where}: version 1 veya daha büyük tam sayı olmalı`);
    }
    if (typeof entry.description !== "string" || entry.description.trim() === "") {
      errors.push(`${where}: description boş olmayan bir metin olmalı`);
    }
    if (typeof entry.executor !== "string" || !VALID_EXECUTORS.has(entry.executor)) {
      errors.push(
        `${where}: executor "tool_deny" veya "phase_end" olmalı, gelen ${JSON.stringify(entry.executor)}`,
      );
    }
    validateParamsSchema(entry.params_schema, where, errors);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pool: raw as unknown as GatePool };
}

/**
 * Havuz dosyasının yolu. Profil dosyalarıyla AYNI çözücüyü (phase-registry ASSETS_ROOT)
 * kullanır — repo kökü hem geliştirmede hem paketlenmiş uygulamada aynı şekilde çözülür,
 * yani gate-pool.json .app içinde de bulunur (tauri.conf.json resources listesine bak).
 */
export const GATE_POOL_PATH: string = repoRootFile(join("assets", "gate-pool.json"));

/**
 * Cache: dosya process yaşam süresince bir kez okunur (profile-loader ile aynı desen).
 * Havuz statik bir sözlüktür; iterasyon içinde değişmez.
 */
let cachedPool: GatePool | null = null;

/**
 * Havuzu diskten yükler. Okuma, JSON çözümleme veya şema hatalarının HEPSİ görünür
 * hataya döner (AD-8) ve mesaj dosya yolunu taşır — sessizce boş havuza düşmek,
 * "hiç gate yok" ile "havuz bozuk" durumlarını birbirine karıştırırdı.
 */
export async function loadGatePool(): Promise<GatePool> {
  if (cachedPool) return cachedPool;
  const path = GATE_POOL_PATH;
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`gate-pool.json geçersiz: okunamadı — ${path} — ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `gate-pool.json geçersiz: JSON çözümlenemedi — ${path} — ${String(err)}`,
    );
  }
  const result = validateGatePool(parsed);
  if (!result.ok) {
    throw new Error(`gate-pool.json geçersiz: ${path} — ${result.errors.join("; ")}`);
  }
  cachedPool = result.pool;
  return cachedPool;
}

/** Test yalıtımı için cache temizleme (profile-loader `_clearProfileCache` deseni). */
export function _clearGatePoolCache(): void {
  cachedPool = null;
}
