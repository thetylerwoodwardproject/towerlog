<script lang="ts" generics="T extends string">
  // Segmented control (tabs, view switches): a muted track with the active
  // segment lifted onto the background.
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  let { value = $bindable(), options, size = 'md', label, class: cls = '', item, onchange }: {
    value: T;
    options: { value: T; label: string; disabled?: boolean }[];
    size?: 'xs' | 'md' | 'lg';
    label?: string;
    class?: string;
    item?: Snippet<[{ value: T; label: string }]>;
    onchange?: (v: T) => void;
  } = $props();
  const pad = $derived(size === 'xs' ? 'px-2 py-0.5 font-mono text-[11px] rounded' : size === 'lg' ? 'flex-1 py-2 text-[13px] rounded-md' : 'px-3.5 py-[5px] text-[13px] rounded-md');
</script>

<div role="tablist" aria-label={label} class={cn('inline-flex gap-1 bg-muted', size === 'xs' ? 'gap-0 rounded-md p-0.5' : 'rounded-lg p-[3px]', cls)}>
  {#each options as o (o.value)}
    <button type="button" role="tab" aria-selected={value === o.value} disabled={o.disabled}
      class="inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors disabled:opacity-40 {pad}
        {value === o.value ? (size === 'xs' ? 'bg-secondary text-foreground' : 'bg-background text-foreground') : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => { value = o.value; onchange?.(o.value); }}>
      {#if item}{@render item(o)}{:else}{o.label}{/if}
    </button>
  {/each}
</div>
