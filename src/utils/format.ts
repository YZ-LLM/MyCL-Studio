// Format helper'ları — UI panellerinde paylaşılan dönüştürücüler.

/**
 * Mesaj timestamp'ini "DD.MM HH:mm:ss" formatında üretir. Cross-panel mesaj
 * badge'i için kullanılır (silik etiket; mesaj/event başlığında).
 *
 * 0 veya geçersiz ts → boş string (component conditional render edebilir).
 */
export function fmtTs(ts: number | undefined | null): string {
  if (!ts || typeof ts !== "number") return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Zaman damgasını rozet için tarih + saat parçalarına böler (2026-07-18 "tarihleri daha
 * görünür yap — badge olsun"). fmtTs aynen kalır (mevcut çağıranlar kırılmaz).
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

