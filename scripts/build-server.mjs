// Bundles server/index.ts (engine + HTTP/WebSocket server) to dist/towerlog.mjs, and
// the root network helper (src/engine/netapply.ts) to dist/towerlog-netapply.mjs.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/engine/netapply.ts'],
  outfile: 'dist/towerlog-netapply.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'info',
});

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/towerlog.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
