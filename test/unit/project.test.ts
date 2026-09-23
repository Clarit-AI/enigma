import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findProjectPath,
  findRepoIdentityPath,
  parseCommondirPointer,
  parseGitdirPointer,
  projectId,
  resolveGitPointer,
} from '../../src/core/project.js';

const PROJECT_ID_LENGTH = 16;

function realTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('findProjectPath / projectId', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realTmpDir('enigma-project-');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('finds the git toplevel from a nested subdirectory', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const nested = join(tmpRoot, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(findProjectPath(nested)).toBe(tmpRoot);
  });

  it('falls back to cwd when not inside a git repo', () => {
    const nonGit = join(tmpRoot, 'not-a-repo');
    mkdirSync(nonGit, { recursive: true });

    expect(findProjectPath(nonGit)).toBe(nonGit);
  });

  it('produces a stable 16-hex-char id for the same path', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const id1 = projectId(tmpRoot);
    const id2 = projectId(tmpRoot);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different ids for different projects', () => {
    const a = join(tmpRoot, 'a');
    const b = join(tmpRoot, 'b');
    mkdirSync(join(a, '.git'), { recursive: true });
    mkdirSync(join(b, '.git'), { recursive: true });

    expect(projectId(a)).not.toBe(projectId(b));
  });
});

describe('parseGitdirPointer', () => {
  it('reads an absolute gitdir with a space after the colon', () => {
    expect(parseGitdirPointer('gitdir: /abs/path/.git/worktrees/wt\n')).toBe('/abs/path/.git/worktrees/wt');
  });

  it('reads a relative gitdir with no space after the colon', () => {
    expect(parseGitdirPointer('gitdir:../../.git/worktrees/wt\n')).toBe('../../.git/worktrees/wt');
  });

  it('trims CRLF and trailing whitespace', () => {
    expect(parseGitdirPointer('gitdir: /abs/path\r\n')).toBe('/abs/path');
    expect(parseGitdirPointer('gitdir:   /abs/path   \n')).toBe('/abs/path');
  });

  it('returns null when the first line is not a gitdir pointer', () => {
    expect(parseGitdirPointer('not gitdir: anything\n')).toBeNull();
    expect(parseGitdirPointer('')).toBeNull();
    expect(parseGitdirPointer('gitdir:\n')).toBeNull();
  });

  it('only inspects the first line; later lines are ignored', () => {
    expect(parseGitdirPointer('gitdir: /abs/path\nextra junk that git ignores\n')).toBe('/abs/path');
  });
});

describe('parseCommondirPointer', () => {
  it('reads a relative path with trailing newline', () => {
    expect(parseCommondirPointer('../..\n')).toBe('../..');
  });

  it('trims CRLF and surrounding whitespace', () => {
    expect(parseCommondirPointer('  ../..  \r\n')).toBe('../..');
  });

  it('returns null for empty content', () => {
    expect(parseCommondirPointer('')).toBeNull();
    expect(parseCommondirPointer('   \n')).toBeNull();
  });
});

describe('resolveGitPointer', () => {
  it('leaves an already-absolute posix path unchanged (path.posix)', () => {
    expect(resolveGitPointer('/anywhere', '/abs/path/.git/worktrees/wt', nodePath.posix)).toBe(
      '/abs/path/.git/worktrees/wt',
    );
  });

  it('resolves a relative posix path against the base directory (path.posix)', () => {
    // path.posix.resolve walks the segments from /repo/sub → /repo → /
    // and then appends the rest, so two ".." segments land at "/".
    expect(resolveGitPointer('/repo/sub', '../../other/.git/worktrees/w', nodePath.posix)).toBe(
      '/other/.git/worktrees/w',
    );
  });

  it('resolves a one-step-relative posix path against the base directory', () => {
    expect(resolveGitPointer('/repo/sub', '../sibling/.git', nodePath.posix)).toBe('/repo/sibling/.git');
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveGitPointer('/repo', '  /abs/path  ', nodePath.posix)).toBe('/abs/path');
    expect(resolveGitPointer('/repo/sub', '  ../sibling  ', nodePath.posix)).toBe('/repo/sibling');
  });

  it('resolves a Windows-style absolute forward-slash path through path.win32', () => {
    // C:/... is the form documented in the issue; on macOS the platform
    // path.resolve treats it as a relative segment, so the Windows AC is
    // only evidenced through path.win32. path.win32 normalises the slash
    // form but preserves forward slashes when the absolute root is already
    // in that form — what we care about here is that the function is path-
    // impl-agnostic and treats C:/... as absolute on the Windows impl.
    expect(resolveGitPointer('C:\\repo', 'C:/Users/x/repo/.git/worktrees/w', nodePath.win32)).toBe(
      'C:/Users/x/repo/.git/worktrees/w',
    );
  });

  it('resolves a backslash-absolute Windows path through path.win32', () => {
    expect(resolveGitPointer('C:\\repo', 'D:\\other\\.git', nodePath.win32)).toBe('D:\\other\\.git');
  });

  it('resolves a Windows backslash-relative path through path.win32', () => {
    expect(resolveGitPointer('C:\\repo\\wt', '..\\..\\.git\\worktrees\\w', nodePath.win32)).toBe(
      'C:\\.git\\worktrees\\w',
    );
  });

  it('defaults to the platform path impl when none is provided', () => {
    // Sanity check that the default behaves like the platform path. The
    // exact result depends on the host platform; just verify it does not
    // throw and returns a non-empty string.
    const out = resolveGitPointer(tmpdir(), '../sibling');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('findRepoIdentityPath (Issue #67)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realTmpDir('enigma-identity-');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Issue #67 / 0.2.0 regression pin: normal clone at a non-symlinked path → identity = sha256(path.resolve(root)).slice(0,16)', () => {
    // Real, non-symlinked clone: .git is a directory, no gitdir/commondir.
    // The 0.2.0 hash was sha256(realpath(worktreeRoot)).slice(0,16); under
    // 0.3.0 the same path produces the same hash because realpath of a
    // common dir whose basename is ".git" unwraps to the same worktree root.
    mkdirSync(join(tmpRoot, '.git'));
    const expected = createHash('sha256')
      .update(nodePath.resolve(tmpRoot))
      .digest('hex')
      .slice(0, PROJECT_ID_LENGTH);
    expect(projectId(tmpRoot)).toBe(expected);
    expect(findRepoIdentityPath(tmpRoot)).toBe(tmpRoot);
  });

  it('linked worktree: .git file + commondir → identity equals the main clone\'s identity', () => {
    const main = realTmpDir('enigma-identity-main-');
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat\n');

      const wt = realTmpDir('enigma-identity-wt-');
      try {
        writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);

        expect(projectId(wt)).toBe(projectId(main));
        expect(findRepoIdentityPath(wt)).toBe(main);
        expect(findRepoIdentityPath(main)).toBe(main);
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('relative gitdir pointer in the .git file resolves against the worktree root', () => {
    const main = realTmpDir('enigma-identity-rel-main-');
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');

      const wt = realTmpDir('enigma-identity-rel-wt-');
      try {
        // Relative gitdir: from /tmp/.../wt, "../.."+"/.git/worktrees/wt" is messy;
        // pick a relative path that actually points at the right place.
        const relativePointer = (() => {
          const wtDir = realpathSync(wt);
          const target = join(main, '.git', 'worktrees', 'wt');
          let from = wtDir;
          let ups = 0;
          // Walk up until both share a prefix, then descend.
          while (!target.startsWith(from + nodePath.sep) && from !== nodePath.dirname(from)) {
            from = nodePath.dirname(from);
            ups += 1;
          }
          const down = target.slice(from.length + 1);
          return '../'.repeat(ups) + down;
        })();
        writeFileSync(join(wt, '.git'), `gitdir: ${relativePointer}\n`);

        expect(projectId(wt)).toBe(projectId(main));
        expect(findRepoIdentityPath(wt)).toBe(main);
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('bare repo identity: bare `repo.git` + linked worktree → identity is `repo.git`, shared across worktrees', () => {
    const parent = realTmpDir('enigma-identity-bare-');
    try {
      const bare = join(parent, 'repo.git');
      mkdirSync(join(bare, 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(bare, 'worktrees', 'wt', 'commondir'), '../..\n');

      const wt = realTmpDir('enigma-identity-bare-wt-');
      try {
        writeFileSync(join(wt, '.git'), `gitdir: ${bare}/worktrees/wt\n`);

        expect(findRepoIdentityPath(wt)).toBe(bare);
        // And the bare repo itself, asked from its own tree, hashes to repo.git
        // (the bare dir IS the common dir, basename is "repo.git" ≠ ".git").
        expect(projectId(wt)).toBe(projectId(bare));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('submodule checkout and its own linked worktree share identity', () => {
    const superRepo = realTmpDir('enigma-identity-super-');
    try {
      const submoduleGitDir = join(superRepo, '.git', 'modules', 'x');
      mkdirSync(submoduleGitDir, { recursive: true });

      // submodule checkout at /superRepo/x: .git is a file pointing into superRepo/.git/modules/x
      const subCheckout = join(superRepo, 'x');
      mkdirSync(subCheckout, { recursive: true });
      writeFileSync(join(subCheckout, '.git'), `gitdir: ${submoduleGitDir}\n`);

      // linked worktree of the submodule at /superRepo/x/wt
      mkdirSync(join(submoduleGitDir, 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(submoduleGitDir, 'worktrees', 'wt', 'commondir'), '../..\n');

      const subWt = join(superRepo, 'x', 'wt');
      mkdirSync(subWt, { recursive: true });
      writeFileSync(join(subWt, '.git'), `gitdir: ${submoduleGitDir}/worktrees/wt\n`);

      const checkoutId = projectId(subCheckout);
      const worktreeId = projectId(subWt);
      expect(checkoutId).toBe(worktreeId);
      // Identity is the submodule git dir itself (basename "x" ≠ ".git").
      expect(findRepoIdentityPath(subCheckout)).toBe(submoduleGitDir);
      expect(findRepoIdentityPath(subWt)).toBe(submoduleGitDir);
    } finally {
      rmSync(superRepo, { recursive: true, force: true });
    }
  });

  it('symlinked clone path: identity hashes the physical path, not the symlink', () => {
    const real = realTmpDir('enigma-identity-symlink-real-');
    try {
      mkdirSync(join(real, '.git'));

      const linkDir = realTmpDir('enigma-identity-symlink-link-');
      try {
        const link = join(linkDir, 'alias');
        symlinkSync(real, link);

        // 0.2.0 would have hashed the lexical path (the symlink); 0.3.0
        // canonicalizes via realpath, so identity equals the physical path.
        expect(findRepoIdentityPath(link)).toBe(real);
        expect(projectId(link)).toBe(projectId(real));
      } finally {
        rmSync(linkDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('no .git anywhere up the tree: identity = realpath(findProjectPath(cwd))', () => {
    // findProjectPath falls back to cwd when no .git is found; identity
    // must then be the realpath of that fallback (preserves the 0.2.0
    // shape exactly when reached via a physical path).
    const nonGit = join(tmpRoot, 'plain');
    mkdirSync(nonGit, { recursive: true });

    expect(findRepoIdentityPath(nonGit)).toBe(nonGit);
    expect(projectId(nonGit)).toBe(
      createHash('sha256')
        .update(nodePath.resolve(nonGit))
        .digest('hex')
        .slice(0, PROJECT_ID_LENGTH),
    );
  });

  it('malformed .git file: missing gitdir prefix → falls back to realpath(worktreeRoot)', () => {
    // .git is a file (not a directory) with content that doesn't start
    // with "gitdir:": parser returns null, so we fall back to the worktree
    // root. No directory should exist at .git; the file IS the .git entry.
    writeFileSync(join(tmpRoot, '.git'), 'this is not a gitdir pointer\n');

    expect(findRepoIdentityPath(tmpRoot)).toBe(tmpRoot);
    expect(projectId(tmpRoot)).toBe(
      createHash('sha256')
        .update(nodePath.resolve(tmpRoot))
        .digest('hex')
        .slice(0, PROJECT_ID_LENGTH),
    );
  });

  it('missing gitdir target: .git file points at a path that does not exist → fallback', () => {
    writeFileSync(join(tmpRoot, '.git'), `gitdir: ${tmpRoot}/nonexistent/worktrees/wt\n`);

    expect(findRepoIdentityPath(tmpRoot)).toBe(tmpRoot);
  });

  it('unreadable/missing .git file with no .git directory at all: uses realpath(worktreeRoot)', () => {
    // Sanity: when .git does not exist at all (and nothing above either —
    // tmpRoot is its own fresh dir with no .git), the lexical walk falls
    // back to cwd, and identity = realpath(cwd).
    expect(existsSync(join(tmpRoot, '.git'))).toBe(false);
    expect(findRepoIdentityPath(tmpRoot)).toBe(tmpRoot);
  });

  it('commondir with leading/trailing whitespace resolves correctly', () => {
    const main = realTmpDir('enigma-identity-ws-main-');
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '  ../..  \n');

      const wt = realTmpDir('enigma-identity-ws-wt-');
      try {
        writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
        expect(projectId(wt)).toBe(projectId(main));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('commondir given as an absolute path resolves correctly', () => {
    const main = realTmpDir('enigma-identity-abs-main-');
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      // commondir with an absolute path: pass-through via isAbsolute
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), `${main}/.git\n`);

      const wt = realTmpDir('enigma-identity-abs-wt-');
      try {
        writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
        expect(projectId(wt)).toBe(projectId(main));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('does not throw for any input — every error path returns a string', () => {
    // Spot-check a few obviously broken inputs.
    expect(() => findRepoIdentityPath('')).not.toThrow();
    expect(() => findRepoIdentityPath('/nonexistent/path/at/all')).not.toThrow();
    expect(findRepoIdentityPath('/nonexistent/path/at/all')).toBe(
      findProjectPath('/nonexistent/path/at/all'),
    );
  });
});

describe('findProjectPath remains unchanged after the identity split', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realTmpDir('enigma-location-');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a .git file in a linked worktree still resolves the LEXICAL worktree root, not the main clone', () => {
    const main = realTmpDir('enigma-location-main-');
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');

      const wt = realTmpDir('enigma-location-wt-');
      try {
        writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);

        // findProjectPath stays lexical: the .env file lives at the worktree
        // root (wt), not the main clone's root. Identity-vs-location split.
        expect(findProjectPath(wt)).toBe(wt);
        expect(findProjectPath(main)).toBe(main);
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});
