// Ürün listesi yükleniyor — iskelet satırlar (boş/bozuk görünmesin).
export default function Loading() {
  return (
    <div className="card" aria-busy="true">
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}
