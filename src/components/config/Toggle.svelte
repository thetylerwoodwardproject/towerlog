<script lang="ts">
  // A setting with a switch. `row`: title and hint on the left, switch on the right
  // (lists and cards); `inline`: switch first, for compact forms.
  import { Switch } from '$lib/components/ui/switch/index.js';
  let { checked = $bindable(false), label, hint = '', disabled = false, variant = 'row', class: cls = '' }: {
    checked?: boolean; label: string; hint?: string; disabled?: boolean; variant?: 'row' | 'inline'; class?: string;
  } = $props();
</script>

{#if variant === 'row'}
  <label class="flex cursor-pointer items-center gap-3 {cls}">
    <span class="min-w-0 flex-1">
      <span class="block text-[13px] font-medium">{label}</span>
      {#if hint}<span class="mt-px block text-xs text-muted-foreground">{hint}</span>{/if}
    </span>
    <Switch bind:checked {disabled} />
  </label>
{:else}
  <label class="flex cursor-pointer items-start gap-2.5 text-[13px] {cls}">
    <Switch bind:checked {disabled} class="mt-0.5" />
    <span class="flex flex-col">
      <span class="font-medium">{label}</span>
      {#if hint}<span class="text-xs text-muted-foreground">{hint}</span>{/if}
    </span>
  </label>
{/if}
