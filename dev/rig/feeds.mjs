// Fake audio feeds for trying Towerlog without hardware. Serves live MP3 over HTTP
// on 127.0.0.1:18100 (like an Icecast mount or a Barix in server mode):
//   /tone   440 Hz tone             /quiet  digital silence (silence fault)
//   /hot    hard-clipped at full scale   /mono   identical L/R   /phase  inverted R
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

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const src = SRC[path];
  if (!src) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': path.slice(1) });
  const args = ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', src, '-ac', '2', ...(FILTER[path] ? ['-af', FILTER[path]] : []), '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', '-'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
}).listen(18100, '127.0.0.1', () => console.log('fake feeds on http://127.0.0.1:18100/{tone,quiet,hot,mono,phase}'));
