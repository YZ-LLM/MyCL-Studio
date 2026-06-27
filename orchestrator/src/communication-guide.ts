// communication-guide — YZLLM iletişim rehberi (müfettiş.md) RUNTIME yükleyici. YZLLM 2026-06-27.
//
// Kullanıcı: "müfettiş.md'yi çevirmen ajana ve orkestratör ajana öğret." Dosya repo kökünde tek doğruluk
// kaynağı (kullanıcı sürekli düzenler) → her seferinde TAZE okunur (cache YOK), çevirmen + orkestratör
// prompt'larına enjekte edilir. Yoksa/okunamazsa boş döner + GÖRÜNÜR uyarı (ajan temel promptuyla sürer;
// bir iletişim rehberi güvenlik aracı değildir → fail-soft makul, ama sessiz değil).

import { readFile } from "node:fs/promises";
import { repoRootFile } from "./phase-registry.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

const GUIDE_FILE = "müfettiş.md";

let _warned = false;

/**
 * müfettiş.md içeriğini döndürür (trim'li). Okunamazsa "" döner ve eksiklik GÖRÜNÜR yapılır (KATI #4 + bellek
 * "log.warn yetmez, kullanıcı log'u görmez"): tek sefer hem log.error hem chat'e sistem mesajı. DURMAZ — iletişim
 * rehberi bir güvenlik aracı değil; eksikliği pipeline'ı kırmamalı (ajan temel promptuyla sürer). "Görünür ama
 * sürdür" = bu istisnanın kalibre yanıtı (güvenlik aracı olsaydı fail-closed/dur olurdu). _warned → spam yok.
 * Paketlenmiş .app'te dosya bundle resources'a eklenmelidir (tauri.conf.json "../müfettiş.md").
 */
export async function loadCommunicationGuide(): Promise<string> {
  try {
    return (await readFile(repoRootFile(GUIDE_FILE), "utf-8")).trim();
  } catch (err) {
    if (!_warned) {
      _warned = true;
      log.error(
        "communication-guide",
        `${GUIDE_FILE} okunamadı — iletişim rehberi ajan prompt'larına enjekte EDİLEMEDİ`,
        { path: repoRootFile(GUIDE_FILE), err: String(err) },
      );
      emitChatMessage(
        "system",
        `⚠️ İletişim rehberi (${GUIDE_FILE}) okunamadı → çevirmen ve orkestratör bu rehber olmadan çalışıyor ` +
          `(temel promptlarıyla sürüyorlar, iş durmaz). Dosya repo kökünde mi / paketlenmiş app'te bundle'da mı kontrol et.`,
        { persist: false },
      );
    }
    return "";
  }
}
