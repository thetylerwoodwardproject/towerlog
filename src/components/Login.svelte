<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Logo from './common/Logo.svelte';
  import { safeNext } from '../lib/redirect.ts';

  /** setup: no password yet; it is set on the host, so this page only says how. */
  let { setup, next }: { setup: boolean; next: string } = $props();
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      location.href = safeNext(next);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-svh items-center justify-center p-4">
  <div class="flex w-full max-w-sm flex-col gap-6">
    <div class="flex items-center gap-3">
      <Logo size={40} />
      <div class="text-xl font-semibold tracking-[-0.4px]">Towerlog</div>
    </div>
    <div class="rounded-lg border p-5">
      {#if setup}
        <h1 class="text-base font-medium">Set a password first</h1>
        <p class="mt-1 text-[13px] text-subtle">No web UI password is set yet. On the Towerlog host, run:</p>
        <pre class="mt-3 rounded bg-muted px-3 py-2 font-mono text-[13px]">sudo towerlog password</pre>
        <p class="mt-3 text-[13px] text-subtle">Then reload this page and log in.</p>
      {:else}
        <h1 class="text-base font-medium">Log in</h1>
        <p class="mt-1 text-[13px] text-subtle">Log in to manage your inputs.</p>
        <form class="mt-5 flex flex-col gap-4" onsubmit={submit}>
          <div class="flex flex-col gap-1.5">
            <Label for="pw" class="text-[13px]">Password</Label>
            <Input id="pw" class="h-9" type="password" autocomplete="current-password" bind:value={password} required />
          </div>
          {#if error}<p role="alert" class="text-[13px] text-bad">{error}</p>{/if}
          <Button type="submit" class="h-9" disabled={busy}>Log in</Button>
        </form>
      {/if}
    </div>
    <p class="text-center font-mono text-[11px] text-faint">Broadcast audio logger</p>
  </div>
</div>
