// Small PCM helpers shared by the detectors and the input runtime.
export const DB_FLOOR = -90;

/** View a Buffer of s16le samples as Int16Array (copies only if the buffer is misaligned). */
export function int16View(buf: Buffer): Int16Array {
  const n = buf.length >> 1;
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, n);
  const copy = Buffer.from(buf.subarray(0, n * 2));
  return new Int16Array(copy.buffer, copy.byteOffset, n);
}
