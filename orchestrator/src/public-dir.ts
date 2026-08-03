// public-dir — hedef projenin STATİK varlık klasörünü çöz (stack bağımsız).
//
// NEDEN (2026-08-03): kılavuz artık projenin İÇİNE de yazılıyor (kullanıcı kararı: depoyla gitsin,
// yayına alınınca uygulama içi "?" penceresi çalışsın). Statik dosyaların gideceği klasör stack'e göre
// değişir: çoğu araç `public/`, SvelteKit `static/`. Eskiden `guide-shots.ts` içinde `public/` HARDCODE
// edilmişti — bu, "her süreç stack bağımsız" kuralının sessiz bir ihlaliydi (SvelteKit projesinde ekran
// görüntüleri yanlış klasöre yazılıyordu). Tek çözücü: hem kılavuz hem ekran görüntüleri bunu kullanır.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadProfile } from "./profile-loader.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

/** Bilinen statik klasör adayları — sıra ÖNEMLİ (var olan kazanır, sonra profil, sonra varsayılan). */
const CANDIDATES = ["public", "static"] as const;

export interface PublicDirResult {
  /** Proje köküne göreli klasör adı (örn. "public"). */
  rel: string;
  /** Klasör bu çağrıda oluşturuldu mu. */
  created: boolean;
  /** Karar nereden geldi (görünürlük/teşhis). */
  source: "existing" | "profile" | "default";
}

/** SAF: adaylardan hangisi seçilir (I/O sonuçları enjekte edilir — test edilebilir). */
export function decidePublicDir(inp: {
  /** Var olan aday klasörler (proje kökünde gerçekten bulunanlar). */
  existing: readonly string[];
  /** Stack profilinin bildirdiği klasör (varsa). */
  fromProfile?: string | null;
}): { rel: string; source: PublicDirResult["source"] } {
  for (const c of CANDIDATES) {
    if (inp.existing.includes(c)) return { rel: c, source: "existing" };
  }
  if (inp.fromProfile) return { rel: inp.fromProfile, source: "profile" };
  return { rel: CANDIDATES[0], source: "default" };
}

/**
 * İmpure: projede statik klasörü bul; yoksa oluştur. Oluşturma başarısızsa da bir yol döner
 * (çağıran yazarken hatayı görünür şekilde ele alır — sessiz kayıp yok).
 */
export async function resolvePublicDir(state: State): Promise<PublicDirResult> {
  const existing: string[] = [];
  for (const c of CANDIDATES) {
    try {
      const st = await fs.stat(join(state.project_root, c));
      if (st.isDirectory()) existing.push(c);
    } catch {
      /* yok — aday değil */
    }
  }
  let fromProfile: string | null = null;
  if (state.stack) {
    try {
      const p = (await loadProfile(state.stack)) as unknown as { public_dir?: string };
      fromProfile = p?.public_dir ?? null;
    } catch {
      fromProfile = null;
    }
  }
  const decided = decidePublicDir({ existing, fromProfile });
  let created = false;
  if (decided.source !== "existing") {
    try {
      await fs.mkdir(join(state.project_root, decided.rel), { recursive: true });
      created = true;
    } catch (e) {
      log.warn("public-dir", "statik klasör oluşturulamadı", { rel: decided.rel, error: String(e) });
    }
  }
  return { rel: decided.rel, created, source: decided.source };
}
