<script lang="ts">
  // shadcn Select for a plain list of [value, label] options (string or number values).
  import * as Select from '$lib/components/ui/select/index.js';
  let { value = $bindable(), options, disabled = false, onchange, class: cls = '' }: {
    value: string | number;
    options: [value: string | number, label: string][];
    disabled?: boolean;
    onchange?: () => void;
    class?: string;
  } = $props();
  const numeric = $derived(typeof options[0]?.[0] === 'number');
  const label = $derived(options.find(([v]) => String(v) === String(value))?.[1] ?? 'select…');
</script>

<Select.Root type="single" {disabled} value={String(value)}
  onValueChange={(v: string) => { value = numeric ? Number(v) : v; onchange?.(); }}>
  <Select.Trigger class="h-9 w-full font-mono text-[13px] font-normal normal-case tracking-normal data-[size=default]:h-9 {cls}">
    <span class="truncate">{label}</span>
  </Select.Trigger>
  <Select.Content>
    {#each options as [v, l] (v)}
      <Select.Item value={String(v)} label={l} class="font-mono text-xs">{l}</Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
