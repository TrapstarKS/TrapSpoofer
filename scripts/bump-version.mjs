#!/usr/bin/env node
/**
 * Bump the app version everywhere it lives (package.json, tauri.conf.json,
 * Cargo.toml) and re-format, so a release is just: bump -> commit -> push.
 *
 *   bun run bump            # patch: 3.0.1 -> 3.0.2
 *   bun run bump minor      # 3.0.1 -> 3.1.0
 *   bun run bump 3.2.0      # explicit
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const arg = process.argv[2] ?? 'patch';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const next = /^\d+\.\d+\.\d+$/.test(arg)
  ? arg
  : arg === 'major'
    ? `${major + 1}.0.0`
    : arg === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const replaceIn = (file, pattern, replacement) => {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(pattern, replacement);
  if (before === after) throw new Error(`version not found in ${file}`);
  writeFileSync(file, after);
};

replaceIn('package.json', /"version": "[^"]+"/, `"version": "${next}"`);
replaceIn('src-tauri/tauri.conf.json', /"version": "[^"]+"/, `"version": "${next}"`);
replaceIn('src-tauri/Cargo.toml', /^version(\s*)= "[^"]+"/m, `version$1= "${next}"`);
replaceIn('src-tauri/Cargo.lock', /(name = "app"\r?\nversion = )"[^"]+"/, `$1"${next}"`);

execSync('bunx prettier --write package.json src-tauri/tauri.conf.json', { stdio: 'ignore' });
console.log(`${pkg.version} -> ${next}`);
console.log(`Next: git commit -am "v${next}: ..." && git push   (CI publishes the release)`);
