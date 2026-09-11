// mycl-source-gap — "bunu projede çözemem, KENDİ kaynağımın geliştirilmesi gerek" boşlukları.
//
// NEDEN (YZLLM, 2026-09-11): adli öz denetim, Faz 11'in (sadeleştirme) 94 iterasyonda BİR KEZ bile
// koşmadığını gösterdi. Sebep proje değil: aracı yalnız TypeScript'e bakıyor, proje JavaScript.
// Hiçbir proje tarafı iş bunu çözemez — düzeltme MyCL'in KENDİ kaynağında. Bugün bu durum "uygulanamaz"
// diye nötr gösteriliyor ve orada ölüyor: kullanıcı ne olduğunu görüyor ama elinde harekete geçirecek
// bir şey olmuyor.
//
// YZLLM kararı: "sadece görünür kılmakla kalmasın, çözümü için MyCL'de geliştirme gerekiyorsa onun
// promptunu da versin — ben yapıştırayım." Yani bu modülün çıktısı bir RAPOR değil, doğrudan
// geliştiriciye (ve onun yapay zekâsına) verilebilecek, kendi kendine yeten bir İŞ TANIMI.
//
// KAPSAM DİSİPLİNİ (yanlış alarm yasağı): yalnız HİÇBİR proje tarafı işin çözemeyeceği durumlar
// buraya girer. Araç projede eksikse (`missing_command`) çözüm projede — mevcut "aracı kur" işi
// onu zaten açıyor; oraya karışılmaz.

import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Bir kapı boşluğunun çözümü kimde? */
export type GapOwner = "project" | "mycl-source" | "not-applicable";

/**
 * MyCL'in KENDİ kaynağını gerektiren atlama nedenleri:
 *  - `mycl_tool_broken`  → MyCL'in kendi tarama betiği çalışmıyor (paketleme/kod hatası).
 *  - `ts_tool_*`         → MyCL o boyut için TypeScript'e bağlı bir araç seçmiş; başka dilde boyut
 *                          ölçülemiyor. Boyut gerçek (ölü kod her dilde var), araç dar.
 * Bu ikisinde projede yapılacak hiçbir şey yok; düzeltme MyCL kaynağında.
 */
const MYCL_SOURCE_REASONS = new Set(["mycl_tool_broken", "ts_tool_js_project", "ts_tool_not_applicable"]);

/** Projede çözülebilir (mevcut "aracı kur + kapıyı koştur" işi bunları zaten üstleniyor). */
const PROJECT_REASONS = new Set(["missing_command", "stub_script", "redundant_gate_command"]);

/** SAF: atlama nedeninin ilk kelimesi sınıfı belirler (detay formatı: `<neden> cmd=...`). */
export function classifyGapOwner(reason: string | undefined | null): GapOwner {
  if (!reason) return "not-applicable";
  const first = String(reason).trim().split(/\s+/)[0] ?? "";
  if (MYCL_SOURCE_REASONS.has(first)) return "mycl-source";
  if (PROJECT_REASONS.has(first)) return "project";
  return "not-applicable";
}

export interface SourceGap {
  /** Faz numarası (ör. 11). */
  phase: number;
  /** Kullanıcıya görünen boyut adı (ör. "Sadeleştirme"). */
  dimension: string;
  /** Atlama nedeninin ham detayı (kanıt). */
  detail: string;
  /** Projenin stack kimliği (ör. "node-npm") — düzeltmenin hangi profili ilgilendirdiğini söyler. */
  stack?: string;
  /** Bu boşluğun kaç iterasyondur sürdüğü (biliniyorsa) — aciliyeti kanıtla anlatır. */
  occurrences?: number;
}

/** Aynı boşluk için tek kimlik (tekrar tekrar aynı prompt üretilmesin). */
export function sourceGapKey(gap: SourceGap): string {
  const reason = String(gap.detail).trim().split(/\s+/)[0] ?? "";
  return `faz${gap.phase}-${reason}-${gap.stack ?? "stack-bilinmiyor"}`;
}

/**
 * SAF: yapıştırılabilir iş tanımı. Kendi kendine yeter — okuyanın bu sohbeti görmediği varsayılır.
 *
 * Neden bu kadar açık: prompt, bağlamı OLMAYAN bir geliştiriciye/yapay zekâya gidiyor. Eksik bağlam
 * bırakırsak karşı taraf tahmin eder ve yanlış katmanı düzeltir (kapıyı gevşetmek, boyutu
 * "uygulanamaz" ilan etmek gibi) — tam da kaçınmak istediğimiz sonuç. Bu yüzden kanıt, kısıtlar ve
 * KABUL EDİLMEYEN çözümler açıkça yazılıyor.
 */
export function buildSourcePrompt(gap: SourceGap): string {
  const reason = String(gap.detail).trim().split(/\s+/)[0] ?? "";
  const cmd = /cmd="([^"]+)"/.exec(gap.detail)?.[1];
  const kacTur = gap.occurrences && gap.occurrences > 1
    ? `Bu boşluk ${gap.occurrences} iterasyondur sürüyor.`
    : "";

  const teshis = reason === "mycl_tool_broken"
    ? `MyCL'in KENDİ tarama betiği çalıştırılamıyor (paketleme ya da kod hatası). Hedef projede ` +
      `yapılacak hiçbir şey bunu düzeltmez.`
    : `MyCL bu boyut için TypeScript'e bağlı bir araç seçmiş; bu projenin dili farklı olduğu için ` +
      `kapı hiç koşamıyor. Boyutun kendisi bu dilde de geçerli — eksik olan MyCL'in araç seçimi.`;

  // Koşullu satırlar spread ile eklenir; sabit boş satırlar BÖLÜM AYRACI olduğu için elenmemeli
  // (ilk sürümde hepsi filtreleniyordu ve prompt tek blok hâline gelip okunmaz oluyordu).
  return [
    `MyCL Studio kaynağında bir geliştirme gerekiyor.`,
    ``,
    `## Durum`,
    `Faz ${gap.phase} (${gap.dimension}) bu projede hiç doğrulanamıyor.`,
    `Stack: ${gap.stack ?? "bilinmiyor"}`,
    `Denetim kaydındaki atlama nedeni: \`${gap.detail}\``,
    ...(cmd ? [`İlgili komut: \`${cmd}\``] : []),
    ...(kacTur ? [kacTur] : []),
    ``,
    `## Teşhis`,
    teshis,
    ``,
    `## Yapılması gereken`,
    reason === "mycl_tool_broken"
      ? `MyCL'in bu tarama aracını çalışır hale getir: neden çalışmadığını (yol çözümü, paketleme, ` +
        `bağımlılık) kökünden bul ve düzelt. Aracın paketlenmiş uygulamada da bulunduğunu doğrula.`
      : `Bu boyutu bu dil için de ölçebilen bir yol kur. Stack profilinden okunan, dile uygun bir ` +
        `araç/komut tanımla — MyCL'in her süreci stack bağımsızdır, tek bir dile bağlanamaz.`,
    ``,
    `## Kısıtlar`,
    `- Kapıyı gevşetme, boyutu "uygulanamaz" ilan ederek susturma. Sorun ölçememek; ölçmeyi kurmak gerekiyor.`,
    `- Yanlış alarm üretme: kural tartışmasız olmalı, kuşkuda rapor et ama kapıyı düşürme.`,
    `- Ölçüm yapılamıyorsa bu GÖRÜNÜR kalsın; sessizce "geçti" sayma.`,
    `- Değişiklikten sonra önceki davranışların korunduğunu kanıtla ve testle kilitle.`,
    ``,
    `## Doğrulama`,
    `Düzeltmeyi birim testleriyle doğrula (hedef projeyi çalıştırmadan). Bu boyutun artık gerçekten ` +
      `ölçüldüğünü ve ölçülemediğinde görünür kaldığını iki ayrı testle göster.`,
  ].join("\n");
}

const GAP_DIR = join(".mycl", "mycl-source-tasks");

/**
 * Promptu projeye yazar — sohbet kaydırılıp kaybolsa da elde kalsın. Dosya adı boşluk kimliğinden
 * türetilir, yani aynı boşluk için ikinci bir dosya oluşmaz. Yazamamak akışı DURDURMAZ (prompt zaten
 * sohbette gösteriliyor); yalnız kalıcılık kaybolur.
 */
export async function persistSourcePrompt(
  projectRoot: string,
  gap: SourceGap,
  prompt: string,
): Promise<string | null> {
  const dir = join(projectRoot, GAP_DIR);
  const file = join(dir, `${sourceGapKey(gap)}.md`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, prompt + "\n", "utf-8");
    return file;
  } catch {
    return null;
  }
}
