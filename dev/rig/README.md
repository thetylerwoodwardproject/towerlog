# Test rig

`ctl.sh start` runs Towerlog with fake feeds and no hardware:

| Input | Feed | Shows |
|---|---|---|
| Studio A | 440 Hz tone, 15-minute files | normal operation |
| Studio B | digital silence, 5 s delay | silence fault |
| Hot Mic | clipped at full scale | clipping fault |
| Mono Feed / Phase Feed | identical / inverted channels | mono and phase faults |
| Air Chain | quiet tone, then a SAME Required Weekly Test about every 45 s | EAS tone, decoded message, EAS log (needs multimon-ng on PATH) |
| Dead Barix | refused connection | feed lost |
| Push KUTX | an ffmpeg Icecast push to the source port | the Icecast source (push) path |

Web UI: http://127.0.0.1:18091, password `testpass123`. Data, recordings and logs are in `dev/rig/build/` (git-ignored).
Edit `build/cfg/config.json` (copied from `config.json` on first start) to change the rig; delete `build/` to reset it.
