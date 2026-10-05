// Minimal typings for the parts of net-snmp Towerlog uses (the package ships none).
declare module 'net-snmp' {
  type Callback<T = unknown> = (error: Error | null, data?: T) => void;
  export interface Varbind { oid: string; type: number; value: unknown }
  export interface User { name: string; level: number; authProtocol?: number; authKey?: string; privProtocol?: number; privKey?: string }
  export interface Mib {
    registerProvider(def: Record<string, unknown>): void;
    setScalarValue(name: string, value: unknown): void;
    addTableRow(name: string, row: unknown[]): void;
    setTableSingleCell(name: string, column: number, rowIndex: number[], value: unknown): void;
    deleteTableRow(name: string, rowIndex: number[]): void;
  }
  export interface Authorizer {
    addCommunity(c: string): void;
    addUser(u: User): void;
    getAccessControlModel(): { setCommunityAccess(c: string, l: number): void; setUserAccess(u: string, l: number): void };
  }
  export interface Agent {
    getMib(): Mib;
    getAuthorizer(): Authorizer;
    close(cb?: () => void): void;
    onMsg(socket: unknown, buffer: Buffer, rinfo: { address: string; port: number }): void;
    listener: { sockets: Record<string, import('node:dgram').Socket> };
  }
  export interface Session {
    trap(oid: string, varbinds: Varbind[], options: Record<string, unknown>, cb: (error: Error | null) => void): void;
    get(oids: string[], cb: Callback<Varbind[]>): void;
    set(varbinds: Varbind[], cb: Callback<Varbind[]>): void;
    walk(oid: string, maxRep: number, feed: (vbs: Varbind[]) => void, done: (error: Error | null) => void): void;
    close(): void;
    on(ev: 'error', cb: (e: Error) => void): void;
  }
  export interface Receiver { close(cb?: () => void): void; getAuthorizer(): Authorizer }
  export const ObjectType: Record<string, number>;
  export const MibProviderType: { Scalar: string; Table: string };
  export const MaxAccess: Record<string, number>;
  export const AccessLevel: { None: number; ReadOnly: number; ReadWrite: number };
  export const AccessControlModelType: { None: number; Simple: number };
  export const SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number };
  export const AuthProtocols: Record<string, number>;
  export const PrivProtocols: Record<string, number>;
  export const Version2c: number;
  export const Version3: number;
  export function createAgent(options: Record<string, unknown>, cb: Callback, mib?: Mib): Agent;
  export function createSession(target: string, community: string, options?: Record<string, unknown>): Session;
  export function createV3Session(target: string, user: User, options?: Record<string, unknown>): Session;
  export function createReceiver(options: Record<string, unknown>, cb: Callback<{ pdu: { type: number; varbinds: Varbind[] }; rinfo: unknown }>): Receiver;
  export function isVarbindError(vb: Varbind): boolean;
  const snmp: typeof import('net-snmp');
  export default snmp;
}
