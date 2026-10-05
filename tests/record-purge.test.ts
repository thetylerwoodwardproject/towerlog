import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listChunks, pruneInput, purgeForSpace } from '../src/engine/inputs/record.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'towerlog-p-'));
  const now = 1_800_000_000;
  const put = (input: string, name: string, ageHours: number, size = 1000) => {
    const dir = path.join(root, input, '2026', '10', '01');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.alloc(size));
    const t = now - ageHours * 3600;
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, now, put };
}

describe('retention', () => {
  it('prunes by age for one input only, all audio types, and removes empty folders', () => {
    const { root, now, put } = setup();
    const old = put('A', 'a_old.flac', 24 * 40);
    const oldMka = put('A', 'a_old.mka', 24 * 40);
    const fresh = put('A', 'a_new.mp3', 1);
    const other = put('B', 'b_old.mp3', 24 * 40);
    expect(pruneInput(root, 'A', 30, now)).toBe(2);
    expect(fs.existsSync(old) || fs.existsSync(oldMka)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(pruneInput(root, 'A', 0, now)).toBe(0);
  });
});

describe('disk watermark', () => {
  it('deletes oldest first across inputs until there is room, sparing recent files', () => {
    const { root, now, put } = setup();
    const a = put('A', 'a1.mp3', 50, 1000);
    const b = put('B', 'b1.mp3', 40, 1000);
    const c = put('A', 'a2.mp3', 30, 1000);
    const recent = put('A', 'a3.mp3', 1, 1000);
    let free = 100;
    const freeFn = () => free;
    // Each delete frees 1000 bytes in this fake disk.
    const orig = fs.unlinkSync;
    const spy = (p: fs.PathLike) => { orig(p); free += 1000; };
    (fs as { unlinkSync: unknown }).unlinkSync = spy;
    try {
      const freed = purgeForSpace(root, 1500, freeFn, now);
      expect(freed).toBe(2000);
    } finally {
      (fs as { unlinkSync: unknown }).unlinkSync = orig;
    }
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(c)).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
    expect(listChunks(root)).toHaveLength(2);
  });
  it('does nothing when there is room, and never touches files inside the protect window', () => {
    const { root, now, put } = setup();
    const recent = put('A', 'r.mp3', 0.5);
    expect(purgeForSpace(root, 10, () => 1000, now)).toBe(0);
    expect(purgeForSpace(root, 1e12, () => 5, now)).toBe(0);
    expect(fs.existsSync(recent)).toBe(true);
  });
});
