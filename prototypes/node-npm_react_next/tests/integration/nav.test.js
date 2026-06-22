import { describe, it, expect } from 'vitest';
import { navForRole, NAV_CONFIG } from '@/lib/nav-config';
import { t } from '@/lib/i18n';

// Group C — shared Turkish layout with role-aware navigation (AC5).
describe('role-aware navigation (AC5)', () => {
  it('admin sees the full menu including Hata Kodları', () => {
    const hrefs = navForRole('admin').map((i) => i.href);
    expect(hrefs).toContain('/urunler');
    expect(hrefs).toContain('/hata-kodlari');
    expect(hrefs).toContain('/ayarlar');
  });

  it('dealer and service technician do NOT see the admin-only Hata Kodları item', () => {
    for (const role of ['dealer', 'service_technician']) {
      const hrefs = navForRole(role).map((i) => i.href);
      expect(hrefs).not.toContain('/hata-kodlari');
      // but they still see the items they are permitted (products)
      expect(hrefs).toContain('/urunler');
    }
  });

  it('an unknown role gets no navigation items', () => {
    expect(navForRole('intruder')).toHaveLength(0);
  });

  // AC5 — the shared layout renders in Turkish: every nav label has a Turkish
  // translation (no raw key leaking through).
  it('every navigation label resolves to a Turkish string', () => {
    for (const item of NAV_CONFIG) {
      const label = t('tr', item.labelKey);
      expect(label).not.toBe(item.labelKey); // key was actually translated
      expect(label.length).toBeGreaterThan(0);
    }
    expect(t('tr', 'nav.products')).toBe('Ürünler');
    expect(t('tr', 'nav.errorCodes')).toBe('Hata Kodları');
  });
});
