'use client';

// Hata Kodları tablosu — /api/errors'tan çeker, loading/error/empty/retry (resilience),
// zamana göre sıralanabilir, açıklama+konum araması. Kendisi de fetch wrapper kullanır.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n-context';
import { apiFetch } from '@/lib/api-client';

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}.${p(d.getMonth() + 1)}`;
}

export function HataKodlariTable() {
  const t = useT();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | error | ok
  const [query, setQuery] = useState('');
  const [sortDir, setSortDir] = useState('desc');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const res = await apiFetch('/api/errors');
      const data = await res.json();
      setRows(Array.isArray(data.errors) ? data.errors : []);
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (status === 'loading') {
    return (
      <div aria-busy="true">
        <div className="skeleton-row" />
        <div className="skeleton-row" />
        <div className="skeleton-row" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="state error" role="alert">
        <p>{t('errors.loadError')}</p>
        <button type="button" className="btn btn-primary" onClick={load}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return <p className="state">{t('errors.empty')}</p>;
  }

  const q = query.trim().toLowerCase();
  const filtered = rows
    .filter((r) => {
      if (!q) return true;
      return (
        (r.description_tr || '').toLowerCase().includes(q) ||
        (r.location || '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      const cmp = new Date(a.ts).getTime() - new Date(b.ts).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="err-search">{t('common.search')}</label>
        <input
          id="err-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('errors.searchPlaceholder')}
        />
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col" aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}>
                <button type="button" className="sort" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                  {t('errors.time')}
                  <span aria-hidden="true">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                </button>
              </th>
              <th scope="col">{t('errors.code')}</th>
              <th scope="col">{t('errors.location')}</th>
              <th scope="col">{t('errors.description')}</th>
              <th scope="col">{t('errors.status')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>{fmtTime(r.ts)}</td>
                <td>
                  <code>{r.error_code}</code>
                </td>
                <td>{r.location}</td>
                <td>{r.description_tr}</td>
                <td>
                  {r.resolved ? (
                    <span className="status-resolved">{t('errors.resolved')}</span>
                  ) : (
                    <span className="status-open">{t('errors.open')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
