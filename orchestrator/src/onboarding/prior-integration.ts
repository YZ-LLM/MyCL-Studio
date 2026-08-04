// prior-integration — "bu proje daha önce entegre edilmiş mi?" tespiti + sıfırdan başlama kararı.
//
// KÖK NEDEN (YZLLM 2026-08-04): "dün gece sıfırdan entegrasyon başlattım ama sanırım eski referansına
// gitti. sıfırdan entegrasyon başlatırsam yeni id ile yeni kopya oluştursun. ordan ilerlesin. önceki
// kopyanın işleri gelmez bu sayede iş listesine."
//
// Yaşanan akış: kullanıcı ORİJİNAL klasörü seçiyor → orijinalde `.mycl` olmadığı için "yabancı"
// sınıflanıyor → onboarding koşuyor → kum havuzu erişim engeline takılıyor → copyProjectToAccessible
// çağrılıyor → hedef adı kaynak yolunun hash'inden DETERMİNİSTİK üretildiği ve "hedef varsa re-copy yok"
// kısa devresi olduğu için ESKİ kopyanın yolu dönüyor → o kopya açılıyor ve eski iş kuyruğu sürülüyor.
//
// Bu modül kararı ÖNDEN verilebilir hale getirir: açılış akışının en başında "önceki entegrasyon var mı"
// bilinir, kullanıcıya sorulur, ve ancak ondan sonra pahalı onboarding başlar. Böylece eski kuyruk hiç
// yüzeye çıkmaz. Saf karar (decideIntegrationRestart) ile IO (findPriorIntegrations) ayrı.

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  copyHashFor,
  isUnderMyclProjeler,
  myclProjelerDir,
  parseCopyDirName,
} from "./copy-to-accessible.js";
import { log } from "../logger.js";

/** Bulunan bir kopya (kuşak + o kopyada bekleyen iş sayısı). */
export interface PriorCopy {
  path: string;
  generation: number;
  /** Onboarding o kopyada BAŞARIYLA tamamlanmış mı (.mycl/onboarded.json). */
  onboarded: boolean;
  /** Kuyrukta bekleyen/koşan iş sayısı — "kaldığın yerden devam" seçeneğini anlamlı kılar. */
  pendingTasks: number;
}

export interface PriorIntegration {
  /** GERÇEK kaynak: kopya seçildiyse copied-from.json'daki origin, yoksa seçilen yolun kendisi. */
  source: string;
  /** Seçilen yolun kendisi bir MyCL kopyası mı? */
  selectedIsCopy: boolean;
  /** Seçilen yol DIŞINDAKİ kopyalar, en yeni kuşak başta. */
  copies: PriorCopy[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `.mycl/task-queue.jsonl` içinde bekleyen/koşan iş sayısı. Dosya yoksa/bozuksa 0 (asla throw etmez). */
async function countPendingTasks(root: string): Promise<number> {
  try {
    const raw = await fs.readFile(join(root, ".mycl", "task-queue.jsonl"), "utf-8");
    const status = new Map<string, string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { id?: string; status?: string };
        if (rec.id) status.set(rec.id, rec.status ?? "pending");
      } catch {
        // bozuk satır — atla (sayım tahmini; kararı bu sayı belirlemiyor, yalnız mesajı zenginleştiriyor)
      }
    }
    return [...status.values()].filter((s) => s === "pending" || s === "running").length;
  } catch {
    return 0;
  }
}

/**
 * Seçilen yol için önceki entegrasyonları bulur. `baseDir` ENJEKTE EDİLEBİLİR → testler geçici dizinde
 * koşar, gerçek "MyCL Projeler" klasörü asla kirlenmez.
 *
 * Eşleşme İKİ kanıta dayanır: klasör adındaki kaynak hash'i VE `copied-from.json` içindeki `origin`.
 * Yalnız hash'e güvenmek (teorik) çakışmada yanlış projeyi "önceki kopya" gösterebilirdi.
 */
export async function findPriorIntegrations(
  selectedRoot: string,
  baseDir: string = myclProjelerDir(),
): Promise<PriorIntegration> {
  const selected = selectedRoot.replace(/\/+$/, "");
  const selectedIsCopy = isUnderMyclProjeler(selected) || dirname(selected) === baseDir;
  const copiedFrom = await readJson(join(selected, ".mycl", "copied-from.json"));
  const origin = typeof copiedFrom?.origin === "string" ? copiedFrom.origin : undefined;
  const source = selectedIsCopy && origin ? origin : selected;
  const wantHash = copyHashFor(source);

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(baseDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    entries = []; // "MyCL Projeler" henüz yok → önceki kopya da yok
  }

  const copies: PriorCopy[] = [];
  for (const name of entries) {
    const parsed = parseCopyDirName(name);
    if (!parsed || parsed.hash !== wantHash) continue;
    const path = join(baseDir, name);
    if (path === selected) continue; // seçilen kopyanın kendisi "başka kopya" değildir
    // İKİNCİ KANIT: bu klasör gerçekten aynı kaynağın kopyası mı?
    const meta = await readJson(join(path, ".mycl", "copied-from.json"));
    if (typeof meta?.origin === "string" && meta.origin !== source) continue;
    copies.push({
      path,
      generation: parsed.generation,
      onboarded: !!(await readJson(join(path, ".mycl", "onboarded.json"))),
      pendingTasks: await countPendingTasks(path),
    });
  }
  copies.sort((a, b) => b.generation - a.generation);
  log.info("prior-integration", "önceki entegrasyon taraması", {
    selected,
    source,
    selectedIsCopy,
    found: copies.length,
  });
  return { source, selectedIsCopy, copies };
}

/** Kapının kararı. */
export type IntegrationRestartDecision =
  | "proceed" // soru yok — bugünkü akış aynen
  | "ask" // kullanıcıya sor
  | "fresh"; // yeni kimlikle yeni kopya

/**
 * SAF karar. Soru YALNIZ şu durumda çıkar: kullanıcı "Proje Aç (Entegre Et)" düğmesine bastı VE bu
 * projenin daha önce bir entegrasyonu var. Son projeler listesinden açmak `integrate` taşımadığı için
 * (Splash.tsx) normal yeniden açmada asla soru sorulmaz.
 *
 * `neverAsk` ("hiçbir şey sorma") modunda SORULMAZ ve "devam" seçilir: yeni kopya yeni kimlik + disk +
 * yeni kuyruk demektir, bu "kararları sen ver" izninin kapsamı değil (model yükseltme askq'sinin aynı
 * ilkesi: kalıcı kullanıcı tercihini otomatik değiştirme). Soruyu asılı bırakmak seçenek değil.
 */
export function decideIntegrationRestart(input: {
  integrate: boolean;
  prior: { selectedIsCopy: boolean; copies: readonly PriorCopy[] };
  alreadyOnboardedInPlace: boolean;
  neverAsk: boolean;
  /** Önceden verilmiş tek atışlık karar (askq cevabı / onboarding'in kendi yeniden açması). */
  decided?: "resume" | "fresh";
}): IntegrationRestartDecision {
  if (input.decided === "fresh") return "fresh";
  if (input.decided === "resume") return "proceed";
  if (!input.integrate) return "proceed";
  const hasPrior = input.prior.copies.length > 0 || input.alreadyOnboardedInPlace;
  if (!hasPrior) return "proceed";
  return input.neverAsk ? "proceed" : "ask";
}

/** Soru metni + seçenekler (SAF) — kullanıcı neyin arasında seçtiğini somut görsün. */
export const RESTART_RESUME = "▶️ Kaldığım yerden devam et";
export const RESTART_FRESH = "🆕 Sıfırdan yeni kopya";

export function restartQuestion(prior: PriorIntegration, selectedRoot: string): string {
  const newest = prior.copies[0];
  const where = newest ? basename(newest.path) : basename(selectedRoot);
  const work = newest?.pendingTasks
    ? ` Orada bekleyen ${newest.pendingTasks} iş var.`
    : " Orada bekleyen iş yok.";
  return (
    `Bu proje daha önce entegre edilmiş (${where}).${work}\n\n` +
    `Kaldığın yerden mi devam edeyim, yoksa sıfırdan yeni bir kopya mı açayım? ` +
    `Yeni kopya boş bir iş listesiyle başlar; eski kopya silinmez, yerinde durur.`
  );
}
