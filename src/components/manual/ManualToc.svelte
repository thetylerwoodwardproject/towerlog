<script lang="ts">
  // Manual contents: numbered sections, the one being read highlighted, sections
  // filtered out by the search dimmed.
  import { onMount } from 'svelte';
  let { toc }: { toc: string[][] } = $props();
  let current = $state('');
  let hidden = $state<Set<string>>(new Set());

  onMount(() => {
    const secs = [...document.querySelectorAll<HTMLElement>('[data-manual-section]')];
    const spy = () => {
      let id = secs.find((s) => !s.hidden)?.id ?? '';
      for (const s of secs) if (!s.hidden && s.getBoundingClientRect().top < 120) id = s.id;
      current = id;
    };
    const onFilter = () => { hidden = new Set(secs.filter((s) => s.hidden).map((s) => s.id)); spy(); };
    spy();
    addEventListener('scroll', spy, { passive: true });
    addEventListener('manual-filter', onFilter);
    return () => { removeEventListener('scroll', spy); removeEventListener('manual-filter', onFilter); };
  });
</script>

<nav aria-label="Contents" class="sticky top-14 hidden h-[calc(100svh-56px)] w-[260px] flex-none flex-col gap-0.5 overflow-y-auto border-r px-3 py-6 lg:flex">
  <div class="px-2.5 pb-2 text-[11px] font-medium text-muted-foreground">Contents</div>
  {#each toc as [id, label], i (id)}
    <a href="#{id}" aria-current={current === id ? 'location' : undefined}
      class="flex gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium {current === id ? 'bg-muted text-foreground' : 'text-subtle hover:bg-muted hover:text-foreground'} {hidden.has(id) ? 'pointer-events-none opacity-30' : ''}">
      <span class="w-[18px] flex-none font-mono text-[11px] leading-5 text-faint">{i + 1}</span>{label}
    </a>
  {/each}
</nav>
