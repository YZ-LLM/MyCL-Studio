// SAF, client-safe yardımcılar (fs YOK). Hem server hem client import edebilir.
// fs okuyan kod ayrı dosyada (help.server.js) — client bundle'a 'fs' SIZMASIN.

// Rota → ekran-görüntüsü dosya adı: baştaki "/" düşer, alfanümerik olmayan "-" olur,
// kök "/" → "anasayfa".
export function sanitizeRoute(route) {
  if (!route || route === '/') return 'anasayfa';
  const trimmed = route.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return 'anasayfa';
  return trimmed.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

// İlgili dilde ekran-görüntüsü yolu.
export function guideShotPath(route, lang) {
  const safeLang = lang === 'en' ? 'en' : 'tr';
  return `/docs/guide-shots/${safeLang}/${sanitizeRoute(route)}.png`;
}

// Mevcut rota için help girdisini seç (en uzun eşleşen route kazanır).
export function findHelpForRoute(pages, pathname) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  let best = null;
  for (const page of pages) {
    if (!page || typeof page.route !== 'string') continue;
    if (page.route === pathname) return page;
    if (pathname.startsWith(page.route) && page.route !== '/') {
      if (!best || page.route.length > best.route.length) best = page;
    }
  }
  return best;
}
