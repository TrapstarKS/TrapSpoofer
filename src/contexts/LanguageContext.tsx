import { create } from 'zustand';

import { formatTranslation, getTranslation } from '../utils/i18n';

interface LanguageState {
  lang: string;
  setLang: (lang: string) => void;
  t: (keyPath: string) => string;
  /** Translate with `{var}` interpolation. */
  tf: (keyPath: string, vars: Record<string, string | number>) => string;
}

const getInitialLang = () => {
  const hasStorage =
    typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
  const savedLang = hasStorage ? localStorage.getItem('language') : null;
  if (savedLang) return savedLang;

  const systemLang = navigator.language ? navigator.language.split('-')[0] : 'en';
  const supported = ['pt', 'en', 'es', 'ru', 'fr'];
  if (supported.includes(systemLang)) {
    if (hasStorage && typeof localStorage.setItem === 'function') {
      localStorage.setItem('language', systemLang);
    }
    return systemLang;
  }
  return 'en';
};

export const useLanguage = create<LanguageState>((set, get) => ({
  lang: getInitialLang(),
  setLang: (newLang: string) => {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem('language', newLang);
    }
    set({ lang: newLang });
  },
  t: (keyPath: string) => getTranslation(get().lang, keyPath),
  tf: (keyPath, vars) => formatTranslation(get().lang, keyPath, vars),
}));

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};
