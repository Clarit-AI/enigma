import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

describe('.github/workflows/release.yml', () => {
  it('triggers on v* tag pushes', () => {
    expect(workflow).toMatch(/tags:\s*\[['"]v\*['"]\]/);
  });

  it('does not trigger on the plugin release tag format (enigma--v*)', () => {
    // claude plugin tag creates `enigma--v<version>`, which must never also
    // kick off an npm publish attempt — see RELEASING.md.
    expect(workflow).not.toMatch(/enigma--v/);
  });

  it('runs the build', () => {
    expect(workflow).toMatch(/run:\s*npm run build/);
  });

  it('verifies committed dist matches the build, with a message naming the release as aborted', () => {
    expect(workflow).toMatch(/git status --porcelain plugins\/enigma\/dist/);
    expect(workflow).toMatch(/Release aborted.*plugins\/enigma\/dist does not match its committed source/);
  });

  it('publishes with --provenance', () => {
    expect(workflow).toMatch(/npm publish --provenance/);
  });

  it('keeps the publish step an unconditional, hardcoded dry run', () => {
    expect(workflow).toMatch(/npm publish --provenance --dry-run/);
    // Never conditional on a secret being present — see RELEASING.md's
    // "why" for making this explicit rather than an accidental live publish.
    expect(workflow).not.toMatch(/if:\s*.*secrets\.NPM_TOKEN/);
  });

  it('grants id-token write for provenance', () => {
    expect(workflow).toMatch(/id-token:\s*write/);
  });
});
