// strip-ansi — yakalanan komut çıktısından ANSI/CSI escape kodlarını soyar. TEK KAYNAK.
//
// Ümit 2026-06-12: execAsync/spawn ile yakalanan çıktı (npm test → vitest, vite dev-server) RENKLİ gelebilir
// (`ESC[31m×ESC[39m`, `ESC[31mError:`), terminal-redirect'te ise renksiz. Ham metin bekleyen ^-çapalı parser'lar
// (`^\s*[×✕✗✖]`, `^\s*Error:`) ESC yüzünden eşleşmez → fail/hata KAÇIRILIR. İki yerde ayrı ayrı (biri ESC baytını
// kaçıran bozuk `/\[[0-9;]*m/g` ile) soyuluyordu → tek doğru kaynakta topla ki bir daha sapmasın/yarım kalmasın.
//
// new RegExp + fromCharCode(27): ESC (0x1b) karakterini regex-literal kaçış sorunları olmadan güvenle yaz.
// Desen: ESC `[` (CSI) + parametre baytları [0-9;?]* + ara baytlar [ -/]* + son bayt [@-~] (m=renk dahil hepsi).
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]", "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
