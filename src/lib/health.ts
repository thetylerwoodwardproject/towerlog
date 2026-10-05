// Service health rows (source port, Zabbix, Email, SNMP) for the sidebar and phone menu.
import type { ServiceStatus } from './types.ts';
import { fmtAgo } from './format.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export interface Health { name: string; state: string; tone: Tone; title: string }

export function serviceHealth(s: ServiceStatus): Health[] {
  const zbxBad = s.zabbix.enabled && !!s.zabbix.last_error_at && (!s.zabbix.last_ok || s.zabbix.last_error_at > s.zabbix.last_ok);
  const mailBad = s.smtp.enabled && !!s.smtp.last_error_at && (!s.smtp.last_sent || s.smtp.last_error_at > s.smtp.last_sent);
  return [
    {
      name: 'Encoder port',
      state: s.source.enabled ? `:${s.source.port}` : 'off',
      tone: s.source.enabled ? 'ok' : 'muted',
      title: s.source.enabled ? `Encoders can send to Towerlog on port ${s.source.port} · ${s.source.push_inputs} encoder input(s)` : 'Receiving from encoders is turned off',
    },
    {
      name: 'Zabbix',
      state: !s.zabbix.enabled ? 'off' : zbxBad ? 'error' : s.zabbix.last_ok ? 'ok' : 'waiting',
      tone: !s.zabbix.enabled ? 'muted' : zbxBad ? 'bad' : s.zabbix.last_ok ? 'ok' : 'warn',
      title: s.zabbix.enabled ? `${s.zabbix.server} · last accepted ${fmtAgo(s.zabbix.last_ok)}${s.zabbix.last_error ? ' · ' + s.zabbix.last_error : ''}` : 'Zabbix is turned off',
    },
    {
      name: 'Email',
      state: !s.smtp.enabled ? 'off' : mailBad ? 'error' : 'on',
      tone: !s.smtp.enabled ? 'muted' : mailBad ? 'bad' : 'ok',
      title: s.smtp.enabled ? `last sent ${fmtAgo(s.smtp.last_sent)}${s.smtp.last_error ? ' · ' + s.smtp.last_error : ''}` : s.smtp.problem,
    },
    {
      name: 'SNMP',
      state: !s.snmp?.enabled ? 'off' : s.snmp.error ? 'error' : snmpTrapBad(s) ? 'trap error' : 'on',
      tone: !s.snmp?.enabled ? 'muted' : s.snmp.error || snmpTrapBad(s) ? 'bad' : 'ok',
      title: !s.snmp?.enabled ? 'SNMP is turned off' : s.snmp.error || `agent ${s.snmp.listening ? 'listening' : 'starting'} · ${s.snmp.requests} requests · ${s.snmp.traps_sent} traps sent${s.snmp.last_trap_error ? ' · ' + s.snmp.last_trap_error : ''}`,
    },
  ];
}

const snmpTrapBad = (s: ServiceStatus) => !!s.snmp.last_trap_error_at && (!s.snmp.last_trap || s.snmp.last_trap_error_at > s.snmp.last_trap);
