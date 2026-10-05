<script lang="ts">
  // Host network: interfaces (DHCP / static, with automatic rollback), Wi-Fi,
  // and host name. Addresses change through NetworkManager, or through the
  // towerlog-netapply helper on hosts using netplan, systemd-networkd, ifupdown or
  // dhcpcd; view-only when neither is available. Wi-Fi needs NetworkManager.
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Lock from '@lucide/svelte/icons/lock';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { attempt, del, get, post, put } from '$lib/api';
  import Section from './Section.svelte';
  import Panel from './Panel.svelte';
  import Field from './Field.svelte';
  import Segmented from '../common/Segmented.svelte';
  import StatusBadge from '../common/StatusBadge.svelte';

  type Iface = { device: string; type: string; state: string; mac: string; connection: string; method: 'auto' | 'manual' | 'unknown'; ipv4: string[]; ipv6: string[]; gateway: string; dns: string[] };
  type Status = { available: boolean; reason: string; backend: string; backend_name: string; wifi: boolean; hostname: string; interfaces: Iface[]; time: { timezone: string; ntp: boolean; synchronized: boolean; servers: string[] }; pending: { until: number } | null };
  type Wifi = { ssid: string; signal: number; security: string; active: boolean };
  type Draft = { method: 'auto' | 'manual'; address: string; gateway: string; dns: string };

  let s = $state<Status | null>(null);
  let drafts = $state<Record<string, Draft>>({});
  let wifi = $state<Wifi[] | null>(null);
  let scanning = $state(false);
  let joining = $state<Wifi | null>(null);
  let wifiPw = $state('');
  let hostname = $state('');
  let now = $state(Date.now());
  const IN = 'h-9 font-mono text-[13px]';

  async function load() {
    const r = await attempt('Network', () => get<Status>('/api/network'));
    if (!r) return;
    s = r;
    hostname = r.hostname;
    for (const i of r.interfaces) {
      drafts[i.device] ??= { method: i.method === 'manual' ? 'manual' : 'auto', address: i.ipv4[0] ?? '', gateway: i.gateway, dns: i.dns.join(', ') };
    }
  }
  onMount(() => {
    load();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const left = $derived(s?.pending ? Math.max(0, Math.round((s.pending.until - now) / 1000)) : 0);
  $effect(() => { if (s?.pending && left === 0) { s.pending = null; load(); } });

  async function applyIp(i: Iface) {
    const d = drafts[i.device];
    const ok = confirm(`Apply ${d.method === 'auto' ? 'DHCP' : d.address} to ${i.device}? If you can't reach Towerlog afterwards, the change rolls back by itself in 90 seconds.`);
    if (!ok) return;
    const r = await attempt('IPv4', () => put<{ until: number }>(`/api/network/ipv4/${encodeURIComponent(i.device)}`, {
      method: d.method, address: d.address, gateway: d.gateway, dns: d.dns.split(/[\s,]+/).filter(Boolean),
    }));
    if (r && s) s.pending = { until: r.until };
  }
  async function confirmChange(keep: boolean) {
    await attempt('Network', () => post('/api/network/confirm', { keep }), keep ? 'Network settings kept' : 'Rolled back');
    load();
  }
  async function scan() {
    scanning = true;
    wifi = (await attempt('Wi-Fi scan', () => get<Wifi[]>('/api/network/wifi'))) ?? wifi;
    scanning = false;
  }
  async function join() {
    if (!joining) return;
    const ok = await attempt('Wi-Fi', () => post('/api/network/wifi', { ssid: joining!.ssid, password: wifiPw }), `Joined ${joining.ssid}`);
    if (ok !== undefined) { joining = null; wifiPw = ''; scan(); load(); }
  }
  const forget = async (con: string) => { if (confirm(`Forget ${con}?`)) { await attempt('Wi-Fi', () => del(`/api/network/wifi/${encodeURIComponent(con)}`), `Forgot ${con}`); load(); } };
  const saveHostname = () => attempt('Host name', () => put('/api/network/hostname', { hostname }), 'Host name saved');
  const bars = (sig: number) => (sig >= 75 ? 4 : sig >= 50 ? 3 : sig >= 25 ? 2 : 1);
</script>

<Section title="Network" description={s ? `Addresses, Wi-Fi and host name for this Towerlog. Managed by ${s.backend_name}.` : 'Addresses, Wi-Fi and host name for this Towerlog.'} wide>
  {#snippet actions()}
    <Button variant="outline" class="h-8 px-3" onclick={load}><RefreshCw /> Refresh</Button>
  {/snippet}

  {#if s?.pending}
    <div role="alert" class="flex flex-wrap items-center gap-3 rounded-lg border border-warn/50 px-4 py-3 text-[13px]">
      <span class="min-w-0 flex-1"><span class="font-medium text-warn">Keep these network settings?</span>
        <span class="text-subtle">They roll back in {left}s unless you keep them.</span></span>
      <Button size="sm" onclick={() => confirmChange(true)}>Keep</Button>
      <Button size="sm" variant="outline" onclick={() => confirmChange(false)}>Revert now</Button>
    </div>
  {/if}

  {#if s && !s.available}
    <div class="rounded-lg border px-4 py-3 text-[13px] text-subtle">
      <span class="font-medium text-foreground">View only.</span> {s.reason}.
      {#if s.backend === 'none' || s.backend === 'nm'}
        To change addresses here, re-run <code class="font-mono text-xs text-soft">sudo ./deploy/install.sh --network-manager</code> from a local console (it hands the interfaces over to NetworkManager).
      {:else}
        Re-run <code class="font-mono text-xs text-soft">sudo ./deploy/install.sh</code> to install the network helper for {s.backend_name}.
      {/if}
    </div>
  {/if}

  {#if !s}
    <Skeleton class="h-48 w-full rounded-lg" />
  {:else}
    <div class="flex flex-col gap-5">
      {#each s.interfaces as i (i.device)}
        {@const d = drafts[i.device]}
        {@const editable = s.available && !!d && (s.backend !== 'nm' || !!i.connection)}
        <Panel>
          {#snippet head()}
            <h2 class="font-mono text-sm font-medium">{i.device}</h2>
            <span class="text-xs text-muted-foreground">{i.type}{i.connection ? ` · ${i.connection}` : ''}{i.method !== 'unknown' ? ` · ${i.method === 'auto' ? 'DHCP' : 'static'}` : ''}</span>
            <StatusBadge tone={/^(connected|up)/.test(i.state) ? 'ok' : 'muted'} class="ml-auto">{i.state || 'unknown'}</StatusBadge>
          {/snippet}
          <div class="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <dl class="grid grid-cols-[88px_minmax(0,1fr)] content-start gap-x-4 gap-y-2 px-5 py-4 text-[13px] max-sm:px-4">
              <dt class="text-muted-foreground">IPv4</dt><dd class="font-mono text-xs leading-5 break-all text-soft">{i.ipv4.join(', ') || '—'}</dd>
              <dt class="text-muted-foreground">Gateway</dt><dd class="font-mono text-xs leading-5 text-soft">{i.gateway || '—'}</dd>
              <dt class="text-muted-foreground">DNS</dt><dd class="font-mono text-xs leading-5 break-all text-soft">{i.dns.join(', ') || '—'}</dd>
              {#if i.ipv6.length}<dt class="text-muted-foreground">IPv6</dt><dd class="font-mono text-xs leading-5 break-all text-muted-foreground">{i.ipv6.join(', ')}</dd>{/if}
              {#if i.mac}<dt class="text-muted-foreground">MAC</dt><dd class="font-mono text-xs leading-5 text-faint">{i.mac}</dd>{/if}
            </dl>
            <div class="flex flex-col gap-4 border-t px-5 py-4 max-sm:px-4 lg:border-t-0 lg:border-l">
              {#if editable}
                <Segmented label="IPv4 method for {i.device}" bind:value={d.method} options={[{ value: 'auto', label: 'DHCP' }, { value: 'manual', label: 'Static' }]} />
                {#if d.method === 'manual'}
                  <div class="grid gap-4 sm:grid-cols-2">
                    <Field label="Address / prefix" hint="e.g. 192.168.1.50/24"><Input class={IN} bind:value={d.address} /></Field>
                    <Field label="Gateway"><Input class={IN} bind:value={d.gateway} /></Field>
                    <Field label="DNS servers" hint="Comma separated" class="sm:col-span-2"><Input class={IN} bind:value={d.dns} /></Field>
                  </div>
                {/if}
                <div class="mt-auto"><Button class="h-9 px-4" disabled={!!s.pending} onclick={() => applyIp(i)}>Apply</Button></div>
              {:else}
                <p class="text-[13px] text-muted-foreground">{!s.available ? 'Read only on this host.' : 'Not managed by NetworkManager.'}</p>
              {/if}
            </div>
          </div>
        </Panel>
      {:else}
        <p class="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">No network interfaces found.</p>
      {/each}
    </div>

    <Panel title="Host name" class="max-w-xl">
      <form class="flex flex-col gap-4 p-5 max-sm:p-4" onsubmit={(e) => { e.preventDefault(); saveHostname(); }}>
        <Field label="Host name" hint="Letters, digits and hyphens"><Input class={IN} bind:value={hostname} /></Field>
        <div class="mt-auto"><Button type="submit" class="h-9 px-4">Save host name</Button></div>
      </form>
    </Panel>

    <Panel title="Wi-Fi">
      {#snippet head()}
        {#if s?.wifi}<Button size="sm" variant="outline" class="ml-auto -my-1" disabled={scanning} onclick={scan}>{scanning ? 'Scanning…' : 'Scan'}</Button>{/if}
      {/snippet}
      {#if !s.wifi}
        <p class="px-5 py-4 text-[13px] text-muted-foreground max-sm:px-4">Joining Wi-Fi from here needs NetworkManager{s.backend !== 'nm' ? ` (this host uses ${s.backend_name}; set Wi-Fi up with raspi-config or wpa_supplicant)` : ''}.</p>
      {:else if wifi === null}
        <p class="px-5 py-4 text-[13px] text-muted-foreground max-sm:px-4">Scan to see nearby networks.</p>
      {:else}
        {#each wifi as w (w.ssid)}
          <div class="flex items-center gap-3 border-b px-5 py-2.5 text-[13px] last:border-b-0 max-sm:px-4">
            <span class="flex h-3.5 items-end gap-0.5" aria-label="signal {w.signal}%">
              {#each [1, 2, 3, 4] as b (b)}<span class="w-[3px] rounded-sm {b <= bars(w.signal) ? 'bg-foreground' : 'bg-border'}" style="height:{b * 25}%"></span>{/each}
            </span>
            <span class="min-w-0 flex-1 truncate">{w.ssid}</span>
            {#if w.security}<Lock class="size-3.5 text-muted-foreground" />{/if}
            {#if w.active}
              <StatusBadge tone="ok">connected</StatusBadge>
              <Button size="sm" variant="ghost" onclick={() => forget(w.ssid)}>Forget</Button>
            {:else}
              <Button size="sm" variant="outline" onclick={() => { joining = w; wifiPw = ''; }}>Connect</Button>
            {/if}
          </div>
          {#if joining?.ssid === w.ssid}
            <form class="flex gap-2 border-b bg-muted/40 px-5 py-3 max-sm:px-4" onsubmit={(e) => { e.preventDefault(); join(); }}>
              {#if w.security}<Input class="h-9 flex-1" type="password" placeholder="Password" bind:value={wifiPw} autocomplete="off" />{/if}
              <Button type="submit" class="h-9">Join</Button>
              <Button variant="ghost" class="h-9" onclick={() => (joining = null)}>Cancel</Button>
            </form>
          {/if}
        {:else}
          <p class="px-5 py-4 text-[13px] text-muted-foreground max-sm:px-4">No networks found.</p>
        {/each}
      {/if}
    </Panel>
  {/if}
</Section>
