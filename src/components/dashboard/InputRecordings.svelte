<script lang="ts">
  // An input's recording files, grouped by day: play in the browser or download.
  import Play from '@lucide/svelte/icons/play';
  import Download from '@lucide/svelte/icons/download';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { fmtBytes } from '$lib/format';

  let { id }: { id: string } = $props();
  type Rec = { path: string; name: string; size: number; mtime: number };
  let files = $state<Rec[] | null>(null);
  let error = $state('');
  let playing = $state<Rec | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/inputs/${encodeURIComponent(id)}/recordings`, { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.json()).error);
      files = await r.json();
      error = '';
    } catch (e) { error = (e as Error).message; }
  }
  onMount(load);
  const href = (p: string) => '/api/recordings/' + p.split('/').map(encodeURIComponent).join('/');
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const groups = $derived.by(() => {
    const g = new Map<string, Rec[]>();
    for (const f of files ?? []) {
      const k = day(f.mtime);
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(f);
    }
    return [...g.entries()];
  });
</script>

<div class="flex flex-col gap-3">
  {#if playing}
    <div class="sticky top-16 z-10 rounded-lg border bg-muted p-3">
      <div class="mb-2 truncate font-mono text-xs text-subtle">{playing.name}</div>
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio class="w-full" controls autoplay src={href(playing.path)}></audio>
    </div>
  {/if}
  {#if error}<p class="text-sm text-bad">{error}</p>
  {:else if !files}<p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !files.length}<p class="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">No recordings yet.</p>
  {:else}
    {#each groups as [d, list] (d)}
      <div class="overflow-hidden rounded-lg border">
        <div class="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">{d}</div>
        <ul>
          {#each list as f (f.path)}
            <li class="flex items-center gap-3 border-b px-4 py-2 text-[13px] last:border-b-0 {playing?.path === f.path ? 'bg-muted' : ''}">
              {#if f.name.endsWith('.mka')}
                <span class="inline-flex size-8 flex-none items-center justify-center rounded-full border text-faint" title="Browsers can't play .mka; download it"><Play class="size-3" /></span>
              {:else}
                <button class="inline-flex size-8 flex-none items-center justify-center rounded-full border hover:bg-secondary" aria-label="Play {f.name}" onclick={() => (playing = f)}><Play class="size-3 fill-current" /></button>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-xs">{f.name}</div>
                <div class="text-[11px] text-muted-foreground">until {new Date(f.mtime).toLocaleTimeString()} · {fmtBytes(f.size)}</div>
              </div>
              <Button size="icon-sm" variant="ghost" href={`${href(f.path)}?download=1`} aria-label="Download {f.name}"><Download /></Button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>
