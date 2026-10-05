<script lang="ts" module>
  import type { Tone } from '$lib/health';
  export type { Tone };
  export const DOT: Record<Tone, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    bad: 'bg-bad',
    info: 'bg-info',
    muted: 'bg-faint',
  };
</script>

<script lang="ts">
  // Status pill: hairline border, soft text and a dot in the status colour.
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  let { tone = 'muted', dot = true, class: cls = '', title = undefined, children }: { tone?: Tone; dot?: boolean; class?: string; title?: string; children: Snippet } = $props();
</script>

<span {title} class={cn('pill whitespace-nowrap', cls)}>
  {#if dot}<span class="size-1.5 flex-none rounded-full {DOT[tone]}"></span>{/if}{@render children()}
</span>
