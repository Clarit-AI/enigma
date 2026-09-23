// Probe entry bundled by test/integration/native-artifact-resolution.test.ts.
// esbuild inlines the real src/ modules — including native-lock.ts — into a
// single .mjs the test then copies into arbitrary layouts, so the spawned
// process exercises the loader's artifact resolution exactly as an installed
// bundle would. Prints "MUTATED" when the locked write went through or
// "ERROR <code>" when it refused, so the parent can tell a foreign-addon
// load apart from a clean refusal without parsing stack text.
import { mutateIndex, upsertIndexEntry } from '../../src/core/index-store.js';

try {
  mutateIndex((cur) =>
    upsertIndexEntry(cur, {
      name: 'PROBE',
      scope: 'global',
      depository: 'encrypted',
      ref: 'global/PROBE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  process.stdout.write('MUTATED\n');
} catch (err) {
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  process.stdout.write(`ERROR ${code}\n`);
  process.exit(3);
}
