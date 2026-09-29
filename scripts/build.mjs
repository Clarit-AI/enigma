#!/usr/bin/env node
import { chmodSync, readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const OUT_DIR = 'plugins/enigma/dist';

// Embedded in every bundle as `ENIGMA_VERSION` (src/core/version.ts).
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const entries = [
  { name: 'mcp-server', entry: 'src/mcp/server.ts' },
  { name: 'hooks', entry: 'src/hooks/index.ts' },
  { name: 'cli', entry: 'src/cli/index.ts', executable: true },
];

for (const { name, entry, executable } of entries) {
  const outfile = `${OUT_DIR}/${name}.mjs`;
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    loader: { '.html': 'text' },
    define: { __ENIGMA_VERSION__: JSON.stringify(version) },
    ...(executable ? { banner: { js: '#!/usr/bin/env node' } } : {}),
  });
  if (executable) chmodSync(outfile, 0o755);
}
