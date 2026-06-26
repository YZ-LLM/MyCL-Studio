// user-directives — kullanıcının orkestra ajanına verdiği KALICI YÖNERGELER (~/.mycl/directives.md).
//
// YZLLM 2026-06-26 (req 4): Orkestra panelinin altındaki composer "iş" değil, "işin NASIL yapılacağı"na dair
// genel/kalıcı bir ÇAPA verir — örn. "projelerde her zaman versiyonlama yapalım". Orkestratör değerlendirip
// itirazı varsa söyler, yoksa benimser. Benimsenen yönerge buraya eklenir + sonraki TÜM orkestratör prompt'larına
// "## KULLANICI KALICI YÖNERGELERİ" olarak enjekte edilir (context-builder) → çapraz-proje uygulanır.
//
// GLOBAL (~/.mycl) — "projelerde her zaman" çapraz-proje anlamına gelir (proje-içi .mycl DEĞİL). Küçük metin →
// cap yok, düz markdown bullet listesi. Dedup: aynı yönerge iki kez eklenmez.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { globalConfigFile } from "./paths.js";
import { log } from "./logger.js";

const DIRECTIVES_FILE = "directives.md";

function directivesPath(): string {
  return globalConfigFile(DIRECTIVES_FILE);
}

/** SAF: ham dosya içeriğinden yönerge satırlarını çıkar (bullet "- " soyulur, boşlar elenir). Test edilebilir. */
export function parseDirectiveLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .filter((l) => l.length > 0);
}

/** SAF: dedup karşılaştırması için normalleştir (mahkeme #6: noktalama/büyük-küçük varyantı yakın-kopya saymasın). */
export function normalizeForDedup(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[.!?;,\s]+$/u, ""); // sondaki noktalama/boşluk soy
}

/** Kalıcı kullanıcı yönergesini ~/.mycl/directives.md'ye ekle. Döner: true=eklendi, false=zaten vardı (dedup).
 *  Mahkeme #8: dönüş değeri çağırana "gerçekten yazdım mı?" der → sahte "kaydettim" iddiası önlenir. */
export async function appendUserDirective(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  const path = directivesPath();
  await fs.mkdir(dirname(path), { recursive: true });
  // HAM içeriği oku (dedup + prefix için trim'siz lazım) — readUserDirectives trim'ler, prefix kararını bozardı.
  let raw = "";
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    /* dosya yok → boş */
  }
  // Dedup (normalleştirilmiş): zaten varsa tekrar ekleme (prompt'u şişirmesin + sahte "kaydettim" demesin).
  if (parseDirectiveLines(raw).some((l) => normalizeForDedup(l) === normalizeForDedup(t))) return false;
  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : ""; // ham \n ile bitmiyorsa ayır (tek satır kalmasın)
  await fs.appendFile(path, `${prefix}- ${t}\n`, "utf-8");
  log.info("orchestrator", "user directive adopted", { len: t.length });
  return true;
}

/** SAF: orkestratöre "bu yönergeyi benimse/itiraz et" değerlendirmesi yaptıran prompt (test edilebilir). */
export function buildDirectiveEvalPrompt(directive: string): string {
  return [
    "Kullanıcı sana bir GÖREV değil, işin NASIL yapılacağına dair KALICI bir YÖNERGE (çapa) verdi:",
    `"${directive.trim()}"`,
    "",
    "Bu, bundan sonraki TÜM projelerde/işlerde uygulanmasını istediği genel bir tercihtir (örn. 'projelerde her",
    "zaman versiyonlama yapalım'). Değerlendir: makul, uygulanabilir ve mevcut ilkelerle çelişmeyen bir yönerge mi?",
    "Bir ENDİŞEN / İTİRAZIN var mı?",
    "- İtirazın YOKSA → benimse (bundan sonra bu yönergeye uyacaksın).",
    "- İtirazın VARSA → kısaca söyle (neden uygulanamaz / riskli / mevcut ilkeyle çelişir).",
    "",
    "Yanıtın TÜRKÇE olsun. Önce 1-2 cümle gerekçe yaz; SON satıra SADECE şunlardan birini koy:",
    "KARAR: BENİMSE   (yönergeyi kabul ediyorsan)",
    "KARAR: İTİRAZ    (itirazın varsa)",
  ].join("\n");
}

/** SAF: orkestratör yanıtından kararı (benimse/itiraz) ve kullanıcıya gösterilecek temiz mesajı çıkar.
 *  "KARAR:" işaretçisi yoksa verdict=null (fail-closed: çağıran kaydetmez, net söyler). Test edilebilir. */
export function parseDirectiveVerdict(raw: string): {
  verdict: "adopt" | "object" | null;
  message: string;
} {
  const text = (raw ?? "").trim();
  const m = text.match(/KARAR\s*:\s*([^\s\n]+)/i);
  // İşaretçi satırını mesajdan çıkar (kullanıcı temiz gerekçeyi görsün).
  const message = text
    .split("\n")
    .filter((l) => !/KARAR\s*:/i.test(l))
    .join("\n")
    .trim();
  if (!m) return { verdict: null, message: text };
  const tok = m[1].toLocaleUpperCase("tr-TR");
  // BENİMSE/BENIMSE/ADOPT/KABUL → adopt; İTİRAZ/ITIRAZ/OBJECT → object. Türkçe-İ varyasyonlarına dayanıklı.
  const isAdopt = tok.startsWith("BEN") || tok === "ADOPT" || tok === "KABUL";
  const isObject = tok.startsWith("İT") || tok.startsWith("IT") || tok === "OBJECT";
  const verdict = isAdopt ? "adopt" : isObject ? "object" : null;
  return { verdict, message: message || text };
}

/** ~/.mycl/directives.md içeriğini oku (yoksa boş string — enjeksiyon "yönerge yok"a düşer). */
export async function readUserDirectives(): Promise<string> {
  try {
    return (await fs.readFile(directivesPath(), "utf-8")).trim();
  } catch {
    return ""; // dosya yok / okunamadı → yönerge yok (sessiz değil: çağıran boş bölümü atlar)
  }
}
