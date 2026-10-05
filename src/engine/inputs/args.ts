// ffmpeg input-side arguments for each kind of logged feed. Pure: nothing here
// spawns a process or touches the disk, so it is all unit-tested as strings.
import type { InputConfig } from '../config.ts';

export const METER_RATE = 48000;
export const METER_CHANNELS = 2;

export interface Source {
  /** Arguments that go before the output options, ending with `-i <something>`. */
  args: string[];
  /** SDP text the caller must write to `sdpPath` first (rtp and livewire), else null. */
  sdp: string | null;
  /** The feed arrives on ffmpeg's stdin (push). */
  stdin: boolean;
  /** How the original audio is stored: stream copy, or FLAC for linear PCM. */
  record: { codec: 'copy' | 'flac'; ext: string; format: string };
}

export function livewireGroup(channel: number): string {
  return `239.192.${(channel >> 8) & 255}.${channel & 255}`;
}

export const isMulticast = (addr: string) => {
  const first = Number(addr.split('.')[0]);
  return first >= 224 && first <= 239;
};

const RTP_PT: Record<InputConfig['rtp_codec'], number | null> = {
  l16: null,
  l24: null,
  pcmu: 0,
  pcma: 8,
  mp3: 14,
};

/** Build the SDP that tells ffmpeg what the RTP packets carry. */
export function rtpSdp(o: { address: string; port: number; codec: InputConfig['rtp_codec']; rate: number; channels: number; payload?: number }): string {
  const fixed = RTP_PT[o.codec];
  const pt = o.payload ?? fixed ?? 96;
  const map =
    o.codec === 'l16' ? `L16/${o.rate}/${o.channels}`
    : o.codec === 'l24' ? `L24/${o.rate}/${o.channels}`
    : o.codec === 'pcmu' ? `PCMU/8000/1`
    : o.codec === 'pcma' ? `PCMA/8000/1`
    : `MPA/90000`;
  const addr = o.address || '0.0.0.0';
  const conn = isMulticast(addr) ? `${addr}/32` : addr;
  return ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=towerlog', `c=IN IP4 ${conn}`, 't=0 0', `m=audio ${o.port} RTP/AVP ${pt}`, `a=rtpmap:${pt} ${map}`, ''].join('\n');
}

const FILE_TYPE: Record<InputConfig['stream_codec'], { ext: string; format: string }> = {
  mp3: { ext: 'mp3', format: 'mp3' },
  aac: { ext: 'aac', format: 'adts' },
  other: { ext: 'mka', format: 'matroska' },
};

export function buildSource(cfg: InputConfig, sdpPath: string): Source {
  const flac = { codec: 'flac' as const, ext: 'flac', format: 'flac' };
  if (cfg.kind === 'http') {
    return {
      args: ['-rw_timeout', '10000000', '-user_agent', 'Towerlog', '-i', cfg.url],
      sdp: null,
      stdin: false,
      record: { codec: 'copy', ...FILE_TYPE[cfg.stream_codec] },
    };
  }
  if (cfg.kind === 'push') {
    return {
      args: ['-f', cfg.stream_codec === 'aac' ? 'aac' : 'mp3', '-i', 'pipe:0'],
      sdp: null,
      stdin: true,
      record: { codec: 'copy', ...FILE_TYPE[cfg.stream_codec] },
    };
  }
  const rtpArgs = ['-protocol_whitelist', 'file,udp,rtp', '-rw_timeout', '10000000', '-i', sdpPath];
  if (cfg.kind === 'livewire') {
    return {
      args: rtpArgs,
      sdp: rtpSdp({ address: livewireGroup(cfg.livewire_channel), port: 5004, codec: 'l24', rate: 48000, channels: 2, payload: 97 }),
      stdin: false,
      record: flac,
    };
  }
  const linear = cfg.rtp_codec === 'l16' || cfg.rtp_codec === 'l24';
  return {
    args: rtpArgs,
    sdp: rtpSdp({ address: cfg.address, port: cfg.port, codec: cfg.rtp_codec, rate: cfg.rtp_rate, channels: cfg.channels, payload: linear ? cfg.rtp_payload : undefined }),
    stdin: false,
    record: linear || cfg.rtp_codec === 'pcmu' || cfg.rtp_codec === 'pcma' ? flac : { codec: 'copy', ...FILE_TYPE.mp3 },
  };
}
