// NAV_CONFIG — SidebarNav ve middleware'in beslendiği tek kaynak.
// Ertelenen modüller buraya satır ekleyerek girer (Open/Closed).
export const NAV_CONFIG = [
  { href: '/urunler', labelKey: 'nav.products', roles: ['admin', 'dealer', 'service_technician'] },
  { href: '/hata-kodlari', labelKey: 'nav.errorCodes', roles: ['admin'] },
  { href: '/kilavuz', labelKey: 'nav.guide', roles: ['admin', 'dealer', 'service_technician'] },
  { href: '/ayarlar', labelKey: 'nav.settings', roles: ['admin', 'dealer', 'service_technician'] },
];

export function navForRole(role) {
  return NAV_CONFIG.filter((item) => item.roles.includes(role));
}
