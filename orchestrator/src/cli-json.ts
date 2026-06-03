// cli-json — `claude -p` serbest metninden yapılandırılmış JSON çıkarımı (paylaşımlı).
//
// CLI custom tool desteklemediği için ajan kararını/çıktısını text-JSON bloğu olarak
// yazar; MyCL son geçerli nesneyi çıkarır. String-aware dengeli `{ … }` tarayıcı —
// REGEX YOK (kullanıcı kuralı), ```json fence'leri de düz nesne olarak yakalanır.
// cli-orchestrator (orchestrator kararı) + cli-interactive-loop (qa-askq/schema) + Faz 0
// hepsi bunu kullanır.

/** JSON.parse, hata yutulur → null. */
export function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Metindeki tüm top-level dengeli `{ … }` parçalarını döndürür (string-aware:
 * tırnak içi süslü parantezleri ve `\"` kaçışlarını yok sayar).
 */
export function scanBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Serbest metinden, `predicate`'i sağlayan SON geçerli JSON nesnesini çıkar
 * (prompt "JSON en sonda olsun" der → sondan tara). Bulunamazsa null.
 */
export function extractLastJsonObject(
  text: string,
  predicate: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const candidates = scanBalancedObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i]);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (predicate(obj)) return obj;
    }
  }
  return null;
}

/**
 * `kind` alanı verilen değerlerden biri olan son JSON nesnesini çıkar.
 * Interaktif loop + Faz 0/schema CLI backend'leri bununla blok ayırır.
 */
export function extractKindBlock(
  text: string,
  kinds: readonly string[],
): Record<string, unknown> | null {
  return extractLastJsonObject(
    text,
    (obj) => typeof obj.kind === "string" && kinds.includes(obj.kind),
  );
}

// ───────────────── Dayanıklılık: somut örnek + şemaya coerce (v15.12) ─────────────────
// CLI'da native tool yok → ajan JSON'u elle yazar, iç içe dizileri düzyazıya çevirebilir.
// schemaToSkeleton: ajana TAM şekli gösterir (proaktif). coerceToSchema: bozuk-ama-var
// bloğu tip-güvenli doldurur (pipeline takılmasın). İkisi de SAF → test edilebilir.

/**
 * JSON Schema (input_schema) → somut örnek değer. Nesne→alanlar, dizi→tek örnek item
 * (iç içe diziyi GÖSTERİR: `[{...}]`), enum→ilk değer, integer→0, bool→false, string→"…".
 */
export function schemaToSkeleton(schema: Record<string, unknown>): unknown {
  const enumVals = schema.enum as unknown[] | undefined;
  if (Array.isArray(enumVals) && enumVals.length > 0) return enumVals[0];
  switch (schema.type as string | undefined) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) out[k] = schemaToSkeleton(v);
      return out;
    }
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      return items ? [schemaToSkeleton(items)] : [];
    }
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return "...";
  }
}

export interface CoerceResult {
  coerced: Record<string, unknown>;
  /** Eksik/yanlış-tip olduğu için doldurulan zorunlu alanlar (görünür uyarı için). */
  defaulted: string[];
}

// Eksik string alanını kurtarmak için yaygın jenerik ad alias'ları (örn. ajan
// `enriched_summary` yerine `summary` yazmışsa onu eşle — v15.9 contract bug'ı onar).
const STRING_ALIASES = ["summary", "title", "pitch_en", "pitch", "text", "description"];

/**
 * SAF: bloğun zorunlu alanlarını şemaya göre tamamla (pipeline takılmasın). Var + doğru
 * tip → DOKUNMA. Eksik/yanlış-tip → tip-güvenli default: array→[], object→{}, number→0,
 * bool→false, string→ alias'tan ya da `fallbackText` (ajanın ham metni) ya da "".
 * `defaulted` doldurulan alanları listeler (caller görünür uyarı verir; sessiz değil).
 */
export function coerceToSchema(
  block: Record<string, unknown>,
  schema: Record<string, unknown>,
  fallbackText?: string,
): CoerceResult {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[] | undefined) ?? [];
  const coerced: Record<string, unknown> = { ...block };
  const defaulted: string[] = [];
  for (const field of required) {
    const v = coerced[field];
    const type = props[field]?.type as string | undefined;
    const emptyish = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    const typeMismatch =
      (type === "array" && !Array.isArray(v)) ||
      (type === "object" && (typeof v !== "object" || v === null || Array.isArray(v)));
    if (!emptyish && !typeMismatch) continue; // var + doğru tip → koru
    defaulted.push(field);
    if (type === "array") coerced[field] = [];
    else if (type === "object") coerced[field] = {};
    else if (type === "integer" || type === "number") coerced[field] = 0;
    else if (type === "boolean") coerced[field] = false;
    else {
      const alias = STRING_ALIASES.map((a) => coerced[a]).find(
        (x): x is string => typeof x === "string" && x.trim() !== "",
      );
      coerced[field] = alias ?? (fallbackText?.trim() || "");
    }
  }
  return { coerced, defaulted };
}
