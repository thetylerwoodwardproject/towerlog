// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import towerlog from './scripts/dev-engine.mjs';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [svelte(), towerlog()],
  server: { host: true, port: 4321 },
  security: { checkOrigin: true },
  devToolbar: { enabled: false },
  // dev/rig/build holds the test rig's tool builds: nothing for Vite to watch.
  vite: { plugins: [tailwindcss()], server: { watch: { ignored: ['**/dev/rig/build/**'] } } },
});
