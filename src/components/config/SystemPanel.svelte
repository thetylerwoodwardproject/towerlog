<script lang="ts">
  // Host info, installed tools, storage (with the disk watermark), password and logs.
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { onMount, tick } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import type { LogLine } from '$lib/types';
  import { attempt, get, put } from '$lib/api';
  import { fmtUptime } from '$lib/format';
  import Field from './Field.svelte';
  import FormSelect from '../common/FormSelect.svelte';
  import StatusBadge from '../common/StatusBadge.svelte';
  import Section from './Section.svelte';
  import Panel from './Panel.svelte';

  type Sys = {
    version: string; hostname: string; uptime_s: number; host_uptime_s: number; load: number[]; mem: { total_mb: number; free_mb: number };
    node: string; kernel: string; arch: string; tools: Record<string, string | null>; paths: Record<string, string>;
    disk: { free_gb: number; total_gb: number } | null; config_problems: string[]; purge_min_free_gb: number;
  };
  let sys = $state<Sys | null>(null);
  let recDir = $state('');
  let purgeGb = $state(0);
  let pwCur = $state(''), pw1 = $state(''), pw2 = $state('');
  let logFile = $state('towerlog.log');
  let logs = $state<{ files: string[]; lines: LogLine[]; disk: string[] } | null>(null);
  let follow = $state(true);
  let logBox = $state<HTMLDivElement>();

  async function load() {
    sys = (await attempt('System', () => get<Sys>('/api/system'))) ?? null;
    if (sys) { recDir = sys.paths.recordings; purgeGb = sys.purge_min_free_gb; }
  }
  async function loadLogs(quiet = false) {
    const url = `/api/logs?file=${encodeURIComponent(logFile)}&limit=400`;
    const r = quiet ? await get<typeof logs>(url).catch(() => undefined) : await attempt('Logs', () => get<typeof logs>(url));
    if (r === undefined) return;
    logs = r;
    await tick();
    if (follow && logBox) logBox.scrollTop = logBox.scrollHeight;
  }
  onMount(() => {
    load();
    loadLogs();
    const t = setInterval(() => { if (follow && !document.hidden) loadLogs(true); }, 5000);
    return () => clearInterval(t);
  });

  const saveRec = () => attempt('Recordings folder', () => put('/api/system', { recordings_dir: recDir }), 'Recordings folder saved');
  const savePurge = () => attempt('Disk watermark', () => put('/api/system', { purge_min_free_gb: Number(purgeGb) }), purgeGb > 0 ? `Oldest recordings are deleted when under ${purgeGb} GB is free` : 'Disk watermark off');
  async function changePw() {
    if (pw1 !== pw2) return alert('The new passwords do not match.');
    const ok = await attempt('Password', () => put('/api/password', { current: pwCur, password: pw1 }), 'Password changed — other sessions are signed out');
    if (ok) { pwCur = pw1 = pw2 = ''; }
  }
  const TOOL_HELP: Record<string, string> = { ffmpeg: 'reads every feed, records, plays' };
  const about = $derived(sys ? [
    ['Version', `Towerlog ${sys.version}`], ['Host', `${sys.hostname} · ${sys.kernel} · ${sys.arch}`], ['Service uptime', fmtUptime(sys.uptime_s)],
    ['Host uptime', fmtUptime(sys.host_uptime_s)], ['Load', sys.load.join(' / ')], ['Memory', `${sys.mem.free_mb} MB free of ${sys.mem.total_mb} MB`],
    ['Node', sys.node], ['Disk (recordings)', sys.disk ? `${sys.disk.free_gb} GB free of ${sys.disk.total_gb} GB` : '—'], ['Config', sys.paths.config], ['Logs', sys.paths.logs],
  ] : []);
  const usedPct = $derived(sys?.disk && sys.disk.total_gb ? Math.round((1 - sys.disk.free_gb / sys.disk.total_gb) * 100) : null);
  const lineTone = (l: string) => (/\b(error|fail(ed)?|SIGTERM|shutting down)\b/i.test(l) ? 'text-bad' : /\b(warn|lost|not found|missing|retry)\b/i.test(l) ? 'text-warn' : 'text-subtle');
</script>

<Section title="System" description="Host, tools, storage and logs." wide>
  {#each sys?.config_problems ?? [] as p (p)}
    <div role="alert" class="rounded-lg border border-warn/40 px-4 py-3 text-[13px] text-warn">{p}</div>
  {/each}

  <div class="grid items-start gap-5 xl:grid-cols-2">
    <Panel title="About">
      {#if !sys}<div class="p-4"><Skeleton class="h-40 w-full" /></div>{:else}
        {#each about as [k, v] (k)}
          <div class="flex gap-4 border-b px-4 py-[9px] text-[13px] last:border-b-0">
            <span class="w-[120px] flex-none text-muted-foreground">{k}</span><span class="min-w-0 font-mono text-xs break-all text-soft">{v}</span>
          </div>
        {/each}
      {/if}
    </Panel>
    <Panel title="Installed tools" sub="Found on PATH">
      {#if !sys}<div class="p-4"><Skeleton class="h-40 w-full" /></div>{:else}
        {#each Object.entries(sys.tools) as [k, v] (k)}
          <div class="flex items-center gap-3 border-b px-4 py-[9px] text-[13px] last:border-b-0">
            <span class="w-[104px] flex-none font-mono text-xs">{k}</span>
            <span class="min-w-0 flex-1 truncate text-muted-foreground">{TOOL_HELP[k] ?? ''}</span>
            <StatusBadge tone={v ? 'ok' : 'bad'} title={v ?? 'not found on PATH'} class="h-5">{v ? 'found' : 'missing'}</StatusBadge>
          </div>
        {/each}
      {/if}
    </Panel>
  </div>

  <div class="grid items-start gap-5 xl:grid-cols-2">
    <section class="flex flex-col gap-3 rounded-lg border p-4">
      <h2 class="text-sm font-medium">Storage</h2>
      <div class="flex items-end gap-2">
        <Field label="Recordings folder" class="flex-1"><Input class="h-9 font-mono text-[13px]" bind:value={recDir} /></Field>
        <Button variant="outline" class="h-9" onclick={saveRec}>Save</Button>
      </div>
      {#if sys?.disk && usedPct != null}
        <div class="flex items-center gap-2.5">
          <div class="h-1 flex-1 rounded-full bg-border" role="meter" aria-label="Recordings disk used" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100}>
            <div class="h-full rounded-full {usedPct > 90 ? 'bg-bad' : 'bg-foreground'}" style="width:{usedPct}%"></div>
          </div>
          <span class="font-mono text-[11px] text-muted-foreground">{sys.disk.free_gb} GB free of {sys.disk.total_gb}</span>
        </div>
      {/if}
      <div class="flex items-end gap-2">
        <Field label="Keep at least this much free (GB)" hint="When free space falls under this, the oldest recordings are deleted first. 0 = off." class="flex-1"><Input class="h-9 font-mono text-[13px]" type="number" min="0" bind:value={purgeGb} /></Field>
        <Button variant="outline" class="h-9" onclick={savePurge}>Save</Button>
      </div>
    </section>
  </div>

  <div class="grid items-start gap-5 xl:grid-cols-2">
    <Panel title="Web UI password">
      <form class="flex flex-col gap-4 p-4" onsubmit={(e) => { e.preventDefault(); changePw(); }}>
        <div class="grid gap-3 sm:grid-cols-3">
          <Field label="Current"><Input class="h-9" type="password" bind:value={pwCur} autocomplete="current-password" /></Field>
          <Field label="New"><Input class="h-9" type="password" bind:value={pw1} autocomplete="new-password" /></Field>
          <Field label="Repeat"><Input class="h-9" type="password" bind:value={pw2} autocomplete="new-password" /></Field>
        </div>
        <div class="flex items-center gap-3">
          <Button type="submit" variant="outline" class="h-9" disabled={!pwCur || pw1.length < 8}>Change password</Button>
          <span class="text-xs text-muted-foreground">At least 8 characters. Other sessions are signed out.</span>
        </div>
      </form>
    </Panel>
  </div>

  <section class="flex flex-col overflow-hidden rounded-lg border">
    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <h2 class="text-sm font-medium">Logs</h2>
      <div class="w-40"><FormSelect bind:value={logFile} class="h-7 text-[11px]" options={(logs?.files?.length ? logs.files : ['towerlog.log']).map((f) => [f, f] as [string, string])} onchange={() => loadLogs()} /></div>
      <label class="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
        <input type="checkbox" class="sr-only" bind:checked={follow} />
        <span class="size-1.5 rounded-full {follow ? 'bg-ok' : 'bg-faint'}"></span>{follow ? 'following' : 'paused'}
      </label>
      <Button size="icon-sm" variant="ghost" onclick={() => loadLogs()} aria-label="Refresh logs"><RefreshCw /></Button>
    </div>
    <div bind:this={logBox} class="h-[420px] overflow-auto px-4 py-3 font-mono text-[11px] leading-[1.7]">
      {#each logs?.disk ?? [] as l, i (i)}
        {@const m = /^\[(\S+) (\d\d:\d\d:\d\d)\] (.*)$/.exec(l)}
        <div class="whitespace-pre-wrap break-all">{#if m}<span class="text-faint" title={m[1]}>{m[2]}</span> <span class={lineTone(m[3])}>{m[3]}</span>{:else}<span class={lineTone(l)}>{l}</span>{/if}</div>
      {:else}
        <span class="text-muted-foreground">empty</span>
      {/each}
    </div>
  </section>
</Section>
