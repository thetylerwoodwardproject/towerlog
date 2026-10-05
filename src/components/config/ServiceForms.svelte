<script lang="ts">
  // Zabbix, Email and SNMP settings pages.
  import Download from '@lucide/svelte/icons/download';
  import Send from '@lucide/svelte/icons/send';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { attempt, post, put } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { fmtAgo } from '$lib/format';
  import Field from './Field.svelte';
  import FormSelect from '../common/FormSelect.svelte';
  import Toggle from './Toggle.svelte';
  import Section from './Section.svelte';
  import Panel from './Panel.svelte';

  type Cfg = Record<string, Record<string, unknown>>;
  let { config, section }: { config: Cfg; section: 'zabbix' | 'smtp' | 'snmp' } = $props();
  // svelte-ignore state_referenced_locally
  let f = $state(structuredClone($state.snapshot(config[section])) as Record<string, any>);
  let busy = $state(false);
  let testTo = $state('');
  const svc = $derived(live.snapshot?.services);
  const IN = 'h-9 font-mono text-[13px]';
  const GRID = 'grid gap-x-5 gap-y-[18px] p-5 max-sm:p-4 sm:grid-cols-2';

  async function save() {
    busy = true;
    const out = await attempt('Save', () => put<Record<string, unknown>>(`/api/${section}`, $state.snapshot(f)), 'Saved');
    if (out) f = out as Record<string, any>;
    busy = false;
  }
  const testEmail = () => attempt('Test email', () => post<{ sent_to: string[] }>('/api/smtp/test', { to: testTo }), 'Test email sent');
  const testSnmp = () => attempt('SNMP test', async () => {
    const r = await post<{ results: string[] }>('/api/snmp/test');
    const bad = r.results.filter((l) => /failed/.test(l));
    if (bad.length) throw new Error(bad.join('; '));
    return r;
  }, 'Test trap sent to every destination');
  const addTrap = () => { f.traps = [...(f.traps ?? []), { host: '', port: 162, version: 'v2c', community: 'public' }]; };
  const testZabbix = () => attempt('Zabbix test', () => post<{ info: string }>('/api/zabbix/test'), 'Zabbix accepted the test values');
</script>

{#snippet master(label: string, status: string, bad = false)}
  <div class="rounded-lg border px-4 py-3.5">
    <Toggle bind:checked={f.enabled} {label} />
    {#if status}<div class="mt-0.5 text-xs {bad ? 'text-bad' : 'text-muted-foreground'}">{status}</div>{/if}
  </div>
{/snippet}

{#if section === 'zabbix'}
  <Section title="Zabbix" description="Pushes fault events, per-input items and a heartbeat with the Zabbix trapper protocol (TCP 10051). Import the template on the Zabbix server and attach it to a host named like Host name below.">
    {@render master('Send data to Zabbix', svc?.zabbix.enabled ? `Last accepted ${fmtAgo(svc.zabbix.last_ok)}${svc.zabbix.last_error ? ' · ' + svc.zabbix.last_error : ''}` : 'Inactive: Zabbix is turned off', !!svc?.zabbix.last_error)}
    <Panel title="Server">
      <div class={GRID}>
        <Field label="Zabbix server"><Input class={IN} bind:value={f.server} placeholder="zabbix.example.com" /></Field>
        <Field label="Trapper port"><Input class={IN} type="number" bind:value={f.port} /></Field>
        <Field label="Host name" hint="The Zabbix host the template is attached to"><Input class={IN} bind:value={f.hostname} /></Field>
        <Field label="Snapshot interval (s)" hint="Also the heartbeat"><Input class={IN} type="number" min="10" bind:value={f.interval} /></Field>
      </div>
      <div class="border-t px-5 py-3 max-sm:px-4">
        <Toggle bind:checked={f.level_monitor} label="Send audio levels" hint="Each input's dBFS every 10 s" />
      </div>
    </Panel>
    <Panel>
      <details class="group">
        <summary class="cursor-pointer px-5 py-4 text-sm font-medium max-sm:px-4">Item keys <span class="text-xs font-normal text-muted-foreground">must match the template</span></summary>
        <div class="{GRID} border-t">
          <Field label="Event key"><Input class={IN} bind:value={f.key_event} /></Field>
          <Field label="Inputs-live key"><Input class={IN} bind:value={f.key_active} /></Field>
          <Field label="Heartbeat key"><Input class={IN} bind:value={f.key_heartbeat} /></Field>
          <Field label="EAS tone key"><Input class={IN} bind:value={f.key_eas} /></Field>
        </div>
      </details>
    </Panel>
    <div class="flex flex-wrap items-center gap-2">
      <Button class="h-9 px-4" disabled={busy} onclick={save}>Save Zabbix</Button>
      <Button variant="outline" class="h-9 px-3.5 sm:ml-auto" onclick={testZabbix}><Send /> Send test values</Button>
      <Button variant="outline" class="h-9 px-3.5" href="/api/zabbix/template"><Download /> Download template</Button>
    </div>
  </Section>

{:else if section === 'smtp'}
  <Section title="Email alerts" description="Emails when an input raises or clears a fault (feed lost, silence, clipping, mono, phase), on low disk space and on service start/stop.">
    {@render master('Send email alerts', svc ? (svc.smtp.enabled ? `Active · last sent ${fmtAgo(svc.smtp.last_sent)}${svc.smtp.last_error ? ' · ' + svc.smtp.last_error : ''}` : `Inactive: ${svc.smtp.problem}`) : '', !!svc?.smtp.last_error)}
    <Panel title="SMTP server">
      <div class={GRID}>
        <Field label="SMTP server"><Input class={IN} bind:value={f.host} placeholder="smtp.example.com" /></Field>
        <Field label="Port"><Input class={IN} type="number" bind:value={f.port} /></Field>
        <Field label="Security">
          <FormSelect bind:value={f.security} options={[['starttls', 'STARTTLS (usually 587)'], ['ssl', 'SSL/TLS (usually 465)'], ['none', 'None (internal relay)']]} />
        </Field>
        <Field label="Username" hint="Blank if no login"><Input class={IN} bind:value={f.username} autocomplete="off" /></Field>
        <Field label="Password"><Input class={IN} type="password" bind:value={f.password} autocomplete="new-password" /></Field>
        <Field label="From" hint={'Default towerlog@<hostname>'}><Input class={IN} bind:value={f.from} placeholder="towerlog@hostname" /></Field>
        <Field label="To" hint="Comma separated"><Input class={IN} bind:value={f.to} /></Field>
        <Field label="Subject prefix"><Input class={IN} bind:value={f.subject_prefix} /></Field>
        <Field label="Timeout (s)"><Input class={IN} type="number" bind:value={f.timeout} /></Field>
        <Field label="Low disk alert (GB)" hint="Only while an input records"><Input class={IN} type="number" step="0.5" bind:value={f.disk_min_gb} /></Field>
      </div>
    </Panel>
    <Panel title="Notify on">
      {#each [
        ['alert_input', 'Input faults raised / cleared'],
        ['alert_eas', 'EAS tones and messages'],
        ['alert_disk', 'Low recording disk space'],
        ['alert_service', 'Service started / stopped'],
      ] as [k, label] (k)}
        <div class="border-b px-5 py-3 max-sm:px-4"><Toggle bind:checked={f[k]} {label} /></div>
      {/each}
      <div class="px-5 py-3 max-sm:px-4"><Toggle bind:checked={f.verify_tls} label="Verify the server’s TLS certificate" hint="Turn off only for an internal relay with a self-signed certificate" /></div>
    </Panel>
    <div class="flex flex-wrap items-center gap-2">
      <Button class="h-9 px-4" disabled={busy} onclick={save}>Save email</Button>
      <Input class="h-9 w-full text-[13px] sm:ml-auto sm:w-[240px]" bind:value={testTo} placeholder="Test address (default: To)" aria-label="Test address" />
      <Button variant="outline" class="h-9 px-3.5" onclick={testEmail}><Send /> Send test email</Button>
      <p class="w-full text-right text-xs text-muted-foreground max-sm:text-left">Save first: the test uses the saved settings.</p>
    </div>
  </Section>

{:else if section === 'snmp'}
  <Section title="SNMP" description="Answers GET / GETNEXT / GETBULK for the TOWERLOG-MIB (enterprise 99999) and sends traps for input faults, disk space and service start/stop. Read-only: SET requests are refused.">
    {@render master('Enable the SNMP agent and traps', svc?.snmp?.enabled ? (svc.snmp.error ? `Error: ${svc.snmp.error}` : `${svc.snmp.listening ? 'Listening' : 'Starting'} · ${svc.snmp.requests} requests · ${svc.snmp.traps_sent} traps sent${svc.snmp.last_trap_error ? ' · ' + svc.snmp.last_trap_error : ''}`) : 'Inactive: SNMP is turned off', !!(svc?.snmp?.error || svc?.snmp?.last_trap_error))}
    <Panel title="Agent" sub="SNMPv2c">
      <div class={GRID}>
        <Field label="UDP port" hint="161 is standard"><Input class={IN} type="number" bind:value={f.port} /></Field>
        <Field label="Listen address" hint="0.0.0.0 = every interface"><Input class={IN} bind:value={f.bind} /></Field>
        <Field label="Read-only community" hint="Blank turns v2c off (v3 only)"><Input class={IN} bind:value={f.community} autocomplete="off" /></Field>
        <Field label="Allowed managers" hint="Comma-separated IPs or CIDRs; blank = anyone"><Input class={IN} bind:value={f.allow} placeholder="10.0.0.0/8, 192.0.2.10" /></Field>
      </div>
    </Panel>
    <Panel title="SNMPv3" sub="User-based security, also used for v3 traps">
      <div class="border-b px-5 py-3 max-sm:px-4"><Toggle bind:checked={f.v3_enabled} label="Enable SNMPv3" /></div>
      {#if f.v3_enabled}
        <div class={GRID}>
          <Field label="User name"><Input class={IN} bind:value={f.v3_user} autocomplete="off" /></Field>
          <Field label="Authentication">
            <FormSelect bind:value={f.v3_auth} options={[['sha', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']]} />
          </Field>
          <Field label="Auth key" hint="At least 8 characters"><Input class={IN} type="password" bind:value={f.v3_auth_key} autocomplete="new-password" /></Field>
          <Field label="Privacy">
            <FormSelect bind:value={f.v3_priv} options={[['aes', 'AES-128 (authPriv)'], ['none', 'None (authNoPriv)']]} />
          </Field>
          {#if f.v3_priv === 'aes'}<Field label="Privacy key" hint="At least 8 characters"><Input class={IN} type="password" bind:value={f.v3_priv_key} autocomplete="new-password" /></Field>{/if}
          <Field label="Engine ID" hint="Receivers of v3 traps need this"><Input class={IN} readonly value={svc?.snmp?.engine_id ?? ''} /></Field>
        </div>
      {/if}
    </Panel>
    <Panel title="Trap destinations" sub="Up to 4">
      {#each f.traps ?? [] as t, i (i)}
        <div class="grid gap-3 border-b px-5 py-4 max-sm:px-4 sm:grid-cols-[minmax(0,1.6fr)_90px_110px_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Host"><Input class={IN} bind:value={t.host} placeholder="nms.example.com" /></Field>
          <Field label="Port"><Input class={IN} type="number" bind:value={t.port} /></Field>
          <Field label="Version"><FormSelect bind:value={t.version} options={[['v2c', 'v2c'], ['v3', 'v3']]} /></Field>
          {#if t.version === 'v2c'}<Field label="Community"><Input class={IN} bind:value={t.community} /></Field>{:else}<div class="pb-2 text-xs text-muted-foreground">Uses the SNMPv3 user above</div>{/if}
          <Button variant="ghost" class="h-9 text-muted-foreground hover:text-bad" onclick={() => (f.traps = f.traps.filter((_: unknown, j: number) => j !== i))}>Remove</Button>
        </div>
      {:else}
        <p class="border-b px-5 py-4 text-[13px] text-muted-foreground max-sm:px-4">No destinations: the agent answers GETs but sends no traps.</p>
      {/each}
      <div class="px-5 py-3 max-sm:px-4"><Button variant="outline" class="h-8" disabled={(f.traps?.length ?? 0) >= 4} onclick={addTrap}>Add destination</Button></div>
    </Panel>
    <Panel title="Send traps on">
      {#each [
        ['trap_input', 'Input fault raised / cleared'],
        ['trap_eas', 'EAS tones and messages'],
        ['trap_disk', 'Low recording disk space'],
        ['trap_service', 'Service started / stopped'],
      ] as [k, label] (k)}
        <div class="border-b px-5 py-3 max-sm:px-4"><Toggle bind:checked={f[k]} {label} /></div>
      {/each}
      <div class="grid gap-x-5 p-5 max-sm:p-4 sm:grid-cols-2">
        <Field label="Heartbeat trap (s)" hint="0 = off"><Input class={IN} type="number" min="0" bind:value={f.heartbeat_secs} /></Field>
      </div>
    </Panel>
    <div class="flex flex-wrap items-center gap-2">
      <Button class="h-9 px-4" disabled={busy} onclick={save}>Save SNMP</Button>
      <Button variant="outline" class="h-9 px-3.5 sm:ml-auto" onclick={testSnmp}><Send /> Send test trap</Button>
      <Button variant="outline" class="h-9 px-3.5" href="/api/snmp/mib"><Download /> Download MIB</Button>
    </div>
  </Section>

{/if}
