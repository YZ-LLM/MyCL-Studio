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
