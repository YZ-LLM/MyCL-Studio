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
];

/**
 * Komutu denetle. blocked: true ise spawn etmeyin, error_result döndürün.
 *
 * NOT: Bu bir sanitizasyon DEĞİL — sadece açıkça yıkıcı pattern'leri yakalar.
 * Determined attacker dolaylı yöntemlerle (eval, base64 decode + exec) etrafından
 * dolaşabilir. Birinci savunma hattı = template + güvenli env (safe-env.ts);
 * bu liste defense-in-depth.
 */
export function inspectBashCommand(cmd: string): BashGuardResult {
  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}
