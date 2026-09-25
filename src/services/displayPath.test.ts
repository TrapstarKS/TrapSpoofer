import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { displayPath } from './spoofer';

describe('displayPath', () => {
  it('strips the Windows extended-length prefix', () => {
    const extended = '\\\\?\\C:\\Users\\x\\place.spoofed.rbxl';
    expect(extended.startsWith('\\\\?\\')).toBe(true);
    expect(displayPath(extended)).toBe('C:\\Users\\x\\place.spoofed.rbxl');
  });

  it('leaves normal paths alone', () => {
    expect(displayPath('C:\\Users\\x\\place.rbxl')).toBe('C:\\Users\\x\\place.rbxl');
    expect(displayPath('/home/x/place.rbxl')).toBe('/home/x/place.rbxl');
  });
});
