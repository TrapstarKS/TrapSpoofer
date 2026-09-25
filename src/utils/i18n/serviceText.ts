import { formatTranslation } from './index';

/** Translate a `services.*` message outside React, using the saved UI language. */
export function serviceText(key: string, vars: Record<string, string | number> = {}): string {
  const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('language')) || 'pt';
  return formatTranslation(lang, `services.${key}`, vars);
}
