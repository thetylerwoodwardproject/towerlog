import { describe, expect, it } from 'vitest';
import { InputSchema, parseConfig, type InputConfig } from '../src/engine/config.ts';
import { buildSource, livewireGroup, rtpSdp } from '../src/engine/inputs/args.ts';
import { ffmpegArgs, segmentPattern } from '../src/engine/inputs/record.ts';

const mk = (o: Record<string, unknown>): InputConfig => InputSchema.parse({ id: 'a', name: 'Studio A', kind: 'http', url: 'http://10.0.0.5:8000/a', ...o });

describe('input config', () => {
  it('fills defaults', () => {
    const i = mk({});
    expect(i).toMatchObject({ chunk_minutes: 60, record: true, keep_days: 30, silence_db: -50 });
  });
  it('bad chunk length falls back to 60', () => {
    expect(mk({ chunk_minutes: 20 }).chunk_minutes).toBe(60);
    expect(mk({ chunk_minutes: 15 }).chunk_minutes).toBe(15);
  });
  it('drops inputs missing what their kind needs, and duplicates', () => {
    const { config, problems } = parseConfig({
      inputs: [
        { id: 'ok', name: 'OK', kind: 'http', url: 'http://x/y' },
        { id: 'nourl', name: 'No URL', kind: 'http' },
        { id: 'p1', name: 'P1', kind: 'push', mount: 'a', source_password: 'pw' },
        { id: 'p2', name: 'P2', kind: 'push', mount: '/a', source_password: 'pw' },
        { id: 'ok', name: 'Dup', kind: 'http', url: 'http://x/z' },
        { id: 'nopw', name: 'No pw', kind: 'push', mount: '/b' },
      ],
    });
    expect(config.inputs.map((i) => i.id)).toEqual(['ok', 'p1']);
    expect(config.inputs[1].mount).toBe('/a');
    expect(problems).toHaveLength(4);
  });
});

describe('sources', () => {
  it('http pulls with a timeout and copies mp3', () => {
    const s = buildSource(mk({}), '/x.sdp');
    expect(s.args.slice(-2)).toEqual(['-i', 'http://10.0.0.5:8000/a']);
    expect(s.record).toEqual({ codec: 'copy', ext: 'mp3', format: 'mp3' });
    expect(s.sdp).toBeNull();
  });
  it('push reads stdin', () => {
    const s = buildSource(mk({ kind: 'push', mount: '/a', source_password: 'p' }), '/x.sdp');
    expect(s.stdin).toBe(true);
    expect(s.args).toEqual(['-f', 'mp3', '-i', 'pipe:0']);
  });
  it('livewire channel maps to its multicast group', () => {
    expect(livewireGroup(1)).toBe('239.192.0.1');
    expect(livewireGroup(258)).toBe('239.192.1.2');
    const s = buildSource(mk({ kind: 'livewire', livewire_channel: 258 }), '/x.sdp');
    expect(s.sdp).toContain('c=IN IP4 239.192.1.2/32');
    expect(s.sdp).toContain('m=audio 5004 RTP/AVP 97');
    expect(s.sdp).toContain('a=rtpmap:97 L24/48000/2');
    expect(s.record.codec).toBe('flac');
  });
  it('rtp sdp: multicast joins, unicast binds, mp3 uses static type 14', () => {
    expect(rtpSdp({ address: '239.1.1.1', port: 6000, codec: 'l16', rate: 44100, channels: 2 })).toContain('c=IN IP4 239.1.1.1/32');
    expect(rtpSdp({ address: '', port: 6000, codec: 'pcmu', rate: 8000, channels: 1 })).toContain('c=IN IP4 0.0.0.0\n');
    expect(rtpSdp({ address: '10.0.0.9', port: 6000, codec: 'mp3', rate: 44100, channels: 2 })).toContain('m=audio 6000 RTP/AVP 14');
  });
});

describe('recording args', () => {
  it('cuts on the clock at the chosen chunk length and also emits PCM', () => {
    const cfg = mk({ chunk_minutes: 15 });
    const a = ffmpegArgs(cfg, buildSource(cfg, ''), '/rec');
    expect(a).toContain('-segment_atclocktime');
    expect(a[a.indexOf('-segment_time') + 1]).toBe('900');
    expect(a).toContain('/rec/Studio_A/%Y/%m/%d/Studio_A_%y%m%d_%H%M.mp3');
    expect(a.at(-1)).toBe('pipe:1');
  });
  it('no recording means meter output only', () => {
    const cfg = mk({ record: false });
    const a = ffmpegArgs(cfg, buildSource(cfg, ''), '/rec');
    expect(a).not.toContain('-segment_time');
  });
  it('escapes % in paths', () => {
    expect(segmentPattern('/r%x', 'A', 'mp3')).toContain('/r%%x/');
  });
});
