<script lang="ts">
  // Analog stereo VU meter pair (after the Sescom SES-VUA-1RU) in the UI palette:
  // dark faces, −20…+3 VU scale with the red 0…+3 arc, white needles with VU
  // ballistics (≈300 ms), and a red peak light per meter. 0 VU = `ref` dBFS (RMS).
  import { onMount } from 'svelte';
  import { animate, fitCanvas } from '$lib/canvas';

  let { rms = [-90, -90] as [number, number], peak = [-90, -90] as [number, number], channels = 2, live = true, compact = false, ref = -18 }: {
    rms?: [number, number]; peak?: [number, number]; channels?: number; live?: boolean; compact?: boolean; ref?: number;
  } = $props();

  let cv = $state<HTMLCanvasElement>();
  const VU_MIN = -20, VU_MAX = 3;
  // Needle travel follows voltage, like a real VU movement.
  const lin = (vu: number) => Math.pow(10, vu / 20);
  const L_MIN = lin(VU_MIN), L_MAX = lin(VU_MAX);
  const frac = (vu: number) => Math.max(-0.015, Math.min(1.02, (lin(Math.max(VU_MIN - 2, Math.min(VU_MAX + 0.6, vu))) - L_MIN) / (L_MAX - L_MIN)));
  const TAU = 0.065; // first-order ≈ 99% in 300 ms
  const SWEEP = (50 * Math.PI) / 180;
  const meters = [0, 1].map(() => ({ pos: frac(VU_MIN - 2), led: 0 }));

  onMount(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    return animate((dt) => {
      for (let c = 0; c < 2; c++) {
        const target = live ? frac((rms[c] ?? -90) - ref) : frac(VU_MIN - 2);
        const m = meters[c];
        m.pos = reduce.matches ? target : target + (m.pos - target) * Math.exp(-dt / TAU);
        if (live && (peak[c] ?? -90) >= -1) m.led = 1;
        else m.led = Math.max(0, m.led - dt);
      }
      draw();
    });
  });

  // UI palette, read from the theme variables once (hex fallbacks match app.css).
  let P = { ok: '#4ade80', bad: '#ef4444', border: '#27272a', muted: '#18181b', bg: '#09090b', fg: '#fafafa', mfg: '#71717a', subtle: '#a1a1aa', faint: '#52525b', tick: '#3f3f46' };
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    P = { ...P, ok: v('--ok', P.ok), bad: v('--bad', P.bad), border: v('--border', P.border), muted: v('--muted', P.muted), bg: v('--background', P.bg),
      fg: v('--foreground', P.fg), mfg: v('--muted-foreground', P.mfg), subtle: v('--subtle', P.subtle), faint: v('--faint', P.faint) };
  });

  function face(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number, label: string) {
    ctx.globalAlpha = live ? 1 : 0.45;
    ctx.fillStyle = P.bg;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = P.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.clip();

    const coverH = Math.max(8, h * 0.14);
    const px = x + w / 2, py = y + h - coverH * 0.4;
    const labelRoom = Math.max(10, h * 0.13);
    // Largest dial whose labels stay inside the face on both sides and at the top.
    const r = Math.max(10, Math.min((w / 2 - 6) / (Math.sin(SWEEP) * 1.1), (py - y - labelRoom) / 1.04));
    const ang = (f: number) => -Math.PI / 2 - SWEEP + f * 2 * SWEEP;
    const pt = (a: number, rr: number) => [px + Math.cos(a) * rr, py + Math.sin(a) * rr] as const;

    // Scale arc, with the 0…+3 zone in red.
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.tick;
    ctx.beginPath(); ctx.arc(px, py, r * 0.82, ang(0), ang(frac(0))); ctx.stroke();
    ctx.lineWidth = Math.max(2.5, r * 0.04);
    ctx.strokeStyle = P.bad;
    ctx.beginPath(); ctx.arc(px, py, r * 0.855, ang(frac(0)), ang(1)); ctx.stroke();

    // Ticks and labels.
    const fs = Math.max(8, Math.round(r * 0.095));
    ctx.font = `500 ${fs}px "Geist Mono Variable", ui-monospace, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const marks: [number, string][] = [[-20, '20'], [-10, '10'], [-7, '7'], [-5, '5'], [-3, '3'], [-2, '2'], [-1, '1'], [0, '0'], [1, '1'], [2, '2'], [3, '3']];
    for (const [vu, t] of marks) {
      const a = ang(frac(vu));
      const red = vu > 0;
      ctx.strokeStyle = red ? P.bad : vu === 0 ? P.subtle : P.faint;
      ctx.lineWidth = vu === 0 ? 1.5 : 1;
      const [x1, y1] = pt(a, r * 0.82), [x2, y2] = pt(a, r * (vu === 0 || vu === -20 ? 0.94 : 0.9));
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (!compact || [-20, -10, -5, -3, 0, 3].includes(vu)) {
        const [tx, ty] = pt(a, r * 1.02);
        ctx.fillStyle = red ? P.bad : vu === 0 ? P.subtle : P.mfg;
        ctx.fillText(vu > 0 ? `+${t}` : vu === 0 ? '0' : `−${t}`, tx, ty);
      }
    }
    for (let vu = -9; vu <= 2.5; vu += 0.5) {
      if (Number.isInteger(vu) && marks.some(([m]) => m === vu)) continue;
      const a = ang(frac(vu));
      const [x1, y1] = pt(a, r * 0.82), [x2, y2] = pt(a, r * 0.86);
      ctx.strokeStyle = vu > 0 ? P.bad : P.tick; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // Legends.
    ctx.fillStyle = P.subtle;
    ctx.font = `600 ${Math.round(fs * 1.5)}px "Geist Variable", system-ui, sans-serif`;
    ctx.fillText('VU', px, y + h * 0.66);
    ctx.font = `500 ${fs}px "Geist Mono Variable", ui-monospace, monospace`;
    ctx.fillStyle = P.faint;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 8, y + h * 0.8);

    // Needle: white, red once it is past 0 VU.
    const a = ang(meters[c].pos);
    const [nx, ny] = pt(a, r * 0.96);
    const [bx, by] = pt(a, r * 0.3);
    ctx.strokeStyle = meters[c].pos > frac(0) ? P.bad : P.fg;
    ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Pivot cover along the bottom edge.
    ctx.fillStyle = P.muted;
    ctx.beginPath(); ctx.roundRect(x + 1, y + h - coverH, w - 2, coverH - 1, [0, 0, 5, 5]); ctx.fill();
    ctx.strokeStyle = P.border;
    ctx.beginPath(); ctx.moveTo(x + 1, y + h - coverH + 0.5); ctx.lineTo(x + w - 1, y + h - coverH + 0.5); ctx.stroke();

    // Peak light.
    const lr = Math.max(2.5, h * 0.04);
    const lx = x + w - lr * 2.8, ly = y + lr * 2.8;
    const on = meters[c].led > 0;
    ctx.fillStyle = on ? P.bad : P.border;
    if (on) { ctx.shadowColor = P.bad; ctx.shadowBlur = 6; }
    ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.muted;
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
    ctx.strokeStyle = P.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(0.5, 0.5, w - 1, h - 1, 8); ctx.stroke();
    const n = channels > 1 ? 2 : 1;
    const pad = compact ? 6 : 10, gap = compact ? 6 : 10;
    const fw = (w - 2 * pad - gap * (n - 1)) / n;
    for (let c = 0; c < n; c++) face(ctx, pad + c * (fw + gap), pad, fw, h - pad * 2, c, n === 1 ? 'M' : c === 0 ? 'L' : 'R');
  }
</script>

<div role="img" aria-label="VU meter{channels > 1 ? 's' : ''}: {live ? (channels > 1 ? `L ${(rms[0] - ref).toFixed(0)} VU, R ${(rms[1] - ref).toFixed(0)} VU` : `${(rms[0] - ref).toFixed(0)} VU`) : 'idle'}"><canvas bind:this={cv} class="block w-full {compact ? 'h-24' : 'h-[132px]'}" aria-hidden="true"></canvas></div>
