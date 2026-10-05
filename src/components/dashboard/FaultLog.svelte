<script lang="ts">
  // Fault history from the persistent log: raises and clears, newest first.
  import { onMount } from 'svelte';
  import { get } from '$lib/api';
  import type { FaultRecord } from '$lib/types';
  import { FAULT_TEXT, fmtSecs } from '$lib/inputs';

  let { input = '' }: { input?: string } = $props();
  let rows = $state<FaultRecord[] | null>(null);
  let error = $state('');

  async function load() {
    try { rows = await get<FaultRecord[]>(`/api/faults?limit=200${input ? `&input=${encodeURIComponent(input)}` : ''}`); error = ''; }
    catch (e) { error = (e as Error).message; }
  }
  onMount(() => { load(); const t = setInterval(() => { if (!document.hidden) load(); }, 10000); return () => clearInterval(t); });
  $effect(() => { input; load(); });
</script>

{#if error}<p class="text-sm text-bad">{error}</p>
{:else if !rows}<p class="text-sm text-muted-foreground">Loading…</p>
{:else if !rows.length}<p class="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">No faults logged{input ? ' for this input' : ''}.</p>
{:else}
  <div class="overflow-x-auto rounded-lg border">
    <table class="w-full text-[13px]">
      <thead><tr class="border-b text-left text-xs text-muted-foreground"><th class="px-4 py-2 font-medium">Time</th>{#if !input}<th class="px-2 py-2 font-medium">Input</th>{/if}<th class="px-2 py-2 font-medium">Fault</th><th class="px-2 py-2 font-medium">Event</th><th class="px-4 py-2 font-medium">Lasted</th></tr></thead>
      <tbody>
        {#each rows as r (r.input + r.kind + r.state + r.at)}
          <tr class="border-b last:border-b-0">
            <td class="px-4 py-2 font-mono text-xs whitespace-nowrap">{new Date(r.at * 1000).toLocaleString()}</td>
            {#if !input}<td class="px-2 py-2">{r.name}</td>{/if}
            <td class="px-2 py-2">{FAULT_TEXT[r.kind] ?? r.kind}</td>
            <td class="px-2 py-2 {r.state === 'raised' ? 'text-bad' : 'text-ok'}">{r.state === 'raised' ? 'started' : 'cleared'}</td>
            <td class="px-4 py-2 font-mono text-xs">{r.duration !== undefined ? fmtSecs(r.duration) : ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
