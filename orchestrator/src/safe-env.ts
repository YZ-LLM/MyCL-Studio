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
// Bu modül başka hiçbir yan etki üretmez (saf fonksiyon).

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
  return out;
}
