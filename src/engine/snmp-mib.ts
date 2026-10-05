// The TOWERLOG-MIB: one definition drives the SNMP agent's providers, the trap
// varbinds and the MIB file users load into their NMS (/api/snmp/mib).
//
// 99999 is a placeholder private enterprise number. Register a real one with IANA
// (https://pen.iana.org) before deploying widely; it is this one constant.
export const ENTERPRISE = 99999;
export const ROOT = `1.3.6.1.4.1.${ENTERPRISE}`;
export const OBJECTS = `${ROOT}.1`;
export const NOTIFICATIONS = `${ROOT}.2.0`;

/** SMI types used here (map to net-snmp ObjectType names). */
export type SmiType = 'OctetString' | 'Integer' | 'Gauge' | 'Counter' | 'TimeTicks';

export interface ColumnDef {
  n: number;
  name: string;
  type: SmiType;
  desc: string;
  /** Enumerated INTEGER values. */
  enums?: Record<string, number>;
  /** Index column: not readable (MAX-ACCESS not-accessible). */
  index?: boolean;
}

export const BOOL = { false: 0, true: 1 };
export const KIND = { http: 1, rtp: 2, livewire: 3, push: 4 };
export const STATUS = { stopped: 1, connecting: 2, live: 3, down: 4 };
export const SEVERITY = { info: 1, warning: 2, critical: 3, cleared: 4 };
/** Levels and dB values are tenths; this means "no value" (no signal, not measured). */
export const NO_VALUE = -9999;

/** towerlogSystem (.1.1): scalars. */
export const SYSTEM: ColumnDef[] = [
  { n: 1, name: 'towerlogVersion', type: 'OctetString', desc: 'Towerlog software version' },
  { n: 2, name: 'towerlogUptime', type: 'TimeTicks', desc: 'Time since the Towerlog service started' },
  { n: 3, name: 'towerlogInputsTotal', type: 'Integer', desc: 'Number of configured inputs' },
  { n: 4, name: 'towerlogInputsLive', type: 'Integer', desc: 'Number of inputs delivering audio' },
  { n: 5, name: 'towerlogInputsFaulted', type: 'Integer', desc: 'Number of inputs with at least one raised fault' },
  { n: 6, name: 'towerlogHostname', type: 'OctetString', desc: 'Host name of the Towerlog server' },
  { n: 7, name: 'towerlogEasActive', type: 'Integer', enums: BOOL, desc: 'true while an EAS attention tone is being heard on any input' },
  { n: 8, name: 'towerlogEasLastText', type: 'OctetString', desc: 'Last EAS tone or message heard, as text' },
];

/** towerlogInputTable (.1.2), INDEX { towerlogInputIndex }. */
export const INPUT_COLUMNS: ColumnDef[] = [
  { n: 1, name: 'towerlogInputIndex', type: 'Integer', index: true, desc: 'Row number (configuration order, from 1)' },
  { n: 2, name: 'towerlogInputId', type: 'OctetString', desc: 'Input id (as used in the API and Zabbix keys)' },
  { n: 3, name: 'towerlogInputName', type: 'OctetString', desc: 'Input name' },
  { n: 4, name: 'towerlogInputKind', type: 'Integer', enums: KIND, desc: 'http (Icecast, Shoutcast, Barix, Inovonics), rtp, livewire or push (Icecast source client)' },
  { n: 5, name: 'towerlogInputStatus', type: 'Integer', enums: STATUS, desc: 'Connection state' },
  { n: 6, name: 'towerlogInputUp', type: 'Integer', enums: BOOL, desc: 'true while the feed is delivering audio' },
  { n: 7, name: 'towerlogInputLevelLeft', type: 'Integer', desc: 'Left RMS level, tenths of dBFS (-9999 = no audio)' },
  { n: 8, name: 'towerlogInputLevelRight', type: 'Integer', desc: 'Right RMS level, tenths of dBFS (-9999 = no audio)' },
  { n: 9, name: 'towerlogInputSilentSecs', type: 'Gauge', desc: 'Seconds the feed has been below the silence level, 0 when not silent' },
  { n: 10, name: 'towerlogInputFaultLink', type: 'Integer', enums: BOOL, desc: 'true while the feed is lost' },
  { n: 11, name: 'towerlogInputFaultSilence', type: 'Integer', enums: BOOL, desc: 'true while the silence alert is raised' },
  { n: 12, name: 'towerlogInputFaultClip', type: 'Integer', enums: BOOL, desc: 'true while the clipping alert is raised' },
  { n: 13, name: 'towerlogInputFaultMono', type: 'Integer', enums: BOOL, desc: 'true while the mono alert is raised' },
  { n: 14, name: 'towerlogInputFaultPhase', type: 'Integer', enums: BOOL, desc: 'true while the out-of-phase alert is raised' },
  { n: 15, name: 'towerlogInputRecording', type: 'Integer', enums: BOOL, desc: 'true while the input is recording to disk' },
  { n: 16, name: 'towerlogInputChunkMinutes', type: 'Integer', desc: 'Minutes per recording file (15, 30 or 60)' },
  { n: 17, name: 'towerlogInputDetail', type: 'OctetString', desc: 'Detail of the current state (for example the error when down)' },
  { n: 18, name: 'towerlogInputEasTone', type: 'Integer', enums: BOOL, desc: 'true while the EAS attention tone is heard on this input' },
];

/** towerlogEasLast (.1.4): the last decoded EAS/SAME message. */
export const EAS_LAST: ColumnDef[] = [
  { n: 1, name: 'towerlogEasLastEvent', type: 'OctetString', desc: 'SAME event code, e.g. TOR' },
  { n: 2, name: 'towerlogEasLastEventName', type: 'OctetString', desc: 'Event name, e.g. Tornado Warning' },
  { n: 3, name: 'towerlogEasLastAreas', type: 'OctetString', desc: 'Areas (state + county FIPS)' },
  { n: 4, name: 'towerlogEasLastSender', type: 'OctetString', desc: 'Sending station, e.g. KEAX/NWS' },
  { n: 5, name: 'towerlogEasLastHeard', type: 'OctetString', desc: 'When it was heard (ISO 8601)' },
  { n: 6, name: 'towerlogEasLastInput', type: 'OctetString', desc: 'Name of the input it was heard on' },
  { n: 7, name: 'towerlogEasLastRaw', type: 'OctetString', desc: 'Raw SAME header' },
];

/** towerlogTrapObjects (.1.5): varbinds carried by every notification (accessible-for-notify). */
export const TRAP_OBJECTS: ColumnDef[] = [
  { n: 1, name: 'towerlogTrapInputId', type: 'OctetString', desc: 'Input id the notification is about (empty for service events)' },
  { n: 2, name: 'towerlogTrapInputName', type: 'OctetString', desc: 'Input name' },
  { n: 3, name: 'towerlogTrapText', type: 'OctetString', desc: 'Human-readable description' },
  { n: 4, name: 'towerlogTrapSeverity', type: 'Integer', enums: SEVERITY, desc: 'Severity of the event' },
];

export const sysOid = (n: number) => `${OBJECTS}.1.${n}`;
export const inputTableOid = `${OBJECTS}.2`;
export const easOid = (n: number) => `${OBJECTS}.4.${n}`;
export const trapObjOid = (n: number) => `${OBJECTS}.5.${n}`;

export type TrapCategory = 'input' | 'eas' | 'disk' | 'service' | 'heartbeat' | 'test';

export interface TrapDef { n: number; name: string; category: TrapCategory; severity: keyof typeof SEVERITY; desc: string; eas?: boolean }

/** Notifications (.2.0.N). */
export const TRAPS = {
  inputFault: { n: 1, name: 'towerlogInputFault', category: 'input', severity: 'critical', desc: 'A logged input has a fault: feed lost, silence, clipping, mono or out of phase (the text says which)' },
  inputCleared: { n: 2, name: 'towerlogInputCleared', category: 'input', severity: 'cleared', desc: 'A fault on a logged input cleared' },
  diskLow: { n: 3, name: 'towerlogDiskLow', category: 'disk', severity: 'warning', desc: 'Free space for recordings is below the alert level' },
  diskOk: { n: 4, name: 'towerlogDiskOk', category: 'disk', severity: 'cleared', desc: 'Free space for recordings recovered' },
  serviceStarted: { n: 5, name: 'towerlogServiceStarted', category: 'service', severity: 'info', desc: 'The Towerlog service started' },
  serviceStopped: { n: 6, name: 'towerlogServiceStopped', category: 'service', severity: 'warning', desc: 'The Towerlog service is stopping' },
  heartbeat: { n: 7, name: 'towerlogHeartbeat', category: 'heartbeat', severity: 'info', desc: 'Periodic heartbeat (if enabled)' },
  test: { n: 8, name: 'towerlogTestNotification', category: 'test', severity: 'info', desc: 'Sent by "Send test trap" in the web UI' },
  easTone: { n: 9, name: 'towerlogEasTone', category: 'eas', severity: 'critical', desc: 'The EAS attention tone was heard on an input' },
  easMessage: { n: 10, name: 'towerlogEasMessage', category: 'eas', severity: 'warning', eas: true, desc: 'An EAS/SAME header was decoded; the towerlogEasLast objects are included' },
} satisfies Record<string, TrapDef>;
export type TrapName = keyof typeof TRAPS;
export const trapOid = (t: TrapName) => `${NOTIFICATIONS}.${TRAPS[t].n}`;

// ------------------------------------------------------------------ MIB file

const SMI: Record<SmiType, string> = { OctetString: 'DisplayString', Integer: 'Integer32', Gauge: 'Gauge32', Counter: 'Counter32', TimeTicks: 'TimeTicks' };

function syntax(c: ColumnDef): string {
  if (c.enums) return `INTEGER { ${Object.entries(c.enums).map(([k, v]) => `${k}(${v})`).join(', ')} }`;
  return SMI[c.type];
}
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function objectType(c: ColumnDef, parent: string, access: string): string {
  return `${c.name} OBJECT-TYPE
    SYNTAX      ${syntax(c)}
    MAX-ACCESS  ${c.index ? 'not-accessible' : access}
    STATUS      current
    DESCRIPTION ${quote(c.desc)}
    ::= { ${parent} ${c.n} }
`;
}

function table(name: string, n: number, entry: string, indexes: string[], cols: ColumnDef[], desc: string): string {
  const entryType = cap(entry);
  return `${name} OBJECT-TYPE
    SYNTAX      SEQUENCE OF ${entryType}
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION ${quote(desc)}
    ::= { towerlogObjects ${n} }

${entry} OBJECT-TYPE
    SYNTAX      ${entryType}
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION ${quote(`A row of ${name}`)}
    INDEX       { ${indexes.join(', ')} }
    ::= { ${name} 1 }

${entryType} ::= SEQUENCE {
${cols.map((c) => `    ${c.name.padEnd(32)} ${c.enums ? 'INTEGER' : SMI[c.type]}`).join(',\n')}
}

${cols.map((c) => objectType(c, entry, 'read-only')).join('\n')}`;
}

/** The TOWERLOG-MIB as SMIv2 text. */
export function buildMib(): string {
  const all = [...SYSTEM, ...INPUT_COLUMNS, ...EAS_LAST, ...TRAP_OBJECTS].map((c) => c.name);
  const traps = Object.values(TRAPS) as TrapDef[];
  return `TOWERLOG-MIB DEFINITIONS ::= BEGIN

-- Towerlog: broadcast audio logger (Icecast, RTP, Livewire, Barix, Inovonics) monitoring.
-- Enterprise ${ENTERPRISE} is a placeholder private enterprise number.

IMPORTS
    MODULE-IDENTITY, OBJECT-TYPE, NOTIFICATION-TYPE, enterprises,
    Integer32, Gauge32, Counter32, TimeTicks          FROM SNMPv2-SMI
    DisplayString                                     FROM SNMPv2-TC
    MODULE-COMPLIANCE, OBJECT-GROUP, NOTIFICATION-GROUP FROM SNMPv2-CONF;

towerlog MODULE-IDENTITY
    LAST-UPDATED "202610050000Z"
    ORGANIZATION "Towerlog"
    CONTACT-INFO "https://github.com/thetylerwoodwardproject/towerlog"
    DESCRIPTION  "Status of Towerlog inputs, and notifications for lost feeds, silence, clipping, mono and phase faults and EAS alerts."
    REVISION     "202610050000Z"
    DESCRIPTION  "Added the EAS objects (towerlogEasLast, towerlogEasActive, towerlogInputEasTone) and the towerlogEasTone and towerlogEasMessage notifications."
    REVISION     "202610040000Z"
    DESCRIPTION  "First version."
    ::= { enterprises ${ENTERPRISE} }

towerlogObjects       OBJECT IDENTIFIER ::= { towerlog 1 }
towerlogNotifyPrefix  OBJECT IDENTIFIER ::= { towerlog 2 }
towerlogNotifications OBJECT IDENTIFIER ::= { towerlogNotifyPrefix 0 }
towerlogConformance   OBJECT IDENTIFIER ::= { towerlog 3 }
towerlogSystem        OBJECT IDENTIFIER ::= { towerlogObjects 1 }
towerlogEasLast       OBJECT IDENTIFIER ::= { towerlogObjects 4 }
towerlogTrapObjects   OBJECT IDENTIFIER ::= { towerlogObjects 5 }

${SYSTEM.map((c) => objectType(c, 'towerlogSystem', 'read-only')).join('\n')}
${table('towerlogInputTable', 2, 'towerlogInputEntry', ['towerlogInputIndex'], INPUT_COLUMNS, 'One row per configured input')}
${EAS_LAST.map((c) => objectType(c, 'towerlogEasLast', 'read-only')).join('\n')}
${TRAP_OBJECTS.map((c) => objectType(c, 'towerlogTrapObjects', 'accessible-for-notify')).join('\n')}
${traps.map((t) => `${t.name} NOTIFICATION-TYPE
    OBJECTS     { towerlogTrapInputId, towerlogTrapInputName, towerlogTrapText, towerlogTrapSeverity${t.eas ? ',\n                  ' + EAS_LAST.map((c) => c.name).join(', ') : ''} }
    STATUS      current
    DESCRIPTION ${quote(t.desc)}
    ::= { towerlogNotifications ${t.n} }
`).join('\n')}
towerlogCompliances OBJECT IDENTIFIER ::= { towerlogConformance 1 }
towerlogGroups      OBJECT IDENTIFIER ::= { towerlogConformance 2 }

towerlogCompliance MODULE-COMPLIANCE
    STATUS      current
    DESCRIPTION "Towerlog agents implement every object and notification."
    MODULE
        MANDATORY-GROUPS { towerlogObjectGroup, towerlogNotificationGroup }
    ::= { towerlogCompliances 1 }

towerlogObjectGroup OBJECT-GROUP
    OBJECTS     { ${all.filter((n) => !/Index$/.test(n)).join(',\n                  ')} }
    STATUS      current
    DESCRIPTION "All Towerlog objects."
    ::= { towerlogGroups 1 }

towerlogNotificationGroup NOTIFICATION-GROUP
    NOTIFICATIONS { ${traps.map((t) => t.name).join(',\n                    ')} }
    STATUS      current
    DESCRIPTION "All Towerlog notifications."
    ::= { towerlogGroups 2 }

END
`;
}
