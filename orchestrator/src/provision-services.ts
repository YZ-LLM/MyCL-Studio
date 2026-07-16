// provision-services — bilinen runtime servisleri (DB/cache) VERİ dosyasından yükler.
//
// Neden (YZLLM 2026-07-16, "çözümler her zaman generic olsun"): port→servis tablosu
// (MySQL 3306, Postgres 5432…) + bağımlılık imzaları service-provision.ts içinde
// hardcode idi ve imzalar yalnız npm ekosistemini tanıyordu. Tablo artık
// `assets/provision/services.json`'da (çok ekosistemli imzalarla); yeni servis
// eklemek kod değişikliği İSTEMEZ. profile-loader üslubu: cache + el yazımı doğrulama.
//
// KATI #4 (sessiz fallback yok): bu dosya UYGULAMAYLA GELİR — yokluğu/bozukluğu
// bozuk kurulum demektir → ENOENT DAHİL her hata FIRLATIR (profillerdeki "dosya yok
// → null meşru" durumundan farklı; orada stack'in profili olmayabilir, burada tek
// zorunlu veri dosyası var).

import { readFile } from "node:fs/promises";
import { log } from "./logger.js";
import { provisionPath } from "./phase-registry.js";

export interface KnownService {
  /** Varsayılan port (1-65535). */
  port: number;
  /** Görünen ad (MySQL/PostgreSQL/...). */
  name: string;
  /** Manifest metninde aranan bağımlılık imzaları (derlenmiş). */
  deps: RegExp[];
  /** Elle başlatma ipucu (compose yoksa kullanıcıya gösterilir). */
  hint: string;
}

let servicesCache: KnownService[] | null = null;

/** Bilinen servis tablosunu yükle (cache'li). Dosya yok/bozuk → THROW (görünür). */
export async function loadKnownServices(): Promise<KnownService[]> {
  if (servicesCache) return servicesCache;
  servicesCache = await _loadServicesFromPath(provisionPath("services.json"));
  return servicesCache;
}

/** Path-tabanlı yükleyici — cache by-pass; test fixture'ları için export. */
export async function _loadServicesFromPath(path: string): Promise<KnownService[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    log.error("provision-services", "servis tablosu okunamadı (bozuk kurulum?)", { path, err });
    throw new Error(
      `Servis tablosu okunamadı: ${path} — bu dosya uygulamayla gelir; yokluğu bozuk kurulum demektir. (${String(err)})`,
    );
  }
  const parsed = JSON.parse(raw) as unknown; // bozuk JSON → throw (görünür)
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: servis tablosu dizi olmalı, ${typeof parsed} geldi`);
  }
  const services = parsed.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (!Number.isInteger(o.port) || (o.port as number) < 1 || (o.port as number) > 65535) {
      throw new Error(`${path}: services[${i}].port 1-65535 arası tamsayı olmalı`);
    }
    if (typeof o.name !== "string" || o.name.length === 0) {
      throw new Error(`${path}: services[${i}].name boş olmayan string olmalı`);
    }
    if (typeof o.hint !== "string" || o.hint.length === 0) {
      throw new Error(`${path}: services[${i}].hint boş olmayan string olmalı`);
    }
    if (!Array.isArray(o.dep_signatures)) {
      throw new Error(`${path}: services[${i}].dep_signatures dizi olmalı`);
    }
    const deps = (o.dep_signatures as unknown[]).map((s, j) => {
      if (typeof s !== "string") {
        throw new Error(`${path}: services[${i}].dep_signatures[${j}] string olmalı`);
      }
      try {
        // Bayraksız derleme — eski hardcode tablonun büyük/küçük harf davranışı korunur.
        return new RegExp(s);
      } catch (err) {
        throw new Error(`${path}: services[${i}].dep_signatures[${j}] geçersiz regex: ${String(err)}`);
      }
    });
    return { port: o.port as number, name: o.name, hint: o.hint, deps };
  });
  log.info("provision-services", "loaded", { path, count: services.length });
  return services;
}

/** Test için cache temizleme. */
export function _clearServicesCache(): void {
  servicesCache = null;
}
