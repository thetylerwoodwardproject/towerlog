// Command-line helpers used by the installer and for troubleshooting:
//
//   node dist/towerlog.mjs init [--source-port P]
//        create the config if missing; the port is only applied to a new config
//   node dist/towerlog.mjs set-password          read a new web UI password from stdin
//   node dist/towerlog.mjs has-password          exit 0 if a web UI password is set
//   node dist/towerlog.mjs check                 print config problems, tools and inputs
//   node dist/towerlog.mjs test-email [ADDRESS]  send a test email with the saved settings
//   node dist/towerlog.mjs zabbix-template       print the Zabbix template XML
//   node dist/towerlog.mjs snmp-mib              print the TOWERLOG-MIB
import fs from 'node:fs';
import { Engine, VERSION } from '../src/engine/index.ts';
import { defaultPaths } from '../src/engine/config.ts';
import { buildTemplate } from '../src/engine/zabbix-template.ts';
import { buildMib } from '../src/engine/snmp-mib.ts';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const paths = defaultPaths();
  switch (cmd) {
    case 'init': {
      const existed = fs.existsSync(paths.config);
      const engine = new Engine(paths);
      const port = arg(args, '--source-port');
      if (!existed && port) engine.store.update((c) => { c.source.port = Number(port); });
      console.log(`${existed ? 'kept' : 'created'} ${paths.config} (${engine.config.inputs.length} input(s))`);
      for (const p of engine.store.problems) console.log(`warning: ${p}`);
      return 0;
    }
    case 'set-password': {
      const pw = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      const engine = new Engine(paths);
      engine.setPassword(pw);
      console.log('web UI password set');
      return 0;
    }
    case 'has-password': {
      return new Engine(paths).hasPassword ? 0 : 1;
    }
    case 'check': {
      const engine = new Engine(paths);
      console.log(`Towerlog ${VERSION}`);
      console.log(`config: ${paths.config}`);
      for (const p of engine.store.problems) console.log(`  problem: ${p}`);
      const c = engine.config;
      console.log(`source endpoint: ${c.source.enabled ? `${c.source.bind}:${c.source.port}` : 'disabled'}`);
      console.log(`zabbix: ${c.zabbix.enabled ? `${c.zabbix.server}:${c.zabbix.port} as ${c.zabbix.hostname}` : 'disabled'}`);
      console.log(`email: ${engine.mailer.enabled ? `${c.smtp.host}:${c.smtp.port} (${c.smtp.security}) to ${c.smtp.to}` : `disabled (${engine.mailer.problem()})`}`);
      console.log('tools:');
      for (const [k, v] of Object.entries(engine.toolPaths)) console.log(`  ${k.padEnd(8)} ${v ?? 'MISSING'}`);
      console.log('inputs:');
      for (const i of c.inputs) {
        const where = i.kind === 'http' ? i.url : i.kind === 'rtp' ? `${i.address || 'any'}:${i.port}` : i.kind === 'livewire' ? `channel ${i.livewire_channel}` : i.mount;
        console.log(`  ${i.id}: ${i.name} · ${i.kind} ${where} · ${i.record ? `${i.chunk_minutes}-minute files` : 'not recording'}${i.enabled ? '' : ' (disabled)'}`);
      }
      return engine.store.problems.length || !engine.toolPaths.ffmpeg ? 1 : 0;
    }
    case 'zabbix-template': {
      process.stdout.write(buildTemplate());
      return 0;
    }
    case 'snmp-mib': {
      process.stdout.write(buildMib());
      return 0;
    }
    case 'test-email': {
      const engine = new Engine(paths);
      try {
        const to = await engine.testEmail(args[0]);
        console.log(`test email sent to ${to.join(', ')}`);
        return 0;
      } catch (e) {
        console.log(`test email FAILED: ${(e as Error).message}`);
        return 1;
      }
    }
    default:
      console.log('usage: towerlog.mjs [init|set-password|has-password|check|test-email [ADDRESS]|zabbix-template|snmp-mib]');
      return 2;
  }
}
