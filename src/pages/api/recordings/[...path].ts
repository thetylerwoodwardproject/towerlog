import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { APIRoute } from 'astro';
import { getEngine } from '../../../lib/server/engine.ts';

const TYPES: Record<string, string> = { '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.flac': 'audio/flac', '.mka': 'audio/x-matroska' };

/**
 * One recording (or RBDS.log) from the recordings folder. Plays inline with
 * HTTP Range support (so the browser player can seek); ?download=1 saves it.
 */
export const GET: APIRoute = ({ params, request, url }) => {
  const file = getEngine().recordingFile(params.path ?? '');
  if (!file) return new Response('not found', { status: 404 });
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = {
    'Content-Type': TYPES[path.extname(file)] ?? 'text/plain; charset=utf-8',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${path.basename(file)}"`,
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, 'Content-Length': String(size) } });
};
