/* Shared fixtures for the Issue #108 fan-out tests. Hermetic: ENIGMA_HOME and
 * every repo are temp dirs; the only "prompting store" is an in-memory fake
 * swapped into DEPOSITORY_MODULES, so no real Keychain / 1Password / Secret
 * Service item is ever touched. Not a `.test.ts`, so vitest does not collect it.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditLogPath } from '../../../src/core/paths.js';
import { projectId } from '../../../src/core/project.js';
import { replaceTarget } from '../../../src/render/ledger.js';
import { DEPOSITORY_MODULES } from '../../../src/storage/detect.js';
import type { Depository, DepositoryModule } from '../../../src/storage/interfaces.js';
import { RENDER_BEGIN_MARKER, RENDER_END_MARKER } from '../../../src/storage/dotenv-file.js';

export const SENTINEL = 'sk-sentinel-value-should-never-appear-108';

export interface Sandbox {
  home: string;
  dirs: string[];
  cleanup(): void;
}

/** Point ENIGMA_HOME at a fresh temp dir; `cleanup` restores it and removes everything made through `repo`. */
export function makeSandbox(): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-fanout-home-')));
  const prior = process.env.ENIGMA_HOME;
  process.env.ENIGMA_HOME = home;
  const dirs: string[] = [home];
  return {
    home,
    dirs,
    cleanup() {
      if (prior === undefined) delete process.env.ENIGMA_HOME;
      else process.env.ENIGMA_HOME = prior;
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

/**
 * One repository with `extra` linked worktrees. Every returned path shares one
 * `projectId` (linked worktrees resolve to the main clone's identity), and
 * `worktrees[0]` is the main clone.
 */
export function makeRepo(sandbox: Sandbox, extra = 0): { worktrees: string[]; projectId: string } {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-fanout-repo-')));
  sandbox.dirs.push(main);
  mkdirSync(join(main, '.git'));
  const worktrees = [main];
  for (let i = 0; i < extra; i++) {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-fanout-wt-')));
    sandbox.dirs.push(wt);
    const gitdir = join(main, '.git', 'worktrees', `wt${i}`);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    worktrees.push(wt);
  }
  return { worktrees, projectId: projectId(main) };
}

/** A repo of its own (a different `projectId`). */
export function makeOtherRepo(sandbox: Sandbox): { worktree: string; projectId: string } {
  const { worktrees, projectId: pid } = makeRepo(sandbox, 0);
  return { worktree: worktrees[0]!, projectId: pid };
}

export const block = (...lines: string[]): string => `${RENDER_BEGIN_MARKER}\n${lines.map((l) => `${l}\n`).join('')}${RENDER_END_MARKER}\n`;

export const readEnv = (worktree: string, file = '.env'): string => readFileSync(join(worktree, file), 'utf8');

/**
 * Write `content` as `worktree`'s target file and record it in the ledger as
 * holding `names` (the state an earlier render or fan-out would have left).
 */
export function seedTarget(worktree: string, pid: string, content: string, names: string[], file = '.env'): string {
  const path = join(worktree, file);
  writeFileSync(path, content);
  replaceTarget({ projectId: pid, worktree, file: path, names });
  return path;
}

export function auditLines(): Array<Record<string, unknown>> {
  try {
    return readFileSync(auditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export interface FakeStore {
  values: Map<string, string>;
  resolveCalls: string[];
  restore(): void;
}

/**
 * Replace the `keychain` module with an in-memory store that has the real
 * module's prompt profile (`may-prompt`), and record every `resolve` so a test
 * can assert fan-out never reads a prompting store.
 */
export function installFakePromptingStore(): FakeStore {
  const idx = DEPOSITORY_MODULES.findIndex((m) => m.id === 'keychain');
  const original = DEPOSITORY_MODULES[idx]!;
  const values = new Map<string, string>();
  const resolveCalls: string[] = [];
  const fake: Depository = {
    id: 'keychain',
    promptProfile: original.promptProfile,
    async set(ref, value) {
      values.set(ref, value);
      return ref;
    },
    async resolve(ref) {
      resolveCalls.push(ref);
      const v = values.get(ref);
      if (v === undefined) throw new Error('fake store: not found');
      return v;
    },
    async delete(ref) {
      values.delete(ref);
    },
    async has(ref) {
      return values.has(ref);
    },
  };
  const mod: DepositoryModule = { ...original, create: () => fake };
  DEPOSITORY_MODULES[idx] = mod;
  return {
    values,
    resolveCalls,
    restore() {
      DEPOSITORY_MODULES[idx] = original;
    },
  };
}
