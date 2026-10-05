<script lang="ts" module>
  export interface InputForm {
    id: string; name: string; enabled: boolean; kind: 'http' | 'rtp' | 'livewire' | 'push';
    url: string; address: string; port: number; rtp_codec: 'l16' | 'l24' | 'pcmu' | 'pcma' | 'mp3'; rtp_payload: number; rtp_rate: number; channels: number;
    stream_codec: 'mp3' | 'aac' | 'other'; livewire_channel: number; mount: string; source_password: string;
    chunk_minutes: 15 | 30 | 60; record: boolean; keep_days: number;
    silence_db: number; silence_secs: number; link_secs: number; clip_secs: number; mono_secs: number;
    detect_clip: boolean; detect_mono: boolean;
  }
</script>

<script lang="ts">
  // Edit one logged input (or a new one when `input.id` is empty).
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import StatusBadge, { DOT } from '../common/StatusBadge.svelte';
  import type { InputSnapshot } from '$lib/types';
  import { attempt, del, post, put } from '$lib/api';
  import { INPUT_STATUS_TEXT, SILENCE_PRESETS, inputTone, silenceLabel } from '$lib/inputs';
  import Field from './Field.svelte';
  import FormSelect from '../common/FormSelect.svelte';
  import Toggle from './Toggle.svelte';

  let { input, live, sourcePort, onsaved, ondeleted }: {
    input: InputForm; live?: InputSnapshot; sourcePort: number;
    onsaved: (i: InputForm) => void; ondeleted: (id: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let f = $state<InputForm>(structuredClone($state.snapshot(input)) as InputForm);
  let busy = $state(false);
  const isNew = $derived(!input.id);
  const IN = 'h-9 font-mono text-[13px]';
  const host = typeof location !== 'undefined' ? location.hostname : 'this-server';

  const silenceOptions = $derived.by(() => {
    const opts: [number, string][] = SILENCE_PRESETS.map((s) => [s, silenceLabel(s)]);
    if (!SILENCE_PRESETS.includes(f.silence_secs as never)) opts.push([f.silence_secs, `${silenceLabel(f.silence_secs)} (custom)`]);
    return opts.sort((a, b) => a[0] - b[0]);
  });
  let custom = $state(false);

  async function save() {
    busy = true;
    const body = $state.snapshot(f);
    const saved = await attempt('Save', () => (isNew ? post<InputForm>('/api/inputs', body) : put<InputForm>(`/api/inputs/${input.id}`, body)),
      `${f.name} saved${isNew ? '' : ' — restarting'}`);
    busy = false;
    if (saved) onsaved(saved);
  }
  async function remove() {
    if (isNew) { ondeleted(''); return; }
    if (!confirm(`Delete input ${input.name}? Its recordings stay on disk.`)) return;
    const ok = await attempt('Delete', () => del(`/api/inputs/${input.id}`), `${input.name} deleted`);
    if (ok) ondeleted(input.id);
  }
</script>

<section class="overflow-hidden rounded-lg border">
  <div class="flex flex-wrap items-center gap-3 border-b px-5 py-3 max-sm:px-4">
    {#if live}<span class="size-1.5 flex-none rounded-full {DOT[inputTone(live)]}"></span>{/if}
    <Input class="h-9 w-full max-w-[240px] text-sm font-medium" bind:value={f.name} placeholder="Input name" aria-label="Input name" />
    <span class="font-mono text-[11px] text-faint">{isNew ? 'new input' : input.id}</span>
    {#if live}<StatusBadge tone={inputTone(live)} title={live.detail}>{INPUT_STATUS_TEXT[live.status]}</StatusBadge>{/if}
    <div class="ml-auto flex items-center gap-3">
      <label class="flex items-center gap-2 text-[13px] text-subtle">Enabled <Switch bind:checked={f.enabled} /></label>
      <Button size="icon" variant="ghost" class="text-muted-foreground hover:text-bad" title={isNew ? 'Discard' : 'Delete input'} aria-label={isNew ? 'Discard' : 'Delete input'} onclick={remove}><Trash2 /></Button>
    </div>
  </div>

  <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-5 gap-y-[18px] p-5 max-sm:p-4">
    <Field label="Source type">
      <FormSelect bind:value={f.kind} options={[['http', 'HTTP / Icecast / Shoutcast (Barix, Inovonics…)'], ['rtp', 'RTP unicast or multicast'], ['livewire', 'Livewire channel'], ['push', 'Icecast push (encoder → Towerlog)']]} />
    </Field>
    {#if f.kind === 'http'}
      <Field label="Stream URL" hint="e.g. http://10.1.2.3:8000/stream — an Inovonics or Barix unit's stream"><Input class={IN} bind:value={f.url} placeholder="http://host:port/mount" /></Field>
      <Field label="Stream codec" hint="Chooses the recording file type; audio is never re-encoded">
        <FormSelect bind:value={f.stream_codec} options={[['mp3', 'MP3'], ['aac', 'AAC (ADTS)'], ['other', 'Other (.mka)']]} />
      </Field>
    {:else if f.kind === 'rtp'}
      <Field label="Address" hint="Multicast group to join, or blank for any unicast"><Input class={IN} bind:value={f.address} placeholder="239.192.1.1" /></Field>
      <Field label="Port"><Input class={IN} type="number" min="1" max="65535" bind:value={f.port} /></Field>
      <Field label="Payload">
        <FormSelect bind:value={f.rtp_codec} options={[['l24', 'L24 linear (FLAC recording)'], ['l16', 'L16 linear (FLAC recording)'], ['pcmu', 'G.711 µ-law'], ['pcma', 'G.711 A-law'], ['mp3', 'MP3 (RTP type 14)']]} />
      </Field>
      {#if f.rtp_codec === 'l16' || f.rtp_codec === 'l24'}
        <Field label="Sample rate"><FormSelect bind:value={f.rtp_rate} options={[[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']]} /></Field>
        <Field label="Channels"><FormSelect bind:value={f.channels} options={[[2, 'Stereo'], [1, 'Mono']]} /></Field>
        <Field label="Payload type" hint="Must match the sender: 96 is usual, 97 for Livewire-style streams"><Input class={IN} type="number" min="96" max="127" bind:value={f.rtp_payload} /></Field>
      {/if}
    {:else if f.kind === 'livewire'}
      <Field label="Livewire channel" hint="Joins multicast 239.192.x.y for this channel number (L24, 48 kHz)"><Input class={IN} type="number" min="1" max="32767" bind:value={f.livewire_channel} /></Field>
    {:else}
      <Field label="Mount" hint="The mount the source client connects to"><Input class={IN} bind:value={f.mount} placeholder="/fm1" /></Field>
      <Field label="Source password"><Input class={IN} type="password" bind:value={f.source_password} autocomplete="new-password" /></Field>
      <Field label="Stream codec"><FormSelect bind:value={f.stream_codec} options={[['mp3', 'MP3'], ['aac', 'AAC (ADTS)']]} /></Field>
      <p class="col-span-full text-xs text-muted-foreground">
        In the source client set host <code class="font-mono">{host}</code>, port <code class="font-mono">{sourcePort}</code> and this password, and mount <code class="font-mono">{f.mount || '/fm1'}</code>.
      </p>
    {/if}
  </div>

  <div class="border-t px-5 py-3 max-sm:px-4">
    <Toggle bind:checked={f.record} label="Record to disk" hint="Files start on the clock (top of the hour, :15, :30, :45) in the original codec" />
    {#if f.record}
      <div class="mt-3 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-5 gap-y-[18px]">
        <Field label="File length"><FormSelect bind:value={f.chunk_minutes} options={[[15, '15 minutes'], [30, '30 minutes'], [60, '60 minutes (hourly)']]} /></Field>
        <Field label="Keep recordings (days)" hint="0 = keep until the disk fills"><Input class={IN} type="number" min="0" bind:value={f.keep_days} /></Field>
      </div>
    {/if}
  </div>

  <div class="border-t px-5 py-4 max-sm:px-4">
    <div class="mb-3 text-[13px] font-medium">Fault alerts</div>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-5 gap-y-[18px]">
      <Field label="Alert on silence after" hint="Dead air must last this long before an alert">
        {#if custom}
          <Input class={IN} type="number" min="1" max="3600" bind:value={f.silence_secs} aria-label="Silence seconds" />
        {:else}
          <FormSelect bind:value={f.silence_secs} options={silenceOptions} />
        {/if}
        <button type="button" class="self-start text-xs font-normal text-subtle underline-offset-2 hover:text-foreground hover:underline" onclick={() => (custom = !custom)}>{custom ? 'Pick a preset' : 'Custom seconds'}</button>
      </Field>
      <Field label="Silence level (dBFS)" hint="Quieter than this counts as silence"><Input class={IN} type="number" step="1" min="-90" max="0" bind:value={f.silence_db} /></Field>
      <Field label="Alert when feed lost for (s)"><Input class={IN} type="number" min="1" max="3600" bind:value={f.link_secs} /></Field>
    </div>
    <div class="mt-4 flex flex-col gap-3">
      <Toggle bind:checked={f.detect_clip} label="Clipping" hint="Full-scale samples held for the delay below" />
      {#if f.detect_clip}<Field label="Clipping delay (s)" class="w-48"><Input class={IN} type="number" min="1" max="3600" bind:value={f.clip_secs} /></Field>{/if}
      <Toggle bind:checked={f.detect_mono} label="Mono and phase" hint="Left and right identical, or out of phase" />
      {#if f.detect_mono}<Field label="Mono / phase delay (s)" class="w-48"><Input class={IN} type="number" min="1" max="3600" bind:value={f.mono_secs} /></Field>{/if}
    </div>
  </div>

  <div class="flex items-center gap-3 border-t px-5 py-3 max-sm:px-4">
    <Button class="h-9 px-4" disabled={busy} onclick={save}>{isNew ? 'Add input' : 'Save & restart'}</Button>
    <span class="text-xs text-muted-foreground">{isNew ? 'Starts logging as soon as it is added.' : 'Only this input restarts.'}</span>
  </div>
</section>
