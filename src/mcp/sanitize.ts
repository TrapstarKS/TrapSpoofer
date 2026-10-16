import { useConfigStore } from '../stores/configStore';

const secretKey =
  /^(?:cookie|cookies|fallbackCookies|apiKey|groupApiKey|api_key|group_api_key|x-api-key|authorization|\.ROBLOSECURITY)$/i;

export function currentSecrets(): string[] {
  const { config, accountSecrets } = useConfigStore.getState();
  return [
    ...new Set(
      [
        config.spoofing.cookie,
        config.spoofing.apiKey,
        config.spoofing.groupApiKey,
        ...Object.values(accountSecrets).flatMap((value) => [
          value.cookie,
          value.apiKey,
          value.groupApiKey,
        ]),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function sanitizeMcp(value: unknown, secrets = currentSecrets()): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      text = text.split(secret).join('[REDACTED]');
      text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
    return text
      .replace(/(\.ROBLOSECURITY\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
      .replace(
        /((?:x-api-key|api[_ -]?key|cookie|authorization)\s*[=:]\s*)[^\s,;"']+/gi,
        '$1[REDACTED]',
      );
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeMcp(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !secretKey.test(key))
        .map(([key, item]) => [String(sanitizeMcp(key, secrets)), sanitizeMcp(item, secrets)]),
    );
  }
  return value;
}
