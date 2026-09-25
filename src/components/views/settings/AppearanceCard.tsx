import { Moon, Palette, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HexAlphaColorPicker } from 'react-colorful';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useThemeAccent } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';
import { SUPPORTED_LANGUAGES } from '../../../utils/i18n';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { SettingCard, SettingRow } from './SettingComponents';

const PRESETS = ['#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4'];
const DEFAULT_ACCENT = '#10b981';

export default function AppearanceCard() {
  const { t, lang, setLang } = useLanguage();
  const { accentColor, setAccentColor, themeMode, setThemeMode } = useThemeAccent();
  const [localAccent, setLocalAccent] = useState(accentColor || DEFAULT_ACCENT);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalAccent(accentColor || DEFAULT_ACCENT);
  }, [accentColor]);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      setLocalAccent(hex);
      document.documentElement.style.setProperty('--primary', hex);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setAccentColor(hex), 60);
    },
    [setAccentColor],
  );

  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === lang) ?? SUPPORTED_LANGUAGES[0];

  return (
    <SettingCard
      icon={Palette}
      title={t('prefs.appearance.title')}
      description={t('prefs.appearance.desc')}
    >
      <SettingRow
        label={t('prefs.appearance.language')}
        description={t('prefs.appearance.languageDesc')}
      >
        <Select
          value={lang}
          onValueChange={(val) => {
            if (typeof val === 'string') setLang(val);
          }}
        >
          <SelectTrigger className="h-9 w-48 text-[13px]">
            <SelectValue>{currentLang.label}</SelectValue>
          </SelectTrigger>
          <SelectContent className="p-1">
            {SUPPORTED_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code} className="text-[13px]">
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow label={t('prefs.appearance.theme')} description={t('prefs.appearance.themeDesc')}>
        <div className="flex w-48 rounded-lg border border-border-subtle bg-bg-base p-0.5">
          {(['light', 'dark'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={themeMode === mode}
              onClick={() => setThemeMode(mode)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium transition-colors',
                themeMode === mode
                  ? 'bg-bg-elevated text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {mode === 'light' ? <Sun size={13} /> : <Moon size={13} />}
              {t(`prefs.appearance.${mode}`)}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label={t('prefs.appearance.accent')}
        description={t('prefs.appearance.accentDesc')}
      >
        <div className="flex items-center gap-1.5">
          {PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              onClick={() => handleColorChange(color)}
              className={cn(
                'size-6 rounded-full ring-1 ring-border-strong transition-transform hover:scale-110',
                localAccent.toLowerCase() === color &&
                  'ring-2 ring-offset-2 ring-offset-bg-surface ring-text-primary',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={t('prefs.appearance.accent')}
                  className="ml-1 size-6 rounded-full ring-1 ring-border-strong"
                  style={{
                    background:
                      'conic-gradient(#ef4444, #f59e0b, #10b981, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
                  }}
                />
              }
            />
            <PopoverContent align="end" className="w-auto gap-0 overflow-hidden p-0">
              <HexAlphaColorPicker color={localAccent} onChange={handleColorChange} />
              <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-2.5">
                <span className="text-[11px] font-semibold text-text-muted">{t('common.hex')}</span>
                <input
                  type="text"
                  value={localAccent.toUpperCase()}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="w-24 rounded border border-border-subtle bg-bg-base px-2 py-1 text-center font-mono text-xs text-text-primary outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => handleColorChange(DEFAULT_ACCENT)}
                  className="text-[11px] font-medium text-text-secondary hover:text-text-primary"
                >
                  {t('prefs.appearance.reset')}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </SettingRow>
    </SettingCard>
  );
}
