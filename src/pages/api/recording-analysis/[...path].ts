import type { APIRoute } from 'astro';
import { getEngine, handle } from '../../../lib/server/engine.ts';

/** Waveform, spectrum and spectrogram of one recording (path relative to the recordings folder). */
export const GET: APIRoute = ({ params }) => handle(() => getEngine().recordingAnalysis(params.path ?? ''));
