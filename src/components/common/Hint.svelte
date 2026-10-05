<script lang="ts">
  // Tooltip around any content (falls back to nothing when text is empty).
  import type { Snippet } from 'svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  let { text, class: cls = '', children }: { text: string; class?: string; children: Snippet } = $props();
</script>

{#if text}
  <Tooltip.Root>
    <Tooltip.Trigger>{#snippet child({ props })}<span {...props} class="inline-flex {cls}">{@render children()}</span>{/snippet}</Tooltip.Trigger>
    <Tooltip.Content class="max-w-xs">{text}</Tooltip.Content>
  </Tooltip.Root>
{:else}
  {@render children()}
{/if}
