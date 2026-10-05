<script lang="ts">
  // Configuration: a section list (a scrolling strip on phones) and one section at a time.
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
  import Search from '@lucide/svelte/icons/search';
  import { Input } from '$lib/components/ui/input/index.js';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { attempt, get } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import Shell from '../shell/Shell.svelte';
  import InputEditor, { type InputForm } from './InputEditor.svelte';
  import ServiceForms from './ServiceForms.svelte';
  import SystemPanel from './SystemPanel.svelte';
  import ClockPanel from './ClockPanel.svelte';
  import NetworkPanel from './NetworkPanel.svelte';
  import CreditsPanel from './CreditsPanel.svelte';
  import Section from './Section.svelte';

  type Config = { inputs: InputForm[]; source: { port: number } } & Record<string, Record<string, unknown>>;
  const SECTIONS = [
    ['inputs', 'Inputs'], ['zabbix', 'Zabbix'], ['smtp', 'Email'], ['snmp', 'SNMP'], ['network', 'Network'], ['clock', 'Clock'], ['system', 'System'], ['credits', 'Credits'],
  ] as const;
  type Tab = (typeof SECTIONS)[number][0];
  const fromHash = (): Tab => {
    const h = typeof location !== 'undefined' ? location.hash.slice(1) : '';
    return (SECTIONS.find(([id]) => id === h)?.[0] ?? 'inputs') as Tab;
  };

  let config = $state<Config | null>(null);
  let inputDrafts = $state<InputForm[]>([]);
  let tab = $state<Tab>(fromHash());
  // Saved inputs start collapsed so a long list stays scannable; new drafts open.
  let openIds = $state<Record<string, boolean>>({});
  let filter = $state('');
  const FILTER_AT = 6;
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const all = config?.inputs ?? [];
    return q ? all.filter((i) => `${i.name} ${i.id} ${i.url} ${i.address} ${i.mount}`.toLowerCase().includes(q)) : all;
  });
  const setAll = (v: boolean) => { for (const i of shown) openIds[i.id] = v; };

  async function load() {
    config = (await attempt('Config', () => get<Config>('/api/config'))) ?? null;
  }
  onMount(() => {
    load();
    const onHash = () => (tab = fromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });
  $effect(() => { if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`); });

  function blankInput(): InputForm {
    return {
      id: '', name: `Input ${(config?.inputs.length ?? 0) + inputDrafts.length + 1}`, enabled: true, kind: 'http',
      url: '', address: '', port: 5004, rtp_codec: 'l24', rtp_payload: 96, rtp_rate: 48000, channels: 2, stream_codec: 'mp3', livewire_channel: 1,
      mount: '', source_password: '', chunk_minutes: 60, record: true, keep_days: 30,
      silence_db: -50, silence_secs: 30, link_secs: 5, clip_secs: 10, mono_secs: 30, detect_clip: true, detect_mono: false, detect_eas: true,
    };
  }
  const liveInput = (id: string) => live.snapshot?.inputs.find((i) => i.id === id);
</script>

<Shell page="config" crumbs={['System', 'Configuration']}>
  <div class="flex gap-10 px-4 py-5 max-md:flex-col max-md:gap-5 md:px-6 md:py-8">
    <nav aria-label="Configuration sections"
      class="flex flex-none gap-0.5 max-md:-mx-4 max-md:overflow-x-auto max-md:px-4 md:sticky md:top-[88px] md:h-fit md:w-[180px] md:flex-col">
      {#each SECTIONS as [id, label] (id)}
        <a href="#{id}" aria-current={tab === id ? 'page' : undefined}
          class="rounded-md px-2.5 py-[7px] text-[13px] font-medium whitespace-nowrap {tab === id ? 'bg-muted text-foreground' : 'text-subtle hover:bg-muted hover:text-foreground'}">{label}</a>
      {/each}
    </nav>

    <div class="min-w-0 flex-1">
      {#if !config}
        <div class="flex max-w-[820px] flex-col gap-4"><Skeleton class="h-8 w-48" /><Skeleton class="h-64 w-full rounded-lg" /></div>
      {:else if tab === 'inputs'}
        <Section title="Inputs" description="Audio feeds to log. Each saves and restarts on its own; the others keep recording.">
          {#snippet actions()}
            {#if config.inputs.length > 1}
              <Button variant="ghost" class="h-8 px-2.5 text-subtle" onclick={() => setAll(true)} title="Expand all"><ChevronsUpDown /> Expand</Button>
              <Button variant="ghost" class="h-8 px-2.5 text-subtle" onclick={() => setAll(false)} title="Collapse all"><ChevronsDownUp /> Collapse</Button>
            {/if}
            <Button class="h-8 px-3" onclick={() => (inputDrafts = [...inputDrafts, blankInput()])}><Plus /> Add input</Button>
          {/snippet}
          {#if config.inputs.length >= FILTER_AT}
            <div class="relative">
              <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input class="h-9 pl-9" placeholder="Filter {config.inputs.length} inputs by name, id or address" aria-label="Filter inputs" bind:value={filter} />
            </div>
            {#if filter && !shown.length}<p class="text-sm text-muted-foreground">No inputs match “{filter}”.</p>{/if}
          {/if}
          {#each shown as inp (inp.id)}
            <InputEditor input={inp} live={liveInput(inp.id)} bind:open={openIds[inp.id]} sourcePort={config.source.port} onsaved={load} ondeleted={load} />
          {/each}
          {#each inputDrafts as d, i (d)}
            <InputEditor input={d} open sourcePort={config.source.port}
              onsaved={() => { inputDrafts = inputDrafts.filter((_, j) => j !== i); load(); }}
              ondeleted={() => (inputDrafts = inputDrafts.filter((_, j) => j !== i))} />
          {/each}
          {#if !config.inputs.length && !inputDrafts.length}
            <p class="rounded-lg border px-4 py-12 text-center text-sm text-muted-foreground">No inputs yet — click <b class="font-medium text-foreground">Add input</b>.</p>
          {/if}
        </Section>
      {:else if tab === 'network'}
        <NetworkPanel />
      {:else if tab === 'clock'}
        <ClockPanel />
      {:else if tab === 'system'}
        <SystemPanel />
      {:else if tab === 'credits'}
        <CreditsPanel />
      {:else}
        {#key tab}<ServiceForms {config} section={tab} />{/key}
      {/if}
    </div>
  </div>
</Shell>
