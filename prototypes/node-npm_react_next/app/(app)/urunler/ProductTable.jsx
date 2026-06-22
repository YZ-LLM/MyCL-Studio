'use client';

// Ürün tablosu — sıralanabilir kolonlar, satır aksiyonları (Admin), silme onay dialogu.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT, useLang } from '@/lib/i18n-context';
import { useToast } from '@/components/ToastProvider';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TABLE_FIELDS } from '@/lib/field-defs';

export function ProductTable({ products, isAdmin, deleteAction }) {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const router = useRouter();
  const [sortKey, setSortKey] = useState('code');
  const [sortDir, setSortDir] = useState('asc');
  const [confirmId, setConfirmId] = useState(null);
  const [pending, startTransition] = useTransition();

  if (!products || products.length === 0) {
    return <p className="state">{t('products.empty')}</p>;
  }

  const numberFmt = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'tr-TR');

  const sorted = [...products].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    let cmp;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv), lang);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function confirmDelete() {
    const id = confirmId;
    startTransition(async () => {
      const res = await deleteAction(id);
      setConfirmId(null);
      if (res?.ok) {
        toast.show(t('products.deleted'), 'success');
        router.refresh();
      } else if (res?.error === 'FORBIDDEN') {
        toast.show(t('products.noPermission'), 'error');
      } else {
        toast.show(t('common.actionFailed'), 'error');
      }
    });
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {TABLE_FIELDS.map((def) => {
                const active = sortKey === def.name;
                return (
                  <th
                    key={def.name}
                    scope="col"
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="sort" onClick={() => toggleSort(def.name)}>
                      {t(def.labelKey)}
                      <span aria-hidden="true">{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                    </button>
                  </th>
                );
              })}
              {isAdmin ? <th scope="col">{t('common.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.id}>
                {TABLE_FIELDS.map((def) => (
                  <td key={def.name}>
                    {def.type === 'number' ? numberFmt.format(p[def.name]) : p[def.name]}
                  </td>
                ))}
                {isAdmin ? (
                  <td>
                    <div className="row">
                      <Link className="btn btn-sm" href={`/urunler/${p.id}/duzenle`}>
                        {t('products.edit')}
                      </Link>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setConfirmId(p.id)}
                      >
                        {t('products.delete')}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmId !== null ? (
        <ConfirmDialog
          title={t('products.deleteTitle')}
          message={t('products.deleteConfirm')}
          confirmLabel={t('products.delete')}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmId(null)}
          pending={pending}
        />
      ) : null}
    </>
  );
}
