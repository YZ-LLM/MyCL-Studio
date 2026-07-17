'use client';

// "?" yardım tetikleyicisi — her sayfada görünür. Mevcut rotanın help girdisini
// modal popup'ta TR/EN sekmeleriyle gösterir. fs YOK: helpPages prop olarak gelir
// (server tarafında okunur), burada yalnız saf yardımcılar (sanitizeRoute) kullanılır.
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Modal } from '@/components/Modal';
import { useT, useLang } from '@/lib/i18n-context';
import { findHelpForRoute, guideShotPath, sanitizeRoute } from '@/lib/help';

export function HelpButton({ helpPages }) {
  const t = useT();
  const lang = useLang();
  const pathname = usePathname() || '/';
  const entry = findHelpForRoute(helpPages, pathname);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(lang === 'en' ? 'en' : 'tr');

  // Bu rota için içerik yoksa "?" gösterme.
  if (!entry) return null;

  const title = tab === 'en' ? entry.title_en : entry.title_tr;
  const body = tab === 'en' ? entry.body_en : entry.body_tr;
  const shot = guideShotPath(entry.route, tab);

  return (
    <>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={t('help.open')}
        title={t('help.open')}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} labelledBy="help-title">
          <div className="tabs" role="tablist" aria-label={t('help.open')}>
            <button type="button" role="tab" aria-selected={tab === 'tr'} onClick={() => setTab('tr')}>
              {t('help.tabTr')}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'en'} onClick={() => setTab('en')}>
              {t('help.tabEn')}
            </button>
          </div>
          <h2 id="help-title">{title || t('help.open')}</h2>
          <p>{body || t('help.none')}</p>
          <img className="help-shot" src={shot} alt={title || ''} />
          <div className="modal-actions">
            <Link className="btn" href={`/kilavuz#${sanitizeRoute(entry.route)}`} onClick={() => setOpen(false)}>
              {t('guide.openInGuide')}
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
