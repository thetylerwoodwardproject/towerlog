<script lang="ts">
  // EAS tones and decoded SAME messages as a table; a row opens the full message in a side sheet.
  import Download from '@lucide/svelte/icons/download';
  import Copy from '@lucide/svelte/icons/copy';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { attempt, get } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import Shell from './shell/Shell.svelte';
  import StatusBadge, { type Tone } from './common/StatusBadge.svelte';
  import FormSelect from './common/FormSelect.svelte';

  type Loc = { code: string; part: string; state: string; county: string };
  type Entry = {
    id: string; kind: 'message' | 'tone'; received: string; input: string; input_name: string;
    chunk_start: number; chunk_minutes: number;
    originator?: string; originator_name?: string; event?: string; event_name?: string; locations?: Loc[];
    duration_min?: number; issued?: string; sender?: string; summary?: string; raw?: string; eom?: string;
  };
  let entries = $state<Entry[] | null>(null);
  let input = $state('');
  let filter = $state('');
  let open = $state<Entry | null>(null);
  let now = $state(Date.now());

  async function load() {
    entries = (await attempt('EAS log', () => get<Entry[]>(`/api/eas?limit=1000${input ? `&input=${encodeURIComponent(input)}` : ''}`))) ?? [];
  }
  onMount(() => {
    load();
    const t = setInterval(() => { load(); now = Date.now(); }, 15000);
    return () => clearInterval(t);
  });

  const inputs = $derived.by((): [string, string][] => {
    const m = new Map<string, string>();
    for (const i of live.snapshot?.inputs ?? []) m.set(i.id, i.name);
    for (const e of entries ?? []) if (!m.has(e.input)) m.set(e.input, e.input_name);
    return [['', 'All inputs'], ...[...m.entries()]];
  });
  const tone = (ev = ''): Tone => (/W$|^(EAN|CEM|CAE|EVI|SPW|LAE|CDW)$/.test(ev) ? 'bad' : /A$/.test(ev) ? 'warn' : 'muted');
  const area = (l: Loc) => (l.county === '000' ? `${l.state} (all)` : `${l.part !== 'all' ? l.part + ' ' : ''}${l.state} ${l.county}`);
  const areas = (e: Entry) => (e.locations ?? []).map(area).join(', ');
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const whenLong = (iso: string) => new Date(iso).toLocaleString();
  /** Minutes the message is still valid for, or null once expired (or for a tone with no header). */
  function left(e: Entry): number | null {
    if (!e.duration_min) return null;
    const start = Date.parse(e.issued || e.received);
    if (!Number.isFinite(start)) return null;
    const m = Math.round((start + e.duration_min * 60000 - now) / 60000);
    return m > 0 ? m : null;
  }
  const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const title = (e: Entry) => (e.kind === 'tone' ? 'Attention tone (no header decoded)' : e.event_name);
  /** Where in the recording the audio is: the chunk's start time and how far in the alert was heard. */
  function where(e: Entry): string {
    if (!e.chunk_start) return 'this input was not recording';
    const start = new Date(e.chunk_start * 1000);
    const into = Math.max(0, Math.round(Date.parse(e.received) / 1000 - e.chunk_start));
    return `file starting ${start.toLocaleString()}, about ${Math.floor(into / 60)}:${String(into % 60).padStart(2, '0')} in`;
  }

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !entries) return entries ?? [];
    return entries.filter((e) => [e.event, title(e), e.input_name, e.sender, e.originator_name, areas(e), e.raw].join(' ').toLowerCase().includes(q));
  });
  async function copyRaw(raw: string) {
    try { await navigator.clipboard.writeText(raw); toast.success('Header copied'); } catch { toast.error('Copy failed: the browser blocked clipboard access'); }
  }
  const COLS = 'grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[140px_130px_minmax(0,1.6fr)_minmax(0,1.2fr)_150px] gap-x-4';
</script>

<Shell page="eas" crumbs={['System', 'EAS log']}>
  <div class="flex flex-col gap-5 p-4 md:p-6">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[240px] flex-1">
        <h1 class="text-[22px] font-semibold tracking-[-0.4px]">EAS / SAME alerts</h1>
        <p class="mt-1 text-[13px] text-subtle">Every EAS attention tone and SAME header heard on any input. Each entry notes the recording that holds the audio.
          Stored in <code class="font-mono text-xs">&lt;data&gt;/eas/messages.jsonl</code> and emailed when email alerts are on.</p>
      </div>
      <Input class="h-8 w-full sm:w-[220px]" type="search" placeholder="Filter events…" aria-label="Filter events" bind:value={filter} />
      <div class="w-full sm:w-[170px]"><FormSelect bind:value={input} options={inputs} onchange={load} /></div>
      <Button variant="outline" class="h-8" href={`/api/eas?format=csv${input ? `&input=${encodeURIComponent(input)}` : ''}`}><Download /> Download CSV</Button>
    </div>

    {#if live.snapshot && !live.snapshot.eas.decoder}
      <p class="rounded-lg border border-warn/50 px-4 py-3 text-[13px] text-subtle">multimon-ng is not installed on this server, so attention tones are logged but the SAME message (event, areas, sender) is not decoded.</p>
    {/if}

    {#if entries === null}
      <Skeleton class="h-64 w-full rounded-lg" />
    {:else if !entries.length}
      <p class="rounded-lg border px-4 py-12 text-center text-sm text-muted-foreground">No EAS alerts heard yet. Feeds that carry the station's air chain (or NOAA Weather Radio) show a Required Weekly Test within a week.</p>
    {:else}
      <div class="overflow-hidden rounded-lg border">
        <div class="{COLS} h-9 items-center border-b px-4 text-xs font-medium text-muted-foreground max-md:hidden">
          <span>Heard</span><span>Input</span><span>Event</span><span>Areas</span><span>From</span>
        </div>
        {#each shown as e (e.id)}
          {@const remaining = left(e)}
          <button type="button" onclick={() => (open = e)}
            class="{COLS} w-full items-center border-b px-4 py-3 text-left text-[13px] last:border-b-0 hover:bg-muted md:h-[52px] md:py-0 {open?.id === e.id ? 'bg-muted' : ''}">
            <span class="font-mono text-xs text-subtle max-md:order-2 max-md:text-right">{when(e.received)}</span>
            <span class="truncate max-md:order-3 max-md:col-span-2 max-md:text-xs max-md:text-muted-foreground">{e.input_name}</span>
            <span class="flex min-w-0 items-center gap-2 max-md:order-1">
              <StatusBadge tone={e.kind === 'tone' ? 'warn' : tone(e.event)} class="h-5 flex-none px-[7px] font-mono text-[10px]">{e.kind === 'tone' ? 'TONE' : e.event}</StatusBadge>
              <span class="truncate">{title(e)}</span>
              {#if remaining}<span class="flex-none text-[11px] text-bad-text">active</span>{/if}
            </span>
            <span class="truncate font-mono text-xs text-subtle max-md:hidden">{areas(e)}</span>
            <span class="truncate text-xs text-subtle max-md:hidden">{e.sender ?? ''}</span>
          </button>
        {:else}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">Nothing matches “{filter}”.</p>
        {/each}
      </div>
    {/if}
  </div>
</Shell>

<Sheet.Root open={!!open} onOpenChange={(o: boolean) => { if (!o) open = null; }}>
  <Sheet.Content side="right" class="w-full gap-0 p-0 sm:max-w-[420px]">
    {#if open}
      {@const remaining = left(open)}
      <Sheet.Header class="gap-0 p-5 pb-4">
        <div class="flex items-center gap-2 text-xs text-subtle">
          <StatusBadge tone={open.kind === 'tone' ? 'warn' : tone(open.event)} class="h-5 px-[7px] font-mono text-[10px]">{open.kind === 'tone' ? 'TONE' : open.event}</StatusBadge>
          {#if open.kind === 'message'}{remaining ? `Active · ${dur(remaining)} left` : 'Expired'}{/if}
        </div>
        <Sheet.Title class="mt-2.5 text-[22px] font-semibold tracking-[-0.4px]">{title(open)}</Sheet.Title>
        <Sheet.Description class="mt-1.5 text-[13px] text-subtle">Heard on {open.input_name} at {whenLong(open.received)}</Sheet.Description>
      </Sheet.Header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <dl class="grid grid-cols-[100px_minmax(0,1fr)] border-t px-5 text-[13px]">
          {#each [
            ...(open.kind === 'message' ? [
              ['Originator', `${open.originator_name} (${open.originator})`],
              ['Sent by', open.sender ?? ''],
              ['Issued', open.issued ? new Date(open.issued).toUTCString().replace(':00 GMT', ' UTC') : '—'],
              ['Valid for', dur(open.duration_min ?? 0)],
              ['End of msg', open.eom ? `heard ${new Date(open.eom).toLocaleTimeString()}` : 'not heard'],
            ] : []),
            ['Recording', where(open)],
          ] as [k, v] (k)}
            <dt class="border-b py-[11px] text-muted-foreground">{k}</dt><dd class="border-b py-[11px] break-words">{v}</dd>
          {/each}
        </dl>
        {#if open.kind === 'tone'}
          <p class="px-5 pt-4 text-[13px] text-subtle">The 853 + 960 Hz attention tone was heard but no SAME header was decoded with it. The header may have been too noisy or too short to decode{live.snapshot && !live.snapshot.eas.decoder ? ', or multimon-ng is not installed' : ''}; listen to the recording to check.</p>
        {:else}
          {#if open.summary}<p class="px-5 pt-4 text-[13px] text-subtle">{open.summary}</p>{/if}
          <div class="px-5 pt-4 pb-2 text-xs font-medium text-muted-foreground">Areas</div>
          <div class="flex flex-wrap gap-1.5 px-5">
            {#each open.locations ?? [] as l (l.code)}<span title={l.code} class="rounded-full border px-[9px] py-0.5 font-mono text-[11px]">{area(l)}</span>{/each}
          </div>
          <div class="px-5 pt-4 pb-2 text-xs font-medium text-muted-foreground">Raw header</div>
          <code class="mx-5 block rounded-md bg-muted p-3 font-mono text-[11px] break-all text-soft">{open.raw}</code>
        {/if}
      </div>
      <div class="flex gap-2 border-t px-5 py-4">
        {#if open.kind === 'message'}<Button class="h-9 flex-1" onclick={() => copyRaw(open!.raw ?? '')}><Copy /> Copy header</Button>{/if}
        <Button variant="outline" class="h-9 px-3.5 {open.kind === 'message' ? '' : 'flex-1'}" onclick={() => (open = null)}>Close</Button>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
