// safe-env — child process env güvenlik filtresi.
//
// Sorun: handleBash + mechanical runner + dev-server-launcher `...process.env`
// ile orchestrator'ın tüm env'ini child'a forward ediyor. Eğer kullanıcının
// shell'inde `ANTHROPIC_API_KEY`, `AWS_*`, `OPENAI_API_KEY`, `GH_TOKEN`,
// vs. varsa Claude'un Bash'i bunları okuyabilir (`env | grep -i key`).
//
// Çözüm: allowlist — sadece bilinen güvenli env değişkenleri geçir. Bilinmeyen
// veya hassas anahtarlar (özellikle *_KEY/*_TOKEN/*_SECRET pattern'leri)
// dışarda kalır.
//
// E2BIG ÖZ-İYİLEŞTİRME (2026-06-10, ekran kanıtı — Faz 5 dev server hiç kalkamadı): kullanıcı
// shell'inde birikerek şişen değişken (örn. her oturumda uzayan PATH) macOS ARG_MAX (~1MB
// env+argv) sınırını aşınca MyCL'in başlattığı HER alt süreç (npm/vite/claude/git) E2BIG ile
// çöker. MyCL bunu kullanıcıya "terminali yeniden başlat" diye SORMAZ, kendisi çözer:
// (1) PATH kayıpsız dedupe (tekrar eden segmentler atılır); (2) yine de devasa kalan değişken
// alt sürece AKTARILMAZ + BİR KEZ görünür uyarı (sessiz fallback yok).
//
// Bu modülün tek yan etkisi: boyut-budama uyarısı (process başına bir kez, chat'e).

import { emitChatMessage } from "./ipc.js";

const SAFE_ENV_KEYS = new Set([
  // Shell temelleri
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "PWD",
  // Locale
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  // Temp dirs
  "TMPDIR",
  "TMP",
  "TEMP",
  // Node temelleri
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_ENV", // genelde güvenli; "development" / "production" / "test"
  // Node version manager'lar — Mac/Linux'ta `bash -lc` ile başlatılan
  // child process'lerin doğru node sürümünü bulabilmesi için zorunlu.
  // Bunlar secret değil, sadece path/version pointer.
  "NVM_DIR",
  "NVM_BIN",
  "NVM_INC",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "FNM_VERSION_FILE_STRATEGY",
  "FNM_NODE_DIST_MIRROR",
  "NODENV_ROOT",
  "NODENV_VERSION",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "VOLTA_HOME",
  // System
  "OS",
  "OSTYPE",
  "ARCH",
  // Endüstri tooling — Faz 13 semgrep + Faz 17 k6 user customization.
  // Bunlar secret değil, sadece scan davranışını yönlendiren config path /
  // numeric value. Token gerektiren tool'lar (snyk SNYK_TOKEN) bilinçli olarak
  // dahil edilmedi — onlar ayrı tur.
  "SEMGREP_RULES",     // semgrep custom ruleset path (opsiyonel; default `--config auto`)
  "K6_VUS",            // k6 default virtual users (sayı)
  "K6_DURATION",       // k6 default test duration (örn. "30s")
  "K6_THRESHOLDS",     // k6 threshold override (JSON string)
]);

/** Bu prefix ile başlayan tüm değişkenler geçer — locale (LC_ALL, LC_CTYPE, vs.)
 *  ve npm subprocess child'larının kendi yaydığı `npm_*` değişkenleri. */
const SAFE_ENV_PREFIXES = ["LC_", "npm_"];

/**
 * process.env'i child process için filtrele. Bilinen güvenli anahtarlar +
 * SAFE_ENV_PREFIXES dışındaki her şey atılır. Caller ek değişkenler eklemek
 * istiyorsa dönen objeyi spread'leyebilir (`{ ...safeEnv(), PORT: "..." }`).
 */
export function safeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const src = process.env;
  for (const key of Object.keys(src)) {
    if (SAFE_ENV_KEYS.has(key)) {
      const v = src[key];
      if (v !== undefined) out[key] = v;
      continue;
    }
    for (const prefix of SAFE_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        const v = src[key];
        if (v !== undefined) out[key] = v;
        break;
      }
    }
  }
  return trimOversizedEnv(out);
}

/** Tek değişken üst sınırı. Normal PATH/değişken <5KB; bunu aşan, birikme/bozulma işaretidir. */
export const MAX_ENV_VAR_BYTES = 100_000;

/** PATH'i kayıpsız küçült: tekrar eden segmentleri at (sıra korunur). SAF. */
export function dedupePathValue(path: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of path.split(":")) {
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  return parts.join(":");
}

let oversizedWarned = false; // process başına bir uyarı (spam yok)

/**
 * E2BIG öz-iyileştirme: PATH dedupe + MAX_ENV_VAR_BYTES'ı aşan değişkeni DÜŞÜR (görünür uyarı,
 * bir kez). Objeyi yerinde düzenleyip döndürür. Export — test edilebilir (warn'sız saf yol için
 * dedupePathValue kullan).
 */
export function trimOversizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string") env.PATH = dedupePathValue(env.PATH);
  const dropped: string[] = [];
  for (const key of Object.keys(env)) {
    const v = env[key];
    if (typeof v === "string" && Buffer.byteLength(v, "utf8") > MAX_ENV_VAR_BYTES) {
      delete env[key];
      dropped.push(key);
    }
  }
  if (dropped.length > 0 && !oversizedWarned) {
    oversizedWarned = true;
    emitChatMessage(
      "system",
      `⚠️ Kabuk ortamında aşırı büyük değişken(ler) tespit edildi ve alt süreçlere AKTARILMADI: ${dropped.join(", ")} (>${Math.round(MAX_ENV_VAR_BYTES / 1000)}KB). Bu, "argument list too long" (E2BIG) çökmesini önler; kalıcı çözüm için kabuk başlangıç dosyanda (.zshrc/.zshenv) bu değişkenin neden büyüdüğüne bak.`,
    );
  }
  return env;
}
