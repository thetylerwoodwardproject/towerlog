<script lang="ts">
  // Clock: chrony's status and the NTP servers it follows. Recordings are cut and faults
  // are stamped by this computer's clock, so it has to be right.
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { attempt, get, put } from '$lib/api';
  import FormSelect from '../common/FormSelect.svelte';
  import StatusBadge from '../common/StatusBadge.svelte';
  import Field from './Field.svelte';
  import Panel from './Panel.svelte';
  import Section from './Section.svelte';

  type Status = { available: boolean; reason: string; synchronized: boolean; leap: string; stratum: number | null; offset_ms: number | null; reference: string; last_update_s: number | null };
  type Source = { state: string; address: string; stratum: number; reach: number; offset_ms: number };
  type Clock = { status: Status; sources: Source[]; servers: string[]; writable: boolean; reason: string; time_zone: string };
  let c = $state<Clock | null>(null);
  let servers = $state('');
  let tz = $state('');
  let ntp = $state(false);
  let zones = $state<string[]>([]);
  let busy = $state(false);
  const IN = 'h-9 font-mono text-[13px]';
  const PRESETS: [string, string][] = [['pool.ntp.org', 'pool.ntp.org'], ['time.cloudflare.com', 'Cloudflare'], ['time.google.com', 'Google'], ['time.nist.gov', 'NIST']];

  async function load() {
    const r = await attempt('Clock', () => get<Clock>('/api/clock'));
    if (r) { c = r; if (servers === '' || !busy) servers = r.servers.join(' '); }
  }
  async function loadTime() {
    const r = await attempt('Time zone', () => get<{ timezones: string[]; time: { timezone: string; ntp: boolean } }>('/api/network/time'));
    if (r) { zones = r.timezones; tz = r.time.timezone; ntp = r.time.ntp; }
  }
  async function saveTime() { await attempt('Time zone', () => put('/api/network/time', { timezone: tz }), 'Time zone saved'); loadTime(); }
  const setNtp = async (on: boolean) => { await attempt('NTP', () => put('/api/network/time', { ntp: on })); loadTime(); load(); };
  onMount(() => { load(); loadTime(); const t = setInterval(() => { if (!document.hidden) load(); }, 5000); return () => clearInterval(t); });

  async function save() {
    busy = true;
    const r = await attempt('Clock', () => put<Clock>('/api/clock', { servers: servers.split(/[\s,]+/).filter(Boolean) }), servers.trim() ? 'NTP servers saved' : 'Using the host defaults');
    busy = false;
    if (r) { c = r; servers = r.servers.join(' '); }
  }
  const add = (h: string) => { const l = servers.split(/[\s,]+/).filter(Boolean); if (!l.includes(h)) servers = [...l, h].join(' '); };
  const ago = (s: number | null) => (s === null ? 'never' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`);
  const STATE: Record<string, string> = { selected: 'in use', combined: 'combined', candidate: 'standby', rejected: 'rejected', falseticker: 'wrong time', unreachable: 'unreachable', other: '?' };
  const tone = (s: Source) => (s.state === 'selected' || s.state === 'combined' ? 'ok' : s.state === 'candidate' ? 'muted' : 'warn') as 'ok' | 'muted' | 'warn';
</script>

<Section title="Clock" description="Towerlog cuts every recording and stamps every fault by this computer's clock, so it must be right. chrony keeps it right by following the NTP servers below.">
  {#if !c}
    <Skeleton class="h-40 w-full rounded-lg" />
  {:else}
    <Panel title="Status">
      {#snippet head()}
        {#if c.status.available}
          <StatusBadge tone={c.status.synchronized ? 'ok' : 'bad'} class="ml-auto">{c.status.synchronized ? 'synchronised' : 'not synchronised'}</StatusBadge>
        {:else}
          <StatusBadge tone="muted" class="ml-auto">unavailable</StatusBadge>
        {/if}
      {/snippet}
      {#if c.status.available}
        {#each [
          ['Following', c.status.reference || '—'],
          ['Clock error', c.status.offset_ms === null ? '—' : `${c.status.offset_ms > 0 ? '+' : ''}${c.status.offset_ms} ms`],
          ['Stratum', c.status.stratum ?? '—'],
          ['Last update', ago(c.status.last_update_s)],
          ['Time zone', c.time_zone],
        ] as [k, v] (k)}
          <div class="flex gap-4 border-b px-4 py-[9px] text-[13px] last:border-b-0"><span class="w-[120px] flex-none text-muted-foreground">{k}</span><span class="font-mono text-xs text-soft">{v}</span></div>
        {/each}
      {:else}
        <p class="px-5 py-4 text-[13px] text-muted-foreground max-sm:px-4">{c.status.reason}. In a container the clock belongs to the host: set it up there.</p>
      {/if}
    </Panel>

    <Panel title="Time zone and automatic time">
      <div class="flex flex-col gap-4 p-5 max-sm:p-4">
        <label class="flex items-center gap-3 text-[13px]"><span class="flex-1 font-medium">Set the clock automatically (NTP)</span>
          <Switch checked={ntp} onCheckedChange={(v: boolean) => setNtp(v)} /></label>
        <Field label="Time zone" hint="Decides what the top of the hour means for file names and logs.">
          {#if zones.length}<FormSelect bind:value={tz} options={zones.map((z) => [z, z] as [string, string])} />{:else}<Input class={IN} bind:value={tz} />{/if}
        </Field>
        <div><Button class="h-9 px-4" onclick={saveTime}>Save time zone</Button></div>
      </div>
    </Panel>

    <Panel title="NTP servers">
      <div class="flex flex-col gap-4 p-5 max-sm:p-4">
        {#if !c.writable}
          <p class="rounded-md border border-warn/40 px-3 py-2 text-xs text-warn">The servers can't be changed from here: {c.reason}.</p>
        {/if}
        <Field label="Servers" hint="Host names or IP addresses, separated by spaces. Blank = the host's own chrony defaults. Use your own NTP or GPS time server if you have one.">
          <Input class={IN} bind:value={servers} placeholder="pool.ntp.org" disabled={!c.writable} />
        </Field>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Add:
          {#each PRESETS as [h, label] (h)}<button type="button" class="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-40" disabled={!c.writable} onclick={() => add(h)}>{label}</button>{/each}
        </div>
        <div><Button class="h-9 px-4" disabled={busy || !c.writable} onclick={save}>Save servers</Button></div>
      </div>
    </Panel>

    {#if c.sources.length}
      <Panel title="Servers chrony is using">
        {#each c.sources as s (s.address)}
          <div class="flex items-center gap-3 border-b px-4 py-[9px] text-[13px] last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{s.address}</span>
            <span class="font-mono text-[11px] text-muted-foreground">stratum {s.stratum} · {s.offset_ms > 0 ? '+' : ''}{s.offset_ms} ms</span>
            <StatusBadge tone={tone(s)} class="h-5">{STATE[s.state]}</StatusBadge>
          </div>
        {/each}
      </Panel>
    {/if}
  {/if}
</Section>
