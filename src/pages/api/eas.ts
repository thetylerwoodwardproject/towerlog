import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../lib/server/engine.ts';

/** EAS tones and decoded SAME messages, newest first. ?input=<id>&limit=N, or ?format=csv */
export const GET: APIRoute = ({ url }) => handle(() => {
  const e = getEngine();
  const list = e.easLog.list({ input: url.searchParams.get('input') || undefined, limit: Math.min(2000, Number(url.searchParams.get('limit')) || 500) });
  if (url.searchParams.get('format') !== 'csv') return list;
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['received', 'input', 'kind', 'originator', 'event', 'event_name', 'areas', 'duration_min', 'issued', 'sender', 'eom', 'recording_chunk_start', 'raw'].join(',')];
  for (const m of list) {
    const chunk = m.chunk_start ? new Date(m.chunk_start * 1000).toISOString() : '';
    rows.push([m.received, m.input_name, m.kind, m.originator, m.event, m.event_name, (m.locations ?? []).map((l) => l.code).join(' '), m.duration_min, m.issued, m.sender, m.eom ?? '', chunk, m.raw].map(q).join(','));
  }
  return new Response(rows.join('\n') + '\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="towerlog-eas-log.csv"' } });
});
