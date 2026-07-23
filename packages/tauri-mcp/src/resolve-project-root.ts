import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve which directory the Tauri app lives in.
 *
 * The MCP server needs the directory that DIRECTLY contains `src-tauri/`.
 * Historically this came from a bare `TAURI_APP_DIR || TAURI_PROJECT_ROOT || cwd`
 * chain, which had two failure modes that were both silent:
 *
 *   1. `TAURI_APP_DIR` arriving as an EMPTY STRING is falsy, so it fell through
 *      to `cwd` with no signal at all. That happens whenever the plugin's
 *      `tauri_app_dir` userConfig fails to resolve — most commonly because it
 *      was written to `<project>/.claude/settings.json`, a scope Claude Code
 *      does not read `pluginConfigs` from (it reads user/flag/policy settings
 *      only), after which the unresolved placeholder is substituted with "".
 *   2. In a monorepo, `cwd` is the repo root, where no `src-tauri/` exists, so
 *      detection failed and every launch threw "No Tauri app detected".
 *
 * This module keeps explicit configuration authoritative but adds a bounded
 * search so that the common monorepo layout works with no configuration at all,
 * and reports precisely which branch was taken.
 */

/** Directories never worth descending into when searching for a Tauri app. */
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '.cache',
]);

/** How deep below the search root to look for `<dir>/src-tauri/Cargo.toml`. */
const MAX_DEPTH = 4;

/** Stop searching once this many apps are found — enough to report ambiguity. */
const MAX_CANDIDATES = 10;

export type ProjectRootSource =
  | 'TAURI_APP_DIR'
  | 'TAURI_PROJECT_ROOT'
  | 'cwd'
  | 'auto-discovered';

export interface ProjectRootResolution {
  /** Absolute path to the directory that should contain `src-tauri/`. */
  projectRoot: string;
  /** Which branch produced `projectRoot`. */
  source: ProjectRootSource;
  /** Human-readable notes to print; empty on a clean explicit configuration. */
  diagnostics: string[];
}

/** True when `dir` directly contains `src-tauri/Cargo.toml`. */
export function isTauriApp(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'src-tauri', 'Cargo.toml'));
}

/**
 * Find directories under `root` (inclusive) that directly contain
 * `src-tauri/Cargo.toml`.
 *
 * Symlinked entries are skipped, which both avoids cycles and keeps the walk
 * cheap; explicit configuration remains the escape hatch for symlinked layouts.
 */
export function findTauriApps(root: string, maxDepth: number = MAX_DEPTH): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (found.length >= MAX_CANDIDATES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race). Skip it rather than failing
      // the whole server start.
      return;
    }

    if (isTauriApp(dir)) {
      found.push(dir);
      // A Tauri app's own subtree cannot contain another app we care about.
      return;
    }

    if (depth >= maxDepth) return;

    for (const entry of entries) {
      // `isDirectory()` is false for symlinks, so this skips them too.
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

/**
 * Resolve the project root from the environment, falling back to a bounded
 * search. Explicit configuration always wins, even when it looks wrong — this
 * never silently overrides a value the user set on purpose.
 */
export function resolveProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): ProjectRootResolution {
  const diagnostics: string[] = [];

  for (const key of ['TAURI_APP_DIR', 'TAURI_PROJECT_ROOT'] as const) {
    const raw = env[key];
    if (raw === undefined) continue;

    const value = raw.trim();
    if (value === '') {
      // Set-but-empty is a distinct failure from unset, and it is the one that
      // used to be invisible. Name the likely cause instead of guessing.
      diagnostics.push(
        `${key} is set but EMPTY — the plugin's \`tauri_app_dir\` userConfig did not resolve.\n` +
          `  Claude Code reads \`pluginConfigs\` from user/flag/policy settings only, so a value in\n` +
          `  <project>/.claude/settings.json is ignored. Move it to ~/.claude/settings.json and restart.\n` +
          `  Continuing with auto-discovery.`
      );
      continue;
    }

    // Resolve to an absolute path so every downstream consumer — including the
    // FNV-1a socket hash, which the Rust plugin computes over an absolute path —
    // sees the same string regardless of how the value was written.
    const resolved = path.resolve(cwd, value);
    if (!isTauriApp(resolved)) {
      diagnostics.push(
        `${key}="${value}" resolved to ${resolved}, which has no src-tauri/Cargo.toml.\n` +
          `  Honoring it anyway because explicit configuration wins, but launching will fail\n` +
          `  until the path points at the directory that contains src-tauri/.`
      );
    }
    return { projectRoot: resolved, source: key, diagnostics };
  }

  // Unconfigured. The single-app layout (cwd IS the app) keeps its old behavior.
  if (isTauriApp(cwd)) {
    return { projectRoot: cwd, source: 'cwd', diagnostics };
  }

  const candidates = findTauriApps(cwd);

  if (candidates.length === 1) {
    diagnostics.push(
      `No Tauri app in ${cwd}; auto-discovered the only one at ${candidates[0]}.\n` +
        `  Set the plugin's \`tauri_app_dir\` userConfig to "${path.relative(cwd, candidates[0]) || '.'}" to pin it.`
    );
    return { projectRoot: candidates[0], source: 'auto-discovered', diagnostics };
  }

  if (candidates.length > 1) {
    // Never guess between real apps — picking wrong is worse than not picking.
    diagnostics.push(
      `Found ${candidates.length} Tauri apps under ${cwd} and will not guess between them:\n` +
        candidates.map((c) => `    - ${path.relative(cwd, c) || '.'}`).join('\n') +
        `\n  Set the plugin's \`tauri_app_dir\` userConfig (in ~/.claude/settings.json) to one of them.`
    );
  } else {
    diagnostics.push(
      `No Tauri app (src-tauri/Cargo.toml) found in or below ${cwd} within ${MAX_DEPTH} levels.\n` +
        `  Set the plugin's \`tauri_app_dir\` userConfig to the directory that contains src-tauri/.`
    );
  }

  return { projectRoot: cwd, source: 'cwd', diagnostics };
}
