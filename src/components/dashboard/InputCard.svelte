<script lang="ts">
  // One logged input: status, faults, L/R meters, recording state and a listen button.
  import Play from '@lucide/svelte/icons/play';
  import Square from '@lucide/svelte/icons/square';
  import Circle from '@lucide/svelte/icons/circle';
  import type { InputSnapshot } from '$lib/types';
  import { FAULT_TEXT, INPUT_STATUS_TEXT, KIND_TEXT, fmtSecs, inputTone } from '$lib/inputs';
  import { player } from '$lib/player.svelte';
  import { cn } from '$lib/utils';
  import StatusBadge from '../common/StatusBadge.svelte';
  import LedMeter from './LedMeter.svelte';
  import VuMeter from './VuMeter.svelte';

  let { input, selected = false, onselect }: { input: InputSnapshot; selected?: boolean; onselect?: (id: string) => void } = $props();
  const url = $derived(`/listen/input/${encodeURIComponent(input.id)}`);
  const playing = $derived(player.current === url);
  const tone = $derived(inputTone(input));
  const live = $derived(input.status === 'live');
</script>

<div class={cn('flex flex-col gap-3 rounded-lg border p-4', tone === 'bad' && 'border-bad-border bg-bad/5', tone === 'warn' && 'border-warn/50', selected && 'ring-1 ring-ring')}>
  <div class="flex items-center gap-2">
    <button class="min-w-0 truncate text-left text-[15px] font-semibold hover:underline" onclick={() => onselect?.(input.id)}>{input.name}</button>
    <StatusBadge {tone} title={input.detail}>{INPUT_STATUS_TEXT[input.status] ?? input.status}</StatusBadge>
    <span class="ml-auto font-mono text-[11px] text-faint">{KIND_TEXT[input.kind] ?? input.kind}</span>
    <button aria-label={playing ? 'Stop listening' : `Listen to ${input.name}`} disabled={!live && !playing}
      onclick={() => player.toggle(url, input.name, input.id)}
      class="inline-flex size-8 flex-none items-center justify-center rounded-full border disabled:opacity-40 {playing ? 'border-foreground bg-foreground text-background' : 'hover:bg-secondary'}">
      {#if playing}<Square class="size-3 fill-current" />{:else}<Play class="size-3 fill-current" />{/if}
    </button>
  </div>

  <div class="min-h-[40px] text-[13px]">
    {#if input.faults.length}
      <div class="flex flex-wrap gap-1.5">
        {#each input.faults as f (f)}
          <span class="rounded-md border border-bad-border px-2 py-0.5 text-xs font-medium text-bad-text">
            {FAULT_TEXT[f] ?? f}{f === 'silence' && input.silent_s ? ` · ${fmtSecs(input.silent_s)}` : ''}
          </span>
        {/each}
      </div>
    {/if}
    {#if input.status !== 'live' && input.detail}
      <div class="mt-1 line-clamp-2 text-subtle">{input.detail}</div>
    {:else if !input.faults.length}
      <div class="text-subtle">
        {#if input.silent_s > 0}Quiet for {fmtSecs(input.silent_s)}{:else}Audio OK{/if}
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-3">
    <VuMeter rms={input.meter.rms_db} peak={input.meter.peak_db} channels={2} {live} compact />
    <LedMeter peak={input.meter.peak_db} channels={2} {live} />
  </div>

  <div class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
    {#if input.record_error}
      <Circle class="size-2.5 fill-bad text-bad" /> <span class="text-bad" title={input.record_error}>not recording: recordings folder unavailable</span>
    {:else if input.recording}
      <Circle class="size-2.5 fill-bad text-bad" /> recording · {input.chunk_minutes}-minute files
    {:else}
      not recording
    {/if}
    {#if input.up_since && live}<span class="ml-auto">up {fmtSecs(Math.max(0, Math.floor(Date.now() / 1000 - input.up_since)))}</span>{/if}
  </div>
</div>
