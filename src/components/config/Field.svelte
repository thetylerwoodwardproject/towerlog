<script lang="ts">
  import type { Snippet } from 'svelte';
  let { label, hint = '', children, class: cls = '' }: { label: string; hint?: string; children: Snippet; class?: string } = $props();
</script>

<label class="field-label {cls}">
  <span>{label}</span>
  {@render children()}
  {#if hint}<span class="-mt-0.5 text-xs font-normal text-muted-foreground">{hint}</span>{/if}
</label>
