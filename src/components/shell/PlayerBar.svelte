<script lang="ts">
  // Now-listening bar: which input is playing, whether it is live, volume and stop.
  import Square from '@lucide/svelte/icons/square';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import { live } from '$lib/live.svelte';
  import { player } from '$lib/player.svelte';
  import { cn } from '$lib/utils';

  let { class: cls = '', volume = true }: { class?: string; volume?: boolean } = $props();
  const inp = $derived((live.snapshot?.inputs ?? []).find((i) => i.id === player.input));
  const title = $derived(inp ? (inp.status === 'live' ? 'Live' : `${inp.status}${inp.detail ? ': ' + inp.detail : ''}`) : '');
</script>

{#if player.current}
  <div class={cn('flex flex-col gap-2 rounded-lg border bg-muted p-2 pl-3.5', cls)}>
    <div class="flex items-center gap-3">
      <span class="size-1.5 flex-none rounded-full bg-ok"></span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-[11px] text-subtle">{inp?.name ?? player.label}</div>
        {#if title}<div class="truncate text-[13px] font-medium">{title}</div>{/if}
      </div>
      <button aria-label="Stop listening" onclick={() => player.stop()}
        class="inline-flex size-9 flex-none items-center justify-center rounded-full bg-foreground text-background hover:bg-soft max-md:size-11">
        <Square class="size-3 fill-current" />
      </button>
    </div>
    {#if volume}
      <Slider type="single" min={0} max={1} step={0.01} value={player.volume} onValueChange={(v: number) => player.setVolume(v)} aria-label="Volume" class="px-1" />
    {/if}
  </div>
{/if}
