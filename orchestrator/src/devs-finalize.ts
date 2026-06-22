// devs-finalize — iterasyon-SONU: devs/_pending/<ts>/ artefaktlarını iş-birimi klasörlerine taşır/böler.
// YZLLM 2026-06-16: resolver ile değişen dosyalar → birimler (pages/endpoints/tables/shared); her birim
// devs/<type>/<key>/<ts>/ altına; iter-spec ilgili birime; _shared değişen sayfalara link verir.
//
// pipeline-end'de FAIL-SOFT çağrılır — throw pipeline'ı KIRMAZ (snapshotPrototype/updateLivingDocs deseni).
//
// Faz 4a kapsamı: yapısal split + iter-spec yerleştirme + meta.json + _pending temizlik.
// (page-spec.md zenginleştirme + kök genel spec tazeleme + diff yakalama → Faz 4b.)

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { State } from "./types.js";
import { log } from "./logger.js";
import { emitChatMessage } from "./ipc.js";
import { deriveDevsPaths, pendingSpecPath } from "./devs-paths.js";
import { resolveUnits, type ResolvedUnit, type UnitType } from "./fix/route-resolver.js";
import { computeChangedScope } from "./fix/scope.js";

/** Birim tipi → devs/ alt-dizini. shared → _shared (sayfaya bağlanamayan). */
const TYPE_DIR: Record<UnitType, string> = {
  page: "pages",
  endpoint: "endpoints",
  table: "tables",
  shared: "_shared",
};

interface UnitMeta {
  ts: string;
  intent: string;
  unit: { type: UnitType; key: string };
  files: string[];
  /** Bu iterasyonda dokunulan TÜM birimler (kardeş erişimi için). */
  all_units: { type: UnitType; key: string }[];
  /** Çoklu-birimde iter-spec birincil birimde; ikincil birimler buradan referans verir. */
  spec_ref?: string;
}

/** Bu iterasyonda hangi birimlere ne yazıldı — Faz 4b spec-tazeleme bunu tüketir (page-spec/kök-spec). */
export interface FinalizeOutcome {
  /** YYYY-MM-DD-HH-MM-SS. */
  tsLabel: string;
  /** Gerçek birimler (page/endpoint/table) — her birinin devs/<type>/<key>/<ts>/ mutlak dizini. */
  units: { type: UnitType; key: string; dir: string }[];
  /** Gerçek birim yoksa devs/<ts>/ doğrudan dizini (units boş). */
  directDir?: string;
  /** Bu iterasyonun iter-spec.md mutlak yolu (birincil birimde ya da doğrudan dizinde). */
  iterSpecPath: string;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * İterasyon-sonu devs/ finalize. fail-soft: herhangi bir adım patlasa log.warn + devam
 * (pipeline-end zincirini KIRMAZ). iteration_started_at yoksa (Faz 0 garantiler) no-op.
 */
export async function finalizeDevsArtifacts(state: State): Promise<FinalizeOutcome | null> {
  const ts = state.iteration_started_at;
  if (!ts) return null;
  const { devsRoot, tsLabel, pendingDir } = deriveDevsPaths(state.project_root, ts);

  // iter-spec _pending'de yoksa (Faz 4 atlandı/yazılmadı) → finalize edilecek artefakt yok.
  let iterSpec: string;
  try {
    iterSpec = await fs.readFile(pendingSpecPath(state.project_root, ts), "utf-8");
  } catch (e) {
    // errno-AYRIMI (sessiz-fallback denetimi): ENOENT = Faz 4 atlandı/yazılmadı (meşru no-op). BAŞKA hata
    // (EACCES/EIO) = spec VAR ama okunamadı → finalize sessizce atlanırsa iterasyon-spec'i kaybolur. Görünür.
    if ((e as { code?: string }).code !== "ENOENT") {
      log.error("devs-finalize", "iter-spec okunamadı (var ama erişilemedi) — finalize atlandı, spec kaybolabilir", {
        code: (e as { code?: string }).code,
      });
    }
    return null; // spec yok → no-op
  }

  // değişen dosyalar → birimler (deterministik resolver). Boşsa tek "shared" birim.
  const changed = await computeChangedScope(state.project_root, undefined, ts)
    .then((s) => s.files)
    .catch((e) => {
      // Beklenmedik throw'u sessiz []'e düşürmek (sessiz-fallback denetimi): değişen-dosya kümesi kaybolur →
      // birim çözümü yanlış 'shared'a düşebilir. Görünür kıl (boş-liste ≠ crash).
      log.error("devs-finalize", "computeChangedScope hata — değişen-dosya kümesi boş türetildi (birim çözümü 'shared'a düşebilir)", { error: String(e) });
      return [] as string[];
    });
  let units: ResolvedUnit[] = [];
  if (changed.length > 0) {
    units = await resolveUnits(state.project_root, changed).catch((e) => {
      log.warn("devs-finalize", "resolveUnits başarısız (shared'a düş)", e);
      return [];
    });
  }

  const intent = (state.intent_summary ?? "").slice(0, 600);
  const realUnits = units.filter((u) => u.type !== "shared");
  const sharedUnit = units.find((u) => u.type === "shared");
  const allUnitsRef = units.map((u) => ({ type: u.type, key: u.key }));

  try {
    let outcome: FinalizeOutcome;
    if (realUnits.length === 0) {
      // Sayfa/endpoint/tablo yok (YZLLM: "hiçbiri yoksa devs içine direk") → devs/<ts>/ doğrudan.
      const dir = join(devsRoot, tsLabel);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "iter-spec.md"), iterSpec, "utf-8");
      const meta: UnitMeta = {
        ts: tsLabel,
        intent,
        unit: { type: "shared", key: "_root" },
        files: sharedUnit?.files ?? changed,
        all_units: allUnitsRef,
      };
      await writeJson(join(dir, "meta.json"), meta);
      outcome = { tsLabel, units: [], directDir: dir, iterSpecPath: join(dir, "iter-spec.md") };
    } else {
      // Birincil birim = en çok dosya değişen (iter-spec'in tam metni burada yaşar).
      const primary = [...realUnits].sort((a, b) => b.files.length - a.files.length)[0];
      const primaryRef = `../../${TYPE_DIR[primary.type]}/${primary.key}/${tsLabel}/iter-spec.md`;
      const outUnits: FinalizeOutcome["units"] = [];
      let primaryIterSpecPath = "";

      for (const unit of realUnits) {
        const dir = join(devsRoot, TYPE_DIR[unit.type], unit.key, tsLabel);
        await fs.mkdir(dir, { recursive: true });
        const isPrimary = unit === primary;
        if (isPrimary) {
          primaryIterSpecPath = join(dir, "iter-spec.md");
          await fs.writeFile(primaryIterSpecPath, iterSpec, "utf-8");
        }
        const meta: UnitMeta = {
          ts: tsLabel,
          intent,
          unit: { type: unit.type, key: unit.key },
          files: unit.files,
          all_units: allUnitsRef,
          // İkincil birim: iter-spec birincil birimde — buraya referans (kopya YOK).
          ...(isPrimary ? {} : { spec_ref: primaryRef }),
        };
        await writeJson(join(dir, "meta.json"), meta);
        outUnits.push({ type: unit.type, key: unit.key, dir });
      }

      // _shared: sayfaya bağlanamayan değişiklikler + o iterasyonda değişen TÜM birimlere link.
      if (sharedUnit) {
        const sharedDir = join(devsRoot, "_shared", tsLabel);
        await fs.mkdir(sharedDir, { recursive: true });
        await writeJson(join(sharedDir, "pages.json"), {
          ts: tsLabel,
          linked_units: realUnits.map((u) => ({ type: u.type, key: u.key })),
          shared_files: sharedUnit.files,
          spec_ref: primaryRef,
        });
      }
      outcome = { tsLabel, units: outUnits, iterSpecPath: primaryIterSpecPath };
    }

    // _pending/<ts>/ taşındı → temizle (bir sonraki iterasyon temiz başlasın).
    await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => {});
    log.info("devs-finalize", "iterasyon artefaktları birimlere taşındı", {
      ts: tsLabel,
      units: allUnitsRef.length,
    });
    return outcome;
  } catch (e) {
    // finalize artefaktları (iter-spec/units/_shared) yazılamadı (sessiz-fallback denetimi): sessiz log.warn →
    // bu iterasyonun spec'i KAYDEDİLMEDİ (yaşayan-dökümantasyon/handoff eksik). GÖRÜNÜR kıl (pipeline kırılmaz).
    log.error("devs-finalize", "finalize başarısız — iterasyon spec/artefaktları kaydedilmedi (non-fatal)", e);
    emitChatMessage(
      "system",
      `⚠️ İterasyon artefaktları (spec/birimler) kaydedilemedi — yaşayan-dökümantasyon bu tur eksik kalabilir. (${String(e).slice(0, 100)})`,
    );
    return null;
  }
}
