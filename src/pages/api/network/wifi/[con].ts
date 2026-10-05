import type { APIRoute } from 'astro';
import { handle } from '../../../../lib/server/engine.ts';
import { getNetwork } from '../../../../lib/server/network.ts';

export const DELETE: APIRoute = ({ params }) => handle(() => getNetwork().wifiForget(String(params.con)));
