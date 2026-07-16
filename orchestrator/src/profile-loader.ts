// profile-loader — stack profil dosyalarını yükler ve komut resolver sağlar.
//
// Profil dosyaları: `assets/profiles/<stack-id>.json`. Her stack için
// install/dev/build/test/lint/security/perf komutları + e2e + load test
// runner'ları project_type'a göre haritalanır.
//
// Cache: dosyalar process-yaşam süresince bir kere okunur (Map<StackId, ...>).
// Eksik profil dosyası → null döner (caller fallback'a düşer veya skip).
// JSON parse hatası → throw (kullanıcı görsün, profil bozuksa pipeline durmalı).

import { readFile } from "node:fs/promises";
import { log } from "./logger.js";
import { profilePath } from "./phase-registry.js";
import type { ProjectType, StackId } from "./types.js";

/**
 * Profil komut anahtarları — `commands` objesi her stack için zorunlu (null
 * olabilir ama tanım var). Faz registry'sinde `mechanical_config` veya
 * Phase 5 build/dev resolution buradan key alır.
 */
export type ProfileCommandKey =
  | "install"
  | "dev"
  // Generic "çalıştır" komutu — web dev-server olmayan çalıştırma (cargo run,
  // python main.py). `dev` web dev-server'dır; ikisi ayrı niyettir. Profilde
  // run yoksa caller dev'e düşer (commandFor).
  | "run"
  | "build"
  | "test"
  | "lint"
  | "lint_fix"
  | "perf"
  | "security"
  | "simplify"
  | "integration"
  // v15.9: scoped varyantlar — `{files}` şablonu taşır (değişen dosyalara
  // daralma). Profilde tanımlı değilse mekanik runner tüm-proje key'ine düşer.
  | "lint_scoped"
  | "lint_fix_scoped"
  | "test_scoped";

/**
 * project_type-aware komut anahtarları — Faz 16 (E2E) + Faz 17 (Load) gibi
 * proje tipine göre runner'ı değişen fazlar için. Web app → Playwright,
 * REST API → hurl/supertest, CLI → shell, library → null vb.
 */
export interface ProjectTypeCommands {
  web?: string | null;
  api?: string | null;
  cli?: string | null;
  library?: string | null;
  mobile?: string | null;
  desktop?: string | null;
  ml?: string | null;
  game?: string | null;
  /** project_type "unknown" veya yukarıdakilerde tanımsız ise fallback. */
  default?: string | null;
}

export interface StackProfile {
  /** StackId — dosya adıyla eşleşir (örn. "node-npm" → node-npm.json). */
  stack_id: StackId;
  /** Mechanical fazlar 10-17 + Phase 5 build/dev için stack-spesifik komutlar. */
  commands: Partial<Record<ProfileCommandKey, string | null>>;
  /** Faz 16 E2E test — project_type'a göre. */
  e2e_by_project_type?: ProjectTypeCommands;
  /** Faz 17 Load test — project_type'a göre. */
  load_by_project_type?: ProjectTypeCommands;
  /** Dev server default port (Phase 5 sonrası bekleme). */
  default_port?: number;
  /** Manifest dosyaları — detectStack already kullanıyor, profil için referans. */
  manifest_files?: string[];
  /** Frontend build tool tespiti için ipuçları (vite|webpack|next|astro|esbuild). */
  build_tool?: string;
  /** Bağımlılıkların YEREL kurulduğu dizin (proje köküne göre): node→"node_modules", php→"vendor",
   *  dart→".dart_tool", elixir→"deps". PROAKTİF deps kontrolü bunu kullanır (crash'ten önce: dizin yok/boşsa kur).
   *  Global cache kullanan stack'ler (python/go/rust) bunu BİLDİRMEZ → yalnız reaktif yol (KATI #1: bilgi profilde). */
  deps_dir?: string;
  /** Eksik-bağımlılık crash imzaları (regex kaynakları) — service-provision
   *  reaktif deps tespiti bu stack'in crash çıktısında bunları arar.
   *  BOŞ dizi meşru = "bu stack için imza bildirilmiyor" (kasıtlı hariç tutma;
   *  ör. ruby/rust'ta yerel-typo ile ayırt edilemez). Alan hiç yoksa [] sayılır. */
  missing_deps_signatures?: string[];
}

/**
 * Cache: Map<StackId, StackProfile | null>. Null = profil dosyası yok
 * (re-read denemesi yapılmaz). undefined (Map'te yok) = henüz denenmedi.
 */
const profileCache = new Map<StackId, StackProfile | null>();

/** StackProfile'ın bilinen üst-seviye anahtarları — bilinmeyene load'da uyarı verilir. */
const KNOWN_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "stack_id",
  "commands",
  "e2e_by_project_type",
  "load_by_project_type",
  "default_port",
  "manifest_files",
  "build_tool",
  "deps_dir",
  "missing_deps_signatures",
]);

/**
 * Komut değerinin geçerli olup olmadığını doğrular: `string | null` dışında
 * her şey reddedilir. QC B4 (2026-05-23): bozuk profil dosyaları erken
 * yakalansın — mechanical-runner subprocess spawn anında patlamak yerine
 * load anında net hata mesajı.
 */
function validateCommandValue(v: unknown, key: string, path: string): void {
  if (v !== null && typeof v !== "string") {
    throw new Error(
      `${path}: command ${key} must be string|null, got ${typeof v}`,
    );
  }
}

/**
 * Bir stack için profil dosyasını yükle (cache'li). Profil yoksa null.
 *
 * `assets/profiles/<stack-id>.json` okunur, JSON.parse edilir,
 * minimal şema validasyonu yapılır (stack_id field'ı string + commands obj).
 * Dosya yoksa null. JSON bozuksa throw.
 */
export async function loadProfile(stackId: StackId): Promise<StackProfile | null> {
  if (profileCache.has(stackId)) {
    return profileCache.get(stackId)!;
  }
  const path = profilePath(`${stackId}.json`);
  const profile = await _loadProfileFromPath(path);
  profileCache.set(stackId, profile);
  return profile;
}

/**
 * Path-tabanlı profil yükleyici — cache by-pass. Production'da loadProfile
 * kullanılır; bu helper test fixture'ları için (geçici tmp profil dosyaları).
 * Dosya yoksa null, JSON bozuk veya schema invalid ise throw.
 */
export async function _loadProfileFromPath(
  path: string,
): Promise<StackProfile | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { stack_id?: unknown }).stack_id !== "string" ||
      typeof (parsed as { commands?: unknown }).commands !== "object"
    ) {
      throw new Error(`invalid profile schema: ${path}`);
    }
    // QC B4 (2026-05-23): commands ve project-type bloklarındaki her değer
    // string|null olmalı — bozuk profil mechanical-runner'a düşmeden burada
    // patlamalı, kullanıcı net hata mesajı görsün.
    const commandsObj = (parsed as { commands: Record<string, unknown> }).commands;
    for (const [k, v] of Object.entries(commandsObj)) {
      validateCommandValue(v, `commands.${k}`, path);
    }
    for (const blockKey of [
      "e2e_by_project_type",
      "load_by_project_type",
    ] as const) {
      const block = (parsed as Record<string, unknown>)[blockKey];
      if (block === undefined) continue;
      if (typeof block !== "object" || block === null) {
        throw new Error(`${path}: ${blockKey} must be object`);
      }
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        validateCommandValue(v, `${blockKey}.${k}`, path);
      }
    }
    // missing_deps_signatures: dizi + her eleman derlenebilir regex kaynağı.
    // Bozuk imza load anında patlasın (KATI #4) — runtime'da sessiz kaçırma olmasın.
    const sigs = (parsed as Record<string, unknown>).missing_deps_signatures;
    if (sigs !== undefined) {
      if (!Array.isArray(sigs)) {
        throw new Error(`${path}: missing_deps_signatures dizi olmalı, ${typeof sigs} geldi`);
      }
      sigs.forEach((s, i) => {
        if (typeof s !== "string") {
          throw new Error(`${path}: missing_deps_signatures[${i}] string olmalı, ${typeof s} geldi`);
        }
        try {
          new RegExp(s);
        } catch (e) {
          throw new Error(`${path}: missing_deps_signatures[${i}] geçersiz regex: ${String(e)}`);
        }
      });
    }
    // Bilinmeyen üst-seviye anahtar → uyar ama FIRLATMA (kullanıcının elle
    // düzenlediği profildeki yazım hatası görünür olsun, pipeline kilitlenmesin).
    for (const key of Object.keys(parsed as Record<string, unknown>)) {
      if (!KNOWN_PROFILE_KEYS.has(key)) {
        log.warn("profile-loader", "bilinmeyen profil anahtarı (yazım hatası olabilir)", { path, key });
      }
    }
    const profile = parsed as StackProfile;
    log.info("profile-loader", "loaded", { path });
    return profile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn("profile-loader", "profile not found", { path });
      return null;
    }
    log.error("profile-loader", "profile load failed", { path, err });
    throw err;
  }
}

/**
 * Stack profilinden basit komut key'i resolve eder. Profil yoksa veya key
 * tanımlı değilse null → caller mechanical-runner.ts isMissingCommand
 * pattern'i ile skip eder.
 */
export function resolveCommand(
  profile: StackProfile | null,
  key: ProfileCommandKey,
): string | null {
  if (!profile) return null;
  const cmd = profile.commands[key];
  return cmd ?? null;
}

/**
 * project_type-aware komut resolve — Faz 16 E2E ve Faz 17 Load için.
 * Önce projectType key'i denenir, yoksa "default" fallback, o da yoksa null.
 *
 * `which`: "e2e" | "load" — profilin hangi blokunu okuyacağını belirtir.
 */
export function resolveProjectTypeCommand(
  profile: StackProfile | null,
  which: "e2e" | "load",
  projectType: ProjectType,
): string | null {
  if (!profile) return null;
  const block =
    which === "e2e" ? profile.e2e_by_project_type : profile.load_by_project_type;
  if (!block) return null;
  // Anahtar EXPLICIT tanımlıysa (string veya null) onu kullan — `null`
  // "bu tip için runner yok" anlamına gelir, default'a düşmez. Sadece anahtar
  // hiç tanımsız (undefined) ise default fallback'e gider.
  const specific = block[projectType as keyof ProjectTypeCommands];
  if (specific !== undefined) return specific;
  return block.default ?? null;
}

/**
 * Test için cache temizleme — vitest'lerde profile-loader'ı izole tutmak için.
 */
export function _clearProfileCache(): void {
  profileCache.clear();
}
