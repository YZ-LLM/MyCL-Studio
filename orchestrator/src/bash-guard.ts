// bash-guard — Claude'un Bash tool'unda çalıştırmasını engellediğimiz yıkıcı
// veya ekosistem-yayıcı komutların denylist'i.
//
// Felsefe: pasif test. Komut string'ini regex setine karşı denetle; match
// varsa spawn'dan ÖNCE reddet. Bash parser yazmıyoruz — Claude'un "izinli görünüp
// işi yıkıcı yapan" trick'leri (env substitution, eval'lenmiş command vs.)
// engellemek değil amaç; AÇIK yıkıcı pattern'leri yakalamak.
//
// Liste tutucu: gelecekte ekleme yapılabilir; her pattern için kullanıcıya
// dönen sebep tanımlı.

export interface BashGuardResult {
  blocked: boolean;
  reason?: string;
}

interface DenyRule {
  /** Pattern; case-insensitive. */
  re: RegExp;
  /** Kullanıcıya/Claude'a dönen sebep. */
  reason: string;
}

const DENY_RULES: DenyRule[] = [
  // rm -rf / | rm -rf ~ | rm -rf .git | rm -rf $HOME
  {
    re: /\brm\s+-[a-z]*[rf][a-z]*\s+(\/(?!\w)|~|\.git\b|\$HOME\b)/i,
    reason: "destructive rm against root/home/.git",
  },
  // sudo
  { re: /(^|[\s;&|])sudo\b/i, reason: "sudo not allowed" },
  // git push --force / -f
  {
    re: /\bgit\s+push\s+(--force\b|-f\b|--force-with-lease\b)/i,
    reason: "force push not allowed",
  },
  // curl|wget pipe to shell — curl x | bash, wget x | sh, curl x|zsh
  {
    re: /\b(curl|wget|fetch)\s+[^|;<>]+\|\s*(bash|sh|zsh|ksh)\b/i,
    reason: "curl|sh remote code execution not allowed",
  },
  // npm/yarn/pnpm publish — accidental release
  {
    re: /\b(npm|yarn|pnpm)\s+publish\b/i,
    reason: "package publish not allowed",
  },
  // chmod -R 777/666 — open permissions everywhere
  {
    re: /\bchmod\s+(-R\s+)?(777|666|a\+w)\b/i,
    reason: "overly permissive chmod not allowed",
  },
  // raw disk write — `> /dev/sda` veya `dd of=/dev/sda` (yazma hedefi)
  {
    re: /(>\s*|\bof=)\/dev\/(sd[a-z]|nvme\d|disk\d)/i,
    reason: "direct disk write not allowed",
  },
  // fork bomb (sembolik literal)
  {
    re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/,
    reason: "fork bomb pattern",
  },
  // git reset --hard origin/main + push gibi force-rewrite sekansı
  // (sadece destructive flag'li reset'i yakala)
  {
    re: /\bgit\s+reset\s+(--hard\s+)(origin\/|upstream\/)/i,
    reason: "destructive remote reset not allowed",
  },
  // PROJE İSKELESİ KURUCULARI (YZLLM 2026-06-19): create-next-app / create-react-app / create-vite /
  // degit + `npm|yarn|pnpm|npx create|init` — YENİ proje iskeleti kurar. MyCL projeyi ZATEN yönetir;
  // codegen yalnız DOSYA yazar (package.json'a yazar), bağımlılık kurulumunu MyCL yapar. Scaffolder
  // çalıştırmak: mevcut yapıyı ezme + node_modules sel (E2BIG) + stray dizin + interaktif takılma.
  {
    re: /\b(create-next-app|create-react-app|create-vite|degit)\b|\b(npm|yarn|pnpm|bunx?|npx)\s+(create|init)\b/i,
    reason: "proje iskelesi kurucusu (create-*-app / npm init / yarn create …) yasak — MyCL projeyi yönetir; sen yalnız dosya yaz, kurulumu MyCL yapar",
  },
  // YAZMA-KAÇIŞI defense-in-depth (YZLLM 2026-06-19). Native sandbox (enforce=varsayılan) yazma+Bash'i
  // ZATEN proje-hapsine alır (path-aware kernel-confine); bu kurallar warn/off modunda + command
  // seviyesinde EK kalkan — yalnız BİR codegen projesinin ASLA meşru yazmayacağı hedefler (false-positive
  // yok). PROJE-İÇİ .npmrc/.gitconfig vb. KASTEN dışarıda bırakıldı (meşru olabilir).
  // (a) kullanıcı home'una shell-rc / ssh / aws-cred / gnupg yazma/append (persistence + cred implant):
  {
    re: /(>>?|\btee\b\s+(-a\s+)?)\s*['"]?(\$HOME|~)\/\.(ssh|aws|gnupg|bashrc|zshrc|bash_profile|zprofile|profile)\b/i,
    reason: "kullanıcı home'una (ssh/aws/shell-rc) yazma yasak — write-escape/persistence",
  },
  // (b) sistem dizinlerine yazma (/etc, /System, LaunchAgents/Daemons):
  {
    re: /(>>?|\btee\b\s+(-a\s+)?)\s*['"]?(\/etc\/|\/System\/|\/Library\/Launch(Agents|Daemons)\/)/i,
    reason: "sistem dizinine (/etc, /System, LaunchAgents) yazma yasak — write-escape",
  },
];

/**
 * Komutu denetle. blocked: true ise spawn etmeyin, error_result döndürün.
 *
 * NOT: Bu bir sanitizasyon DEĞİL — sadece açıkça yıkıcı pattern'leri yakalar.
 * Determined attacker dolaylı yöntemlerle (eval, base64 decode + exec) etrafından
 * dolaşabilir. Birinci savunma hattı = template + güvenli env (safe-env.ts);
 * bu liste defense-in-depth.
 */
/**
 * KANIT DEFTERİ YAZMA DESENLERİ (adli denetim, 2026-09-10). MyCL'in hükmü `.mycl/audit.log`'dan
 * geri okunuyor; oraya yazabilen, kapıyı geçmeden kapının KAYDINI geçebilir (mahkeme geçici dizinde
 * kanıtladı: 7 satır değişince hüküm KISMİ'den GEÇTİ'ye döndü). Yazma araçları (`Write`/`Edit`)
 * `.mycl`'i zaten reddediyor; API arka ucunda `Bash` hiçbir yol denetiminden geçmiyordu — açık
 * buradaydı.
 *
 * DÜRÜST SINIR: bu bir düzenli ifade listesi, güvenlik sınırı DEĞİL (dosyanın kendi felsefesi de
 * bunu söylüyor). `cd .mycl && ...`, değişken dolaylaması ya da base64 ile etrafından dolaşılabilir.
 * Gerçek sınır işletim sistemi hapsi (abonelik yolunda var) ve kayıt bütünlüğü doğrulaması. Bu
 * kurallar açık girişimi kaynağında keser ve niyeti kayda düşürür — savunma katmanlarından biri.
 */
const EVIDENCE_DIR_RE = /\.(mycl|git)\b/i;
const EVIDENCE_WRITE_RULES: DenyRule[] = [
  {
    // yönlendirme: `echo x > .mycl/audit.log`, `... >> .mycl/...`
    re: /(^|[\s;&|])[^|;&]*>{1,2}\s*[^\s;&|]*\.(mycl|git)\//i,
    reason: "evidence log write (redirect into .mycl/.git) not allowed",
  },
  {
    // yerinde düzenleme / kopyalama / taşıma / kesme araçları hedefte kanıt klasörü ile
    re: /\b(tee|sed\s+-i|perl\s+-i|truncate|shred|dd\b[^\n]*\bof=)\b[^\n]*\.(mycl|git)\//i,
    reason: "evidence log rewrite (in-place edit of .mycl/.git) not allowed",
  },
  {
    re: /\b(cp|mv|rsync|install)\b[^\n]*\s[^\s;&|]*\.(mycl|git)\/[^\s;&|]*\s*($|[;&|])/i,
    reason: "evidence log overwrite (copy/move into .mycl/.git) not allowed",
  },
];

export function inspectBashCommand(cmd: string): BashGuardResult {
  if (EVIDENCE_DIR_RE.test(cmd)) {
    for (const rule of EVIDENCE_WRITE_RULES) {
      if (rule.re.test(cmd)) return { blocked: true, reason: rule.reason };
    }
  }
  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}
