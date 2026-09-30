import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORMS = [
  { key: 'windows-x86_64', match: /-setup\.exe\.sig$/i },
  { key: 'darwin-aarch64', match: /aarch64\.app\.tar\.gz\.sig$/i },
  { key: 'darwin-x86_64', match: /(?:x64|x86_64)\.app\.tar\.gz\.sig$/i },
  { key: 'linux-x86_64', match: /\.AppImage\.sig$/i },
];
const REQUIRED = ['windows-x86_64', 'darwin-aarch64', 'linux-x86_64'];

export function buildUpdaterManifest(tag, dir, repo = 'TrapstarKS/TrapSpoofer') {
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('Invalid release tag');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
  const platforms = {};
  for (const file of readdirSync(dir).sort()) {
    const platform = PLATFORMS.find((candidate) => candidate.match.test(file));
    if (!platform) continue;
    if (platforms[platform.key]) throw new Error(`Duplicate updater artifact for ${platform.key}`);
    const signature = readFileSync(join(dir, file), 'utf8').trim();
    if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature))
      throw new Error(`Missing or malformed signature: ${file}`);
    platforms[platform.key] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file.slice(0, -4))}`,
    };
  }
  const missing = REQUIRED.filter((platform) => !platforms[platform]);
  if (missing.length) throw new Error(`Missing updater platforms: ${missing.join(', ')}`);
  return {
    version: tag.replace(/^v/, ''),
    notes: `TrapSpoofer ${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [tag, dir] = process.argv.slice(2);
    if (!tag || !dir) throw new Error('usage: updater-manifest.mjs <tag> <sig-dir>');
    process.stdout.write(
      `${JSON.stringify(buildUpdaterManifest(tag, dir, process.env.GITHUB_REPOSITORY), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
