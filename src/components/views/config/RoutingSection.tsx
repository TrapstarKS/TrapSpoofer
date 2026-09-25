import { Gauge } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import {
  SettingCard,
  SettingFieldRow,
  SettingSliderItem,
  SettingSwitchRow,
} from '../settings/SettingComponents';

export default function RoutingSection() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();
  const batch = config.advanced.batchSize ?? 250;
  const batchDesc =
    batch <= 25
      ? t('prefs.routing.batchUltra')
      : batch <= 80
        ? t('prefs.routing.batchBalanced')
        : batch <= 180
          ? t('prefs.routing.batchFast')
          : t('prefs.routing.batchMax');

  return (
    <SettingCard
      icon={Gauge}
      title={t('prefs.routing.title')}
      description={t('prefs.routing.desc')}
    >
      <SettingFieldRow
        label={t('prefs.routing.proxy')}
        description={t('prefs.routing.proxyDesc')}
        value={config.advanced.proxyUrl}
        onChange={(val) => updateConfig('advanced', 'proxyUrl', val)}
        placeholder="http://127.0.0.1:8080"
      />
      <SettingSwitchRow
        label={t('prefs.routing.concurrent')}
        description={t('prefs.routing.concurrentDesc')}
        checked={config.advanced.concurrentSpoofing}
        onCheckedChange={(val) => updateConfig('advanced', 'concurrentSpoofing', val)}
      />
      {config.advanced.concurrentSpoofing && (
        <>
          <SettingSliderItem
            label={t('prefs.routing.maxConcurrency')}
            description={t('prefs.routing.maxConcurrencyDesc')}
            value={config.advanced.maxConcurrency}
            onChange={(val) => updateConfig('advanced', 'maxConcurrency', val)}
            min={1}
            max={100}
            ticks={[1, 50, 100]}
          />
          <SettingSliderItem
            label={t('prefs.routing.maxDownload')}
            description={t('prefs.routing.maxDownloadDesc')}
            value={config.advanced.maxDownloadConcurrency}
            onChange={(val) => updateConfig('advanced', 'maxDownloadConcurrency', val)}
            min={1}
            max={100}
            ticks={[1, 50, 100]}
          />
          <SettingSliderItem
            label={t('prefs.routing.discovery')}
            description={t('prefs.routing.discoveryDesc')}
            value={config.advanced.discoveryConcurrency ?? 30}
            onChange={(val) => updateConfig('advanced', 'discoveryConcurrency', val)}
            min={1}
            max={50}
            ticks={[1, 25, 50]}
          />
        </>
      )}
      <SettingSliderItem
        label={t('prefs.routing.poll')}
        description={t('prefs.routing.pollDesc')}
        value={config.advanced.operationPollIntervalMs ?? 250}
        onChange={(val) => updateConfig('advanced', 'operationPollIntervalMs', val)}
        min={100}
        max={1000}
        step={10}
        ticks={[100, 250, 500, 1000]}
      />
      <SettingSliderItem
        label={t('prefs.routing.batch')}
        description={batchDesc}
        value={batch}
        onChange={(val) => {
          updateConfig('advanced', 'batchSize', val);
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('set_plugin_batch_size', { batchSize: val }).catch(console.error);
          });
        }}
        min={10}
        max={500}
        step={5}
        ticks={[10, 100, 250, 500]}
      />
    </SettingCard>
  );
}
