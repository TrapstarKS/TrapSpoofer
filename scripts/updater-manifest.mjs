#!/usr/bin/env node
/**
 * Builds the Tauri updater manifest (latest.json) from the `.sig` files that
 * the parallel platform builds uploaded to the release.
 *
 *   node scripts/updater-manifest.mjs v3.0.0 ./sigs > latest.json
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [tag, dir] = process.argv.slice(2);
if (!tag || !dir) {
  console.error('usage: updater-manifest.mjs <tag> <sig-dir>');
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY || 'TrapstarKS/TrapSpoofer';

const PLATFORMS = [
  { key: 'windows-x86_64', match: /-setup\.exe\.sig$/i },
  { key: 'darwin-aarch64', match: /aarch64\.app\.tar\.gz\.sig$/i },
  { key: 'darwin-x86_64', match: /x64\.app\.tar\.gz\.sig$|x86_64\.app\.tar\.gz\.sig$/i },
  { key: 'linux-x86_64', match: /\.AppImage\.sig$/i },
];

const platforms = {};
for (const file of readdirSync(dir)) {
  const platform = PLATFORMS.find((p) => p.match.test(file));
  if (!platform) continue;
  const asset = file.slice(0, -'.sig'.length);
  platforms[platform.key] = {
    signature: readFileSync(join(dir, file), 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}

if (Object.keys(platforms).length === 0) {
  console.error('No .sig signatures found; the updater manifest will have no platforms.');
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      version: tag.replace(/^v/, ''),
      notes: `TrapSpoofer ${tag}`,
      pub_date: new Date().toISOString(),
      platforms,
    },
    null,
    2,
  )}\n`,
);
