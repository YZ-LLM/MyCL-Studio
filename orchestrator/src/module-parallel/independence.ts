// module-parallel/independence — paralel codegen GÜVENLİK KAPISI (SAF, deterministik).
//
// Paralele YALNIZ modüller PROVABLY bağımsızsa girilir; aksi hâlde SERİ yola düşülür (fail-closed).
// Luke Alvoeiro (Missions) uyarısı: paralel yazma çakışırsa felaket → çakışmayı YAPISAL olarak imkânsız kıl:
// her worker'a AYRIK izinli-yol kapsamı verilir + codegen'de `normalizeAndCheck` onu kendi modülü dışına
// yazdırmaz. Bu modül o ayrıklığı KARAR ANINDA deterministik doğrular (LLM "bağımsız" diye över; kapıyı kod geçer).

export interface ModuleScope {
  /** Modül kimliği (worktree/branch adı + audit için). */
  id: string;
  /** Bu modülün YAZACAĞI yol önekleri/dosyaları (ör. "src/auth/", "src/ui/login.tsx"). Göreli. */
  scope_paths: string[];
}

/** Trailing slash temizle (dizin/dosya karşılaştırması için normalize). */
function norm(p: string): string {
  return p.replace(/\/+$/, "");
}

/** İki yol kesişiyor mu? Eşit ya da biri diğerinin alt-dizini ise EVET. SAF. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/** `file` verilen kapsam önekinin (dizin/dosya) İÇİNDE mi? Entegrasyonda kapsam-dışı yazımı yakalar. SAF. */
export function pathWithin(file: string, scopePrefix: string): boolean {
  const f = norm(file);
  const p = norm(scopePrefix);
  return f === p || f.startsWith(p + "/");
}

/**
 * Modüllerin YOL kapsamları çiftler hâlinde ayrık mı? İlk çakışmada {ok:false, reason}. SAF.
 * (Dosya-yazma çakışmasının önlenmesinin temeli — ayrık kapsam + enforce = çakışma imkânsız.)
 */
export function modulesDisjoint(modules: ModuleScope[]): { ok: boolean; reason: string } {
  for (let i = 0; i < modules.length; i++) {
    for (let j = i + 1; j < modules.length; j++) {
      for (const pa of modules[i].scope_paths) {
        for (const pb of modules[j].scope_paths) {
          if (pathsOverlap(pa, pb)) {
            return {
              ok: false,
              reason: `kapsam çakışması: "${modules[i].id}" (${pa}) ↔ "${modules[j].id}" (${pb})`,
            };
          }
        }
      }
    }
  }
  return { ok: true, reason: "kapsamlar ayrık" };
}

/**
 * Paralel codegen'e girilmeli mi? FAIL-CLOSED: flag açık + ≥2 modül + boş-kapsam yok + kapsamlar ayrık —
 * hepsi gerekli; biri bile yoksa SERİ. SAF (test edilebilir; çekirdeğe dokunmaz).
 */
export function shouldParallelize(
  modules: ModuleScope[],
  opts: { enabled: boolean },
): { parallel: boolean; reason: string } {
  if (!opts.enabled) return { parallel: false, reason: "flag kapalı → seri" };
  if (modules.length < 2) return { parallel: false, reason: "<2 modül → seri" };
  if (modules.some((m) => !m.scope_paths || m.scope_paths.length === 0)) {
    return { parallel: false, reason: "kapsamı boş modül → seri (fail-closed)" };
  }
  const d = modulesDisjoint(modules);
  if (!d.ok) return { parallel: false, reason: `${d.reason} → seri (fail-closed)` };
  return { parallel: true, reason: `${modules.length} ayrık modül → paralel` };
}
