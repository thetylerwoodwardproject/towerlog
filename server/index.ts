// Production entry point (bundled to dist/towerlog.mjs): starts the engine, then
// serves the built Astro app and the /ws live feed from one HTTP server.
import http from 'node:http';
import { createEngine } from '../src/engine/index.ts';
import { attachWebSocket } from './ws.ts';
import { runCli } from './cli.ts';
import { makeAllow } from '../src/engine/allow.ts';
import { handleListen } from './listen.ts';
import { createSourceServer } from './source.ts';
import { ConfigUnreadableError } from '../src/engine/config.ts';

/** EX_CONFIG: towerlog.service doesn't restart on it (RestartPreventExitStatus). */
const EXIT_CONFIG = 78;

function configError(e: unknown): never {
  if (!(e instanceof ConfigUnreadableError)) throw e;
  console.error(`Towerlog: ${e.message}`);
  process.exit(EXIT_CONFIG);
}

if (process.argv[2]) process.exit(await runCli(process.argv.slice(2)).catch(configError));

process.env.ASTRO_NODE_AUTOSTART = 'disabled';

let engine: ReturnType<typeof createEngine>;
try {
  engine = createEngine();
} catch (e) {
  configError(e);
}
const entry = new URL('./server/entry.mjs', import.meta.url).href;
const { handler } = (await import(entry)) as {
  handler: (req: http.IncomingMessage, res: http.ServerResponse, next?: (e?: unknown) => void) => void;
};

const web = engine.config.web;
const port = Number(process.env.PORT) || web.port;
const host = process.env.HOST || web.bind;

const allow = makeAllow(process.env.TOWERLOG_ALLOW);
if (allow) engine.log.info(`web UI restricted to ${process.env.TOWERLOG_ALLOW}`);

const denied = new Map<string, number>();
const server = http.createServer((req, res) => {
  if (allow && !allow(req.socket.remoteAddress)) {
    const ip = req.socket.remoteAddress ?? '?';
    if (Date.now() - (denied.get(ip) ?? 0) > 60000) {
      denied.set(ip, Date.now());
      engine.log.warn(`web UI: refused ${ip} (not in TOWERLOG_ALLOW)`);
    }
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden\n');
    return;
  }
  // A throw here would be uncaught and take every station down with it.
  try {
    if (handleListen(engine, req, res)) return;
    handler(req, res, (err?: unknown) => {
      if (err) engine.log.error(`http: ${String(err)}`);
      if (!res.headersSent) res.writeHead(err ? 500 : 404);
      res.end();
    });
  } catch (e) {
    engine.log.error(`http: ${(e as Error).stack || e}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
attachWebSocket(server, engine, allow);

server.listen(port, host, () => {
  engine.log.info(`web UI listening on http://${host}:${port}`);
});

// Icecast source endpoint: Towerlogs and other source clients push streams here.
const src = engine.config.source;
if (src.enabled) {
  const sourceServer = createSourceServer({ find: (m) => engine.pushInput(m), log: engine.log });
  sourceServer.on('error', (e) => engine.log.error(`source endpoint on port ${src.port}: ${e.message}`));
  sourceServer.listen(src.port, src.bind, () => engine.log.info(`Icecast source endpoint listening on ${src.bind}:${src.port}`));
}

await engine.start();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  engine.log.info(`received ${signal}, shutting down`);
  server.close();
  const force = setTimeout(() => process.exit(1), 20000);
  await engine.shutdown();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGHUP', () => {
  engine.log.info('received SIGHUP, restarting inputs');
  void engine.restartInputs();
});
process.on('unhandledRejection', (e) => engine.log.error(`unhandled rejection: ${(e as Error)?.stack || e}`));
