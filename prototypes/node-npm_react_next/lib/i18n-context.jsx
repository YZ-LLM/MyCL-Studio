'use client';

// Dil sistemi (i18n) — client tarafı sağlayıcı. Server, geçerli dilin mesaj
// katalogunu prop olarak verir; client component'ler useT()/useLang() ile tüketir.
import { createContext, useContext } from 'react';

const I18nContext = createContext({ lang: 'tr', messages: {} });

export function LanguageProvider({ lang, messages, children }) {
  return (
    <I18nContext.Provider value={{ lang, messages: messages || {} }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  const { messages } = useContext(I18nContext);
  // Eksik anahtarda anahtarı döndür (sessiz kalma yerine görünür ipucu).
  return (key) => messages[key] ?? key;
}

export function useLang() {
  return useContext(I18nContext).lang;
}
