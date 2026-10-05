# Towerlog status notes

Plan: ~/.claude/plans/pasted-content-id-bf99-i-want-prancy-moler.md

Stages 1-9 of the plan are done (2026-10-04): fork stripped of the SDR/EAS/HD/network code, inputs (http, rtp, livewire, push),
clock-aligned recording, fault detection, email/SNMP/Zabbix, Icecast source endpoint, UI, Docker files, rig, README.

Verified with simulated feeds only (see tests/ and dev/rig/). Next, in order of value:
1. Try real hardware: a Barix and an Inovonics stream URL, a Livewire channel, a real Icecast source client push.
2. SNMP polling of Inovonics / Barix units (OIDs per model are not looked up yet).
3. Build and run the Docker image (not built here: no docker on the dev box).
4. Users and roles, range export, fault timeline over recordings.
5. Measure CPU on the real target and on FLAC inputs; README sizing is one reading.
