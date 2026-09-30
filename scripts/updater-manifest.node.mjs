import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildUpdaterManifest } from './updater-manifest.mjs';

const files = [
  'TrapSpoofer_3.0.1_x64-setup.exe.sig',
  'TrapSpoofer_aarch64.app.tar.gz.sig',
  'TrapSpoofer_amd64.AppImage.sig',
];
function signatures(context) {
  const directory = mkdtempSync(join(tmpdir(), 'trapspoofer-updates-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) writeFileSync(join(directory, file), 'dGVzdA==');
  return directory;
}

test('builds a complete manifest for the release matrix', (context) => {
  const manifest = buildUpdaterManifest('v3.0.1', signatures(context));
  assert.equal(manifest.version, '3.0.1');
  assert.equal(Object.keys(manifest.platforms).length, 3);
  assert.ok(manifest.platforms['windows-x86_64'].url.endsWith('TrapSpoofer_3.0.1_x64-setup.exe'));
});

test('rejects partial platform releases', (context) => {
  const directory = signatures(context);
  rmSync(join(directory, files[1]));
  assert.throws(
    () => buildUpdaterManifest('v3.0.1', directory),
    /Missing updater platforms: darwin-aarch64/,
  );
});

test('rejects empty signatures and duplicate platform artifacts', (context) => {
  const directory = signatures(context);
  writeFileSync(join(directory, files[1]), '');
  assert.throws(() => buildUpdaterManifest('v3.0.1', directory), /signature/);
  writeFileSync(join(directory, files[1]), 'dGVzdA==');
  writeFileSync(join(directory, 'Other_aarch64.app.tar.gz.sig'), 'dGVzdA==');
  assert.throws(() => buildUpdaterManifest('v3.0.1', directory), /Duplicate/);
});
