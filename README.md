<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo-light.svg" alt="Towerlog" width="320">
  </picture>
</p>

<p align="center">
  Broadcast audio logger for IP audio feeds: record every feed in clock-aligned files,<br>
  watch the levels, listen in, and get alerted by email, SNMP and Zabbix when one fails.
</p>

<p align="center">
  <img alt="Status: in development" src="https://img.shields.io/badge/status-in%20development-ff9f0a?style=flat-square">
  <img alt="Version v2026.10.04" src="https://img.shields.io/badge/version-v2026.10.04-26272b?style=flat-square">
  <img alt="Node 22" src="https://img.shields.io/badge/node-22-26272b?style=flat-square">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-26272b?style=flat-square"></a>
</p>

> [!NOTE]
> Towerlog is **new and has only been tried against simulated feeds** (ffmpeg-generated
> Icecast, RTP and Livewire-format streams). Nothing has been verified yet against real Barix,
> Inovonics or Livewire hardware.

<p align="center">
  <img src="docs/images/dashboard.png" alt="Towerlog dashboard: a card per input with status, fault chips, VU and peak meters and a recording indicator" width="900">
</p>

## What it does

| | |
|---|---|
| 🎙️ **Many source types** | a stream URL Towerlog connects to (Barix units in server mode, Inovonics 541 / 551 / 525 / 677 streams, Icecast, Shoutcast), RTP unicast and multicast, Livewire channels, and encoders that connect in and send to Towerlog |
| 🕐 **Clock-aligned recording** | 15, 30 or 60 minute files that always start on the clock (top of the hour, :15, :30, :45). The original codec is copied, never re-encoded; linear audio is stored as FLAC |
| 🚨 **Fault detection** | Feed lost, silence (alert after 5 s, 10 s, 30 s, 1 min, 2 min, 5 min, 10 min or any custom time), clipping, mono and out-of-phase, each with its own delay; every raise and clear is logged |
| 📟 **Email, SNMP and Zabbix** | SMTP alerts, an SNMP agent (v2c / v3) with traps and its own MIB, and a Zabbix trapper with a generated template |
| 📊 **Live UI** | A card per input with VU and peak meters, fault chips, a listen-in player, recordings by day with playback and download, a waveform and spectrum view of each recording, and the fault history |
| 🕰️ **Clock** | chrony keeps the host clock right (NTP servers set in the UI); the dashboard warns if it drifts or loses sync, since file times depend on it |
| 🧹 **Retention** | Keep-days per input, plus a disk watermark that deletes the oldest recordings first |
| 🔁 **Encoders can send to it** | Anything that can send to an Icecast server (ffmpeg, BUTT, Liquidsoap, a hardware encoder) can send to Towerlog instead and have the stream logged |

## Screens

| | |
|---|---|
| <img src="docs/images/faults.png" alt="Fault history across all inputs"> | <img src="docs/images/input-settings.png" alt="Input settings: source, recording and fault alert timing"> |
| **Fault history**: every raise and clear, with how long it lasted | **Input settings**: source, file length, retention and alert timing (silence after 5 s to 10 min, or custom) |

<p align="center"><img src="docs/images/mobile.png" alt="Towerlog on a phone" width="260"></p>

## Install

**Debian / Ubuntu** (amd64 or arm64):

```sh
sudo ./deploy/install.sh
```

It installs ffmpeg, chrony and Node.js 22, builds the app into `/usr/local/lib/towerlog`, creates the `towerlog` user, asks for a web password and starts `towerlog.service`.
Then open `http://<server>:8090` and add inputs under **Configuration → Inputs**. Settings are in `/etc/towerlog/config.json`, recordings in `/var/lib/towerlog/recordings`.

**Docker** (use host networking for multicast):

```sh
docker compose up -d
echo 'a long password' | docker compose exec -T towerlog node dist/towerlog.mjs set-password
```

The container runs as the `node` user (uid 1000): the `./towerlog/*` folders must be writable by it. Point the `data` volume at your big disk. The image has not been built in CI yet.

## Input types

| Type | You give | Recorded as |
|---|---|---|
| Stream URL (Towerlog connects out) | the URL and its codec | `.mp3`, `.aac` or `.mka`, copied as received |
| RTP | address (multicast group or unicast), port, payload (L24, L16, G.711, MP3), rate, channels and, for linear audio, the payload type | `.flac` (MP3 payload: `.mp3`) |
| Livewire | channel number: joins `239.192.(N÷256).(N mod 256)` | `.flac` |
| Encoder sends to Towerlog (Towerlog waits) | a mount and a password you choose; the encoder connects to Towerlog's source port (default 8000) | `.mp3` or `.aac`, copied |

Recordings are laid out as `<recordings>/<Input_name>/YYYY/MM/DD/<Input_name>_YYMMDD_HHMM.<ext>`.

### Encoder inputs (the encoder connects to Towerlog)

With a stream URL input Towerlog connects out. With an **Encoder sends to Towerlog** input it is the reverse: Towerlog waits and the encoder connects in, the way it would to an Icecast server.
Choose a mount (say `/kutx`) and a password, then set the encoder's Icecast server to the Towerlog host, port 8000 (`source.port`), user `source`, that password and mount, or in ffmpeg:

```sh
ffmpeg -re -i input -c:a libmp3lame -b:a 128k -f mp3 -content_type audio/mpeg icecast://source:PASSWORD@towerlog-host:8000/kutx
```

Towerlog is not an Icecast server: nothing can listen at that address. It only receives and logs; listen in the web UI.

## Faults and alerts

| Fault | Raised when | Default delay |
|---|---|---|
| Feed lost | no audio is arriving | 5 s |
| Silence | the louder channel is under the silence level (default −50 dBFS) | 30 s |
| Clipping | at least 10 full-scale samples in a second | 10 s |
| Mono | left and right identical (off by default) | 30 s |
| Out of phase | left and right cancel when summed (off by default) | 30 s |

A fault is raised after its delay and cleared the moment it stops. Raises and clears go to `faults.jsonl`, email (with how long it lasted),
SNMP traps (`towerlogInputFault` / `towerlogInputCleared`) and Zabbix (`fault.<kind>` items and a text event).
Zabbix and SNMP also publish per-input status, level and recording state; the template and MIB are generated from the code
(`towerlog zabbix-template`, `towerlog snmp-mib`, or the download buttons in the UI). The SNMP enterprise number 99999 is a placeholder.

## Command line

```sh
towerlog check               # config problems, ffmpeg, inputs
towerlog password            # set the web UI password
towerlog test-email [ADDR]   # send a test email with the saved settings
towerlog restart             # reconnect every input, keep the web UI up
towerlog logs                # follow the service log
```

Set `TOWERLOG_ALLOW="10.0.0.0/8,::1"` in the service environment to restrict the web UI to certain addresses.

## Resource use

Measured once, on a single AMD EPYC 7713 virtual core, with the test rig below (7 inputs: 5 live HTTP MP3 feeds at 96 kbps,
1 encoder input, 1 unreachable): each live HTTP/MP3 input's ffmpeg used about 0.6 % of a core, and the Towerlog process about 1.6 %.
That is a rough single reading, not a benchmark: FLAC (RTP / Livewire) inputs, AAC feeds, many listeners and larger counts are unmeasured.
Each listener adds one MP3 encoder while they listen.

Disk use equals the feed's bit rate: a 128 kbps MP3 feed is about 58 MB per hour. FLAC depends on the audio: the raw rate of a 48 kHz
24-bit stereo feed is 2.3 Mbit/s (about 1 GB per hour) and FLAC is smaller by an amount not measured here.

## How it works

```
feed ──► ffmpeg ──┬─► segment muxer ─► <input>_YYMMDD_HHMM.<ext>   (copy, cut on the clock)
                  └─► PCM pipe ─► level / silence / clip / mono / phase ─► FaultTracker ─► log, email, SNMP, Zabbix
                                                                      └─► optional MP3 encoder per listener
```

One `ffmpeg` per input does both jobs. The app (Node 22, Astro, Svelte 5) supervises it, restarts it with a growing delay (2 s up to 30 s) if it stops,
and serves the UI over HTTP and a WebSocket. Icecast sources connect to a small raw-TCP listener (`server/source.ts`) because a source
stream has no Content-Length and Node's HTTP parser can't be used.

## Development

```sh
npm install
npm test                      # vitest: detectors, faults, config, recording, SNMP, Zabbix, runtime against real ffmpeg
npm run check                 # astro check + tsc
npm run build                 # dist/towerlog.mjs
dev/rig/ctl.sh start          # run it with fake feeds on http://127.0.0.1:18091 (see dev/rig/README.md)
```

Some tests start `ffmpeg` and take a few seconds; they are skipped if ffmpeg is missing. The multicast Livewire test is skipped when the
loopback interface has no multicast flag: set `TL_MC_ADDR` to another interface's address to run it.

## Not done yet

- Real-hardware verification: Barix 100 / 500, Inovonics, Livewire, and which stream mode and codec each unit emits.
- SNMP polling of the Inovonics / Barix units themselves (health, temperature).
- Roles and multiple users (there is one web password), time-range export as a single file, and a timeline view of faults over recordings.
- AAC over RTP, SRT and other transports.

## Made by

By [The Tyler Woodward Project](https://github.com/thetylerwoodwardproject). MIT licence.
