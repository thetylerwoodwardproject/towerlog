// Canvas helpers shared by the meters and graphs.
export const DB_MIN = -60;
export const DB_MAX = 0;
export const ATTACK = 0.012;
export const RELEASE = 0.34;
export const PEAK_HOLD = 1.2;
export const PEAK_FALL = 13;

export const dbFrac = (db: number) => Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
export const ramp = (cur: number, target: number, dt: number) =>
  target + (cur - target) * Math.exp(-dt / (target > cur ? ATTACK : RELEASE));

export function fitCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 120;
  const h = cv.clientHeight || 40;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** requestAnimationFrame loop; returns a stop function. dt in seconds (capped). */
export function animate(step: (dt: number) => void): () => void {
  let last = performance.now();
  let id = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    id = requestAnimationFrame(frame);
  };
  id = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(id);
}
