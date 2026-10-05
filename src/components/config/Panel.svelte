<script lang="ts">
  // Bordered settings panel with a title row.
  import type { Snippet } from 'svelte';
  let { title = '', sub = '', class: cls = '', head, children }: { title?: string; sub?: string; class?: string; head?: Snippet; children: Snippet } = $props();
</script>

<section class="min-w-0 overflow-hidden rounded-lg border {cls}">
  {#if title || head}
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b px-5 py-4 max-sm:px-4">
      {#if title}<h2 class="text-sm font-medium">{title}</h2>{/if}
      {#if sub}<span class="text-xs text-muted-foreground">{sub}</span>{/if}
      {@render head?.()}
    </div>
  {/if}
  {@render children()}
</section>
