'use client';

// Hafif toast sistemi — 403 / sunucu hatası gibi aksiyon geri bildirimleri için.
import { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastContext = createContext({ show: () => {} });

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const show = useCallback((message, type = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-wrap" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`} role="status">
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
