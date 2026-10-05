// Astro integration for `npm run dev`: runs the real engine inside the Vite dev
// server (loaded through Vite so TypeScript just works) and serves /ws.
// Paths default to ./.dev/ unless TOWERLOG_CONFIG / TOWERLOG_DATA / TOWERLOG_LOG_DIR are set.
import path from 'node:path';

export default function towerlog() {
  return {
    name: 'towerlog-engine',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const root = process.cwd();
        process.env.TOWERLOG_CONFIG ||= path.join(root, '.dev/config.json');
        process.env.TOWERLOG_DATA ||= path.join(root, '.dev/data');
        process.env.TOWERLOG_LOG_DIR ||= path.join(root, '.dev/logs');
        const { createEngine } = await server.ssrLoadModule('/src/engine/index.ts');
        const { attachWebSocket } = await server.ssrLoadModule('/server/ws.ts');
        const { handleListen } = await server.ssrLoadModule('/server/listen.ts');
        const engine = createEngine();
        server.middlewares.use((req, res, next) => { if (!handleListen(engine, req, res)) next(); });
        if (server.httpServer) attachWebSocket(server.httpServer, engine);
        await engine.start();
      },
    },
  };
}
