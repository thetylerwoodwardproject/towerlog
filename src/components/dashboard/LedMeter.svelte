<script lang="ts">
  // Segmented peak meter in the UI's flat style: thin rounded segments on the
  // border-grey track, lit green / amber from −12 dBFS / red from −3, a white
  // peak-hold segment, the peak value per channel (an OVR pill after a clip),
  // and a quiet dB scale underneath.
  import { onMount } from 'svelte';
  import { DB_MIN, PEAK_FALL, PEAK_HOLD, animate, dbFrac, fitCanvas, ramp } from '$lib/canvas';

  // `compact`: no dB scale and a narrower readout, for table rows.
  let { peak = [DB_MIN, DB_MIN] as [number, number], channels = 2, live = true, compact = false }: { peak?: [number, number]; channels?: number; live?: boolean; compact?: boolean } = $props();

  const OVR_DB = -0.5, OVR_HOLD = 1.5;
  const SCALE = [-60, -40, -30, -20, -12, -6, -3, 0];
  const ROW = 6, ROW_GAP = 6;
  let cv = $state<HTMLCanvasElement>();
  const m = [0, 1].map(() => ({ disp: DB_MIN, hold: DB_MIN, holdT: 0, ovr: 0 }));
  // Readouts shown beside the bars (updated a few times a second, not every frame).
  let readout = $state<{ text: string; ovr: boolean }[]>([{ text: '—', ovr: false }, { text: '—', ovr: false }]);
  let P = { ok: '#4ade80', warn: '#eab308', bad: '#ef4444', border: '#27272a', fg: '#fafafa', faint: '#52525b' };
  const n = $derived(channels > 1 ? 2 : 1);
  const scaleH = $derived(compact ? 0 : 16);

  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, d: string) => cs.getPropertyValue(name).trim() || d;
    P = { ok: v('--ok', P.ok), warn: v('--warn', P.warn), bad: v('--bad', P.bad), border: v('--border', P.border), fg: v('--foreground', P.fg), faint: v('--faint', P.faint) };
    let acc = 0;
    return animate((dt) => {
      for (let c = 0; c < 2; c++) {
        const target = live ? Math.max(DB_MIN, peak[c] ?? DB_MIN) : DB_MIN;
        const s = m[c];
        s.disp = ramp(s.disp, target, dt);
        if (s.disp >= s.hold) { s.hold = s.disp; s.holdT = 0; }
        else { s.holdT += dt; if (s.holdT > PEAK_HOLD) s.hold = Math.max(s.disp, s.hold - PEAK_FALL * dt); }
        if (live && (peak[c] ?? DB_MIN) >= OVR_DB) s.ovr = OVR_HOLD;
        else s.ovr = Math.max(0, s.ovr - dt);
      }
      acc += dt;
      if (acc > 0.2) {
        acc = 0;
        readout = m.map((s) => ({ ovr: s.ovr > 0, text: !live || s.hold <= DB_MIN + 0.5 ? '−∞' : s.hold.toFixed(1).replace('-', '−') }));
      }
      draw();
    });
  });

  const zone = (db: number) => (db > -3 ? P.bad : db > -12 ? P.warn : P.ok);

  function draw() {
    if (!cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const gap = 2;
    const segs = Math.max(20, Math.min(60, Math.floor(w / 7)));
    const segW = (w - gap * (segs - 1)) / segs;
    for (let c = 0; c < n; c++) {
      const y = c * (ROW + ROW_GAP);
      const s = m[c];
      const lit = live ? Math.round(dbFrac(s.disp) * segs) : 0;
      const holdSeg = live && s.hold > DB_MIN + 1 ? Math.min(segs - 1, Math.max(0, Math.ceil(dbFrac(s.hold) * segs) - 1)) : -1;
      for (let i = 0; i < segs; i++) {
        const top = DB_MIN + ((i + 1) / segs) * -DB_MIN;
        ctx.fillStyle = i === holdSeg ? P.fg : i < lit ? zone(top) : P.border;
        ctx.beginPath(); ctx.roundRect(i * (segW + gap), y, segW, ROW, 1.5); ctx.fill();
      }
    }
    if (compact) return;
    // dB scale.
    const sy = n * (ROW + ROW_GAP) - ROW_GAP + scaleH / 2;
    ctx.fillStyle = P.faint;
    ctx.font = '400 9px "Geist Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const db of SCALE) {
      ctx.textAlign = db === DB_MIN ? 'left' : db === 0 ? 'right' : 'center';
      ctx.fillText(db === 0 ? '0' : String(db).replace('-', '−'), db === 0 ? w : dbFrac(db) * w, sy);
    }
  }
  const fmt = (db: number) => (db <= -89.9 ? '−∞' : `${db.toFixed(1)} dBFS`);
</script>

<div class="grid items-start gap-x-2.5 {compact ? 'grid-cols-[10px_minmax(0,1fr)_40px]' : 'grid-cols-[14px_minmax(0,1fr)_52px]'}" role="img"
  aria-label="Peak meter: {live ? (n > 1 ? `L ${fmt(peak[0])}, R ${fmt(peak[1])}` : fmt(peak[0])) : 'idle'}">
  <div class="flex flex-col font-mono text-[10px] leading-[6px] text-muted-foreground" aria-hidden="true">
    {#each n > 1 ? ['L', 'R'] : ['M'] as l, i (l)}<span class={i ? 'mt-[6px]' : ''}>{l}</span>{/each}
  </div>
  <canvas bind:this={cv} class="block w-full" style="height:{n * (ROW + ROW_GAP) - ROW_GAP + scaleH}px" aria-hidden="true"></canvas>
  <div class="flex flex-col items-end gap-[6px] font-mono text-[10px] leading-[6px]" aria-hidden="true">
    {#each readout.slice(0, n) as r, i (i)}
      {#if r.ovr}<span class="rounded-full bg-bad px-1.5 py-[3px] text-[9px] font-semibold text-white">OVR</span>
      {:else}<span class={r.text === '−∞' ? 'text-faint' : 'text-soft'}>{r.text}</span>{/if}
    {/each}
  </div>
</div>
