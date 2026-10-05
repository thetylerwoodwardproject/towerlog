<script lang="ts">
  // Manual search: hides the sections that don't mention the query ("/" focuses it).
  import Search from '@lucide/svelte/icons/search';
  import { onMount } from 'svelte';

  let q = $state('');
  let input = $state<HTMLInputElement>();
  let matches = $state<number | null>(null);

  function apply(query: string) {
    const needle = query.trim().toLowerCase();
    let n = 0;
    for (const sec of document.querySelectorAll<HTMLElement>('[data-manual-section]')) {
      const hit = !needle || (sec.textContent ?? '').toLowerCase().includes(needle);
      sec.hidden = !hit;
      if (hit) n++;
    }
    matches = needle ? n : null;
    dispatchEvent(new CustomEvent('manual-filter', { detail: needle }));
  }
  // Keep every copy of the box (header and phone) in step.
  onMount(() => {
    const onFilter = (e: Event) => { const d = (e as CustomEvent<string>).detail; if (d !== q.trim().toLowerCase()) q = d; };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && input?.offsetParent) { e.preventDefault(); input.focus(); }
    };
    addEventListener('manual-filter', onFilter);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('manual-filter', onFilter); removeEventListener('keydown', onKey); };
  });
</script>

<label class="flex h-8 w-full items-center gap-2 rounded-md border px-2.5 text-[13px] text-muted-foreground focus-within:border-ring md:w-[280px]">
  <Search class="size-3.5 flex-none" />
  <input bind:this={input} bind:value={q} oninput={() => apply(q)} onkeydown={(e) => { if (e.key === 'Escape') { q = ''; apply(''); input?.blur(); } }}
    type="search" placeholder="Search the manual…" aria-label="Search the manual"
    class="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
  {#if matches !== null}<span class="font-mono text-[10px]">{matches} section{matches === 1 ? '' : 's'}</span>
  {:else}<kbd class="rounded border px-1.5 py-px font-mono text-[10px] max-md:hidden">/</kbd>{/if}
</label>
