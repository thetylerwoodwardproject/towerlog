// Fake audio feeds for trying Towerlog without hardware. Serves live MP3 over HTTP
// on 127.0.0.1:18100 (like an Icecast mount or a Barix in server mode):
//   /tone   440 Hz tone             /quiet  digital silence (silence fault)
//   /hot    hard-clipped at full scale   /mono   identical L/R   /phase  inverted R
//   /eas    a quiet tone, then a SAME Required Weekly Test (header x3, attention tone, EOM x3) every ~45 s
import http from 'node:http';
import { spawn } from 'node:child_process';

const SRC = {
  '/tone': 'sine=frequency=440:sample_rate=44100',
  '/quiet': 'anullsrc=r=44100:cl=stereo',
  // a 1 kHz sine at 8x, hard-clipped to full scale
  '/hot': 'aevalsrc=exprs=clip(sin(2*PI*1000*t)*8\\,-1\\,1)|clip(sin(2*PI*1000*t)*8\\,-1\\,1):s=44100',
  '/mono': 'sine=frequency=300:sample_rate=44100',
  '/phase': 'sine=frequency=300:sample_rate=44100',
};
const FILTER = { '/phase': 'pan=stereo|c0=c0|c1=-1*c0' };

// ---- /eas: AFSK SAME encoder (520.83 baud, mark 2083.3 Hz, space 1562.5 Hz) plus the 853 + 960 Hz attention tone
const RATE = 48000;
function sameTransmission() {
  const out = [];
  let phase = 0;
  const afsk = (bytes) => {
    const spb = RATE / (520 + 5 / 6);
    let acc = 0;
    for (const byte of bytes) for (let b = 0; b < 8; b++) {
      const f = (byte >> b) & 1 ? 2083 + 1 / 3 : 1562.5;
      acc += spb;
      const n = Math.round(acc);
      acc -= n;
      for (let i = 0; i < n; i++) { phase += (2 * Math.PI * f) / RATE; out.push(0.5 * 32767 * Math.sin(phase)); }
    }
  };
  const gap = () => { for (let i = 0; i < RATE; i++) out.push(0); };
  const burst = (text) => { for (let r = 0; r < 3; r++) { afsk([...Array(16).fill(0xab), ...[...text].map((c) => c.charCodeAt(0))]); gap(); } };
  const now = new Date();
  const day = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
  const p = (n, w) => String(n).padStart(w, '0');
  burst(`ZCZC-WXR-RWT-020103-020209+0015-${p(day, 3)}${p(now.getUTCHours(), 2)}${p(now.getUTCMinutes(), 2)}-KEAX/NWS-`);
  for (let i = 0; i < 5 * RATE; i++) out.push(0.25 * 32767 * (Math.sin((2 * Math.PI * 853 * i) / RATE) + Math.sin((2 * Math.PI * 960 * i) / RATE)));
  gap();
  burst('NNNN');
  return Int16Array.from(out, (v) => Math.round(v));
}

function easFeed(res) {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'eas' });
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  ff.stdin.on('error', () => {});
  const quiet = () => { const q = new Int16Array(RATE * 20); for (let i = 0; i < q.length; i++) q[i] = 3000 * Math.sin((2 * Math.PI * 330 * i) / RATE); return Buffer.from(q.buffer); };
  const cycle = () => { ff.stdin.write(quiet()); const t = sameTransmission(); ff.stdin.write(Buffer.from(t.buffer, t.byteOffset, t.byteLength)); };
  cycle();
  const timer = setInterval(cycle, 45000);
  res.on('close', () => { clearInterval(timer); ff.kill('SIGKILL'); });
}

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/eas') return easFeed(res);
  const src = SRC[path];
  if (!src) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': path.slice(1) });
  const args = ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', src, '-ac', '2', ...(FILTER[path] ? ['-af', FILTER[path]] : []), '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', '-'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
}).listen(Number(process.env.FEEDS_PORT) || 18100, '127.0.0.1', () => console.log('fake feeds on http://127.0.0.1:' + (Number(process.env.FEEDS_PORT) || 18100) + '/{tone,quiet,hot,mono,phase,eas}'));
