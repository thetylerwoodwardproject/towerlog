<script lang="ts">
  // A recording at a glance: waveform, loudness (LUFS) and spectrogram.
  // The server decodes the file once and caches the numbers; drawing is here.
  import { onMount } from 'svelte';
  import { fitCanvas } from '$lib/canvas';
  import type { Analysis } from '$lib/types';

  let { id }: { id: string } = $props();
  type Rec = { path: string; name: string; size: number; mtime: number };
  let files = $state<Rec[] | null>(null);
  let path = $state('');
  let data = $state<Analysis | null>(null);
  let loading = $state(false);
  let error = $state('');
  let wave = $state<HTMLCanvasElement>();
  let gram = $state<HTMLCanvasElement>();
  let loud = $state<HTMLCanvasElement>();
  let seq = 0;

  const css = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

  onMount(async () => {
    try {
      const r = await fetch(`/api/inputs/${encodeURIComponent(id)}/recordings`, { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.json()).error);
      files = await r.json();
      // The newest file is still being written; start from the last finished one when there is one.
      const open = files![0] && Date.now() - files![0].mtime < 90_000 && files!.length > 1;
      if (files!.length) void load(files![open ? 1 : 0].path);
    } catch (e) { error = (e as Error).message; }
  });

  async function load(p: string) {
    path = p;
    const mine = ++seq;
    loading = true; error = ''; data = null;
    try {
      const r = await fetch('/api/recording-analysis/' + p.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (mine === seq) data = j;
    } catch (e) { if (mine === seq) error = (e as Error).message; }
    if (mine === seq) loading = false;
  }

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const khz = (hz: number) => (hz >= 1000 ? `${+(hz / 1000).toFixed(1)}k` : String(hz));
  const AXIS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

  /** Sequential ramp, dark to bright; t 0..1. */
  function heat(t: number): [number, number, number] {
    const stops: [number, number, number, number][] = [[0, 8, 8, 20], [0.25, 40, 30, 110], [0.5, 30, 130, 150], [0.75, 80, 200, 110], [1, 250, 235, 90]];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i], f = (t - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
      }
    }
    return [250, 235, 90];
  }

  function drawWave(a: Analysis) {
    if (!wave) return;
    const { ctx, w, h } = fitCanvas(wave);
    const border = css('--border', '#27272a'), mfg = css('--muted-foreground', '#71717a'), fg = css('--subtle', '#a1a1aa');
    ctx.clearRect(0, 0, w, h);
    const L = 8, B = 16, mid = (h - B) / 2, n = a.wave.min.length, pw = w - L * 2;
    ctx.strokeStyle = border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, mid + 0.5); ctx.lineTo(w - L, mid + 0.5); ctx.stroke();
    ctx.fillStyle = fg;
    for (let i = 0; i < n; i++) {
      const x = L + (i / n) * pw, y1 = mid - Math.max(0, a.wave.max[i]) * mid, y2 = mid - Math.min(0, a.wave.min[i]) * mid;
      ctx.fillRect(x, y1, Math.max(1, pw / n), Math.max(1, y2 - y1));
    }
    ctx.fillStyle = mfg; ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'bottom';
    const step = a.duration > 600 ? 180 : a.duration > 120 ? 60 : 15;
    for (let t = 0; t <= a.duration; t += step) {
      const x = L + (t / a.duration) * pw;
      ctx.textAlign = t === 0 ? 'left' : 'center';
      ctx.fillText(mmss(t), x, h);
    }
  }

  function drawGram(a: Analysis) {
    if (!gram) return;
    const { ctx, w, h } = fitCanvas(gram);
    const mfg = css('--muted-foreground', '#71717a');
    ctx.clearRect(0, 0, w, h);
    const { cols, bands, data: b64 } = a.spectrogram;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = new ImageData(cols, bands);
    for (let c = 0; c < cols; c++) for (let b = 0; b < bands; b++) {
      const [r, g, bl] = heat(bytes[c * bands + b] / 255);
      const o = ((bands - 1 - b) * cols + c) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl; img.data[o + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = cols; off.height = bands;
    off.getContext('2d')!.putImageData(img, 0, 0);
    const L = 34, R = 8, B = 16, pw = w - L - R, ph = h - B;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, L, 0, pw, ph);
    const f = a.spectrogram.freqs, fmin = Math.log(f[0]), fmax = Math.log(f[f.length - 1]);
    ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = mfg; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const hz of AXIS) {
      if (hz < f[0] || hz > f[f.length - 1]) continue;
      ctx.fillText(khz(hz), L - 4, ph - ((Math.log(hz) - fmin) / (fmax - fmin)) * ph);
    }
    ctx.textBaseline = 'bottom';
    const step = a.duration > 600 ? 180 : a.duration > 120 ? 60 : 15;
    for (let t = 0; t <= a.duration; t += step) { ctx.textAlign = t === 0 ? 'left' : 'center'; ctx.fillText(mmss(t), L + (t / a.duration) * pw, h); }
  }

  const LU_TOP = -10;
  const LU_BOTTOM = -50;
  const lufs = (v: number | undefined) => (v === undefined || v <= -69.9 ? '−∞' : v.toFixed(1));

  function drawLoud(a: Analysis) {
    const l = a.loudness;
    if (!loud || !l) return;
    const { ctx, w, h } = fitCanvas(loud);
    const border = css('--border', '#27272a'), mfg = css('--muted-foreground', '#71717a');
    const fg = css('--foreground', '#fafafa'), ok = css('--ok', '#4ade80');
    ctx.clearRect(0, 0, w, h);
    const L = 34, R = 8, T = 6, B = 16, pw = w - L - R, ph = h - T - B;
    const Y = (v: number) => T + ((LU_TOP - Math.max(LU_BOTTOM, Math.min(LU_TOP, v))) / (LU_TOP - LU_BOTTOM)) * ph;
    const X = (i: number) => L + ((i * l.step + 0.5) / a.duration) * pw;
    ctx.font = '10px ui-monospace, monospace'; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = LU_TOP; v >= LU_BOTTOM; v -= 10) {
      ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(L, Math.round(Y(v)) + 0.5); ctx.lineTo(w - R, Math.round(Y(v)) + 0.5); ctx.stroke();
      ctx.fillStyle = mfg; ctx.fillText(String(v), L - 4, Y(v));
    }
    // Targets: EBU R128 -23 LUFS (+/-1 LU) and ATSC A/85 -24 LKFS (+/-2 dB).
    ctx.globalAlpha = 0.12; ctx.fillStyle = ok; ctx.fillRect(L, Y(-22), pw, Y(-24) - Y(-22)); ctx.globalAlpha = 1;
    ctx.setLineDash([4, 4]); ctx.strokeStyle = ok;
    for (const t of [-23, -24]) { ctx.beginPath(); ctx.moveTo(L, Math.round(Y(t)) + 0.5); ctx.lineTo(w - R, Math.round(Y(t)) + 0.5); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = ok; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('R128 −23', w - R - 2, Y(-23) - 1);
    ctx.textBaseline = 'top'; ctx.fillText('A/85 −24', w - R - 2, Y(-24) + 1);
    const line = (vals: number[], color: string, width: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let pen = false;
      vals.forEach((v, i) => { if (v <= -69.9) { pen = false; return; } if (pen) ctx.lineTo(X(i), Y(v)); else { ctx.moveTo(X(i), Y(v)); pen = true; } });
      ctx.stroke();
    };
    line(l.momentary, mfg, 1);
    line(l.short, fg, 1.5);
    line(l.integrated_run, '#60a5fa', 1.5);
    ctx.fillStyle = mfg; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const step = a.duration > 600 ? 180 : a.duration > 120 ? 60 : 15;
    for (let t = 0; t <= a.duration; t += step) { ctx.textAlign = t === 0 ? 'left' : 'center'; ctx.fillText(mmss(t), L + (t / a.duration) * pw, h); }
  }

  function draw() {
    if (!data) return;
    drawWave(data); drawLoud(data); drawGram(data);
  }
  $effect(() => { if (data && wave && gram && (loud || !data.loudness)) draw(); });
  onMount(() => {
    const onResize = () => draw();
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  });
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<div class="flex flex-col gap-4">
  {#if files && !files.length}
    <p class="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">No recordings yet.</p>
  {:else if files}
    <div class="flex flex-wrap items-center gap-3">
      <label class="text-xs text-muted-foreground" for="analysis-file">Recording</label>
      <select id="analysis-file" class="h-8 min-w-0 max-w-full rounded-md border bg-transparent px-2 font-mono text-xs" value={path} onchange={(e) => load(e.currentTarget.value)}>
        {#each files as f (f.path)}<option value={f.path} class="bg-background">{f.name} · {when(f.mtime)}</option>{/each}
      </select>
      {#if data}<span class="text-xs text-muted-foreground">{mmss(data.duration)} analysed</span>{/if}
    </div>
  {/if}
  {#if error}<p class="text-sm text-bad">{error}</p>{/if}
  {#if loading}<p class="text-sm text-muted-foreground">Analysing… a 15 minute file can take up to a minute the first time; it is cached after that.</p>{/if}
  <div class="flex flex-col gap-4" class:hidden={!data}>
    <figure class="rounded-lg border p-3">
      <figcaption class="mb-2 text-xs font-medium text-muted-foreground">Waveform</figcaption>
      <canvas bind:this={wave} class="h-32 w-full" aria-label="Waveform of the recording"></canvas>
    </figure>
    {#if data?.loudness}
      {@const l = data.loudness}
      <figure class="rounded-lg border p-3">
        <figcaption class="mb-2 text-xs font-medium text-muted-foreground">Loudness, LUFS</figcaption>
        <dl class="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
          {#each [['Integrated (long-term)', lufs(l.integrated), 'LUFS'], ['Max short-term (3 s)', lufs(l.max_short), 'LUFS'], ['Max momentary (400 ms)', lufs(l.max_momentary), 'LUFS'], ['Loudness range', l.lra.toFixed(1), 'LU'], ['True peak', lufs(l.true_peak), 'dBTP']] as [k, v, u] (k)}
            <div><dt class="text-[11px] text-muted-foreground">{k}</dt><dd class="font-mono text-lg tabular-nums">{v} <span class="text-xs text-muted-foreground">{u}</span></dd></div>
          {/each}
        </dl>
        <canvas bind:this={loud} class="h-48 w-full" aria-label="Loudness over the recording"></canvas>
        <p class="mt-2 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground"><span class="text-foreground">━ short-term</span><span style="color:#60a5fa">━ integrated so far</span><span>━ momentary</span><span class="text-ok">╌ targets −23 (R128) / −24 (A/85)</span></p>
      </figure>
    {/if}
    <figure class="rounded-lg border p-3">
      <figcaption class="mb-2 text-xs font-medium text-muted-foreground">Spectrogram</figcaption>
      <canvas bind:this={gram} class="h-56 w-full" aria-label="Spectrogram: frequency over time"></canvas>
    </figure>
  </div>
</div>
