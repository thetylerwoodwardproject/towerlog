// One NetworkManagerCtl for the API routes (lives beside the engine, not inside it).
import { NetworkManagerCtl } from '../../engine/network.ts';
import { getEngine } from './engine.ts';

let ctl: NetworkManagerCtl | null = null;
export function getNetwork(): NetworkManagerCtl {
  return (ctl ??= new NetworkManagerCtl(getEngine().log));
}
