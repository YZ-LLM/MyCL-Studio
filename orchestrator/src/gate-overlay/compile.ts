// gate-overlay/compile — iterasyon başında overlay DERLEME: model önerisi → doğrulanmış,
// kalıcı, deterministik bir kısıt kümesi.
//
// NEDEN iterasyon BAŞINDA (sonunda değil): kısıt, kod yazılmadan ÖNCE bilinmezse yalnız
// "yaptığını geri al" diyebiliriz — engelleyemeyiz. Derleme burada bitince Faz C hem araç
// çağrısı anında (tool_deny) hem faz sonunda (phase_end) AYNI kayda bakar.
//
// NEDEN dosyaya YAZILIR (bellek yetmez): iterasyon çökebilir, süreç yeniden başlayabilir,
// kod yazan ajanlar ayrı süreçlerde koşar. `.mycl/overlays/current.json` tek doğruluk kaynağı;
// bellekteki kopya yalnız hızlı erişim içindir.
//
// NEDEN her derleme öncekini ARŞİVE taşır (AD-4): "bir önceki iterasyonun kısıtı bu iterasyona
// sızmasın" garantisi, pipeline sonunda temizlik yapmaya bırakılırsa çökme/iptal yollarında
// tutulmaz (o kod hiç çalışmaz). Süpürmeyi DERLEMENİN İLK ADIMI yapmak garantiyi yapısal kılar:
// current.json her zaman EN SON derlemedir, çünkü yenisi eskisini arşive taşımadan yazılmaz.
//
// AD-8: bozuk overlay dosyası sessizce yok sayılmaz — okuma hatası fırlatılır, çağıran görünür
// hataya çevirir ("gate'siz devam" sessiz bir kalite düşüşü olurdu, KATI #4).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { extractKindBlock, schemaToSkeleton } from "../cli-json.js";
import type { GatePool } from "./pool.js";
import {
  dedupeSelections,
  parseOverlayProposal,
  validateSelection,
} from "./select.js";
import type {
  MissingGate,
  OverlayContext,
  OverlaySelection,
  SelectionFailureCode,
} from "./select.js";

/** Doğrulamanın üç kapısından da geçmiş, uygulanacak seçim. */
export interface AcceptedSelection {
  gate_id: string;
  params: Record<string, string>;
  /** Yalnız insan okuması için (select.ts sözleşmesi: hiçbir mekanik karar buna bakmaz). */
  reason?: string;
}

/** Düşen seçim — kullanıcıya/denetime NEDEN düştüğü ile birlikte taşınır. */
export interface RejectedSelection {
  sel: OverlaySelection;
  code: SelectionFailureCode;
  reason: string;
}

/**
 * Bir iterasyon için derlenmiş overlay. Diske yazılan biçim BUDUR — alan eklerken
 * `overlay_version` artırılmalı (okuyucu eski biçimi sessizce yorumlamasın).
 */
export interface CompiledOverlay {
  overlay_version: 1;
  pool_version: number;
  /** `iter<iteration_count>-<iteration_started_at>` — hangi iterasyona ait olduğu. */
  iteration_key: string;
  compiled_at: number;
  selections: AcceptedSelection[];
  /**
   * Faz C'nin "değişti mi?" tespiti için iterasyon başındaki içerik parmak izleri
   * (proje-göreli yol → sha256, dosya yoksa null).
   */
  baselines: Record<string, string | null>;
}

export interface CompileResult {
  accepted: AcceptedSelection[];
  rejected: RejectedSelection[];
  missing: MissingGate[];
  /** Dolu ise model çıktısı hiç okunamadı — çağıran görünür hataya çevirir. */
  parseError?: string;
}

/** Model çıktısındaki blok kimliği (cli-json `extractKindBlock` sözleşmesi). */
export const OVERLAY_BLOCK_KIND = "gate_overlay";

/**
 * Parametreleri ad sırasına sabitler. NEDEN: modelin anahtar sırası tur tur değişebilir;
 * kalıcılaştırılan JSON'un (ve içerik hash'inin) aynı seçim için AYNI baytlar olması,
 * "overlay değişti mi?" sorusunun karşılaştırmayla cevaplanabilmesi demektir.
 */
function canonicalParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(params).sort()) out[key] = params[key];
  return out;
}

/**
 * SAF derleyici: modelin ham metninden doğrulanmış seçim kümesi üretir.
 * Sıra: blok çıkarımı → biçim → tekilleştirme → seçim başına üç kapı (sözlük/şema/bağlam).
 *
 * Blok yoksa ya da biçimi bozuksa `parseError` dolu döner (accepted BOŞ kalır) — kısmi
 * yorumlama YOK: yarım anlaşılmış bir öneriden kısıt üretmek, hangi kuralın uygulandığını
 * belirsiz bırakırdı. Sözlük dışındaki serbest metin hiçbir yerde yorumlanmaz (AD-1).
 */
export function compileOverlayFromProposal(
  rawText: string,
  pool: GatePool,
  ctx: OverlayContext,
): CompileResult {
  const empty = (parseError: string): CompileResult => ({
    accepted: [],
    rejected: [],
    missing: [],
    parseError,
  });
  const block = extractKindBlock(rawText, [OVERLAY_BLOCK_KIND]);
  if (!block) {
    return empty(`cikti icinde {"kind":"${OVERLAY_BLOCK_KIND}"} blogu bulunamadi`);
  }
  const parsed = parseOverlayProposal(block);
  if (!parsed.ok) return empty(parsed.error);

  const accepted: AcceptedSelection[] = [];
  const rejected: RejectedSelection[] = [];
  for (const sel of dedupeSelections(parsed.proposal.selections)) {
    const verdict = validateSelection(sel, pool, ctx);
    if (!verdict.ok) {
      rejected.push({ sel, code: verdict.code, reason: verdict.reason });
      continue;
    }
    const item: AcceptedSelection = {
      gate_id: sel.gate_id,
      params: canonicalParams(sel.params),
    };
    if (sel.reason !== undefined) item.reason = sel.reason;
    accepted.push(item);
  }
  return { accepted, rejected, missing: parsed.proposal.missing };
}

// ───────────────────────── Prompt (SAF) ─────────────────────────
//
// Prompt İNGİLİZCE: ajan tarafı repoda hep İngilizce çalışır (dil hattı kuralı — kullanıcıya
// dönen metin Türkçe, modele giden metin İngilizce). Gate açıklamaları havuz dosyasından
// AYNEN alınır (Türkçe olsalar bile): İngilizce ikinci bir açıklama yazmak sözlük için İKİNCİ
// bir doğruluk kaynağı yaratır ve havuz güncellenince sessizce bayatlar.

/** Model çıktısının şeması — somut iskelet buradan türetilir (cli-json `schemaToSkeleton`). */
const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [OVERLAY_BLOCK_KIND] },
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gate_id: { type: "string" },
          params: { type: "object" },
          reason: { type: "string" },
        },
      },
    },
    missing: {
      type: "array",
      items: {
        type: "object",
        properties: {
          risk_description: { type: "string" },
          suggested_name: { type: "string" },
        },
      },
    },
  },
};

/**
 * SAF: gate seçicinin system + user mesajını üretir. Kapalı sözlük promptun İÇİNDE tam
 * olarak listelenir — modelin "hangi gate'ler var?" diye tahmin etmesi gereken hiçbir şey
 * kalmaz (önden çöz: uydurma gate_id üretimi kaynağında engellenir).
 */
export function buildOverlayPrompt(
  pool: GatePool,
  taskText: string,
  fileInventorySummary: string,
): { system: string; user: string } {
  const dictionary = pool.gates
    .map((g) => {
      const skeleton = JSON.stringify(
        schemaToSkeleton(g.params_schema as unknown as Record<string, unknown>),
      );
      const required =
        g.params_schema.required.length > 0
          ? g.params_schema.required.join(", ")
          : "(none)";
      return [
        `### ${g.gate_id}  (enforced at: ${g.executor})`,
        `Meaning (verbatim from the pool file): ${g.description}`,
        `params shape: ${skeleton}`,
        `required params: ${required}`,
      ].join("\n");
    })
    .join("\n\n");

  const skeleton = JSON.stringify(schemaToSkeleton(PROPOSAL_SCHEMA));

  const system = [
    "You are MyCL's ITERATION GATE SELECTOR.",
    "",
    "Before an iteration starts, you decide which extra constraints must hold WHILE this",
    "specific piece of work is implemented. You do not write code and you do not plan the work.",
    "",
    "CLOSED DICTIONARY — these are the only gates that exist:",
    "",
    dictionary,
    "",
    "RULES",
    "1. Select gates ONLY by the gate_id values listed above. You cannot invent a rule: free-form",
    "   text you write is never interpreted or enforced by anything.",
    "2. Selecting nothing is a legitimate, common answer — return an empty selections array. Add a",
    "   gate only when THIS task creates a concrete risk that gate prevents. Every gate you add",
    "   constrains the implementer, so a wrong gate costs more than a missing one.",
    "3. params must match the gate's shape exactly: every required key present, every value a",
    "   string, no extra keys.",
    "4. Paths are project-relative: no leading slash, no '..' segment, no backslash. They must",
    "   exist in the project inventory, with one exception: file_must_change.path may name a file",
    "   the iteration is expected to create.",
    "5. Gates only TIGHTEN. Never select a gate meant to permit or loosen something.",
    "6. If this task carries a real risk that NO gate in the dictionary covers, describe it in",
    "   `missing` with a snake_case suggested_name. Do not bend an unrelated gate to cover it —",
    "   a human grows the dictionary, you do not.",
    "7. reason: one short sentence, for humans only.",
    "",
    "OUTPUT CONTRACT — exactly one ```json block and nothing else around it:",
    "```json",
    skeleton,
    "```",
    "Valid JSON: double quotes, no trailing commas, no comments.",
  ].join("\n");

  const user = [
    "TASK TO BE IMPLEMENTED IN THIS ITERATION:",
    '"""',
    taskText.trim(),
    '"""',
    "",
    "PROJECT INVENTORY (relative paths):",
    fileInventorySummary,
    "",
    `Now emit the single ${OVERLAY_BLOCK_KIND} JSON block.`,
  ].join("\n");

  return { system, user };
}

// ───────────────────────── Dosya envanteri ─────────────────────────

/**
 * Envanterde HİÇBİR derinlikte gezilmeyen dizin adları. fix-snapshot'ın EXCLUDE_TOP listesiyle
 * aynı zemin, farkı: burada YALNIZ ÜST SEVİYE değil her seviye elenir — çok paketli depolarda
 * paket altındaki node_modules üst seviyede görünmez ve envanteri on binlerce dosyayla şişirirdi.
 */
const INVENTORY_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".mycl",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "error_folder",
  ".turbo",
  ".cache",
  ".vite",
]);

/** Envanter üst sınırı — aşılırsa gezinti durur, kesildiği GÖRÜNÜR biçimde bildirilir. */
export const INVENTORY_MAX_FILES = 20_000;

export interface OverlayInventory {
  /** validateSelection'ın bağlam kapısı için TAM küme. */
  ctx: OverlayContext;
  /** Prompt'a giren özet (~100 satır). */
  summary: string;
  /** Üst sınıra takılıp kesildi mi (özet bunu da söyler). */
  truncated: boolean;
}

/**
 * STACK-BAĞIMSIZ standart bağımlılık bildirim dosyaları (KATI #1): tek bir ekosisteme
 * (npm) bağlanmaz. forbid_dependency_change seçildiğinde bunların projede VAR OLANLARI
 * taban çizgisine alınır.
 */
export const DEPENDENCY_MANIFEST_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "mix.exs",
  "mix.lock",
];

/** Özette gösterilecek örnek dosya sayısı (prompt'u ~100 satırda tutar). */
const SUMMARY_SAMPLE_FILES = 50;

/**
 * Projeyi gezip TAM göreli dosya/dizin kümesini + prompt özetini üretir.
 * Sembolik bağlantılar atlanır (döngü riski; hedefine kilit koymak bu özelliğin kapsamı değil).
 * Okunamayan bir alt dizin gezintiyi ÇÖKERTMEZ ama kök okunamıyorsa hata fırlatır — kök
 * okunamıyorsa envanter boş çıkar ve her yol seçimi "projede yok" diye düşerdi (sessiz yanlış).
 */
export async function buildOverlayInventory(
  projectRoot: string,
): Promise<OverlayInventory> {
  const files: string[] = [];
  const dirs: string[] = ["."]; // kök: dir="." ile proje geneline kısıt konabilsin
  let truncated = false;

  const walk = async (relDir: string, isRoot: boolean): Promise<void> => {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(join(projectRoot, relDir), { withFileTypes: true });
    } catch (err) {
      if (isRoot) {
        throw new Error(`proje kökü okunamadı: ${projectRoot} — ${String(err)}`);
      }
      return; // izin verilmeyen alt dizin: envanterde yok sayılır (o yola gate de konamaz)
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue;
      const rel = isRoot ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (INVENTORY_SKIP_DIRS.has(e.name)) continue;
        dirs.push(rel);
        await walk(rel, false);
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= INVENTORY_MAX_FILES) {
        truncated = true;
        return;
      }
      files.push(rel);
    }
  };
  await walk("", true);

  return {
    ctx: { projectFiles: new Set(files), projectDirs: new Set(dirs) },
    summary: summarizeInventory(files, dirs, truncated),
    truncated,
  };
}

/** SAF: envanteri prompt'a sığan bir özete indirger (üst dizinler + yayılmış örnek dosyalar). */
export function summarizeInventory(
  files: readonly string[],
  dirs: readonly string[],
  truncated: boolean,
): string {
  const perTop = new Map<string, number>();
  for (const f of files) {
    const slash = f.indexOf("/");
    const top = slash < 0 ? "(root files)" : `${f.slice(0, slash)}/`;
    perTop.set(top, (perTop.get(top) ?? 0) + 1);
  }
  const topLines = [...perTop.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 40)
    .map(([top, n]) => `- ${top} (${n} files)`);

  // Örnekler tüm ağaca YAYILSIN: baştan 50 dosya almak tek bir dizini gösterirdi.
  const sorted = [...files].sort();
  const stride = Math.max(1, Math.ceil(sorted.length / SUMMARY_SAMPLE_FILES));
  const samples: string[] = [];
  for (let i = 0; i < sorted.length && samples.length < SUMMARY_SAMPLE_FILES; i += stride) {
    samples.push(sorted[i]);
  }

  const manifests = DEPENDENCY_MANIFEST_FILES.filter((m) => files.includes(m));

  const out = [
    `Totals: ${files.length} files, ${dirs.length} directories.`,
    ...(truncated
      ? [
          `NOTE: inventory was cut off at ${INVENTORY_MAX_FILES} files — parts of the project are not listed below.`,
        ]
      : []),
    "",
    "Top-level areas:",
    ...(topLines.length > 0 ? topLines : ["- (no files)"]),
    "",
    `Dependency manifests present: ${manifests.length > 0 ? manifests.join(", ") : "(none)"}`,
    "",
    "Sample files:",
    ...(samples.length > 0 ? samples.map((s) => `- ${s}`) : ["- (none)"]),
  ];
  return out.join("\n");
}

// ───────────────────────── Taban çizgileri ─────────────────────────

async function sha256File(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    // Dosya yok / okunamıyor → null. NEDEN sessiz değil: null'ın kendisi TAŞINAN bir bilgidir
    // ("iterasyon başında bu dosya yoktu") ve Faz C bunu "sonradan yaratıldı" tespitinde kullanır.
    return null;
  }
}

/**
 * Kabul edilen seçimlerin dokunduğu dosyaların iterasyon-başı parmak izleri.
 * Anahtarlar SIRALI eklenir → aynı seçim kümesi her zaman aynı JSON'u (ve hash'i) verir.
 */
export async function computeBaselines(
  accepted: readonly AcceptedSelection[],
  projectRoot: string,
): Promise<Record<string, string | null>> {
  const targets = new Set<string>();
  let dependencyLock = false;
  for (const sel of accepted) {
    if (sel.gate_id === "file_immutable" || sel.gate_id === "file_must_change") {
      if (sel.params.path) targets.add(sel.params.path);
    }
    if (sel.gate_id === "forbid_dependency_change") dependencyLock = true;
  }
  if (dependencyLock) {
    // Yalnız projede VAR OLAN bildirimler: olmayan bir manifest için null taban çizgisi,
    // "iterasyon sonunda yaratıldı mı?" sorusunu Faz C'de gereksiz yere büyütürdü.
    for (const manifest of DEPENDENCY_MANIFEST_FILES) {
      try {
        const st = await fs.stat(join(projectRoot, manifest));
        if (st.isFile()) targets.add(manifest);
      } catch {
        // yok → taban çizgisi de yok
      }
    }
  }
  const out: Record<string, string | null> = {};
  for (const rel of [...targets].sort()) {
    out[rel] = await sha256File(join(projectRoot, rel));
  }
  return out;
}

// ───────────────────────── Kalıcılaştırma ─────────────────────────

const OVERLAY_DIR = join(".mycl", "overlays");
const CURRENT_FILE = "current.json";
const ARCHIVE_DIR = "archive";

/** Aktif overlay dosyasının yolu (Faz C ve testler aynı yolu kullansın diye tek kaynak). */
export function overlayCurrentPath(projectRoot: string): string {
  return join(projectRoot, OVERLAY_DIR, CURRENT_FILE);
}

export function overlayArchiveDir(projectRoot: string): string {
  return join(projectRoot, OVERLAY_DIR, ARCHIVE_DIR);
}

/** Arşiv dosya adı: eskimiş overlay'in KENDİ damgasıyla (hangi iterasyondu, ne zaman derlendi). */
function archiveName(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Partial<CompiledOverlay>;
    if (typeof obj.compiled_at === "number" && typeof obj.iteration_key === "string") {
      return `${obj.compiled_at}-${obj.iteration_key}.json`;
    }
  } catch {
    // düşülür
  }
  // Bozuk/eksik damga: adı GÖRÜNÜR biçimde işaretle (sessizce normal bir arşiv gibi durmasın).
  return `bozuk-${Date.now()}.json`;
}

/**
 * Yeni overlay'i yazar; içerik sha256'sını döndürür.
 *
 * SIRA ÖNEMLİ: önce mevcut current.json arşive TAŞINIR, sonra yenisi atomik yazılır
 * (tmp + rename — yarım dosya okunamaz). Böylece "iki iterasyonun kısıtı aynı anda aktif"
 * durumu yapısal olarak imkansızdır (AD-4).
 */
export async function persistOverlay(
  projectRoot: string,
  overlay: CompiledOverlay,
): Promise<string> {
  const dir = join(projectRoot, OVERLAY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const current = overlayCurrentPath(projectRoot);

  let previous: string | null = null;
  try {
    previous = await fs.readFile(current, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`onceki overlay okunamadi: ${current} — ${String(err)}`);
    }
  }
  if (previous !== null) {
    const archive = overlayArchiveDir(projectRoot);
    await fs.mkdir(archive, { recursive: true });
    await fs.rename(current, join(archive, archiveName(previous)));
  }

  const raw = JSON.stringify(overlay, null, 2) + "\n";
  const tmp = `${current}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, raw, "utf-8");
  await fs.rename(tmp, current);
  return createHash("sha256").update(raw).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Diskteki overlay'in yapısını doğrular. Sorun varsa gerekçe, yoksa null. */
function overlayProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "overlay bir nesne olmalı";
  if (raw.overlay_version !== 1) {
    return `overlay_version 1 olmalı, gelen ${JSON.stringify(raw.overlay_version)}`;
  }
  if (typeof raw.pool_version !== "number") return "pool_version sayı olmalı";
  if (typeof raw.iteration_key !== "string") return "iteration_key metin olmalı";
  if (typeof raw.compiled_at !== "number") return "compiled_at sayı olmalı";
  if (!Array.isArray(raw.selections)) return "selections dizi olmalı";
  for (let i = 0; i < raw.selections.length; i++) {
    const sel: unknown = raw.selections[i];
    if (!isPlainObject(sel)) return `selections[${i}] nesne olmalı`;
    if (typeof sel.gate_id !== "string") return `selections[${i}].gate_id metin olmalı`;
    if (!isPlainObject(sel.params)) return `selections[${i}].params nesne olmalı`;
    for (const [k, v] of Object.entries(sel.params)) {
      if (typeof v !== "string") return `selections[${i}].params.${k} metin olmalı`;
    }
  }
  if (!isPlainObject(raw.baselines)) return "baselines nesne olmalı";
  for (const [k, v] of Object.entries(raw.baselines)) {
    if (v !== null && typeof v !== "string") {
      return `baselines.${k} metin ya da null olmalı`;
    }
  }
  return null;
}

/**
 * Aktif overlay'i okur. Dosya yoksa null (bu iterasyonda ek gate seçilmemiş olabilir —
 * meşru durum). Dosya VARSA ama bozuksa THROW (AD-8): "okunamayan kısıt" ile "kısıt yok"
 * aynı şey değildir; ikisini karıştırmak sessizce korumasız devam etmek olurdu.
 */
export async function readActiveOverlay(
  projectRoot: string,
): Promise<CompiledOverlay | null> {
  const path = overlayCurrentPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`overlay okunamadi: ${path} — ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`overlay gecersiz: JSON cozumlenemedi — ${path} — ${String(err)}`);
  }
  const problem = overlayProblem(parsed);
  if (problem) throw new Error(`overlay gecersiz: ${path} — ${problem}`);
  return parsed as CompiledOverlay;
}

// ───────────────────────── Bellek tutucusu ─────────────────────────
//
// Faz C her araç çağrısında diske gitmesin diye derlenen overlay burada da durur. Dosya
// TEK doğruluk kaynağıdır; bu yalnız hızlı erişim kopyasıdır. Proje değişiminde temizlemek
// ÇAĞIRANIN işidir (index.ts açılış sıfırlaması) — modül kendi başına hangi projede
// olduğunu bilmez, sessizce yanlış projenin kısıtını taşımasın.

let _active: CompiledOverlay | null = null;

export function setActiveOverlay(overlay: CompiledOverlay | null): void {
  _active = overlay;
}

export function getActiveOverlay(): CompiledOverlay | null {
  return _active;
}
