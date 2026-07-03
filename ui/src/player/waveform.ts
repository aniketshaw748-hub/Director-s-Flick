/**
 * waveform.ts — voiceover waveform peaks + canvas rendering (T-58).
 *
 * Decode strategy: fetch the VO once, decode on an 8 kHz mono
 * OfflineAudioContext — decodeAudioData resamples to the context rate, so a
 * 10-minute VO costs ~19 MB transiently instead of ~115 MB at native rate.
 * 8 kHz keeps everything below 4 kHz, far more than a visual peak strip
 * needs. Buckets are min/max pairs, one per pixel column, cached per
 * (project, pxPerSecond) at module level — decode happens once per project
 * per session.
 *
 * Rendering never redraws per frame: the base (grey) and played (lime)
 * strips are two canvases painted once; playback progress is revealed by
 * resizing an overflow-hidden wrapper div around the lime copy — an O(1)
 * style write per animation frame, so scrubbing cannot jank on the canvas.
 *
 * Canvas width = duration × pxPerSecond (DPR-aware). At 12 px/s a 40-minute
 * VO is ~29k px — inside typical canvas limits (32k). Longer VOs would need
 * strip tiling; out of scope until the product needs >40-minute timelines.
 */

export interface WaveformPeaks {
  /** interleaved [min0, max0, min1, max1, …], one pair per px column */
  pairs: Float32Array;
  columns: number;
  durationSeconds: number;
}

const DECODE_RATE = 8000;
const cache = new Map<string, Promise<WaveformPeaks | null>>();

/** Fetch + decode + bucket the VO. Resolves null when anything fails
 *  (missing VO, unsupported codec, WebAudio unavailable) — callers degrade. */
export function loadWaveform(cacheKey: string, voUrl: string, pxPerSecond: number): Promise<WaveformPeaks | null> {
  const key = `${cacheKey}@${pxPerSecond}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = computeWaveform(voUrl, pxPerSecond).catch(() => null);
    cache.set(key, entry);
  }
  return entry;
}

async function computeWaveform(voUrl: string, pxPerSecond: number): Promise<WaveformPeaks | null> {
  if (typeof OfflineAudioContext === 'undefined') return null;
  const res = await fetch(voUrl);
  if (!res.ok) return null;
  const encoded = await res.arrayBuffer();

  // length/rate here only size the (unused) render graph; decodeAudioData
  // resamples to the context's sampleRate, which is what we're after.
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  const audio = await ctx.decodeAudioData(encoded);
  const durationSeconds = audio.duration;
  const columns = Math.max(1, Math.ceil(durationSeconds * pxPerSecond));
  const pairs = new Float32Array(columns * 2);

  // downmix channels on the fly while bucketing
  const chans: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  const samplesPerColumn = audio.length / columns;

  for (let col = 0; col < columns; col++) {
    const start = Math.floor(col * samplesPerColumn);
    const end = Math.min(audio.length, Math.ceil((col + 1) * samplesPerColumn));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    pairs[col * 2] = min;
    pairs[col * 2 + 1] = max;
  }
  return { pairs, columns, durationSeconds };
}

/** Paint a peak strip onto a canvas (DPR-aware). One vertical line per
 *  column from min to max, with a hairline center baseline. */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  cssHeight: number,
  color: string,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = peaks.columns;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, cssWidth, cssHeight);
  g.strokeStyle = color;
  g.lineWidth = 1;
  const mid = cssHeight / 2;
  // slight floor so silence still shows a visible baseline
  const MIN_HALF = 0.75;
  g.beginPath();
  for (let col = 0; col < peaks.columns; col++) {
    const min = peaks.pairs[col * 2];
    const max = peaks.pairs[col * 2 + 1];
    const yTop = mid - Math.max(max * mid, MIN_HALF);
    const yBot = mid - Math.min(min * mid, -MIN_HALF);
    g.moveTo(col + 0.5, yTop);
    g.lineTo(col + 0.5, yBot);
  }
  g.stroke();
}
