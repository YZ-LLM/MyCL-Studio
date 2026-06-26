// module-stock — yeniden-kullanılabilir feature modülleri (~/.mycl/modules/<token>/).
//
// Vizyon (YZLLM): "anket modülü gibi UI+backend+DB-şema+test'li modüller stokla, yeni
// projede reuse." Çıkarım = AGENT-GÜDÜMLÜ (dumb-heuristic DEĞİL — adversaryal review
// dosya-adı kümelemenin ÇÖP-MODÜL ürettiğini gösterdi). Orkestratör-rol ajanı (living-docs
// deseni) kodu Read/Grep ile inceleyip NET bir {kind:"modules", modules:[{name,files,...}]}
// döner; EMİN DEĞİLSE boş → no-op (sessiz çöp YASAK). prototype-cache.ts kardeşi: aynı
// güvenlik sözleşmesi (YEŞİL-gate, MYCL_HOME izole, non-blocking, fail-closed, asla throw).
//
// İLK-CUT: extract (stokla) + discover (orkestratör bağlamına available_modules) +
// agent-adapt (ajan ~/.mycl/modules/<token>/'u Read'leyip projeye uyarlar). Otomatik
// kopya/wire + dumb-heuristic boundary ERTELENDİ (review kararı; detay hafıza
// project_module_stock_plan).

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { appendAudit, readAuditLog } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { backendForRole, resolveProvider, type MyclConfig } from "./config.js";
import { resolveCliProvider } from "./claude-api.js";
import { computeVerdict } from "./harness-verdict.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigFile } from "./paths.js";
import { DENY_SEGMENTS } from "./prototype-cache.js";
import type { State } from "./types.js";

const MAX_AGE_DAYS = 30;
const MODULES_DIR = "modules";
const MANIFEST_FILE = "module.json";
const MAX_LISTED = 15; // context token bütçesi (discover)

/** Ajan-belirlenmiş ham modül tanımı (orkestratör çıkarım çıktısı). */
export interface ModuleDescriptor {
  name: string; // İngilizce feature adı (features.md EN-zorunlu)
  files: string[]; // proje-köküne göreli yollar
  db_tables?: string[];
  routes?: string[];
  deps?: string[];
}

/** Diske yazılan modül manifesti (~/.mycl/modules/<token>/module.json). */
export interface ModuleManifest {
  name: string;
  token: string;
  files: string[];
  db_tables: string[];
  routes: string[];
  deps: string[];
  stack: string;
  intent_context: string;
  source_project: string;
  createdAt: number;
  nodeVersion: string;
}

/** Discover özeti (context'e inject — full files[] DEĞİL, ucuz). */
export interface ModuleSummary {
  name: string;
  token: string;
  stack: string;
  fileCount: number;
  db_tables: string[];
  routes: string[];
  createdAt: number;
}

/** SAF: İngilizce ad → slug token (dizin adı + eşleştirme anahtarı). */
export function slugToken(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function modulesRoot(): string {
  return globalConfigFile(MODULES_DIR);
}
function moduleDir(token: string): string {
  return globalConfigFile(join(MODULES_DIR, token));
}
function moduleManifestPath(token: string): string {
  return globalConfigFile(join(MODULES_DIR, token, MANIFEST_FILE));
}

/** SAF: relPath bu modüle ait mi (DENY guard + manifest.files üyeliği). */
export function matchesModule(relPath: string, files: string[]): boolean {
  const norm = relPath.split(sep).join("/");
  if (norm === "" || norm.startsWith("/")) return false;
  if (norm.split("/").some((s) => DENY_SEGMENTS.has(s))) return false;
  return files.includes(norm);
}

/** SAF: modül MAX_AGE_DAYS'ten eski mi (bayat). */
export function isModuleStale(meta: { createdAt: number }, now: number, maxAgeDays = MAX_AGE_DAYS): boolean {
  return now - meta.createdAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

/** SAF: ham descriptor'ı validate + temizle. Güvenli proje-içi göreli yollar
 *  (mutlak / ".." / DENY-segment yasak); boş/geçersizse null. */
export function sanitizeDescriptor(d: unknown): ModuleDescriptor | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const seen = new Set<string>();
  const files: string[] = [];
  for (const f of Array.isArray(o.files) ? o.files : []) {
    if (typeof f !== "string") continue;
    const norm = f.trim().split(sep).join("/");
    if (norm === "" || norm.startsWith("/") || norm.includes("..")) continue;
    if (norm.split("/").some((s) => DENY_SEGMENTS.has(s))) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    files.push(norm);
  }
  if (files.length === 0) return null;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { name, files, db_tables: strArr(o.db_tables), routes: strArr(o.routes), deps: strArr(o.deps) };
}

/** SAF: orkestratör çıktısından modül descriptor'larını parse + sanitize.
 *  {kind:"modules", modules:[...]} veya tek {kind:"module", name, files,...}. */
export function parseModuleBlock(text: string): ModuleDescriptor[] {
  const block = extractKindBlock(text, ["modules", "module"]);
  if (!block) return [];
  const o = block as Record<string, unknown>;
  const raw = Array.isArray(o.modules) ? o.modules : [o];
  const out: ModuleDescriptor[] = [];
  const seenTokens = new Set<string>();
  for (const r of raw) {
    const d = sanitizeDescriptor(r);
    if (!d) continue;
    const tok = slugToken(d.name);
    if (!tok || seenTokens.has(tok)) continue;
    seenTokens.add(tok);
    out.push(d);
  }
  return out;
}

/** Pure: orkestratör çıkarım prompt'u (İngilizce — ana ajan/orkestratör kuralı). */
export function buildModuleExtractPrompt(): string {
  return [
    "You are MyCL Studio's orchestrator. The build pipeline just finished GREEN.",
    "Identify SELF-CONTAINED, REUSABLE feature modules in this project that could be",
    "lifted into a future project (e.g. a 'survey' module = its UI + API/routes + DB",
    "schema + tests). Inspect with Read/Grep/Glob/Bash.",
    "",
    "STRICT rules — quality over coverage:",
    "- Only report a module if its file set is CLEAR and cohesive (you can name the exact",
    "  files that belong to it). If boundaries are fuzzy or you are unsure, DO NOT report it.",
    "- A module must span the feature's own files (component(s) + its backend/route + schema",
    "  + tests when present). Do NOT include shared/generic files (utils, config, app entry,",
    "  index, framework scaffold) — those are not part of any single module.",
    "- Prefer reporting NOTHING over reporting a fuzzy/garbage module.",
    "- file paths must be project-relative (no absolute, no '..').",
    "",
    "Emit EXACTLY ONE JSON object as the LAST thing, nothing else:",
    '{"kind":"modules","modules":[{"name":"<English feature name>","files":["src/...","..."],"db_tables":["..."],"routes":["/..."],"deps":["npm-pkg"]}]}',
    'If there is no clear reusable module, emit {"kind":"modules","modules":[]}.',
  ].join("\n");
}

/**
 * IMPURE: tek bir modülü ~/.mycl/modules/<token>/ altına kopyalar (katman ağacı
 * korunur) + module.json yazar. descriptor.files içinde GERÇEKTEN var olan dosyalar
 * kopyalanır; hiçbiri yoksa NO-OP (çöp dizin bırakmaz). Non-blocking — throw etmez.
 */
export async function extractModule(state: State, descriptor: ModuleDescriptor): Promise<boolean> {
  try {
    const token = slugToken(descriptor.name);
    if (!token) return false;
    const destDir = moduleDir(token);
    await fs.rm(destDir, { recursive: true, force: true }); // tazele
    const copied: string[] = [];
    for (const rel of descriptor.files) {
      const src = join(state.project_root, rel);
      if (!existsSync(src)) continue; // ajan var-olmayan dosya saydıysa atla
      const dest = join(destDir, rel);
      await fs.mkdir(join(dest, ".."), { recursive: true });
      await fs.copyFile(src, dest);
      copied.push(rel);
    }
    if (copied.length === 0) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      return false; // gerçek dosya yok → çöp üretme
    }
    const manifest: ModuleManifest = {
      name: descriptor.name,
      token,
      files: copied,
      db_tables: descriptor.db_tables ?? [],
      routes: descriptor.routes ?? [],
      deps: descriptor.deps ?? [],
      stack: state.stack ?? "unknown",
      intent_context: (state.intent_summary ?? "").slice(0, 300),
      source_project: basename(state.project_root),
      createdAt: Date.now(),
      nodeVersion: process.version,
    };
    await fs.mkdir(modulesRoot(), { recursive: true });
    await fs.writeFile(moduleManifestPath(token), JSON.stringify(manifest, null, 2), "utf-8");
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase,
      event: "module-extracted",
      caller: "mycl-orchestrator",
      detail: `token=${token} files=${copied.length}`,
    }).catch((e) => log.error("module-stock", "module-extracted audit yazılamadı (denetim izi eksik)", { error: String(e) }));
    emitChatMessage(
      "system",
      `📦 '${descriptor.name}' modülü stoklandı (${copied.length} dosya) — yeni projede yeniden kullanılabilir.`,
    );
    return true;
  } catch (err) {
    // Modül stoklama (copyFile/writeFile) başarısız (sessiz-fallback denetimi): sessiz log.warn → modül
    // yeniden-kullanım için KAYDEDİLMEDİ. log.error + görünür (disk/izin).
    log.error("module-stock", "modül stoklanamadı (kopya/yazım hatası) — yeniden-kullanım için kaydedilmedi", err);
    emitChatMessage("system", "⚠️ Modül stoklanamadı (disk/izin?) — yeniden kullanılabilir baseline'a eklenmedi.");
    return false;
  }
}

/**
 * IMPURE: pipeline-end yan-yarar. YEŞİL koşu (gate-fail/security-skip yok) + stack
 * biliniyorsa, orkestratör-rol ajanına projeyi inceletip NET modülleri çıkarır.
 * Ajan emin değilse boş → no-op. CLI-only (fail-closed; API'de görünür not + skip).
 * ASLA throw etmez (prototype-cache snapshot deseni).
 */
export async function extractStockedModules(state: State, config: MyclConfig): Promise<void> {
  try {
    const stack = state.stack;
    if (!stack || stack === "unknown") return;
    const verdict = computeVerdict(await readAuditLog(state.project_root));
    if (!verdict.completed || verdict.gateFailures.length > 0 || verdict.securitySkipped.length > 0) {
      return; // yalnız tam-doğrulanmış koşu (çöp/yarım modül yok)
    }
    // ⑥ CLI/abonelik VEYA Sağlayıcı=Z.AI (orkestratör) → çalışır; z.ai'de claude CLI z.ai endpoint'ine yönlenir.
    if (backendForRole(config, "orchestrator") !== "cli" && !resolveProvider(config, "orchestrator").isZai) {
      emitChatMessage(
        "system",
        "ℹ️ Modül stoğu çıkarımı şu an CLI/abonelik VEYA z.ai modunda yapılır (orkestratör rolü).",
      );
      return;
    }
    const baseModel = config.selected_models.orchestrator ?? config.selected_models.main;
    const cli = resolveCliProvider(config, "orchestrator", baseModel);
    emitChatMessage("system", "📦 Yeniden kullanılabilir modüller aranıyor (orkestratör)…");
    const res = await runClaudeCli({
      systemPrompt: buildModuleExtractPrompt(),
      userMessage: "Inspect the project and emit the modules JSON now.",
      modelId: cli.model,
      extraEnv: cli.extraEnv,
      cwd: state.project_root,
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // salt-okunur: yazma + alt-ajan yasak, Bash inceleme için açık
      effort: config.claude_code_flags.effort,
      timeoutMs: 300_000,
    });
    if (!res.ok) {
      emitChatMessage("system", "⚠️ Modül çıkarımı yapılamadı (claude hatası).");
      return;
    }
    const descriptors = parseModuleBlock(res.text);
    if (descriptors.length === 0) {
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: state.current_phase,
        event: "modules-extract-skipped",
        caller: "mycl-orchestrator",
        detail: "no clear reusable module",
      }).catch((e) => log.error("module-stock", "modules-extract-skipped audit yazılamadı", { error: String(e) }));
      return; // net modül yok → sessiz-çöp değil, audit'e yazıldı (spam yok)
    }
    let n = 0;
    for (const d of descriptors) if (await extractModule(state, d)) n++;
    log.info("module-stock", "extraction done", { found: descriptors.length, stocked: n });
  } catch (err) {
    log.warn("module-stock", "extractStockedModules failed (non-fatal)", err);
  }
}

/**
 * IMPURE: stoklu modüllerin ÖZETLERİ (discover — orkestratör karar bağlamına inject).
 * stack verilirse stack-filtre (cross-stack çöp önle); defansif limit; fail → [].
 * Full files[] DÖNMEZ (token bütçesi).
 */
export async function listAvailableModules(stack?: string): Promise<ModuleSummary[]> {
  try {
    const root = modulesRoot();
    if (!existsSync(root)) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const out: ModuleSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const m = JSON.parse(await fs.readFile(moduleManifestPath(e.name), "utf-8")) as ModuleManifest;
        if (stack && stack !== "unknown" && m.stack && m.stack !== "unknown" && m.stack !== stack) {
          continue; // farklı stack → bu projede reuse-edilemez
        }
        out.push({
          name: m.name,
          token: m.token,
          stack: m.stack,
          fileCount: Array.isArray(m.files) ? m.files.length : 0,
          db_tables: m.db_tables ?? [],
          routes: m.routes ?? [],
          createdAt: m.createdAt,
        });
      } catch (e) {
        // Bozuk manifest sessizce atlanıyordu → görünür kıl (N>0 bozuk = stok bozulmuş olabilir).
        log.warn("module-stock", "bozuk modül manifesti atlandı (stoklu modül listelenemedi)", { error: String(e) });
      }
    }
    return out.slice(0, MAX_LISTED);
  } catch (e) {
    // listAvailableModules gövdesi (readdir/iterasyon) — existsSync boş-stoğu zaten ayırır; buraya düşen
    // GERÇEK hatadır (izin/IO) → sessiz [] yerine görünür kıl.
    log.warn("module-stock", "modül-stoğu listelenemedi (readdir/iterasyon hatası) — boş döndü", { error: String(e) });
    return [];
  }
}
