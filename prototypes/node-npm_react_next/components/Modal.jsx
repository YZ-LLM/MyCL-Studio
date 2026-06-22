'use client';

// Erişilebilir modal: role=dialog + aria-modal, Escape kapatır, focus trap,
// kapanınca focus tetikleyiciye döner.
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({ onClose, labelledBy, children }) {
  const ref = useRef(null);
  const prevFocus = useRef(null);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    const node = ref.current;
    const focusables = node ? node.querySelectorAll(FOCUSABLE) : [];
    if (focusables.length > 0) focusables[0].focus();
    else if (node) node.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const prev = prevFocus.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [onClose]);

  function onBackdrop(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
