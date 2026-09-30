import { expect, test } from '@playwright/test';
import { PluginClient, TauriPage } from '@srsholmes/tauri-playwright';

const socketPath = '/tmp/tauri-playwright.sock';

async function attachNative() {
  const client = new PluginClient(socketPath);
  await client.connect();
  const ping = await client.send({ type: 'ping' });
  expect(ping.ok).toBe(true);
  return { client, page: new TauriPage(client) };
}

test.describe('TrapSpoofer E2E', () => {
  test('attaches to the existing native app', async () => {
    const { client, page } = await attachNative();
    try {
      const windows = await page.listWindows();
      expect(
        windows.some((window) => window.label === 'main' || window.label === 'splashscreen'),
      ).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  test('renders the main TrapSpoofer window', async () => {
    const { client, page } = await attachNative();
    try {
      const mainPage = await page.waitForWindow((window) => window.label === 'main', {
        timeout: 15000,
      });
      expect(await mainPage.evaluate<string>('document.readyState')).toBe('complete');
      expect(await mainPage.evaluate<boolean>('document.body !== null')).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});
