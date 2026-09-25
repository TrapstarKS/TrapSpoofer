export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { pt } from './pt';
import { ru } from './ru';

/**
 * UI namespaces live in ./ui/*.ts and export `{ en, pt }` (other languages
 * fall back to English). They are merged on top of the base dictionaries.
 */
type NamespaceModule = { default?: Record<string, TranslationTree> } & Record<
  string,
  Record<string, TranslationTree> | undefined
>;
const namespaceModules = import.meta.glob<NamespaceModule>('./ui/*.ts', { eager: true });

function deepMerge(target: TranslationTree, source: TranslationTree): TranslationTree {
  const out: TranslationTree = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] =
      typeof value === 'object' && typeof existing === 'object'
        ? deepMerge(existing, value)
        : value;
  }
  return out;
}

const base: Record<string, TranslationTree> = { en, pt, es, ru, fr };
const locales: Record<string, TranslationTree> = {};
for (const lang of Object.keys(base)) {
  let merged = base[lang];
  for (const mod of Object.values(namespaceModules)) {
    const dict = (mod.default ?? mod) as Record<string, TranslationTree | undefined>;
    const tree = dict[lang];
    if (tree && typeof tree === 'object') merged = deepMerge(merged, tree);
  }
  locales[lang] = merged;
}

export const SUPPORTED_LANGUAGES = [
  { code: 'pt', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ru', label: 'Русский' },
] as const;

function lookup(dictionary: TranslationTree | undefined, keys: string[]): string | undefined {
  let current: string | TranslationTree | undefined = dictionary;
  for (const k of keys) {
    if (typeof current !== 'object' || current === null || !(k in current)) return undefined;
    current = current[k];
  }
  return typeof current === 'string' ? current : undefined;
}

export function getTranslation(lang: string, keyPath: string): string {
  const keys = keyPath.split('.');
  return lookup(locales[lang], keys) ?? lookup(locales.en, keys) ?? keyPath;
}

/** `t` with `{name}` interpolation. */
export function formatTranslation(
  lang: string,
  keyPath: string,
  vars: Record<string, string | number>,
): string {
  return getTranslation(lang, keyPath).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
