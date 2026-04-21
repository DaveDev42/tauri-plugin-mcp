#!/usr/bin/env node
// Bump all version strings across the repo in lockstep, then commit/tag/push.
//
// Usage:
//   pnpm bump patch
//   pnpm bump minor
//   pnpm bump major
//   pnpm bump 0.4.0
//
// Updates:
//   - Cargo.toml                                    (Rust crate)
//   - .claude-plugin/plugin.json                    (Claude Code plugin manifest)
//   - .claude-plugin/marketplace.json               (marketplace catalog entry)
//   - package.json                                  (workspace root)
//   - packages/tauri-mcp/package.json               (MCP server)
//   - packages/tauri-plugin-mcp-api/package.json    (frontend API)
// Then rebuilds, commits everything staged, tags vX.Y.Z, and pushes main + tag.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const jsonFiles = [
  '.claude-plugin/plugin.json',
  'package.json',
  'packages/tauri-mcp/package.json',
  'packages/tauri-plugin-mcp-api/package.json',
];

const marketplaceFile = '.claude-plugin/marketplace.json';
const cargoFile = 'Cargo.toml';

function readCurrentVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('root package.json has no version');
  return pkg.version;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a valid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function resolveNextVersion(current, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [major, minor, patch] = parseSemver(current);
  if (arg === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (arg === 'minor') return `${major}.${minor + 1}.0`;
  if (arg === 'major') return `${major + 1}.0.0`;
  throw new Error(`unknown bump spec: ${arg} (use patch|minor|major|X.Y.Z)`);
}

function updateJson(path, mutate) {
  const abs = resolve(root, path);
  const raw = readFileSync(abs, 'utf8');
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  const obj = JSON.parse(raw);
  mutate(obj);
  writeFileSync(abs, JSON.stringify(obj, null, 2) + trailingNewline);
}

function updateCargoToml(path, next) {
  const abs = resolve(root, path);
  const raw = readFileSync(abs, 'utf8');
  const updated = raw.replace(
    /^(version\s*=\s*)"[^"]+"/m,
    (_, prefix) => `${prefix}"${next}"`,
  );
  if (updated === raw) throw new Error(`no version line matched in ${path}`);
  writeFileSync(abs, updated);
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: pnpm bump <patch|minor|major|X.Y.Z>');
    process.exit(1);
  }

  // Require clean working tree so we can attribute the commit to this script alone.
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
  if (status.trim()) {
    console.error('working tree is not clean. commit or stash changes first.');
    console.error(status);
    process.exit(1);
  }

  const current = readCurrentVersion();
  const next = resolveNextVersion(current, arg);
  console.log(`bumping ${current} -> ${next}`);

  // 1. JSON files — set "version"
  for (const f of jsonFiles) {
    updateJson(f, (obj) => {
      obj.version = next;
    });
    console.log(`  updated ${f}`);
  }

  // 2. marketplace.json — nested under plugins[0].version
  updateJson(marketplaceFile, (obj) => {
    if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
      throw new Error(`${marketplaceFile}: plugins[] is empty`);
    }
    for (const p of obj.plugins) p.version = next;
  });
  console.log(`  updated ${marketplaceFile}`);

  // 3. Cargo.toml — first version line under [package]
  updateCargoToml(cargoFile, next);
  console.log(`  updated ${cargoFile}`);

  // 4. Rebuild so Cargo.lock / dist artifacts reflect the new version,
  //    and so the pre-commit hook sees a clean rebuild.
  run('pnpm build');
  run('cargo check --quiet');

  // 5. Commit + tag + push
  run('git add -A');
  run(`git commit -m "chore: bump version to ${next}"`);
  run(`git tag v${next}`);
  run('git push origin main');
  run(`git push origin v${next}`);

  console.log(`\n✅ released v${next}`);
}

main();
