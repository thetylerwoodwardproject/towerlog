<script lang="ts">
  // A configuration page: title, description, optional actions, content.
  import type { Snippet } from 'svelte';
  let { title, description = '', wide = false, actions, children }: { title: string; description?: string; wide?: boolean; actions?: Snippet; children: Snippet } = $props();
</script>

<div class="flex w-full min-w-0 flex-col gap-6 {wide ? '' : 'max-w-[820px]'}">
  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-0 flex-1">
      <h1 class="text-[22px] font-semibold tracking-[-0.4px]">{title}</h1>
      {#if description}<p class="mt-1 text-[13px] leading-normal text-subtle">{description}</p>{/if}
    </div>
    {@render actions?.()}
  </div>
  {@render children()}
</div>
