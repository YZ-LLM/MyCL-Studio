// Format helper'ları — UI panellerinde paylaşılan dönüştürücüler.


/**
 * Zaman damgasını rozet için tarih + saat parçalarına böler (2026-07-18 "tarihleri daha
 * görünür yap — badge olsun"). Eski fmtTs kaldırıldı (tüm çağıranlar rozete geçti — ölü kod).
 */
export function fmtTsParts(ts: number | undefined | null): { date: string; time: string } | null {
  if (!ts || typeof ts !== "number") return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

