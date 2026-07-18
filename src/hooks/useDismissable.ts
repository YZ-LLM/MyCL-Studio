// useDismissable — sağ panel/modal kapatma davranışları (YZLLM 2026-07-18: "sağdan açılan
// pencereler esc ile ya da başka yere tıklayınca da kapansın").
//
// İki hook:
//  - useEscapeToClose: ErrorDrawer/Settings'teki kopya ESC desenlerinin tekili. Modül-düzeyi
//    LIFO kayıt: birden çok panel açıkken ESC yalnız EN SON açılanı kapatır (eskiden Settings +
//    ErrorDrawer birlikte açıkken tek ESC ikisini birden kapatıyordu — gizli hata).
//  - useOutsideClickClose: document mousedown; panelin içi ve [data-dismiss-ignore] işaretli
//    bölgeler (sağ aksiyon barı — toggle butonuyla ÇİFT tetik olmasın) hariç her tık kapatır.
//    Bilinçli olarak backdrop YOK: drawer açıkken sohbet kullanılabilir kalır (mevcut davranış).
//
// Hooks kuralı: bu hook'lar her render'da KOŞULSUZ çağrılmalı — bileşendeki `if (!open) return null`
// satırı hook çağrılarından SONRA gelmeli.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Açık panellerin LIFO yığını — ESC yalnız tepedekini (en son açılanı) kapatır. */
const escStack: symbol[] = [];

export function useEscapeToClose(open: boolean, onClose: () => void, enabled = true): void {
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("dismissable");
  useEffect(() => {
    if (!open || !enabled) return;
    const id = idRef.current!;
    escStack.push(id);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escStack[escStack.length - 1] !== id) return; // tepedeki panel değil → ona bırak
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      const i = escStack.lastIndexOf(id);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [open, enabled, onClose]);
}

export function useOutsideClickClose(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panelRef.current?.contains(t)) return; // panelin içi → kapatma
      // Sağ aksiyon barı (toggle butonları) → dış-tık sayılmaz; kapatmayı toggle'ın kendisi yapar
      // (aksi halde mousedown kapatır + click yeniden açar = çift tetik).
      if (t instanceof Element && t.closest("[data-dismiss-ignore]")) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, panelRef]);
}
