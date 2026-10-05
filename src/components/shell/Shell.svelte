<script lang="ts">
  // App frame: a sidebar (brand, inputs, system pages, service
  // health) and a sticky breadcrumb header on desktop; a compact header, slide-out
  // menu, player bar and bottom tab bar on phones.
  import type { Snippet } from 'svelte';
  import Menu from '@lucide/svelte/icons/menu';
  import LogOut from '@lucide/svelte/icons/log-out';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Settings from '@lucide/svelte/icons/settings';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { live } from '$lib/live.svelte';
  import { player } from '$lib/player.svelte';
  import { fmtUptime } from '$lib/format';
  import { serviceHealth } from '$lib/health';
  import { inputTone } from '$lib/inputs';
  import { DOT } from '../common/StatusBadge.svelte';
  import Hint from '../common/Hint.svelte';
  import Logo from '../common/Logo.svelte';
  import PlayerBar from './PlayerBar.svelte';

  type Page = 'inputs' | 'manual' | 'config';
  let { page, crumbs = [], selected = '', actions, children }: {
    page: Page;
    /** Breadcrumb: section, then page (the last one is emphasised). */
    crumbs?: string[];
    /** Input shown on the dashboard (highlighted in the sidebar). */
    selected?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();

  live.start();
  let menuOpen = $state(false);
  const snap = $derived(live.snapshot);
  const health = $derived(snap ? serviceHealth(snap.services) : []);
  const disk = $derived(snap?.disk && snap.disk.total_gb ? { ...snap.disk, used: Math.round((1 - snap.disk.free_gb / snap.disk.total_gb) * 100) } : null);
  const pages = [
    { id: 'manual', href: '/manual', label: 'Manual', short: 'Manual', icon: BookOpen },
    { id: 'config', href: '/config', label: 'Configuration', short: 'Config', icon: Settings },
  ] as const;

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  }
</script>

{#snippet navList(compact: boolean)}
  <div class="flex flex-col gap-0.5">
    <div class="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">Inputs</div>
    {#each snap?.inputs ?? [] as inp (inp.id)}
      {@const active = page === 'inputs' && selected === inp.id}
      <a href="/#{inp.id}" onclick={() => (menuOpen = false)} aria-current={active ? 'page' : undefined}
        class="flex items-center gap-2.5 rounded-md p-2 {active ? 'bg-muted text-foreground' : 'text-subtle hover:bg-muted hover:text-foreground'}">
        <span class="size-1.5 flex-none rounded-full {DOT[inputTone(inp)]}"></span>
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{inp.name}</span>
        {#if inp.faults.length}<span class="font-mono text-[11px] text-bad">{inp.faults.length}</span>{/if}
      </a>
    {:else}
      <a href="/config#inputs" class="rounded-md p-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">{snap ? 'No inputs yet' : 'Loading…'}</a>
    {/each}
    <div class="px-2 pt-4 pb-1 text-[11px] font-medium text-muted-foreground">System</div>
    {#each pages as p (p.id)}
      <a href={p.href} aria-current={page === p.id ? 'page' : undefined}
        class="flex items-center gap-2.5 rounded-md p-2 text-[13px] font-medium {page === p.id ? 'bg-muted text-foreground' : 'text-subtle hover:bg-muted hover:text-foreground'}">
        {#if compact}<p.icon class="size-4" />{/if}
        <span class="flex-1">{p.label}</span>
      </a>
    {/each}
  </div>
{/snippet}

{#snippet healthList()}
  <div class="flex flex-col gap-2">
    {#if disk}
      <Hint text="Recordings disk: {disk.free_gb} GB free of {disk.total_gb} GB" class="w-full">
        <div class="flex w-full flex-col gap-1.5">
          <div class="flex items-center gap-2 text-xs text-subtle">
            <span class="flex-1">Disk free</span>
            <span class="font-mono text-[11px] {disk.used > 90 ? 'text-bad' : 'text-muted-foreground'}">{disk.free_gb} GB</span>
          </div>
          <div class="h-1 w-full rounded-full bg-border" role="meter" aria-label="Recordings disk used" aria-valuenow={disk.used} aria-valuemin={0} aria-valuemax={100}>
            <div class="h-full rounded-full {disk.used > 90 ? 'bg-bad' : 'bg-foreground'}" style="width:{disk.used}%"></div>
          </div>
        </div>
      </Hint>
    {/if}
    {#each health as h (h.name)}
      <Hint text={h.title} class="w-full">
        <div class="flex w-full items-center gap-2 text-xs text-subtle">
          <span class="size-1.5 rounded-full {DOT[h.tone]}"></span>
          <span class="flex-1">{h.name}</span>
          <span class="font-mono text-[11px] {h.tone === 'bad' ? 'text-bad' : 'text-muted-foreground'}">{h.state}</span>
        </div>
      </Hint>
    {/each}
  </div>
{/snippet}

<Tooltip.Provider>
  <Toaster richColors position="bottom-right" />
  <div class="flex min-h-svh">
    <aside class="sticky top-0 hidden h-svh w-60 flex-none flex-col border-r md:flex">
      <a href="/" class="flex h-14 flex-none items-center gap-2.5 px-4">
        <Logo size={28} />
        <span class="min-w-0">
          <span class="block text-sm font-semibold">Towerlog</span>
          <span class="block truncate text-[11px] text-muted-foreground">{snap?.hostname ?? ''}</span>
        </span>
      </a>
      <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{@render navList(false)}</nav>
      <div class="flex flex-col gap-3 border-t p-4">
        <PlayerBar />
        {@render healthList()}
        <div class="mt-1 flex items-center gap-2 font-mono text-[10px] text-faint">
          <Hint text={live.connected ? 'Live data connected' : 'Reconnecting to the server…'}>
            <span class="size-1.5 rounded-full {live.connected ? 'bg-ok' : 'bg-bad'}"></span>
          </Hint>
          <span class="min-w-0 flex-1 truncate">{snap ? `v${snap.version} · up ${fmtUptime(snap.uptime_s)}${snap.demo ? ' · demo mode' : ''}` : 'connecting…'}</span>
          <Hint text="Log out">
            <button class="rounded p-0.5 text-muted-foreground hover:text-foreground" onclick={logout} aria-label="Log out"><LogOut class="size-3.5" /></button>
          </Hint>
        </div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col {player.current ? 'max-md:pb-[calc(136px+env(safe-area-inset-bottom))]' : 'max-md:pb-[calc(56px+env(safe-area-inset-bottom))]'}">
      <!-- Desktop header: breadcrumb + page actions. -->
      <header class="sticky top-0 z-20 hidden h-14 flex-none items-center gap-3 border-b bg-background/95 px-6 backdrop-blur md:flex">
        {#each crumbs as c, i (i)}
          {#if i}<span class="text-[#3f3f46]">/</span>{/if}
          <span class="truncate text-[13px] {i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground'}">{c}</span>
        {/each}
        <div class="ml-auto flex items-center gap-2">{@render actions?.()}</div>
      </header>

      <!-- Phone header. -->
      <header class="sticky top-0 z-20 flex h-[52px] flex-none items-center gap-2.5 bg-background/95 pr-2 pl-4 backdrop-blur md:hidden">
        <a href="/" class="flex items-center gap-2.5"><Logo size={24} /><span class="text-sm font-semibold">Towerlog</span></a>
        {#if crumbs.length && page !== 'inputs'}<span class="text-[#3f3f46]">/</span><span class="truncate text-[13px] font-medium">{crumbs[crumbs.length - 1]}</span>{/if}
        <span class="ml-auto size-1.5 rounded-full {live.connected ? 'bg-ok' : 'bg-bad'}" title={live.connected ? 'live' : 'reconnecting…'}></span>
        <Sheet.Root bind:open={menuOpen}>
          <Sheet.Trigger>
            {#snippet child({ props })}
              <button {...props} aria-label="Menu" class="inline-flex size-11 items-center justify-center text-subtle"><Menu class="size-[18px]" /></button>
            {/snippet}
          </Sheet.Trigger>
          <Sheet.Content side="right" class="w-72 gap-0 p-0">
            <Sheet.Header class="flex-row items-center gap-2.5 p-4">
              <Logo size={28} />
              <div><Sheet.Title class="text-sm">Towerlog</Sheet.Title><Sheet.Description class="text-[11px]">{snap?.hostname ?? ''}</Sheet.Description></div>
            </Sheet.Header>
            <nav class="px-2">{@render navList(true)}</nav>
            <div class="mt-auto flex flex-col gap-3 border-t p-4">
              {@render healthList()}
              <button class="flex items-center gap-2 text-[13px] text-subtle hover:text-foreground" onclick={logout}><LogOut class="size-4" /> Log out</button>
            </div>
          </Sheet.Content>
        </Sheet.Root>
      </header>

      <main class="flex min-w-0 flex-1 flex-col">{@render children()}</main>
    </div>
  </div>

  <!-- Phone: player above a bottom tab bar. -->
  <div class="fixed inset-x-0 bottom-0 z-30 flex flex-col md:hidden">
    <PlayerBar class="mx-2 mb-2 shadow-lg shadow-black/50" volume={false} />
    <nav class="grid h-14 grid-cols-3 border-t bg-background pb-[env(safe-area-inset-bottom)]" aria-label="Sections">
      <a href="/" class="flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium {page === 'inputs' ? 'text-foreground' : 'text-muted-foreground'}"><AudioLines class="size-[18px]" />Inputs</a>
      {#each pages as p (p.id)}
        <a href={p.href} class="relative flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium {page === p.id ? 'text-foreground' : 'text-muted-foreground'}">
          <p.icon class="size-[18px]" />{p.short}
        </a>
      {/each}
    </nav>
  </div>
</Tooltip.Provider>
