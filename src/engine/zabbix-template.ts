// Zabbix 6.0+ template, generated from the metric table in zabbix.ts so the
// sender and the template can't drift apart.
import crypto from 'node:crypto';
import { INPUT_METRICS, KEY_INPUT_DISCOVERY } from './zabbix.ts';

/** Stable UUIDv4-shaped id derived from a name. */
export function uuidFor(name: string): string {
  const h = crypto.createHash('sha256').update(`towerlog:${name}`).digest('hex').slice(0, 32).split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16], 16) & 3];
  return h.join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const T = 'Towerlog';

const VALUE_TYPE = { char: 'CHAR', text: 'TEXT', uint: 'UNSIGNED', float: 'FLOAT' } as const;
const UNITS: Record<string, string> = { level: 'dBFS' };

interface Trig { id: string; expr: string; name: string; priority: string; desc: string }

function trigXml(t: Trig, tag: 'trigger' | 'trigger_prototype', indent: string): string {
  return `${indent}<${tag}>
${indent}    <uuid>${uuidFor(t.id)}</uuid>
${indent}    <expression>${esc(t.expr)}</expression>
${indent}    <name>${esc(t.name)}</name>
${indent}    <priority>${t.priority}</priority>
${indent}    <description>${esc(t.desc)}</description>
${indent}</${tag}>`;
}

function itemXml(o: {
  id: string; tag: 'item' | 'item_prototype'; name: string; key: string; kind: keyof typeof VALUE_TYPE;
  desc: string; units?: string; valuemap?: boolean; triggers?: Trig[]; indent: string;
}): string {
  const i = o.indent;
  const numeric = o.kind === 'uint' || o.kind === 'float';
  const trigTag = o.tag === 'item' ? 'trigger' : 'trigger_prototype';
  return `${i}<${o.tag}>
${i}    <uuid>${uuidFor(o.id)}</uuid>
${i}    <name>${esc(o.name)}</name>
${i}    <type>TRAP</type>
${i}    <key>${esc(o.key)}</key>
${i}    <delay>0</delay>
${i}    <history>${numeric ? '31d' : '7d'}</history>
${i}    <trends>${numeric ? '365d' : '0'}</trends>
${i}    <value_type>${VALUE_TYPE[o.kind]}</value_type>${o.units ? `\n${i}    <units>${esc(o.units)}</units>` : ''}
${i}    <description>${esc(o.desc)}</description>${o.valuemap ? `\n${i}    <valuemap>\n${i}        <name>Towerlog up/down</name>\n${i}    </valuemap>` : ''}${o.triggers?.length ? `\n${i}    <${trigTag}s>\n${o.triggers.map((t) => trigXml(t, trigTag, i + '        ')).join('\n')}\n${i}    </${trigTag}s>` : ''}
${i}</${o.tag}>`;
}

const LABELS: Record<string, string> = {
  state: 'state', up: 'up', name: 'name', kind: 'type', recording: 'recording', level: 'audio level',
  'fault.link': 'feed lost', 'fault.silence': 'silence', 'fault.clip': 'clipping', 'fault.mono': 'mono', 'fault.phase': 'out of phase',
};

const key = (m: string) => `towerlog.input.${m}[{#INPUT}]`;
const fault = (m: string, label: string, priority: string, desc: string): Trig[] => [{
  id: `ptrig:${m}`, expr: `last(/${T}/${key(`fault.${m}`)})=1`, name: `{#NAME}: ${label}`, priority, desc,
}];

const INPUT_TRIGGERS: Record<string, Trig[]> = {
  'fault.link': fault('link', 'feed lost', 'HIGH', 'The feed stopped delivering audio (stream down, unit offline or network problem). Clears when audio returns.'),
  'fault.silence': fault('silence', 'silence (dead air)', 'HIGH', 'The feed has been silent longer than its alert delay set in Towerlog.'),
  'fault.clip': fault('clip', 'clipping', 'WARNING', 'The audio has been at full scale longer than the clipping delay set in Towerlog.'),
  'fault.mono': fault('mono', 'mono (left and right identical)', 'WARNING', 'Left and right are identical for longer than the delay set in Towerlog.'),
  'fault.phase': fault('phase', 'channels out of phase', 'WARNING', 'Left and right are out of phase for longer than the delay set in Towerlog.'),
};

export function buildTemplate(date = new Date()): string {
  const I = '                ';
  const P = '                        ';
  const globalItems = [
    itemXml({ id: 'item:event', tag: 'item', name: 'Towerlog event', key: 'towerlog.event', kind: 'text', indent: I,
      desc: 'Last fault event pushed by Towerlog (feed lost, silence, clipping, mono, phase, and their clears).' }),
    itemXml({ id: 'item:inputs_live', tag: 'item', name: 'Towerlog inputs live', key: 'towerlog.inputs_live', kind: 'uint', indent: I,
      desc: 'Number of inputs currently delivering audio.',
      triggers: [{ id: 'trigger:no inputs', expr: `last(/${T}/towerlog.inputs_live)=0`, name: 'Towerlog: no inputs live', priority: 'WARNING', desc: 'Zero inputs are currently delivering audio.' }] }),
    itemXml({ id: 'item:heartbeat', tag: 'item', name: 'Towerlog heartbeat', key: 'towerlog.heartbeat', kind: 'uint', indent: I,
      desc: 'Liveness marker sent every Zabbix interval. A missing value means the host or the Towerlog service is down.',
      triggers: [{ id: 'trigger:heartbeat', expr: `nodata(/${T}/towerlog.heartbeat,5m)=1`, name: 'Towerlog heartbeat lost', priority: 'HIGH', desc: 'No heartbeat received for 5 minutes: the host or the Towerlog service is down.' }] }),
  ];
  const protos = Object.entries(INPUT_METRICS).map(([m, [kind, desc]]) => itemXml({
    id: `proto:${m}`, tag: 'item_prototype', name: `{#NAME}: ${LABELS[m] ?? m}`, key: key(m), kind, desc,
    units: UNITS[m], valuemap: m === 'up', triggers: INPUT_TRIGGERS[m], indent: P,
  }));
  const trigs: Trig[] = [
    { id: 'ptrig:recstopped', expr: `last(/${T}/${key('up')})=1 and last(/${T}/${key('recording')})=0`, name: '{#NAME}: live but not recording', priority: 'WARNING', desc: 'The input is delivering audio but is not recording (recording is off or the disk write failed).' },
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<zabbix_export>
    <version>6.0</version>
    <date>${date.toISOString().replace(/\.\d+Z$/, 'Z')}</date>
    <groups>
        <group>
            <uuid>${uuidFor('group:Templates')}</uuid>
            <name>Templates</name>
        </group>
    </groups>
    <templates>
        <template>
            <uuid>${uuidFor('template')}</uuid>
            <template>${T}</template>
            <name>${T}</name>
            <description>Towerlog broadcast audio logger. Data arrives with the Zabbix trapper (zabbix_sender) protocol. Each input is discovered automatically. Attach this template to the Zabbix host whose name matches the Host name set in the Towerlog web UI. Requires Zabbix 6.0 or newer.</description>
            <groups>
                <group>
                    <name>Templates</name>
                </group>
            </groups>
            <items>
${globalItems.join('\n')}
            </items>
            <discovery_rules>
${I}<discovery_rule>
${I}    <uuid>${uuidFor('lld:inputs')}</uuid>
${I}    <name>Towerlog inputs</name>
${I}    <type>TRAP</type>
${I}    <key>${KEY_INPUT_DISCOVERY}</key>
${I}    <delay>0</delay>
${I}    <lifetime>7d</lifetime>
${I}    <description>One entry per input, with macros {#INPUT}, {#NAME}, {#KIND}. Inputs removed from the config are deleted after 7 days.</description>
${I}    <item_prototypes>
${protos.join('\n')}
${I}    </item_prototypes>
${I}    <trigger_prototypes>
${trigs.map((t) => trigXml(t, 'trigger_prototype', P)).join('\n')}
${I}    </trigger_prototypes>
${I}</discovery_rule>
            </discovery_rules>
            <valuemaps>
                <valuemap>
                    <uuid>${uuidFor('valuemap')}</uuid>
                    <name>Towerlog up/down</name>
                    <mappings>
                        <mapping>
                            <value>0</value>
                            <newvalue>Down</newvalue>
                        </mapping>
                        <mapping>
                            <value>1</value>
                            <newvalue>Up</newvalue>
                        </mapping>
                    </mappings>
                </valuemap>
            </valuemaps>
        </template>
    </templates>
</zabbix_export>
`;
}
