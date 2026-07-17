import { headers } from 'next/headers';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getHelpPages } from '@/lib/help.server';
import { sanitizeRoute, guideShotPath } from '@/lib/help';

// Kılavuz — .mycl/help-pages.json tek kaynak. Sıra: başlık → ekran görüntüsü (ÜSTte)
// → açıklama → son güncelleme → "Bu sayfayı aç" linki. İçerik yoksa zarif boş durum.
export default function GuidePage() {
  const lang = headers().get('x-lang') || 'tr';
  const pages = getHelpPages();

  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'guide.title')}</h1>
      </div>
      <p className="muted">{t(lang, 'guide.intro')}</p>

      {pages.length === 0 ? (
        <p className="state">{t(lang, 'guide.empty')}</p>
      ) : (
        pages.map((page) => {
          const title = lang === 'en' ? page.title_en : page.title_tr;
          const body = lang === 'en' ? page.body_en : page.body_tr;
          const shot = guideShotPath(page.route, lang);
          const anchor = sanitizeRoute(page.route);
          return (
            <section className="guide-section" id={anchor} key={page.route}>
              <h2>{title}</h2>
              <img className="guide-shot" src={shot} alt={title || ''} />
              <p>{body}</p>
              <p className="muted">
                {t(lang, 'guide.lastUpdated')}: {page.updated_at || '—'}
              </p>
              <Link className="btn btn-sm" href={page.route}>
                {t(lang, 'guide.openPage')}
              </Link>
            </section>
          );
        })
      )}
    </div>
  );
}
