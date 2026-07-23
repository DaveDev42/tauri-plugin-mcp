#!/usr/bin/env node
// Point git at the repo's tracked hooks so the pre-commit `dist/` rebuild
// actually runs. Git ignores `.githooks/` until `core.hooksPath` names it, and
// nothing else in the repo sets that — so without this the hook is inert, and
// several PRs have merged (or stalled in CI) with a stale `dist/`.
//
// Run from `prepare`, i.e. on every `pnpm install`. It must never fail the
// install: outside a git work tree (tarball installs, CI caches, `git worktree`
// edge cases) it just no-ops.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESIRED = '.githooks';

function git(args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

try {
  // Only touch a real work tree — skip tarball/dependency installs.
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    process.exit(0);
  }

  let current = '';
  try {
    current = git(['config', '--local', 'core.hooksPath']);
  } catch {
    // unset — `git config` exits non-zero, which is fine.
  }

  if (current === DESIRED) {
    process.exit(0);
  }

  git(['config', '--local', 'core.hooksPath', DESIRED]);
  console.error(
    current
      ? `[setup-hooks] core.hooksPath: "${current}" -> "${DESIRED}"`
      : `[setup-hooks] core.hooksPath set to "${DESIRED}" (pre-commit dist rebuild now active)`
  );
} catch {
  // No git binary, not a repo, or a detached environment. Nothing to do.
  process.exit(0);
}
