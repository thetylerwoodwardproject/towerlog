<script lang="ts">
  // Logged inputs: a card per feed (status, faults, meters, listen), then the
  // selected input's recordings and the fault history.
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { live } from '$lib/live.svelte';
  import { FAULT_TEXT } from '$lib/inputs';
  import Shell from './shell/Shell.svelte';
  import InputCard from './dashboard/InputCard.svelte';
  import InputRecordings from './dashboard/InputRecordings.svelte';
  import FaultLog from './dashboard/FaultLog.svelte';

  live.start();
  const snap = $derived(live.snapshot);
  let hash = $state(typeof location !== 'undefined' ? decodeURIComponent(location.hash.slice(1)) : '');
  const inputs = $derived(snap?.inputs ?? []);
  const sel = $derived(inputs.find((i) => i.id === hash) ?? inputs[0]);
  const faulted = $derived(inputs.filter((i) => i.faults.length));

  onMount(() => {
    const onHash = () => (hash = decodeURIComponent(location.hash.slice(1)));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });
  function select(id: string) {
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
    hash = id;
  }
</script>

<Shell page="inputs" crumbs={['Inputs', ...(sel ? [sel.name] : [])]} selected={sel?.id ?? ''}>
  <div class="flex flex-col gap-5 p-4 md:p-6">
    {#if !snap}
      <Skeleton class="h-16 w-64" /><Skeleton class="h-72 w-full rounded-lg" />
    {:else if !inputs.length}
      <div class="flex flex-col items-center gap-4 rounded-lg border px-6 py-16 text-center">
        <h1 class="text-[22px] font-semibold tracking-[-0.4px]">No inputs yet</h1>
        <p class="max-w-md text-[13px] text-subtle">An input is one audio feed to log: an Icecast or HTTP stream, RTP, a Livewire channel, or an encoder pushing to Towerlog.</p>
        <Button href="/config#inputs">Add an input</Button>
      </div>
    {:else}
      {#each faulted as f (f.id)}
        <div role="alert" class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-bad-border px-4 py-3 text-[13px]">
          <TriangleAlert class="size-4 flex-none text-bad" />
          <span class="min-w-0 flex-1"><span class="font-medium text-bad-text">{f.name}:</span> <span class="text-subtle">{f.faults.map((k) => FAULT_TEXT[k] ?? k).join(', ')}</span></span>
          {#if f.id !== sel?.id}<Button size="sm" variant="ghost" onclick={() => select(f.id)}>Show</Button>{/if}
        </div>
      {/each}

      <div class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
        {#each inputs as i (i.id)}
          <InputCard input={i} selected={i.id === sel?.id} onselect={select} />
        {/each}
      </div>

      {#if sel}
        {#key sel.id}
          <Tabs.Root value="recordings" class="gap-4">
            <Tabs.List><Tabs.Trigger value="recordings">Recordings · {sel.name}</Tabs.Trigger><Tabs.Trigger value="faults">Faults · {sel.name}</Tabs.Trigger><Tabs.Trigger value="all">All faults</Tabs.Trigger></Tabs.List>
            <Tabs.Content value="recordings"><InputRecordings id={sel.id} /></Tabs.Content>
            <Tabs.Content value="faults"><FaultLog input={sel.id} /></Tabs.Content>
            <Tabs.Content value="all"><FaultLog /></Tabs.Content>
          </Tabs.Root>
        {/key}
      {/if}
    {/if}
  </div>
</Shell>
